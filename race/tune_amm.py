"""Choose how AMM runs in the race: compare budget schedules on instances the race does not show.

    python race/tune_amm.py [--instances 6-15] [--jobs 10]

The race (race/record.py) shows instances 1-5. Here every competitor and every AMM variant runs
the same races on instances 6-15 (HCMA from the COCO archive, which has runs on instances 1-15),
with the race's rules: the same harness, budget 1000 x D, the first to f - f_opt <= 1e-8 wins,
and when nobody gets there the lowest final value wins. The variant with the most wins is
then recorded on instances 1-5; nothing here looks at those instances.

Every variant is the published amm-optimizer 0.3.0 with the c46 preset; they differ only in
how the budget is handed to it (see AMM in record.py). Results: race/tuning/results.json.
"""

from __future__ import annotations

import argparse
import functools
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import record as R  # noqa: E402

VARIANTS = {
    "c46": {},
    "grid_warm": {"schedule": (10, 30, 100, 300)},
    "grid_cold": {"schedule": (10, 30, 100, 300), "warm": False},
    "lead5_warm": {"schedule": (5, 10, 30, 100, 300)},
    "x2_warm": {"schedule": (10, 20, 40, 80, 160, 320)},
    "short_warm": {"schedule": (10, 30, 100)},
    "tiny_then_full": {"schedule": (10,)},
    # round 2 (after round 1 on the same instances): keep more budget for the last run
    "lead5_cold": {"schedule": (5, 10, 30, 100, 300), "warm": False},
    "lead5_to100": {"schedule": (5, 10, 30, 100)},
    "lead5_to100_cold": {"schedule": (5, 10, 30, 100), "warm": False},
    "lead5_to30": {"schedule": (5, 10, 30)},
    "lead3_warm": {"schedule": (3, 5, 10, 30, 100, 300)},
    "lead5_x3": {"schedule": (5, 15, 50, 150)},
    "lead5_x3_cold": {"schedule": (5, 15, 50, 150), "warm": False},
}
ROUND1 = ["c46", "grid_warm", "grid_cold", "lead5_warm", "x2_warm", "short_warm", "tiny_then_full"]
COMPETITORS = ["slsqp", "hcma", "nelder_mead", "cma_bipop", "ngopt"]
TRIO = ["slsqp", "hcma"]
OUT = HERE / "tuning"


def outcome(regrets, evals=None) -> dict:
    r = np.minimum.accumulate(np.asarray(regrets, dtype=float))
    t = np.arange(1, len(r) + 1) if evals is None else np.asarray(evals)
    hit = np.flatnonzero(r <= R.FINISH)
    return {"finish": int(t[hit[0]]) if len(hit) else None, "best": float(r[-1]) if len(r) else float("inf")}


def worker(functions: list[int], instances: list[int], part: Path, only: list[str] | None) -> None:
    hcma = R.HCMAArchive(None)
    for name, opts in VARIANTS.items():
        R.SOLVERS[f"amm:{name}"] = functools.partial(R.AMM, **opts)
    with part.open("w", encoding="utf-8") as out:
        for f in functions:
            for k in instances:
                problem = R.bbob(f, k)
                fopt = round(float(R.landscape(problem, 3)["f_opt"]), 2)
                row = {"f": f, "k": k}
                names = [f"amm:{v}" for v in only] if only else                     [n for n in COMPETITORS if n != "hcma"] + [f"amm:{v}" for v in ROUND1]
                for name in names:
                    rec = R.run(name, problem, fopt, k)
                    row[name] = outcome(np.asarray(rec.values) - fopt)
                if not only:
                    h = hcma.run(f, k)
                    if abs(h["fopt"] - fopt) > 1e-9:
                        raise SystemExit(f"f{f} i{k}: archive f_opt {h['fopt']} != {fopt}")
                    row["hcma"] = outcome(h["r"], h["t"])
                out.write(json.dumps(row) + "\n")
                out.flush()
                print(f"f{f} i{k} done", flush=True)


