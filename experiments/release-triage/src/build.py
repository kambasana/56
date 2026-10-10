"""Step 4: one row per fetched release -> tabular features (data/features.csv.gz) and a Laya state.

Only facts knowable at publish time, and only fields obtainable the same way for both classes:
  * registry facts from the as-of packument (publisher, maintainers, provenance, scripts, dependencies, history);
  * content facts from the published contents (DataDog archive or registry tarball: same files npm served);
  * previous-release contents from the registry tarball (both classes).
Not included (cannot be had comparably for both classes, or would be hindsight): account burst counts across an
account's other packages, download counts, Scorecard, dependents, advisory text, `deprecated`.

Usage: python -I src/build.py
"""
from __future__ import annotations

import collections
import datetime as dt
import gzip
import json
import math
import re
import statistics
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import (CACHE, DATA, DESC_CHARS, INSTALL_HOOKS, README_CHARS, SCRIPT_FILE_CHARS, cache_path,
                    read_json_gz, semver_key)

DAY = 86400.0
KNOWN_BY = 3600.0  # facts are taken as of release + 1 hour (rule_scorer.ts scores at the same time)


def ts(s: str) -> float:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def hooks_of(scripts) -> dict:
    s = scripts if isinstance(scripts, dict) else {}
    return {h: s[h] for h in INSTALL_HOOKS if isinstance(s.get(h), str)}


def publisher(doc) -> tuple[str | None, bool]:
    u = (doc or {}).get("_npmUser") or {}
    name = u.get("name") if isinstance(u, dict) else None
    trusted = bool(isinstance(u, dict) and u.get("trustedPublisher"))
    return name, trusted


def maint_names(doc) -> set:
    m = (doc or {}).get("maintainers")
    return {x.get("name") for x in m if isinstance(x, dict) and x.get("name")} if isinstance(m, list) else set()


def repo_url(doc) -> str:
    r = (doc or {}).get("repository")
    if isinstance(r, dict):
        r = r.get("url")
    return (r or "").strip().lower() if isinstance(r, str) else ""


def bump(prev: str | None, cur: str) -> str:
    if prev is None:
        return "first"
    a, b = semver_key(prev), semver_key(cur)
    if b[3] == 0:
        return "prerelease"
    if b[:3] < a[:3]:
        return "backport"
    if b[0] != a[0]:
        return "major"
    if b[1] != a[1]:
        return "minor"
    return "patch"


def scrub(text: str, names: list[str]) -> str:
    for n in sorted({n for n in names if n and len(n) >= 3}, key=len, reverse=True):
        text = re.sub(re.escape(n), "<name>", text, flags=re.I)
    return text


def dir_entries(c: dict):
    paths = c.get("paths") or []
    if len(paths) != c.get("files", -1):
        return ""
    dirs = set()
    for q in paths:
        parts = q.split("/")
        for i in range(1, len(parts)):
            dirs.add("/".join(parts[:i]))
    return len(dirs)


def young_dependencies(added: list[str], first_published: dict, pub: float) -> tuple[int, int]:
    """(young, unknown) among the added dependencies.

    A dependency's first-publish time is looked up in today's registry (fetch.py). Only a date that today's registry
    still shows *and* that is no later than the scoring time (release + 1 hour, the time rule_scorer.ts scores at: a
    monorepo often publishes a new sibling seconds after the release that depends on it) is a publish-time fact. A
    dependency that cannot be resolved today (unpublished, or removed as malware), or whose earliest surviving version
    is later than that (npm's `0.0.1-security` placeholder, or the name re-registered later), has an UNKNOWN
    first-publish date: it is
    neither young nor old. Counting it as young would leak hindsight, because malicious dependencies are exactly the
    ones npm removes later. Young = known first publish within 30 days before the release.
    """
    young = unknown = 0
    for d in added:
        fp = first_published.get(d)
        if fp is None or ts(fp) > pub + KNOWN_BY:
            unknown += 1
        elif ts(fp) > pub - 30 * DAY:
            young += 1
    return young, unknown


