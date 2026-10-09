"""Step 1: list positive candidates (one release per package: the first bad release we can get contents for),
with a category and an incident family per row.

Sources (all real, pinned):
  * DataDog malicious-software-packages-dataset @ DD_COMMIT: samples/npm/compromised_lib (hijacked releases of
    legitimate packages) and samples/npm/malicious_intent (packages published by attackers). Each sample is an
    encrypted zip of the published package plus the registry packument captured at detection.
  * data-ml/model labels (blastradius/pack/model/manifest/labels.jsonl @ 305fad8): campaign per compromised
    release (OSV MAL-*/CWE-506, tstromberg/supplychain-attack-data, incident KB, replay incidents).
    Labelled releases that npm still serves are used with the registry tarball as their content source.
  * OSV npm export (all.zip, sha256 recorded): text of MAL-*/CWE-506 records, used only to name families.

Usage: python -I src/collect_positives.py --dd-clone DIR --osv-zip PATH --labels PATH
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import json
import random
import re
import subprocess
import zipfile

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # -I drops the script dir
from common import DATA, DD_COMMIT, registry_packument, semver_key, sha256_file

PER_FAMILY_DOWNLOAD_QUOTA = 160  # packages per family fetched; split-time caps are applied later
SEED = 20261009

SABOTAGE = {"INC-2022-0001": "sabotage", "node-ipc": "sabotage"}  # colors/faker; node-ipc peacenotwar 2022
HANDOVER = {"event-stream": "handover"}

NEW_MAL_MARKERS = [
    ("tea.xyz", "tea-xyz-token-farming"), ("tea protocol", "tea-xyz-token-farming"),
    ("dependency confusion", "dependency-confusion"), ("dependency-confusion", "dependency-confusion"),
    ("typosquat", "typosquat"), ("starjack", "starjacking"),
    ("wallet", "crypto-theft"), ("crypto", "crypto-theft"),
    ("discord", "discord-token-stealer"), ("reverse shell", "backdoor"),
    ("exfiltrat", "data-exfiltration"), ("credential", "data-exfiltration"), ("beacon", "beacon"),
]


def dd_name(seg: str) -> str:
    return "@" + seg[1:].replace("@", "/", 1) if seg.startswith("@") else seg


def load_dd(clone: str, sub: str) -> list[dict]:
    out = subprocess.run(["git", "-C", clone, "ls-tree", "-r", "--name-only", DD_COMMIT, f"samples/npm/{sub}"],
                         check=True, capture_output=True, text=True).stdout.splitlines()
    rows = []
    for line in out:
        p = line.split("/")
        if len(p) != 6 or not p[5].endswith(".zip"):
            continue
        rows.append({"name": dd_name(p[3]), "version": p[4], "dd_path": line, "dd_date": p[5][:10]})
    (DATA / f"dd_{sub}_list.txt.gz").write_bytes(gzip.compress("\n".join(out).encode() + b"\n", mtime=0))
    return rows


def load_osv(path: str) -> dict[str, list[dict]]:
    by: dict[str, list[dict]] = collections.defaultdict(list)
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if not n.endswith(".json"):
                continue
            rec = json.loads(z.read(n))
            rid = rec.get("id", "")
            cwes = (rec.get("database_specific") or {}).get("cwe_ids") or []
            if not (rid.startswith("MAL-") or "CWE-506" in cwes):
                continue
            text = (rec.get("summary") or "") + " " + (rec.get("details") or "")
            for a in rec.get("affected") or []:
                pk = a.get("package") or {}
                if pk.get("ecosystem") == "npm" and pk.get("name"):
                    by[pk["name"]].append({"id": rid, "text": text.lower()})
    return by


def first_per_package(rows: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for r in rows:
        b = best.get(r["name"])
        if b is None or (r["dd_date"], semver_key(r["version"])) < (b["dd_date"], semver_key(b["version"])):
            best[r["name"]] = r
    return list(best.values())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dd-clone", required=True)
    ap.add_argument("--osv-zip", required=True)
    ap.add_argument("--labels", required=True)
    a = ap.parse_args()
    rng = random.Random(SEED)

    labels = [json.loads(l) for l in open(a.labels)]
    lab = {(x["name"], x["version"]): x for x in labels}
    osv = load_osv(a.osv_zip)

    def family_of_campaign(c: str) -> tuple[str, str]:
        if c in ("shai-hulud-2025-09", "sha1-hulud-second-coming-2025-11"):
            return "shai-hulud", c  # one worm family, two waves
        return c, c

    cands: list[dict] = []

    # (a)/(b)/(c): compromised releases of legitimate packages, DataDog archives.
    comp = first_per_package(load_dd(a.dd_clone, "compromised_lib"))
    mapped_dates: dict[str, list[dt.date]] = collections.defaultdict(list)
    for r in comp:
        x = lab.get((r["name"], r["version"]))
        if x:
            fam, wave = family_of_campaign(x["campaign"])
            r.update(family=fam, wave=wave, family_basis="data-ml campaign", label_sources=x["sources"])
            mapped_dates[fam].append(dt.date.fromisoformat(r["dd_date"]))
    for r in comp:
        if "family" in r:
            continue
        t = " ".join(o["text"] for o in osv.get(r["name"], []))
        ids = sorted({o["id"] for o in osv.get(r["name"], [])})
        if "teampcp" in t or "mini shai-hulud" in t or "canisterworm" in t:
            r.update(family="teampcp-2026", wave="teampcp-2026", family_basis="OSV text marker")
        elif "shai-hulud" in t or "sha1-hulud" in t or "shai hulud" in t:
            r.update(family="shai-hulud", wave="shai-hulud", family_basis="OSV text marker")
        else:
            d = dt.date.fromisoformat(r["dd_date"])
            near = sorted((min(abs((d - x).days) for x in ds), f) for f, ds in mapped_dates.items())
            if near and near[0][0] <= 2:
                r.update(family=near[0][1], wave=near[0][1], family_basis="DataDog discovery date within 2 days of a labelled campaign")
            else:
                r.update(family=f"dd-compromised-{r['dd_date'][:7]}", wave=r["dd_date"], family_basis="DataDog discovery month")
        r["label_sources"] = [f"osv:{i}" for i in ids]
    for r in comp:
        r["category"] = SABOTAGE.get(r["family"]) or HANDOVER.get(r["family"]) or "hijack"
        r["label_sources"] = sorted(set(r.get("label_sources", [])) | {"datadog:compromised_lib"})
        r["content_source"] = "datadog-archive"
    comp_keys = {(r["name"], r["family"]) for r in comp}

    # Labelled compromised releases npm still serves (sabotage, handover and older hijacks live on).
    live = []
    by_pkg = collections.defaultdict(list)
    for x in labels:
        by_pkg[(x["name"], family_of_campaign(x["campaign"])[0])].append(x)
    for (name, _fam), xs in sorted(by_pkg.items()):
        if (name, _fam) in comp_keys:
            continue
        if not any(x.get("manifest") for x in xs):
            continue
        p = registry_packument(name)
        if not p:
            continue
        xs = sorted(xs, key=lambda x: x["publishedAt"])
        ok = [x for x in xs if x["version"] in p["versions"]]
        if not ok:
            continue
        x = ok[0]
        fam, wave = family_of_campaign(x["campaign"])
        live.append({"name": name, "version": x["version"], "dd_path": None, "dd_date": x["publishedAt"][:10],
                     "family": fam, "wave": wave, "family_basis": "data-ml campaign", "label_sources": x["sources"],
                     "category": SABOTAGE.get(fam) or HANDOVER.get(fam) or "hijack", "content_source": "registry-tarball",
                     "first_bad_available": x["version"] == xs[0]["version"]})

    # (d)/(e): packages published by attackers, DataDog archives; family from OSV record text.
    mi = first_per_package(load_dd(a.dd_clone, "malicious_intent"))
    for r in mi:
        t = " ".join(o["text"] for o in osv.get(r["name"], []))
        ids = sorted({o["id"] for o in osv.get(r["name"], [])})
        fam = None
        for k, f in NEW_MAL_MARKERS:
            if k in t:
                fam = f
                break
        basis = "OSV text marker"
        if fam is None:
            m = re.match(r"^(\d+)\.", r["version"])
            if m and int(m.group(1)) >= 50:
                fam, basis = "dependency-confusion", "version-jump heuristic (major >= 50), no OSV text"
            elif ids:
                fam, basis = "unattributed-malicious", "OSV record without campaign text"
            else:
                fam, basis = "unattributed-malicious", "DataDog only"
        r.update(family=fam, wave=fam, family_basis=basis, label_sources=[f"osv:{i}" for i in ids] + ["datadog:malicious_intent"],
                 category="spam" if fam == "tea-xyz-token-farming" else "new_malicious", content_source="datadog-archive")

    # Download quotas per family (seeded sample); split-time caps come later (split.py).
    by_fam = collections.defaultdict(list)
    for r in comp + live + mi:
        by_fam[r["family"]].append(r)
    for fam, rs in sorted(by_fam.items()):
        rs.sort(key=lambda r: (r["name"], r["version"]))
        rng.shuffle(rs)
        cands.extend(rs[:PER_FAMILY_DOWNLOAD_QUOTA])
    cands.sort(key=lambda r: (r["family"], r["name"]))
    with open(DATA / "positive_candidates.jsonl", "w") as f:
        for r in cands:
            r["label"] = 1
            f.write(json.dumps(r, sort_keys=True) + "\n")
    summary = {
        "dd_commit": DD_COMMIT,
        "osv_zip_sha256": sha256_file(__import__("pathlib").Path(a.osv_zip)),
        "labels_sha256": sha256_file(__import__("pathlib").Path(a.labels)),
        "available_packages_per_family": {f: len(rs) for f, rs in sorted(by_fam.items())},
        "selected_per_family": dict(sorted(collections.Counter(r["family"] for r in cands).items())),
        "selected_per_category": dict(sorted(collections.Counter(r["category"] for r in cands).items())),
    }
    (DATA / "positive_candidates.summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
