"""Shared helpers for the release-triage dataset builder.

Everything downloaded here is untrusted data. Archives are opened in memory with zipfile/tarfile and
only a few small text members (package.json, install-script files, README) are read; nothing is
extracted to disk and nothing is executed. Run every script with `python -I`.
"""
from __future__ import annotations

import collections
import gzip
import hashlib
import io
import json
import os
import re
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # experiments/release-triage
DATA = ROOT / "data"
RESULTS = ROOT / "results"
# Bulky caches live outside the repository (override with RT_CACHE).
CACHE = Path(os.environ.get("RT_CACHE", "/home/user/rtwork/cache"))

REGISTRY = "https://registry.npmjs.org"
DD_REPO = "DataDog/malicious-software-packages-dataset"
# Pinned commit of the DataDog dataset (HEAD of main when this dataset was built).
DD_COMMIT = "805fcd72db525244cae8dd32056efbd50b8b0e19"
DD_PASSWORD = b"infected"  # documented in the dataset README

INSTALL_HOOKS = ("preinstall", "install", "postinstall")
# Text budgets (characters) for the Laya state. Chosen so states fit 1024 tokens with the head.
SCRIPT_FILE_CHARS = 700
README_CHARS = 300
DESC_CHARS = 200
MAX_FILE_READ = 4_000_000  # bytes read from any single member (never more)
# Archive limits, the same for both classes (added 2026-10-10 after a worker ran out of memory on the v2 fetch; no
# v1 row comes near them): compressed archive bytes, and file entries listed.
MAX_ARCHIVE_BYTES = 150_000_000
MAX_MEMBERS = 50_000

UA = "blastradius-release-triage-research/0.1 (+https://github.com/kambasana/56)"


class TooLarge(Exception):
    """An archive above MAX_ARCHIVE_BYTES or MAX_MEMBERS (same limit for DataDog archives and registry tarballs)."""


