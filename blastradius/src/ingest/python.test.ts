import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseToml, TomlError } from './toml.js';
import {
  hashToSri,
  isExactPypiVersion,
  normalizePypiName,
  parsePipfileLock,
  parsePoetryLock,
  parsePyproject,
  parseRequirements,
  parseUvLock,
  pypiPurl,
  requirementsInventory,
  requirementsScope,
} from './python.js';
import { estimatePackages, notAnalysedLine, unsupportedKind } from './manifests.js';
import { isRequirementsFile } from './fs.js';

const TIER0 = fileURLToPath(new URL('../../test/fixtures/tier0/', import.meta.url));
const read = (p: string) => readFileSync(`${TIER0}${p}`, 'utf8');

describe('TOML reader', () => {
  it('reads tables, arrays of tables, dotted keys, inline tables and multi-line arrays', () => {
    const doc = parseToml(`# c
title = "x" # trailing
[a.b]
n = 1_000
f = 1.5
ok = true
d = 2026-10-12T00:00:00Z
arr = [
  "one", # comment
  'two',
]
[[pkg]]
name = "p1"
deps = [{ name = "q", marker = "python_version < '3.13'" }]
[pkg.extra]
k = """multi
line"""
[[pkg]]
name = "p2"
"quoted.key" = 'lit'
`);
    expect(doc['title']).toBe('x');
    expect(doc['a']).toEqual({ b: { n: 1000, f: 1.5, ok: true, d: '2026-10-12T00:00:00Z', arr: ['one', 'two'] } });
    expect(doc['pkg']).toEqual([
      { name: 'p1', deps: [{ name: 'q', marker: "python_version < '3.13'" }], extra: { k: 'multi\nline' } },
      { name: 'p2', 'quoted.key': 'lit' },
    ]);
  });
  it('rejects malformed input and duplicate keys; "__proto__" is an ordinary key', () => {
    expect(() => parseToml('a = ')).toThrow(TomlError);
    expect(() => parseToml('a = 1\na = 2')).toThrow(/duplicate/);
    expect(() => parseToml('a = "x')).toThrow(/unterminated/);
    const doc = parseToml('__proto__ = "x"');
    expect(Object.getPrototypeOf(doc)).toBeNull();
    expect(doc['__proto__']).toBe('x');
    expect(() => parseToml(`a = ${'['.repeat(100)}${']'.repeat(100)}`)).toThrow(/too deep/);
  });
  it('parses the real flask uv.lock and pyproject.toml', () => {
    expect(() => parseToml(read('flask/repo/uv.lock'))).not.toThrow();
    expect(parsePyproject(read('flask/repo/pyproject.toml')).deps.filter((d) => d.scope === 'runtime').map((d) => d.name)).toEqual(['blinker', 'click', 'itsdangerous', 'jinja2', 'markupsafe', 'werkzeug']);
  });
});

describe('Python names, versions, purls', () => {
  it('normalises names (PEP 503) and builds pypi purls', () => {
    expect(normalizePypiName('Flask_SQLAlchemy')).toBe('flask-sqlalchemy');
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
    expect(pypiPurl('PyYAML', '6.0.2')).toBe('pkg:pypi/pyyaml@6.0.2');
  });
  it('accepts exact PEP 440 versions only', () => {
    for (const v of ['1.0', '2.32.3', '3.1.6', '1.0.0rc1', '2.0.post1', '1.0.dev3', '1!2.0', '1.2.3+local']) expect(isExactPypiVersion(v)).toBe(true);
    for (const v of ['1.*', '>=1.0', '', 'latest']) expect(isExactPypiVersion(v)).toBe(false);
  });
  it('converts hex hashes to SRI', () => {
    expect(hashToSri('sha256:' + '00'.repeat(32))).toBe(`sha256-${Buffer.alloc(32).toString('base64')}`);
    expect(hashToSri('md5:abc')).toBeUndefined();
  });
});