def clip(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[:n] + f"…[+{len(s) - n} chars]"


def row_from_record(r: dict) -> tuple[dict, dict] | None:
    asof, c, pc = r["asof"], r["contents"], r.get("prev_contents")
    v, pv = r["version"], r.get("prev_version")
    doc = asof["versions"][v]
    pdoc = asof["versions"].get(pv) if pv else None
    t = asof["time"]
    pub = ts(t[v])
    hist = sorted((ts(t[x]), x) for x in t if x != v and ts(t[x]) < pub)
    times = [h[0] for h in hist]
    gaps = [b - a for a, b in zip(times, times[1:])]
    pj = c.get("package_json") or {}
    ppj = (pc or {}).get("package_json") or {}

    user, trusted = publisher(doc)
    puser, ptrusted = publisher(pdoc)
    prior_users = collections.Counter(publisher(asof["versions"].get(x))[0] for _, x in hist)
    hooks = hooks_of(doc.get("scripts"))
    phooks = hooks_of(pdoc.get("scripts")) if pdoc else {}
    tar_hooks = hooks_of(pj.get("scripts"))
    deps = set((doc.get("dependencies") or {}) if isinstance(doc.get("dependencies"), dict) else {})
    pdeps = set((pdoc.get("dependencies") or {}) if pdoc and isinstance(pdoc.get("dependencies"), dict) else {})
    added = sorted(deps - pdeps) if pdoc else sorted(deps)
    young, unknown_fp = young_dependencies(added, r.get("added_deps_first_published") or {}, pub)
    maj = semver_key(v)[0] if semver_key(v)[0] < 10**9 else math.nan
    prior_majors = [semver_key(x)[0] for _, x in hist if semver_key(x)[0] < 10**9]
    paths, ppaths = set(c.get("paths") or []), set((pc or {}).get("paths") or [])
    new_paths = sorted(paths - ppaths) if pc else []
    bins = pj.get("bin") if isinstance(pj.get("bin"), dict) else ({"_": pj["bin"]} if isinstance(pj.get("bin"), str) else {})
    pbins = ppj.get("bin") if isinstance(ppj.get("bin"), dict) else ({"_": ppj["bin"]} if isinstance(ppj.get("bin"), str) else {})
    script_files = c.get("script_files") or {}
    att = (doc.get("dist") or {}).get("attestations")
    patt = (pdoc.get("dist") or {}).get("attestations") if pdoc else None
    desc = doc.get("description") if isinstance(doc.get("description"), str) else ""
    pdesc = pdoc.get("description") if pdoc and isinstance(pdoc.get("description"), str) else ""
    nan = math.nan
    first = pdoc is None

    f = {
        "is_first_release": int(first),
        "prior_releases": len(hist),
        "package_age_days": (pub - times[0]) / DAY if times else 0.0,
        "days_since_prev_release": (pub - times[-1]) / DAY if times else nan,
        "median_gap_days_prior": statistics.median(gaps) / DAY if gaps else nan,
        "releases_prev_24h": sum(1 for x in times if x >= pub - DAY),
        "releases_prev_7d": sum(1 for x in times if x >= pub - 7 * DAY),
        "releases_prior_365d": sum(1 for x in times if x >= pub - 365 * DAY),
        "bump_" + bump(pv, v): 1,
        "is_prerelease": int(semver_key(v)[3] == 0),
        "version_major": maj,
        "major_jump": (maj - max(prior_majors)) if prior_majors and not math.isnan(maj) else nan,
        "publisher_differs_prev": nan if first else int(user != puser),
        "publisher_new_to_package": nan if first else int(prior_users.get(user, 0) == 0),
        "publisher_prior_releases": prior_users.get(user, 0),
        "distinct_publishers_prior": len([u for u in prior_users if u]),
        "trusted_publisher": int(trusted),
        "prev_trusted_publisher": nan if first else int(ptrusted),
        "maintainers_count": len(maint_names(doc)),
        "maintainers_added": nan if first else len(maint_names(doc) - maint_names(pdoc)),
        "maintainers_removed": nan if first else len(maint_names(pdoc) - maint_names(doc)),
        "has_provenance": int(bool(att)),
        "prev_has_provenance": nan if first else int(bool(patt)),
        "provenance_dropped": nan if first else int(bool(patt) and not att),
        "install_hooks": len(hooks),
        "new_install_hooks": len(set(hooks) - set(phooks)) if not first else len(hooks),
        "install_hook_changed": nan if first else int(hooks != phooks),
        "install_cmd_chars": sum(len(x) for x in hooks.values()),
        "install_runs_package_file": int(bool(script_files)),
        "install_file_is_new": nan if first else int(any(p not in ppaths for p in script_files)),
        "tarball_manifest_scripts_differ": int(tar_hooks != hooks),
        "gypfile": int(bool(doc.get("gypfile"))),
        "deps_count": len(deps),
        "deps_added": len(added) if not first else nan,
        "deps_removed": len(pdeps - deps) if not first else nan,
        "young_deps_added": young,
        "bin_count": len(bins),
        "bin_added": nan if first else len(set(bins) - set(pbins)),
        "repository_present": int(bool(repo_url(doc))),
        "repository_changed": nan if first else int(repo_url(doc) != repo_url(pdoc)),
        "description_len": len(desc),
        "description_changed": nan if first else int(desc != pdesc),
        "license_changed": nan if first else int(str(doc.get("license")) != str(pdoc.get("license"))),
        "files": c.get("files", 0),
        "log_bytes": math.log10(1 + c.get("bytes", 0)),
        "log_max_file_bytes": math.log10(1 + c.get("max_file_bytes", 0)),
        "js_files": c.get("js_files", 0),
        "files_added": nan if first else len(new_paths),
        "files_removed": nan if first else len(ppaths - paths),
        "bytes_ratio_prev": nan if first else (c.get("bytes", 0) + 1) / ((pc or {}).get("bytes", 0) + 1),
        "readme_len": c.get("readme_len", 0),
        "readme_len_prev": nan if first else (pc or {}).get("readme_len", 0),
        "readme_changed": nan if first else int((c.get("readme_head") or "")[:2000] != ((pc or {}).get("readme_head") or "")[:2000]),
    }

    names = [r["name"], r["name"].split("/")[-1], r["name"].split("/")[0].lstrip("@") if r["name"].startswith("@") else "",
             user or "", puser or ""]
    sc = lambda s, n: clip(scrub(s or "", names), n)
    per_file = max(150, SCRIPT_FILE_CHARS // max(1, len(script_files)))
    facts = {
        "release": {
            "first_release_of_package": bool(first), "bump": bump(pv, v), "prerelease": bool(f["is_prerelease"]),
            "major_jump": None if math.isnan(f["major_jump"]) else int(f["major_jump"]),
            "prior_releases": f["prior_releases"], "package_age_days": round(f["package_age_days"], 1),
            "days_since_previous_release": None if math.isnan(f["days_since_prev_release"]) else round(f["days_since_prev_release"], 1),
            "median_days_between_releases": None if math.isnan(f["median_gap_days_prior"]) else round(f["median_gap_days_prior"], 1),
            "releases_in_previous_24h": f["releases_prev_24h"], "releases_in_previous_year": f["releases_prior_365d"],
        },
        "publisher": {
            "same_as_previous_release": None if first else not f["publisher_differs_prev"],
            "first_release_by_this_account": None if first else bool(f["publisher_new_to_package"]),
            "account_prior_releases_of_package": f["publisher_prior_releases"],
            "distinct_accounts_before": f["distinct_publishers_prior"], "trusted_publishing": bool(trusted),
            "previous_used_trusted_publishing": None if first else bool(ptrusted),
            "maintainers": f["maintainers_count"],
            "maintainers_added": None if first else f["maintainers_added"], "maintainers_removed": None if first else f["maintainers_removed"],
        },
        "provenance": {"present": bool(att), "previous_present": None if first else bool(patt)},
        "install_scripts": {
            "hooks": {h: sc(cmd, 200) for h, cmd in hooks.items()},
            "previous_hooks": None if first else {h: sc(cmd, 120) for h, cmd in phooks.items()},
            "tarball_and_registry_scripts_differ": bool(f["tarball_manifest_scripts_differ"]),
        },
        "dependencies": {"count": f["deps_count"], "added": None if first else f["deps_added"], "removed": None if first else f["deps_removed"],
                         "added_first_published_within_30_days": young},
        "contents": {"files": f["files"], "kilobytes": round(c.get("bytes", 0) / 1024, 1),
                     "largest_file_kilobytes": round(c.get("max_file_bytes", 0) / 1024, 1),
                     "files_added_since_previous": None if first else f["files_added"],
                     "files_removed_since_previous": None if first else f["files_removed"],
                     "size_ratio_to_previous": None if first else round(f["bytes_ratio_prev"], 2),
                     "bin_entries": f["bin_count"], "readme_chars": f["readme_len"],
                     "readme_changed": None if first else bool(f["readme_changed"])},
        "metadata": {"repository_declared": bool(f["repository_present"]),
                     "repository_changed": None if first else bool(f["repository_changed"]),
                     "description_changed": None if first else bool(f["description_changed"]),
                     "license_changed": None if first else bool(f["license_changed"])},
    }
    text = {
        "install_script_files": {sc(p, 80): sc(b, per_file) for p, b in list(script_files.items())[:2]},
        "new_files": [sc(p, 80) for p in new_paths[:10]] if not first else None,
        "description": sc(desc, DESC_CHARS),
        "previous_description": (sc(pdesc, DESC_CHARS) if not first and desc != pdesc else None),
        "readme_head": sc(re.sub(r"\s+", " ", c.get("readme_head") or ""), README_CHARS),
    }
    state = {**facts, "text": text}
    meta = {
        "key": r["key"], "name": r["name"], "version": v, "label": r["label"], "category": r["category"],
        "family": r["family"], "wave": r.get("wave"), "family_basis": r.get("family_basis", ""),
        "published": t[v], "publisher": user or "",
        "content_source": r["content_source"], "packument_source": r.get("packument_source"),
        "neg_pool": r.get("neg_pool", ""), "label_sources": ";".join(r.get("label_sources", [])),
        # Registry's own count/size for this version (metadata, not a feature): used by the leakage check to
        # verify that archive and tarball contents are read the same way.
        "registry_dist_files": (doc.get("dist") or {}).get("fileCount", ""),
        "registry_dist_bytes": (doc.get("dist") or {}).get("unpackedSize", ""),
        # Directory entries implied by the counted paths ("" when the path list is incomplete). Some packers write
        # directory entries (and the root `package/`) into the tarball, and the registry's fileCount then counts
        # them; the leakage check needs this to compare like with like.
        "content_dir_entries": dir_entries(c),
        # Added dependencies whose first-publish date is unknown today (metadata for the leakage check, not a
        # feature: whether a dependency still resolves today is hindsight).
        "deps_added_unknown_first_publish": unknown_fp,
    }
    return {**meta, **f}, {"meta": meta, "state": state}


def main() -> None:
    rows, states = [], []
    drops = collections.Counter()
    # Only the releases listed in the candidate files (the cache may hold records of other runs).
    keys = sorted({f"{c['label']}:{c['name']}@{c['version']}" for f in ("positive_candidates.jsonl", "negative_candidates.jsonl")
                   for c in map(json.loads, open(DATA / f))})
    not_fetched = 0
    for key in keys:
        p = cache_path("records", key)
        if not p.exists():
            not_fetched += 1
            continue
        r = read_json_gz(p)
        if r.get("drop"):
            drops[(r["label"], r["drop"])] += 1
            continue
        out = row_from_record(r)
        rows.append(out[0])
        states.append(out[1])
    cols = sorted({k for r in rows for k in r})
    meta_cols = ["key", "name", "version", "label", "category", "family", "wave", "family_basis", "published",
                 "publisher", "content_source", "packument_source", "neg_pool", "label_sources",
                 "registry_dist_files", "registry_dist_bytes", "content_dir_entries",
                 "deps_added_unknown_first_publish"]
    feat_cols = sorted(k for k in cols if k not in meta_cols)
    for r in rows:
        for k in feat_cols:
            if k.startswith("bump_"):
                r.setdefault(k, 0)
    import csv
    with gzip.open(DATA / "all_rows.csv.gz", "wt", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=meta_cols + feat_cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if isinstance(r.get(k), float) and math.isnan(r[k]) else r.get(k, "")) for k in meta_cols + feat_cols})
    with gzip.open(DATA / "all_states.jsonl.gz", "wt") as fh:
        for s in states:
            fh.write(json.dumps(s, ensure_ascii=False, sort_keys=False) + "\n")
    summ = {"rows": len(rows), "positives": sum(r["label"] for r in rows), "negatives": sum(1 - r["label"] for r in rows),
            "dropped": {f"{'pos' if k[0] else 'neg'}:{k[1]}": n for k, n in sorted(drops.items())},
            "candidates": len(keys), "candidates_not_fetched": not_fetched,
            "feature_columns": feat_cols}
    (DATA / "build.summary.json").write_text(json.dumps(summ, indent=1) + "\n")
    print(json.dumps({k: v for k, v in summ.items() if k != "feature_columns"}, indent=1))


if __name__ == "__main__":
    main()