def http_get(url: str, *, timeout: int = 60, retries: int = 4, accept: str | None = None,
             max_bytes: int | None = None) -> bytes | None:
    """GET with retries. Returns None on 404/410. Raises TooLarge past max_bytes (read in chunks, never buffered)."""
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **({"Accept": accept} if accept else {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if max_bytes is None:
                    return r.read()
                buf = bytearray()
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        return bytes(buf)
                    buf += chunk
                    if len(buf) > max_bytes:
                        raise TooLarge(f"{url}: more than {max_bytes} bytes")
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return None
            last = e
            if e.code == 429:
                time.sleep(5 * (i + 1))
                continue
        except TooLarge:
            raise
        except Exception as e:  # network errors: retry
            last = e
        time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"GET failed after {retries} tries: {url}: {last}")


def enc_name(name: str) -> str:
    return name.replace("/", "%2f") if name.startswith("@") else name


def cache_path(kind: str, key: str, ext: str = ".json.gz") -> Path:
    safe = re.sub(r"[^A-Za-z0-9._@-]", "_", key)
    if len(safe) > 180:
        safe = safe[:150] + "_" + hashlib.sha1(key.encode()).hexdigest()[:16]
    p = CACHE / kind / (safe + ext)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def read_json_gz(p: Path):
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return json.load(f)


def write_json_gz(p: Path, obj) -> None:
    tmp = p.with_suffix(p.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    tmp.replace(p)


# --- Packuments ------------------------------------------------------------------------------------

VERSION_KEEP = (
    "name", "version", "_npmUser", "maintainers", "scripts", "dependencies", "optionalDependencies",
    "peerDependencies", "bin", "description", "repository", "homepage", "license", "main", "gypfile",
    "keywords", "dist",
)


def slim_version(doc: dict) -> dict:
    """Keep the fields we use. Drops `deprecated` (set after the fact) and e-mail addresses."""
    out = {}
    for k in VERSION_KEEP:
        if k not in doc:
            continue
        v = doc[k]
        if k == "_npmUser" and isinstance(v, dict):
            v = {kk: vv for kk, vv in v.items() if kk != "email"}
        elif k == "maintainers" and isinstance(v, list):
            v = [{"name": m.get("name")} if isinstance(m, dict) else m for m in v]
        elif k == "dist" and isinstance(v, dict):
            v = {kk: v[kk] for kk in ("tarball", "attestations", "fileCount", "unpackedSize", "integrity") if kk in v}
        out[k] = v
    return out


def slim_packument(p: dict) -> dict:
    return {
        "name": p.get("name"),
        "time": {k: v for k, v in (p.get("time") or {}).items() if isinstance(v, str)},
        "versions": {v: slim_version(d) for v, d in (p.get("versions") or {}).items() if isinstance(d, dict)},
    }


BIG_PACKUMENT_BYTES = 20_000_000
_BIG_PACKUMENT = threading.Lock()


_PACK_MEMO: "collections.OrderedDict[str, dict | None]" = collections.OrderedDict()
_PACK_MEMO_LOCK = threading.Lock()
_PACK_LOADING: dict[str, threading.Lock] = {}
PACK_MEMO_SIZE = 8  # a few recent packuments shared by all threads (read-only), so a big one is parsed once


def registry_packument(name: str) -> dict | None:
    """Current registry packument (slimmed, cached on disk; the last few also in memory). Treat as read-only."""
    with _PACK_MEMO_LOCK:
        if name in _PACK_MEMO:
            _PACK_MEMO.move_to_end(name)
            return _PACK_MEMO[name]
        lk = _PACK_LOADING.setdefault(name, threading.Lock())
    with lk:  # single flight: threads asking for the same package wait for one load
        with _PACK_MEMO_LOCK:
            if name in _PACK_MEMO:
                _PACK_MEMO.move_to_end(name)
                return _PACK_MEMO[name]
        p = _registry_packument(name)
        with _PACK_MEMO_LOCK:
            _PACK_MEMO[name] = p
            while len(_PACK_MEMO) > PACK_MEMO_SIZE:
                _PACK_MEMO.popitem(last=False)
            _PACK_LOADING.pop(name, None)
    return p


def _registry_packument(name: str) -> dict | None:
    cp = cache_path("packuments", name)
    if cp.exists():
        return read_json_gz(cp)
    url = f"{REGISTRY}/{enc_name(name)}"
    try:
        raw = http_get(url, max_bytes=BIG_PACKUMENT_BYTES)
        if raw is None:
            write_json_gz(cp, None)
            return None
        p = slim_packument(json.loads(raw))
    except TooLarge:  # a very large document (e.g. aws-sdk): one at a time, to bound memory
        with _BIG_PACKUMENT:
            raw = http_get(url, timeout=300)
            if raw is None:
                write_json_gz(cp, None)
                return None
            p = slim_packument(json.loads(raw))
    del raw
    write_json_gz(cp, p)
    return p


def as_of(p: dict, release_iso: str) -> dict:
    """Packument trimmed to versions published at or before the release time (time map and docs)."""
    t = p.get("time") or {}
    keep = {v for v, ts in t.items() if v not in ("created", "modified") and ts <= release_iso}
    return {
        "name": p.get("name"),
        "time": {v: t[v] for v in sorted(keep, key=lambda v: t[v])},
        "versions": {v: d for v, d in (p.get("versions") or {}).items() if v in keep},
    }


# --- Package contents ------------------------------------------------------------------------------

SCRIPT_FILE_RE = re.compile(r"(?:^|[\s;&|(])(?:node|bun|deno|sh|bash|python3?)\s+(?:-[-\w]+\s+)*['\"]?([\w./@-]+\.(?:c?js|mjs|ts|sh|py))", re.I)
README_RE = re.compile(r"^readme(\.(md|markdown|txt|rst))?$", re.I)


def _norm(path: str) -> str | None:
    """Path inside the package, without the archive's first directory ("package/")."""
    parts = [x for x in path.replace("\\", "/").split("/") if x not in ("", ".")]
    if len(parts) < 2 or ".." in parts:
        return None
    return "/".join(parts[1:])


def _contents_from_members(members: dict[str, int], read) -> dict:
    """members: {path_in_package: size}; read(path) -> bytes (at most MAX_FILE_READ)."""
    pj_raw = read("package.json") if "package.json" in members else None
    pj = None
    if pj_raw is not None:
        try:
            pj = json.loads(pj_raw.decode("utf-8", "replace"))
        except Exception:
            pj = None
    scripts = (pj or {}).get("scripts") if isinstance(pj, dict) else None
    scripts = scripts if isinstance(scripts, dict) else {}
    script_files: dict[str, str] = {}
    for hook in INSTALL_HOOKS:
        cmd = scripts.get(hook)
        if not isinstance(cmd, str):
            continue
        for m in SCRIPT_FILE_RE.finditer(cmd):
            f = m.group(1).lstrip("./")
            if f in members and f not in script_files:
                b = read(f) or b""
                script_files[f] = b[: SCRIPT_FILE_CHARS * 4].decode("utf-8", "replace")
    readme_name = next((m for m in sorted(members) if "/" not in m and README_RE.match(m)), None)
    readme = (read(readme_name) or b"").decode("utf-8", "replace") if readme_name else ""
    return {
        "files": len(members),
        "bytes": int(sum(members.values())),
        "max_file_bytes": int(max(members.values()) if members else 0),
        "js_files": sum(1 for m in members if m.endswith((".js", ".cjs", ".mjs"))),
        "top_level": sorted({m.split("/")[0] for m in members})[:200],
        "paths": sorted(members)[:3000],
        "package_json": pj if isinstance(pj, dict) else None,
        "script_files": script_files,
        "readme_len": len(readme),
        "readme_head": readme[:4000],
    }


def contents_from_tgz(data: bytes) -> dict:
    tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
    members: dict[str, int] = {}
    infos: dict[str, tarfile.TarInfo] = {}
    for n_seen, ti in enumerate(tf, 1):  # iterate (not getmembers) so a huge archive is refused early
        if n_seen > MAX_MEMBERS:
            raise TooLarge(f"more than {MAX_MEMBERS} entries")
        if not ti.isfile():
            continue
        p = _norm(ti.name)
        if p is None:
            continue
        members[p] = ti.size
        infos[p] = ti

    def read(p: str) -> bytes | None:
        f = tf.extractfile(infos[p])  # in-memory read of one member; never written to disk
        return f.read(MAX_FILE_READ) if f else None

    return _contents_from_members(members, read)


def contents_from_dd_zip(data: bytes) -> tuple[dict, dict | None]:
    """DataDog sample zip: <tmp>/<tmp>/<pkg>/package/... plus package_info-*.json (registry packument
    captured at detection). Returns (contents, packument or None)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    members: dict[str, int] = {}
    names: dict[str, str] = {}
    info_name = None
    if len(z.infolist()) > MAX_MEMBERS:
        raise TooLarge(f"more than {MAX_MEMBERS} entries")
    for zi in z.infolist():
        if zi.is_dir():
            continue
        n = zi.filename.replace("\\", "/")
        base = n.rsplit("/", 1)[-1]
        if base.startswith("package_info-") and base.endswith(".json") and info_name is None:
            info_name = n
            continue
        idx = n.find("/package/")
        if idx < 0:
            continue
        p = n[idx + len("/package/"):]
        if not p or ".." in p.split("/"):
            continue
        members[p] = zi.file_size
        names[p] = n

    def read(p: str) -> bytes | None:
        with z.open(names[p], pwd=DD_PASSWORD) as f:
            return f.read(MAX_FILE_READ)

    packument = None
    if info_name:
        try:
            with z.open(info_name, pwd=DD_PASSWORD) as f:
                packument = slim_packument(json.loads(f.read().decode("utf-8", "replace")))
        except Exception:
            packument = None
    return _contents_from_members(members, read), packument


def registry_contents(name: str, version: str, tarball_url: str | None) -> dict | None:
    """Contents of a live registry tarball (cached summary)."""
    cp = cache_path("contents", f"{name}@{version}")
    if cp.exists():
        return read_json_gz(cp)
    url = tarball_url or f"{REGISTRY}/{name}/-/{name.split('/')[-1]}-{version}.tgz"
    try:
        raw = http_get(url, timeout=180, max_bytes=MAX_ARCHIVE_BYTES)
    except TooLarge as e:
        c = {"error": f"too_large: {e}"[:200]}
        write_json_gz(cp, c)
        return c
    if raw is None:
        write_json_gz(cp, None)
        return None
    try:
        c = contents_from_tgz(raw)
        c["source"] = "registry-tarball"
        c["archive_sha256"] = hashlib.sha256(raw).hexdigest()
    except Exception as e:  # corrupt tarball: record and move on
        c = {"error": str(e)[:200]}
    write_json_gz(cp, c)
    return c


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def semver_key(v: str):
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", v)
    if not m:
        return (10**9, 0, 0, 1, v)
    pre = m.group(4)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if pre else 1, pre or "")
