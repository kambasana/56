import { controlLabels } from '../stability/build.js';
import { loadControl } from '../stability/fixture.js';
const out = await controlLabels(loadControl());
for (const r of out) for (const p of r.report.packages) console.log([r.repo, p.name, p.label, p.basis ?? '', p.rules.map((x) => x.rule).join('+')].join('\t'));
