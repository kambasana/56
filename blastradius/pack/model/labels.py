"""Positive labels: compromised releases of otherwise legitimate npm packages, grouped by campaign.

    python pack/model/labels.py names  --osv-zip all.zip --attack-data SAD --out out/labels
    python pack/model/labels.py labels --osv-zip all.zip --attack-data SAD --cache .cache/packuments \
        --out out/labels [--min-prior 2] [--min-history-days 90]

`names` writes candidates.txt (packages to fetch with fetch_packuments.py); `labels` writes
labels.jsonl (one compromised release per line), known_bad.json (every listed bad version, for
dropping from the negatives) and labels_report.json (counts, sources, dropped items with reasons).

Sources (licences in the report):
  * OSV npm export: MAL-* records (OpenSSF malicious-packages) and GitHub advisories tagged CWE-506.
    Records whose range covers every version (introduced 0, no fix) are whole-package malware and
    never positives. Explicit versions are used; SEMVER ranges are resolved against the packument.
  * tstromberg/supplychain-attack-data: npm artifacts of each attack (meta.yaml).
  * Our incident KB (kb/incidents/*.yaml) and the replay incidents (test/replay/incidents.config.json).

"Compromised release of a legitimate package" (not spam, not a typosquat, not a whole malicious
package) is decided from the packument's `time` map only, which npm keeps for unpublished versions:
the package must have at least --min-prior releases that are not themselves listed as bad, published
before its first bad release, and its first release must be at least --min-history-days older than
that. A record whose versions of one package were published more than --max-span-days apart
describes a range of affected releases (e.g. fsevents < 1.2.11 fetching a binary from a bucket taken
over years later), not releases that were malicious when published: it is not used for that package
(another, tighter record or curated source may still label the same version). A package with more
than --max-live-stream bad versions, most of them still live on npm, is a stream of releases the
registry has not removed (a package-level classification, often disputed), not discrete compromised
releases: it is dropped. Nothing is invented: a release without a `time` entry, or a package npm removed entirely
(`time.unpublished`), is dropped with the reason.

Campaigns: union of (a) supplychain-attack-data ids, merged into families when their texts name the
same distinctive campaign marker (FAMILIES below), (b) KB / replay incident ids, (c) the OSV record
otherwise. Labels sharing a release are one campaign. A release known only from OSV joins a named
campaign when one of that campaign's positives was published within WINDOW_DAYS of it; remaining
OSV-only releases are chained into time clusters (gap <= CHAIN_GAP_DAYS, a cluster spans at most
CHAIN_MAX_SPAN_DAYS). Merging errs towards fewer, larger campaigns, so a campaign-grouped split
cannot leak one wave into both sides.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import sys
import urllib.parse
import zipfile

import yaml

DAY = 86400.0
WINDOW_DAYS = 2.0
CHAIN_GAP_DAYS = 1.0
CHAIN_MAX_SPAN_DAYS = 14.0
# Distinctive markers in supplychain-attack-data texts; attacks that share one are one family.
# (family, marker, start_date prefix or "")
FAMILIES = [
    ("npnjs-phishing-2025-07", re.compile(r"npnjs", re.I), ""),
    ("npmjs-help-phishing-2025-09", re.compile(r"npmjs\.help", re.I), ""),
    ("sha1-hulud-second-coming-2025-11", re.compile(r"second coming", re.I), ""),
    ("teampcp-2026", re.compile(r"teampcp", re.I), ""),
    ("miasma-2026", re.compile(r"miasma", re.I), ""),
    ("shai-hulud-2025-09", re.compile(r"shai-hulud", re.I), "2025-09"),
]
# Named campaigns with positives this close are one wave (e.g. the 2025-09-08 phishing wave hit
# chalk/debug, duckdb and prebid within hours; sources file them separately).
NAMED_MERGE_HOURS = 12.0
LICENCES = {
    "osv": "OSV npm export: MAL-* records CC-BY-4.0 (OpenSSF malicious-packages), GitHub advisories CC-BY-4.0",
    "sad": "tstromberg/supplychain-attack-data, Apache-2.0",
    "kb": "blastradius incident KB (this repository)",
    "replay": "blastradius replay incidents (this repository)",
}


# --- semver (enough for OSV SEMVER ranges and ordering) ---------------------------------------
_SV = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$")


def semkey(v: str):
    m = _SV.match(v)
    if not m:
        return None
    pre = m.group(4)
    pk = (1,) if pre is None else (0, tuple((0, int(p)) if p.isdigit() else (1, p) for p in pre.split(".")))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), pk)


def in_ranges(v: str, ranges: list) -> bool:
    k = semkey(v)
    if k is None:
        return False
    for rg in ranges:
        if rg.get("type") != "SEMVER":
            continue
        intro = None
        for e in rg.get("events") or []:
            if "introduced" in e:
                intro = semkey(e["introduced"]) if e["introduced"] != "0" else (0, 0, 0, (0, ()))
                if intro is not None and k >= intro and not any(("fixed" in x or "last_affected" in x) for x in rg.get("events") or []):
                    return True
            elif intro is not None and "fixed" in e:
                f = semkey(e["fixed"])
                if f is not None and intro <= k < f:
                    return True
                intro = None
            elif intro is not None and "last_affected" in e:
                la = semkey(e["last_affected"])
                if la is not None and intro <= k <= la:
                    return True
                intro = None
    return False


def whole_package(ranges: list) -> bool:
    for rg in ranges:
        ev = rg.get("events") or []
        if any(e.get("introduced") == "0" for e in ev) and not any(("fixed" in e or "last_affected" in e) for e in ev):
            return True
    return False


# --- sources -------------------------------------------------------------------------------------
class Claim:
    """One source saying name@versions (or name within ranges) is malicious."""

    def __init__(self, source: str, ref: str, name: str, versions: list[str], ranges: list | None = None, whole: bool = False, campaign: str | None = None, text: str = ""):
        self.source, self.ref, self.name = source, ref, name
        self.versions, self.ranges, self.whole, self.campaign, self.text = versions, ranges or [], whole, campaign, text


def osv_claims(zip_path: str) -> tuple[list[Claim], dict]:
    z = zipfile.ZipFile(zip_path)
    out: list[Claim] = []
    import hashlib
    h = hashlib.sha256()
    with open(zip_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    mtime = dt.datetime.fromtimestamp(os.path.getmtime(zip_path), dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    n = 0
    for f in z.namelist():
        if not f.endswith(".json") or not (f.startswith("MAL-") or f.startswith("GHSA-")):
            continue
        try:
            r = json.loads(z.read(f))
        except ValueError:
            continue
        cwes = (r.get("database_specific") or {}).get("cwe_ids") or []
        if r.get("withdrawn") or (f.startswith("GHSA-") and "CWE-506" not in cwes):
            continue
        n += 1
        for a in r.get("affected") or []:
            p = a.get("package") or {}
            if p.get("ecosystem") != "npm" or not isinstance(p.get("name"), str):
                continue
            vs = [v for v in a.get("versions") or [] if isinstance(v, str)]
            rng = a.get("ranges") or []
            out.append(Claim("osv", r["id"], p["name"], vs, rng, whole_package(rng), None, ((r.get("summary") or "") + " " + (r.get("details") or ""))[:4000]))
    return out, {"records": n, "url": "https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip", "downloaded": mtime, "sha256": h.hexdigest()}


def sad_claims(root: str) -> tuple[list[Claim], dict]:
    out: list[Claim] = []
    attacks = 0
    commit = None
    head = os.path.join(root, ".git", "HEAD")
    if os.path.exists(head):
        ref = open(head).read().strip()
        commit = open(os.path.join(root, ".git", ref[5:])).read().strip() if ref.startswith("ref: ") and os.path.exists(os.path.join(root, ".git", ref[5:])) else ref
    for f in sorted(glob.glob(os.path.join(root, "oss", "attacks", "*", "meta.yaml"))):
        try:
            doc = yaml.safe_load(open(f))
        except yaml.YAMLError:
            continue
        for e in doc if isinstance(doc, list) else [doc]:
            if not isinstance(e, dict) or not isinstance(e.get("id"), str):
                continue
            arts = [a for a in e.get("artifacts") or [] if isinstance(a, dict) and a.get("ecosystem") == "npm"]
            if not arts:
                continue
            attacks += 1
            text = " ".join(str(e.get(k) or "") for k in ("title", "synopsis", "story")) + " " + " ".join(map(str, e.get("notes") or []))
            for a in arts:
                name = a.get("package") or a.get("name")
                vs = [str(v) for v in a.get("versions") or [] if isinstance(v, (str, int, float))]
                if isinstance(name, str) and vs:
                    out.append(Claim("sad", e["id"], name, vs, campaign=f"sad:{e['id']}", text=f"{str(e.get('start_date') or '')[:10]}|{text}"))
    return out, {"attacks": attacks, "commit": commit}


def kb_claims(kb_dir: str, replay: str) -> tuple[list[Claim], dict]:
    out: list[Claim] = []
    n = 0
    for f in sorted(glob.glob(os.path.join(kb_dir, "*.yaml"))):
        d = yaml.safe_load(open(f))
        if not isinstance(d, dict) or not isinstance(d.get("id"), str):
            continue
        hit = False
        for a in d.get("affected") or []:
            purl = a.get("purl") if isinstance(a, dict) else None
            if isinstance(purl, str) and purl.startswith("pkg:npm/"):
                body = urllib.parse.unquote(purl[len("pkg:npm/"):]).split("?")[0]
                at = body.find("@", 1)
                name = body if at < 0 else body[:at]
                vs = [str(v) for v in a.get("versions") or []]
                if vs:
                    out.append(Claim("kb", d["id"], name, vs, campaign=f"kb:{d['id']}"))
                    hit = True
        n += hit
    cfg = json.load(open(os.path.join(replay, "incidents.config.json")))
    for inc in cfg["incidents"]:
        for b in inc["bad"]:
            out.append(Claim("replay", inc["id"], b["name"], [b["version"]], campaign=f"replay:{inc['id']}"))
    return out, {"kbIncidents": n, "replayIncidents": len(cfg["incidents"])}


# --- packuments ----------------------------------------------------------------------------------
def load_packument(cache: str, name: str):
    f = os.path.join(cache, name.replace("/", "__", 1) + ".json")
    if not os.path.exists(f):
        return None
    try:
        return json.load(open(f))
    except ValueError:
        return None


def merge_overlay(live: dict | None, over: dict | None) -> dict | None:
    """Same rule as src/features/store.ts mergeOverlay: overlay releases fill gaps, live data wins."""
    if over is None:
        return live
    if live is None:
        return over
    versions = dict(live.get("versions") or {})
    time = dict(live.get("time") or {})
    for v, m in (over.get("versions") or {}).items():
        if v in versions:
            continue
        versions[v] = m
        if v not in time and v in (over.get("time") or {}):
            time[v] = over["time"][v]
    return {**live, "versions": versions, "time": time}


def parse_t(s) -> float | None:
    if not isinstance(s, str):
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


RANK = {"family": 0, "sad": 1, "kb": 2, "replay": 3, "osv-cluster": 4, "osv": 5}


class UF:
    def __init__(self):
        self.p: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # The most curated name represents the campaign: family > sad > kb > replay > clusters > osv.
            if (RANK.get(rb.split(":")[0], 9), rb) < (RANK.get(ra.split(":")[0], 9), ra):
                ra, rb = rb, ra
            self.p[rb] = ra


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["names", "labels"])
    ap.add_argument("--osv-zip", required=True)
    ap.add_argument("--attack-data", required=True)
    ap.add_argument("--root", default=".", help="the blastradius/ directory")
    ap.add_argument("--cache")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-prior", type=int, default=1)
    ap.add_argument("--min-history-days", type=float, default=90.0)
    ap.add_argument("--max-span-days", type=float, default=30.0)
    ap.add_argument("--max-live-stream", type=int, default=10)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    root = os.path.abspath(a.root)
    osv, osv_meta = osv_claims(a.osv_zip)
    sad, sad_meta = sad_claims(a.attack_data)
    kb, kb_meta = kb_claims(os.path.join(root, "kb", "incidents"), os.path.join(root, "test", "replay"))
    claims = osv + sad + kb

    # Every version any source calls bad, and packages that are malicious in every version.
    whole = {c.name for c in claims if c.whole}
    if a.cmd == "names":
        names = sorted({c.name for c in claims if not c.whole})
        with open(os.path.join(a.out, "candidates.txt"), "w") as f:
            f.write("".join(n + "\n" for n in names))
        print(json.dumps({"claims": len(claims), "candidatePackages": len(names), "wholePackageMalware": len(whole)}))
        return 0
    if not a.cache:
        print("labels needs --cache", file=sys.stderr)
        return 2

    dropped: list[dict] = []
    bad: dict[str, dict[str, list[Claim]]] = collections.defaultdict(lambda: collections.defaultdict(list))
    packuments: dict[str, dict | None] = {}
    for c in claims:
        if c.whole:
            continue
        if c.name not in packuments:
            # The replay overlay holds manifests rebuilt from advisories for unpublished releases.
            packuments[c.name] = merge_overlay(load_packument(a.cache, c.name), load_packument(os.path.join(root, "test", "replay", "data", "registry"), c.name))
        p = packuments[c.name]
        vs = set(c.versions)
        if c.ranges and p is not None:
            vs |= {v for v in (p.get("time") or {}) if v not in ("created", "modified", "unpublished") and in_ranges(v, c.ranges)}
        if not vs:
            dropped.append({"name": c.name, "version": None, "source": f"{c.source}:{c.ref}", "reason": "record lists no versions and its ranges match no release"})
        for v in vs:
            bad[c.name][v].append(c)

    known_bad = {n: sorted(vs) for n, vs in bad.items()}
    # Range-like records: drop a claim for a package when its versions span too long.
    for name in list(bad):
        p = packuments.get(name)
        time = (p or {}).get("time") or {}
        per_claim: dict[int, list[float]] = collections.defaultdict(list)
        claim_of: dict[int, Claim] = {}
        for v, cs in bad[name].items():
            t = parse_t(time.get(v))
            for c in cs:
                claim_of[id(c)] = c
                if t is not None:
                    per_claim[id(c)].append(t)
        wide = {cid for cid, ts in per_claim.items() if (max(ts) - min(ts)) / DAY > a.max_span_days}
        if not wide:
            continue
        for v in list(bad[name]):
            keep = [c for c in bad[name][v] if id(c) not in wide]
            if not keep:
                c0 = claim_of[next(id(c) for c in bad[name][v])]
                ts = per_claim[id(c0)]
                dropped.append({"name": name, "version": v, "source": sorted({f"{c.source}:{c.ref}" for c in bad[name][v]}), "reason": f"record covers releases spread over {(max(ts) - min(ts)) / DAY:.0f} days (affected range, not a publish-time compromise)"})
                del bad[name][v]
            else:
                bad[name][v] = keep
        if not bad[name]:
            del bad[name]
    positives: list[dict] = []
    for name in sorted(bad):
        p = packuments.get(name)
        srcs = lambda v: sorted({f"{c.source}:{c.ref}" for c in bad[name][v]})
        if p is None:
            for v in sorted(bad[name]):
                dropped.append({"name": name, "version": v, "source": srcs(v), "reason": "no packument (404 or fetch failed)"})
            continue
        time = p.get("time") or {}
        if isinstance(time.get("unpublished"), dict) and not p.get("versions"):
            for v in sorted(bad[name]):
                dropped.append({"name": name, "version": v, "source": srcs(v), "reason": "package removed from npm entirely (time.unpublished): no release history left"})
            continue
        if name in whole:
            # A curated source (attack data, KB, replay) outranks an OSV record that marks every version.
            for v in sorted(bad[name]):
                if not any(c.source in ("sad", "kb", "replay") for c in bad[name][v]):
                    dropped.append({"name": name, "version": v, "source": srcs(v), "reason": "another record marks every version of the package malicious"})
                    del bad[name][v]
            if not bad[name]:
                continue
        rel = {v: parse_t(t) for v, t in time.items() if v not in ("created", "modified", "unpublished")}
        rel = {v: t for v, t in rel.items() if t is not None}
        badset = set(bad[name])
        bad_times = [rel[v] for v in badset if v in rel]
        first_bad = min(bad_times) if bad_times else None
        for v in sorted(badset):
            if v not in rel:
                dropped.append({"name": name, "version": v, "source": srcs(v), "reason": "bad version has no time entry in the packument"})
                continue
            prior_ok = [u for u, t in rel.items() if t < first_bad and u not in badset]
            first = min(rel.values())
            history = (first_bad - first) / DAY
            if len(prior_ok) < a.min_prior or history < a.min_history_days:
                dropped.append({"name": name, "version": v, "source": srcs(v), "reason": f"not an established package before its first bad release ({len(prior_ok)} clean earlier releases, {history:.0f} days of history; need {a.min_prior} and {a.min_history_days:.0f})"})
                continue
            positives.append({
                "name": name,
                "version": v,
                "publishedAt": time[v],
                "firstBadAt": iso(first_bad),
                "cleanPriorReleases": len([u for u, t in rel.items() if t < rel[v] and u not in badset]),
                "historyDays": round((rel[v] - first) / DAY, 1),
                "manifest": isinstance((p.get("versions") or {}).get(v), dict),
                "sources": srcs(v),
                "_claims": bad[name][v],
            })

    per_pkg = collections.defaultdict(list)
    for r in positives:
        per_pkg[r["name"]].append(r)
    stream = {n for n, rs in per_pkg.items() if len(rs) > a.max_live_stream and sum(r["manifest"] for r in rs) * 2 > len(rs)}
    for r in positives:
        if r["name"] in stream:
            rs = per_pkg[r["name"]]
            dropped.append({"name": r["name"], "version": r["version"], "source": r["sources"], "reason": f"stream of {len(rs)} bad versions, {sum(x['manifest'] for x in rs)} still live on npm (package-level classification, not discrete compromised releases)"})
    positives = [r for r in positives if r["name"] not in stream]

    # --- campaigns -----------------------------------------------------------------------------
    uf = UF()
    sad_text = {c.ref: c.text for c in sad}
    for ref, text in sad_text.items():
        start, _, body = text.partition("|")
        for fam, rx, when in FAMILIES:
            if rx.search(body) and start.startswith(when):
                uf.union(f"family:{fam}", f"sad:{ref}")
                break
    for r in positives:
        keys = sorted({c.campaign for c in r["_claims"] if c.campaign})
        if not keys:
            keys = [f"osv:{c.ref}" for c in r["_claims"]]
        r["_key"] = keys[0]
        for k in keys[1:]:
            uf.union(keys[0], k)
    named = sorted((parse_t(r["publishedAt"]), uf.find(r["_key"])) for r in positives if not uf.find(r["_key"]).startswith("osv:"))
    for (t1, k1), (t2, k2) in zip(named, named[1:]):
        if t2 - t1 <= NAMED_MERGE_HOURS * 3600:
            uf.union(k1, k2)
    # OSV-only releases join the named campaign with the nearest positive within WINDOW_DAYS.
    named = sorted((parse_t(r["publishedAt"]), uf.find(r["_key"])) for r in positives if not uf.find(r["_key"]).startswith("osv:"))
    named_t = [t for t, _ in named]
    loose = []
    import bisect
    for r in positives:
        if not uf.find(r["_key"]).startswith("osv:"):
            continue
        t = parse_t(r["publishedAt"])
        i = bisect.bisect_left(named_t, t)
        near = [(abs(named_t[j] - t), named[j][1]) for j in (i - 1, i) if 0 <= j < len(named_t) and abs(named_t[j] - t) <= WINDOW_DAYS * DAY]
        if near:
            uf.union(min(near)[1], r["_key"])
        else:
            loose.append((t, r))
    loose.sort(key=lambda x: x[0])
    prev_t, start, cur = None, None, None
    for t, r in loose:
        if prev_t is None or t - prev_t > CHAIN_GAP_DAYS * DAY or t - start > CHAIN_MAX_SPAN_DAYS * DAY:
            cur, start = "osv-cluster:" + iso(t)[:10], t
        uf.union(cur, r["_key"])
        prev_t = t
    names_for: dict[str, set[str]] = collections.defaultdict(set)
    for r in positives:
        names_for[uf.find(r["_key"])].add(r["_key"])
    for r in positives:
        k = uf.find(r["_key"])
        r["campaign"] = k.split(":", 1)[1] if k.split(":", 1)[0] in ("family", "sad", "kb", "replay", "osv-cluster") else k
        r["campaignMembers"] = sorted(names_for[k])[:20]
        del r["_claims"], r["_key"]
    positives.sort(key=lambda r: (r["publishedAt"], r["name"], r["version"]))

    with open(os.path.join(a.out, "labels.jsonl"), "w") as f:
        for r in positives:
            f.write(json.dumps({k: v for k, v in r.items() if k != "campaignMembers"}, separators=(",", ":")) + "\n")
    with open(os.path.join(a.out, "known_bad.json"), "w") as f:
        json.dump({"bad": known_bad, "wholePackage": sorted(whole)}, f, separators=(",", ":"))
    by_c = collections.Counter(r["campaign"] for r in positives)
    reasons = collections.Counter(re.sub(r"\d+", "N", d["reason"]) for d in dropped)
    report = {
        "sources": {"osv": {**osv_meta, "licence": LICENCES["osv"], "claims": len(osv)}, "sad": {**sad_meta, "licence": LICENCES["sad"], "claims": len(sad)}, "kb": {**kb_meta, "licence": LICENCES["kb"], "claims": len(kb)}},
        "criteria": {"minCleanPriorReleases": a.min_prior, "minHistoryDays": a.min_history_days, "campaignWindowDays": WINDOW_DAYS, "namedMergeHours": NAMED_MERGE_HOURS, "chainGapDays": CHAIN_GAP_DAYS, "chainMaxSpanDays": CHAIN_MAX_SPAN_DAYS, "maxSpanDays": a.max_span_days, "maxLiveStream": a.max_live_stream},
        "positives": len(positives),
        "positivePackages": len({r["name"] for r in positives}),
        "campaigns": len(by_c),
        "withManifest": sum(r["manifest"] for r in positives),
        "bySource": dict(collections.Counter(src for r in positives for src in {x.split(":")[0] for x in r["sources"]})),
        "byYear": dict(sorted(collections.Counter(r["publishedAt"][:4] for r in positives).items())),
        "byCampaign": {k: {"positives": n, "packages": len({r["name"] for r in positives if r["campaign"] == k}), "first": min(r["publishedAt"] for r in positives if r["campaign"] == k)[:10], "members": next(r["campaignMembers"] for r in positives if r["campaign"] == k)} for k, n in by_c.most_common()},
        "droppedReasons": dict(reasons.most_common()),
        "dropped": dropped,
        "knownBad": {"packages": len(known_bad), "releases": sum(len(v) for v in known_bad.values()), "wholePackageMalware": len(whole)},
    }
    with open(os.path.join(a.out, "labels_report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: report[k] for k in ("positives", "positivePackages", "campaigns", "withManifest", "bySource", "byYear", "droppedReasons")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