def winners(row: dict, field: list[str]) -> set[str]:
    fin = {n: row[n]["finish"] for n in field if row[n]["finish"] is not None}
    if fin:
        first = min(fin.values())
        return {n for n, v in fin.items() if v == first}
    best = min(row[n]["best"] for n in field)
    return {n for n in field if row[n]["best"] == best}


def report(rows: list[dict]) -> dict:
    summary = {}
    for v in VARIANTS:
        a = f"amm:{v}"
        trio = [winners(r, [a] + TRIO) for r in rows]
        full = [winners(r, [a] + COMPETITORS) for r in rows]
        summary[v] = {
            "trio_wins": sum(a in w for w in trio),
            "trio_sole": sum(w == {a} for w in trio),
            "field_wins": sum(a in w for w in full),
            "finished": sum(r[a]["finish"] is not None for r in rows),
            "median_finish": float(np.median([r[a]["finish"] for r in rows if r[a]["finish"] is not None])),
            **{f"beats_{c}": sum(a in winners(r, [a, c]) for r in rows) for c in COMPETITORS},
        }
    n = len(rows)
    print(f"{n} races (24 functions x instances {sorted({r['k'] for r in rows})})")
    cols = ["trio_wins", "trio_sole", "field_wins", "finished", "median_finish"] + [f"beats_{c}" for c in COMPETITORS]
    print(f"{'variant':16s}" + "".join(f"{c.replace('beats_', 'vs '):>14s}" for c in cols))
    for v, s in summary.items():
        print(f"{v:16s}" + "".join(f"{s[c]:>14}" for c in cols))
    trio_others = {c: sum(c in winners(r, ["amm:c46"] + TRIO) for r in rows) for c in TRIO}
    print("trio wins of the others against plain c46:", trio_others)
    return summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--instances", default="6-15")
    ap.add_argument("--functions", default="1-24")
    ap.add_argument("--jobs", type=int, default=10)
    ap.add_argument("--worker", help=argparse.SUPPRESS)
    ap.add_argument("--report", action="store_true", help="only summarise the parts already written")
    ap.add_argument("--variants", help="run only these AMM variants (comma-separated), merged by race")
    ap.add_argument("--tag", default="", help="part file tag for --variants runs")
    a = ap.parse_args(argv)
    instances, functions = R.ids(a.instances), R.ids(a.functions)
    OUT.mkdir(exist_ok=True)
    only = a.variants.split(",") if a.variants else None
    if a.worker:
        worker(functions, instances, OUT / f"part{a.tag}_{a.worker}.jsonl", only)
        return 0
    if not a.report:
        chunks = [functions[i::a.jobs] for i in range(a.jobs)]
        procs = [subprocess.Popen([sys.executable, __file__, "--worker", str(i), "--instances", a.instances,
                                   "--functions", ",".join(map(str, c)), "--tag", a.tag]
                                  + (["--variants", a.variants] if a.variants else []), stdout=subprocess.DEVNULL)
                 for i, c in enumerate(chunks) if c]
        if any(p.wait() for p in procs):
            print("a worker failed")
            return 1
    merged: dict = {}
    for p in sorted(OUT.glob("part*.jsonl")):
        for ln in p.read_text().splitlines():
            if ln:
                r = json.loads(ln)
                merged.setdefault((r["f"], r["k"]), {}).update(r)
    rows = [r for r in merged.values() if all(f"amm:{v}" in r for v in VARIANTS) and "hcma" in r]
    if len(rows) < len(merged):
        print(f"({len(merged) - len(rows)} races lack some variant; reported on the {len(rows)} complete ones)")
    summary = report(rows)
    (OUT / "results.json").write_text(json.dumps({"variants": {k: {kk: list(vv) if isinstance(vv, tuple) else vv
                                                                   for kk, vv in v.items()} for k, v in VARIANTS.items()},
                                                  "summary": summary, "rows": rows}, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
