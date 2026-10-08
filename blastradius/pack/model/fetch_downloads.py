"""Fetch daily npm download counts (api.npmjs.org/downloads/range) for the windows features need.

    python pack/model/fetch_downloads.py --requests requests.jsonl --out .cache/downloads

requests.jsonl has one {"name", "releasedAt"} per row (the dataset's requests). For each release
the features read the ~13 weeks before it (src/features/downloads.ts), so whole UTC calendar years
covering [release - 100 d, release] are fetched: unscoped packages in bulk (128 per request, the
API's limit, one year at most), scoped packages one by one (bulk does not take them). Each package
is stored as {"name", "from": "YYYY-01-01", "counts": [...]} with null for every day not fetched or
not covered (the API starts on 2015-01-10). The API's history is historical, so a value for 2019
is what npm counted in 2019, not today's.

Polite: at most --workers requests in flight, request starts at least --interval seconds apart
across workers, backoff on 429/5xx. Existing
years are kept (cache file per package plus <out>/_years.json listing fetched years). Failures go
to <out>/_failures.json.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.npmjs.org/downloads/range/"
FIRST_DAY = dt.date(2015, 1, 10)
LOOKBACK_DAYS = 100


def series_file(out: str, name: str) -> str:
    return os.path.join(out, name.replace("/", "__", 1) + ".json")


def get(url: str, interval: float, state: dict, retries: int = 5):
    delay = 4.0
    for attempt in range(retries):
        with state["lock"]:
            now = time.monotonic()
            at = max(now, state.get("next", 0.0))
            state["next"] = at + interval
        if at > now:
            time.sleep(at - now)
        try:
            req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "blastradius-bootstrap"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r), None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, "404"
            err = f"HTTP {e.code}"
            if e.code not in (429, 500, 502, 503, 504):
                return None, err
        except Exception as e:  # network errors: retry
            err = type(e).__name__
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    return None, err


def merge(out: str, name: str, year: int, days: list[dict]) -> None:
    path = series_file(out, name)
    cur = json.load(open(path)) if os.path.exists(path) else None
    counts: dict[str, int] = {}
    if cur:
        d0 = dt.date.fromisoformat(cur["from"])
        for i, c in enumerate(cur["counts"]):
            if c is not None:
                counts[(d0 + dt.timedelta(days=i)).isoformat()] = c
    for x in days:
        if isinstance(x, dict) and isinstance(x.get("day"), str) and isinstance(x.get("downloads"), int):
            counts[x["day"]] = x["downloads"]
    if not counts:
        return
    first = dt.date.fromisoformat(min(counts))
    first = dt.date(first.year, 1, 1)
    last = dt.date.fromisoformat(max(counts))
    n = (last - first).days + 1
    arr = [counts.get((first + dt.timedelta(days=i)).isoformat()) for i in range(n)]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"name": name, "from": first.isoformat(), "counts": arr}, f, separators=(",", ":"))
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--requests", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--interval", type=float, default=0.25)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    today = dt.datetime.now(dt.timezone.utc).date()
    need: dict[str, set[int]] = collections.defaultdict(set)
    for line in open(a.requests):
        if not line.strip():
            continue
        r = json.loads(line)
        t = r.get("releasedAt")
        if not isinstance(t, str):
            continue
        d = dt.date.fromisoformat(t[:10])
        lo = max(d - dt.timedelta(days=LOOKBACK_DAYS), FIRST_DAY)
        if lo > d:
            continue
        for y in range(lo.year, d.year + 1):
            need[r["name"]].add(y)
    years_path = os.path.join(a.out, "_years.json")
    have: dict[str, list[int]] = json.load(open(years_path)) if os.path.exists(years_path) else {}
    fail_path = os.path.join(a.out, "_failures.json")
    failures: dict[str, str] = json.load(open(fail_path)) if os.path.exists(fail_path) else {}
    todo = {n: sorted(ys - set(have.get(n, []))) for n, ys in need.items()}
    todo = {n: ys for n, ys in todo.items() if ys}
    state: dict = {"lock": threading.Lock()}
    merge_lock = threading.Lock()
    done = 0

    def span(y: int) -> str:
        s = max(dt.date(y, 1, 1), FIRST_DAY)
        e = min(dt.date(y, 12, 31), today - dt.timedelta(days=1))
        return f"{s.isoformat()}:{e.isoformat()}"

    def mark(n: str, y: int) -> None:
        have.setdefault(n, [])
        if y not in have[n]:
            have[n].append(y)

    # Unscoped: bulk per year.
    by_year: dict[int, list[str]] = collections.defaultdict(list)
    for n, ys in todo.items():
        if not n.startswith("@"):
            for y in ys:
                by_year[y].append(n)
    for y, names in sorted(by_year.items()):
        for i in range(0, len(names), 128):
            chunk = sorted(names[i : i + 128])
            data, err = get(API + span(y) + "/" + ",".join(urllib.parse.quote(n, safe="") for n in chunk), a.interval, state)
            if data is not None and len(chunk) == 1:
                data = {chunk[0]: data}
            for n in chunk:
                if err:
                    failures[f"{n}@{y}"] = err
                    continue
                v = (data or {}).get(n)
                if isinstance(v, dict):
                    merge(a.out, n, y, v.get("downloads") or [])
                    failures.pop(f"{n}@{y}", None)
                else:
                    failures[f"{n}@{y}"] = "no data"
                mark(n, y)
            done += 1
            if done % 20 == 0:
                print(f"bulk {done}", file=sys.stderr)
                json.dump(have, open(years_path, "w"))
    # Scoped: one by one (a package's years in one task, so its file is written by one thread).
    def one(n: str, ys: list[int]):
        res = []
        for y in ys:
            data, err = get(API + span(y) + "/" + urllib.parse.quote(n, safe="@"), a.interval, state)
            if not err and isinstance(data, dict):
                merge(a.out, n, y, data.get("downloads") or [])
            res.append((y, err))
        return n, res

    scoped = sorted((n, ys) for n, ys in todo.items() if n.startswith("@"))
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for fut in cf.as_completed([ex.submit(one, n, ys) for n, ys in scoped]):
            n, res = fut.result()
            with merge_lock:
                for y, err in res:
                    if err:
                        failures[f"{n}@{y}"] = err
                        if err != "404":
                            continue
                    else:
                        failures.pop(f"{n}@{y}", None)
                    mark(n, y)
                done += 1
                if done % 200 == 0:
                    print(f"single {done}/{len(scoped)}", file=sys.stderr)
                    json.dump(have, open(years_path, "w"))
    json.dump(have, open(years_path, "w"))
    with open(fail_path, "w") as f:
        json.dump(failures, f, indent=1, sort_keys=True)
    print(json.dumps({"packages": len(need), "fetchedPackages": len(todo), "failures": len(failures)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