describe('requirements*.txt', () => {
  it('reads pins, hashes, includes, local projects and unpinned entries', () => {
    const r = parseRequirements(
      [
        '-r base.txt',
        '--index-url https://pypi.org/simple',
        '-e ./local-pkg',
        'Django==5.1.4 \\',
        '    --hash=sha256:' + 'ab'.repeat(32),
        'requests[socks]==2.32.3 ; python_version >= "3.8"',
        'flask>=3.0',
        'numpy',
        'git+https://github.com/x/y.git#egg=y',
      ].join('\n'),
    );
    expect(r.includes).toEqual(['base.txt']);
    expect(r.local).toEqual(['./local-pkg']);
    expect(r.entries.filter((e) => e.version).map((e) => `${e.name}@${e.version}`)).toEqual(['django@5.1.4', 'requests@2.32.3']);
    expect(r.entries[0]!.hashes).toEqual(['sha256:' + 'ab'.repeat(32)]);
    expect(r.unresolved).toEqual(['flask >=3.0', 'numpy', 'git+https://github.com/x/y.git#egg=y']);
  });
  it('turns the pip-compile "# via" comments of superset base.txt into the dependency graph', () => {
    const req = parseRequirements(read('superset/repo/requirements/base.txt'));
    expect(req.mentionsProject).toBe(true);
    const inv = requirementsInventory(req, 'repo:superset', requirementsScope('requirements/base.txt'));
    const direct = inv.edges.filter((e) => e.direct).map((e) => e.to);
    expect(direct).toContain('pkg:pypi/paramiko@3.5.1'); // via apache-superset (pyproject.toml)
    expect(direct).not.toContain('pkg:pypi/bcrypt@4.3.0'); // via paramiko only
    expect(inv.edges).toContainEqual({ from: 'pkg:pypi/cryptography@50.0.2', to: 'pkg:pypi/cffi@2.0.0', scope: 'runtime', direct: false });
  });
  it('scopes requirement files by name', () => {
    expect(requirementsScope('requirements.txt')).toBe('runtime');
    expect(requirementsScope('requirements/base.txt')).toBe('runtime');
    for (const f of ['requirements/development.txt', 'requirements-dev.txt', 'docs/requirements.txt', 'requirements/translations.txt', 'test-requirements.txt']) expect(requirementsScope(f)).toBe('dev');
    expect(isRequirementsFile('requirements/base.txt')).toBe(true);
    expect(isRequirementsFile('dev-requirements.txt')).toBe(true);
    expect(isRequirementsFile('constraints.txt')).toBe(false);
    expect(isRequirementsFile('notes.txt')).toBe(false);
  });
});

