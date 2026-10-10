"""Step 2: list negative candidates: real releases of real packages, from the same months as the positives.

Package pools (names only; every release comes from the live npm registry):
  * established: data-ml/model universe lists @ 305fad8 (universe-negatives.txt: popular and long-tail packages;
    universe-hammer.txt: every package in five large real lockfiles, which brings monorepo families such as
    @babel/*, @types/* and bot/CI-published packages).
  * new: packages found through the npm search API for generic topic words, keeping those whose first release
    falls in the dataset window, so first releases of new packages appear in both classes.
Names listed as malicious anywhere we know (OSV MAL-*/CWE-506, DataDog, data-ml labels) are excluded.

Per month, negatives are drawn so the month mix follows the positives (NEG_PER_POS x positives, at least
FLOOR per month), 40 % from first releases of new packages and 60 % from other releases.

Usage: python -I src/collect_negatives.py --labels PATH --universe-dir DIR --osv-zip PATH
       python -I src/collect_negatives.py --extend --labels PATH --universe-dir DIR --osv-zip PATH

--extend (v2, 2026-10-10 deviation in PREREGISTRATION.md): keeps every row of the existing
data/negative_candidates.jsonl (batch v1) and adds batch v2, drawn by exactly the same rules (same pools and
exclusions, same months, 40 % first releases, at most 2 releases of one package per month) from packages that v1
did not use, with larger per-month targets: per split window W, target(m) = max(FLOOR, round(V2_TOTAL[W] *
positives(m) / positives(W))), so the month mix still follows the positives. V2_TOTAL is sized so that, after
the package/account grouping in split.py drops rows, every split keeps >= 5 benign per malicious release and calib
keeps >= 2,000 benign (the 10-per-1,000 threshold then rests on >= 20 benign alerts).
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import random
import sys
import pathlib
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import CACHE, DATA, REGISTRY, cache_path, http_get, read_json_gz, registry_packument, write_json_gz

SEED = 20261009
NEG_PER_POS = 5
FLOOR = 40
FIRST_RELEASE_SHARE = 0.4
N_ESTABLISHED = 1100
N_NEW = 2600
SEARCH_TERMS = """react vue angular svelte next nuxt vite webpack rollup esbuild babel eslint prettier typescript jest
vitest mocha cli tool util utils helper sdk api client server express fastify koa nestjs graphql prisma orm database
mongodb postgres redis queue logger logging config env dotenv auth jwt oauth crypto hash uuid date time format parse
markdown yaml json csv xml http fetch axios request websocket socket stream file fs path image svg icon icons ui
components design-system tailwind css sass theme chart map game bot discord telegram slack ai llm openai agent mcp
langchain embedding vector chat plugin preset template starter boilerplate monorepo workspace test mock lint
github action deploy docker aws azure gcp cloud firebase supabase stripe payment email sms pdf excel i18n locale
validation schema zod form router state store hooks animation editor wasm native electron mobile""".split()


def search(term: str, frm: int) -> list[dict]:
    cp = cache_path("search", f"{term}-{frm}")
    if cp.exists():
        return read_json_gz(cp)
    raw = http_get(f"{REGISTRY}/-/v1/search?text={urllib.parse.quote(term)}&size=250&from={frm}")
    objs = json.loads(raw)["objects"] if raw else []
    res = [{"name": o["package"]["name"], "date": o["package"].get("date")} for o in objs]
    write_json_gz(cp, res)
    return res


def known_bad(labels_path: str, osv_zip: str) -> set[str]:
    bad = {json.loads(l)["name"] for l in open(labels_path)}
    for sub in ("compromised_lib", "malicious_intent"):
        for line in gzip.decompress((DATA / f"dd_{sub}_list.txt.gz").read_bytes()).decode().splitlines():
            p = line.split("/")
            if len(p) == 6:
                bad.add("@" + p[3][1:].replace("@", "/", 1) if p[3].startswith("@") else p[3])
    with zipfile.ZipFile(osv_zip) as z:
        for n in z.namelist():
            rec = json.loads(z.read(n))
            cwes = (rec.get("database_specific") or {}).get("cwe_ids") or []
            if rec.get("id", "").startswith("MAL-") or "CWE-506" in cwes:
                for a in rec.get("affected") or []:
                    if (a.get("package") or {}).get("ecosystem") == "npm":
                        bad.add(a["package"]["name"])
    return bad


# v2 extension (see module docstring). Windows match split.py's defaults.
CALIB_START, TEST_START = "2025-10-01", "2026-03-01"
V2_TOTAL = {"train": 4000, "calib": 5000, "test": 6500}
N_ESTABLISHED_V2 = 10_000  # i.e. every established name v1 did not draw
N_NEW_V2 = 16_000
SEED_V2 = 20261010


def window_of(month: str) -> str:
    d = month + "-01"
    return "train" if d < CALIB_START else ("calib" if d < TEST_START else "test")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--universe-dir", required=True)
    ap.add_argument("--osv-zip", required=True)
    ap.add_argument("--extend", action="store_true", help="keep data/negative_candidates.jsonl (v1) and add batch v2")
    a = ap.parse_args()
    if a.extend:
        return extend(a)
    rng = random.Random(SEED)

    pos = [json.loads(l) for l in open(DATA / "positive_candidates.jsonl")]
    pos_month = collections.Counter(p["dd_date"][:7] for p in pos)
    months = sorted(pos_month)
    lo, hi = months[0], months[-1]
    # Every month from 2024-06 to the last positive month gets at least FLOOR negatives; older positive months too.
    all_months = sorted(set(months) | {f"{y}-{m:02d}" for y in range(2024, 2027) for m in range(1, 13)
                                       if "2024-06" <= f"{y}-{m:02d}" <= hi})
    target = {m: max(FLOOR, NEG_PER_POS * pos_month.get(m, 0)) for m in all_months}

    bad = known_bad(a.labels, a.osv_zip)
    ud = pathlib.Path(a.universe_dir)
    established = sorted({l.strip() for f in ("universe-negatives.txt", "universe-hammer.txt")
                          for l in open(ud / f) if l.strip() and not l.startswith("#")} - bad)
    found = set()
    for t in SEARCH_TERMS:
        for frm in (0, 250, 500, 750):
            found.update(r["name"] for r in search(t, frm))
    new_pool = sorted(found - bad - set(established))
    rng.shuffle(established)
    rng.shuffle(new_pool)
    est_names, new_names = established[:N_ESTABLISHED], new_pool[:N_NEW]
    print(f"bad names {len(bad)}; established {len(established)} -> {len(est_names)}; search {len(new_pool)} -> {len(new_names)}", flush=True)

    def load(n):
        try:
            return n, registry_packument(n)
        except Exception as e:
            print("ERR", n, str(e)[:120], flush=True)
            return n, None

    with ThreadPoolExecutor(12) as ex:
        packs = dict(ex.map(load, est_names + new_names))

    est_set = set(est_names)
    first_pool = collections.defaultdict(list)
    other_pool = collections.defaultdict(list)
    for n, p in packs.items():
        if not p:
            continue
        t = {v: ts for v, ts in p["time"].items() if v not in ("created", "modified") and v in p["versions"]}
        if not t:
            continue
        order = sorted(t, key=lambda v: t[v])
        first = order[0]
        for v in order:
            m = t[v][:7]
            if m not in target:
                continue
            item = {"name": n, "version": v, "month": m, "pool": "established" if n in est_set else "search", "first": v == first}
            (first_pool if v == first else other_pool)[m].append(item)

    chosen = []
    used = collections.Counter()
    for m in all_months:
        k_first = int(round(target[m] * FIRST_RELEASE_SHARE))
        fp = sorted(first_pool[m], key=lambda x: (x["name"], x["version"]))
        rng.shuffle(fp)
        pick = fp[:k_first]
        op = sorted(other_pool[m], key=lambda x: (x["name"], x["version"]))
        rng.shuffle(op)
        rest = []
        for it in op:  # at most 2 releases of one package per month keeps one big monorepo from dominating
            if len(rest) >= target[m] - len(pick):
                break
            if used[(it["name"], m)] >= 2:
                continue
            used[(it["name"], m)] += 1
            rest.append(it)
        chosen += pick + rest
    with open(DATA / "negative_candidates.jsonl", "w") as f:
        for c in sorted(chosen, key=lambda x: (x["month"], x["name"], x["version"])):
            f.write(json.dumps({"name": c["name"], "version": c["version"], "label": 0, "category": "benign",
                                "family": "benign", "wave": "benign", "neg_pool": c["pool"], "dd_date": c["month"] + "-01",
                                "content_source": "registry-tarball", "dd_path": None}, sort_keys=True) + "\n")
    summ = {"targets": target, "chosen_per_month": dict(sorted(collections.Counter(c["month"] for c in chosen).items())),
            "chosen_first_release": sum(1 for c in chosen if c["first"]),
            "chosen_per_pool": dict(collections.Counter(c["pool"] for c in chosen)), "total": len(chosen),
            "packuments_ok": sum(1 for p in packs.values() if p), "search_terms": len(SEARCH_TERMS)}
    (DATA / "negative_candidates.summary.json").write_text(json.dumps(summ, indent=1) + "\n")
    print(json.dumps({k: v for k, v in summ.items() if k != "targets"}, indent=1))


def draw(packs: dict, target: dict, est_set: set, rng: random.Random) -> list[dict]:
    """The v1 per-month draw (first releases share, at most 2 releases of one package per month)."""
    first_pool = collections.defaultdict(list)
    other_pool = collections.defaultdict(list)
    for n, p in packs.items():
        if not p:
            continue
        t = {v: ts for v, ts in p["time"].items() if v not in ("created", "modified") and v in p["versions"]}
        if not t:
            continue
        order = sorted(t, key=lambda v: t[v])
        first = order[0]
        for v in order:
            m = t[v][:7]
            if m not in target:
                continue
            item = {"name": n, "version": v, "month": m, "pool": "established" if n in est_set else "search", "first": v == first}
            (first_pool if v == first else other_pool)[m].append(item)
    chosen = []
    used = collections.Counter()
    for m in sorted(target):
        k_first = int(round(target[m] * FIRST_RELEASE_SHARE))
        fp = sorted(first_pool[m], key=lambda x: (x["name"], x["version"]))
        rng.shuffle(fp)
        pick = fp[:k_first]
        op = sorted(other_pool[m], key=lambda x: (x["name"], x["version"]))
        rng.shuffle(op)
        rest = []
        for it in op:
            if len(rest) >= target[m] - len(pick):
                break
            if used[(it["name"], m)] >= 2:
                continue
            used[(it["name"], m)] += 1
            rest.append(it)
        chosen += pick + rest
    return chosen


def extend(a) -> None:
    rng = random.Random(SEED_V2)
    v1 = [json.loads(l) for l in open(DATA / "negative_candidates.jsonl")]
    v1 = [dict(r, neg_batch=r.get("neg_batch", "v1")) for r in v1 if r.get("neg_batch", "v1") == "v1"]
    v1_names = {r["name"] for r in v1}
    pos = [json.loads(l) for l in open(DATA / "positive_candidates.jsonl")]
    pos_month = collections.Counter(p["dd_date"][:7] for p in pos)
    v1_months = sorted({r["month"] if "month" in r else r["dd_date"][:7] for r in v1})
    months = sorted(set(v1_months) | set(pos_month))
    pos_win = collections.Counter()
    for m in months:
        pos_win[window_of(m)] += pos_month.get(m, 0)
    target = {m: max(FLOOR, int(round(V2_TOTAL[window_of(m)] * pos_month.get(m, 0) / max(1, pos_win[window_of(m)]))))
              for m in months}

    bad = known_bad(a.labels, a.osv_zip)
    ud = pathlib.Path(a.universe_dir)
    established = sorted({l.strip() for f in ("universe-negatives.txt", "universe-hammer.txt")
                          for l in open(ud / f) if l.strip() and not l.startswith("#")} - bad - v1_names)
    found = set()
    for t in SEARCH_TERMS:
        for frm in (0, 250, 500, 750):
            found.update(r["name"] for r in search(t, frm))
    new_pool = sorted(found - bad - set(established) - v1_names)
    rng.shuffle(established)
    rng.shuffle(new_pool)
    est_names, new_names = established[:N_ESTABLISHED_V2], new_pool[:N_NEW_V2]
    print(f"v1 rows {len(v1)}; bad names {len(bad)}; established {len(established)} -> {len(est_names)}; "
          f"search {len(new_pool)} -> {len(new_names)}", flush=True)

    def load(n):
        try:
            return n, registry_packument(n)
        except Exception as e:
            print("ERR", n, str(e)[:120], flush=True)
            return n, None

    with ThreadPoolExecutor(16) as ex:
        packs = dict(ex.map(load, est_names + new_names))
    chosen = draw(packs, target, set(est_names), rng)
    rows = list(v1)
    for c in chosen:
        rows.append({"name": c["name"], "version": c["version"], "label": 0, "category": "benign", "family": "benign",
                     "wave": "benign", "neg_pool": c["pool"], "dd_date": c["month"] + "-01",
                     "content_source": "registry-tarball", "dd_path": None, "neg_batch": "v2"})
    with open(DATA / "negative_candidates.jsonl", "w") as f:
        for r in sorted(rows, key=lambda x: (x["dd_date"], x["name"], x["version"])):
            f.write(json.dumps(r, sort_keys=True) + "\n")
    summ = json.loads((DATA / "negative_candidates.summary.json").read_text())
    summ = {k: v for k, v in summ.items() if not k.startswith("v2_")}
    summ.update({
        "v2_targets": target, "v2_total_by_window": V2_TOTAL, "v2_seed": SEED_V2,
        "v2_chosen_per_month": dict(sorted(collections.Counter(c["month"] for c in chosen).items())),
        "v2_chosen_per_window": dict(collections.Counter(window_of(c["month"]) for c in chosen)),
        "v2_chosen_first_release": sum(1 for c in chosen if c["first"]),
        "v2_chosen_per_pool": dict(collections.Counter(c["pool"] for c in chosen)), "v2_total": len(chosen),
        "v2_packuments_ok": sum(1 for p in packs.values() if p), "v2_names_loaded": len(packs),
        "total_v1_plus_v2": len(rows)})
    (DATA / "negative_candidates.summary.json").write_text(json.dumps(summ, indent=1) + "\n")
    print(json.dumps({k: v for k, v in summ.items() if k.startswith("v2_") and k != "v2_targets"}, indent=1))


if __name__ == "__main__":
    main()