describe('Python lockfiles', () => {
  it('uv.lock: registry packages become components; the project is the importer; groups keep their scope', () => {
    const res = parseUvLock(read('flask/repo/uv.lock'), { assetIdFor: (dir) => (dir === '' ? 'repo:flask' : undefined) });
    expect(res.components.map((c) => c.name).sort()).toEqual(['asgiref', 'blinker', 'click', 'colorama', 'itsdangerous', 'jinja2', 'markupsafe', 'python-dotenv', 'ruff', 'werkzeug']);
    const direct = (scope: string) => res.edges.filter((e) => e.from === 'repo:flask' && e.scope === scope).map((e) => e.to.replace(/@.*/, '')).sort();
    expect(direct('runtime')).toEqual(['pkg:pypi/blinker', 'pkg:pypi/click', 'pkg:pypi/itsdangerous', 'pkg:pypi/jinja2', 'pkg:pypi/markupsafe', 'pkg:pypi/werkzeug']);
    // Tier 0.6: flask's own extras ([project.optional-dependencies]) are installed only on request.
    expect(direct('extra')).toEqual(['pkg:pypi/asgiref', 'pkg:pypi/python-dotenv']);
    expect(direct('optional')).toEqual([]);
    // asgiref and python-dotenv are also in flask's "tests" dependency group.
    expect(direct('dev')).toEqual(['pkg:pypi/asgiref', 'pkg:pypi/python-dotenv', 'pkg:pypi/ruff']);
    expect(res.edges).toContainEqual({ from: 'pkg:pypi/werkzeug@3.1.8', to: 'pkg:pypi/markupsafe@3.0.3', scope: 'runtime', direct: false });
  });
  it('poetry.lock: groups and categories decide scope; pyproject gives the roots', () => {
    const lock = `[[package]]
name = "requests"
version = "2.32.3"
optional = false
groups = ["main"]
files = [{file = "requests-2.32.3.tar.gz", hash = "sha256:${'cd'.repeat(32)}"}]

[package.dependencies]
idna = ">=2.5,<4"

[[package]]
name = "idna"
version = "3.10"
groups = ["main"]

[[package]]
name = "pytest"
version = "8.3.4"
groups = ["dev"]
`;
    const py = parsePyproject(`[tool.poetry]\nname = "app"\n[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.32"\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n`);
    const res = parsePoetryLock(lock, 'repo:app', py);
    expect(res.components.map((c) => c.purl)).toEqual(['pkg:pypi/requests@2.32.3', 'pkg:pypi/idna@3.10', 'pkg:pypi/pytest@8.3.4']);
    expect(res.components[0]!.integrity).toMatch(/^sha256-/);
    expect(res.edges).toEqual([
      { from: 'pkg:pypi/requests@2.32.3', to: 'pkg:pypi/idna@3.10', scope: 'runtime', direct: false },
      { from: 'repo:app', to: 'pkg:pypi/requests@2.32.3', scope: 'runtime', direct: true },
      { from: 'repo:app', to: 'pkg:pypi/pytest@8.3.4', scope: 'dev', direct: true },
    ]);
  });
  it('Pipfile.lock: default is runtime, develop is dev; unpinned entries are unresolved', () => {
    const res = parsePipfileLock(JSON.stringify({ default: { requests: { version: '==2.32.3', hashes: ['sha256:' + 'ef'.repeat(32)] }, odd: { git: 'https://x' } }, develop: { pytest: { version: '==8.3.4' } } }), 'repo:app');
    expect(res.edges).toEqual([
      { from: 'repo:app', to: 'pkg:pypi/requests@2.32.3', scope: 'runtime', direct: true },
      { from: 'repo:app', to: 'pkg:pypi/pytest@8.3.4', scope: 'dev', direct: true },
    ]);
    expect(res.unresolved).toEqual(['odd']);
  });
});

describe('not-analysed manifests', () => {
  it('recognises other ecosystems and estimates their package counts from real files', () => {
    expect(unsupportedKind('Gemfile.lock')).toMatchObject({ ecosystem: 'gem' });
    expect(unsupportedKind('yarn.lock')).toMatchObject({ ecosystem: 'npm' });
    expect(unsupportedKind('package.json')).toBeUndefined();
    const gems = estimatePackages('Gemfile.lock', read('jitsi-meet/repo/Gemfile.lock'))!;
    expect(gems).toBeGreaterThan(10);
    expect(estimatePackages('android/app/build.gradle', read('jitsi-meet/repo/android/app/build.gradle'))).toBeGreaterThan(0);
    expect(estimatePackages('yarn.lock', '# yarn\n\n"a@^1.0.0", "a@^1.1.0":\n  version "1.1.0"\n\nb@2:\n  version "2.0.0"\n')).toBe(2);
    expect(estimatePackages('go.mod', 'module m\nrequire (\n\tgolang.org/x/text v0.14.0\n)\nrequire github.com/pkg/errors v0.9.1\n')).toBe(2);
    expect(estimatePackages('Cargo.lock', '[[package]]\nname="a"\n[[package]]\nname="b"\n')).toBe(2);
  });
  it('summarises as one loud line', () => {
    expect(notAnalysedLine([{ file: 'yarn.lock', ecosystem: 'npm', reason: 'x', packages: 120 }, { file: 'setup.py', ecosystem: 'pypi', reason: 'y' }])).toBe('NOT ANALYSED: yarn.lock, setup.py, ~120+ packages');
  });
});
