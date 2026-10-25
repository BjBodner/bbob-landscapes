"""Experiment: AMM's anytime mode ("replay") in the race, with seed selection but no budget tuning.

    PYTHONPATH=<research main>/src python race/replay_exp.py [--seeds 100] [--jobs 14]
    python race/replay_exp.py --report

AMM is c46 with variant.anytime="replay" (the research main's src/amm_optimizer, which has the
mode; c46 itself is unchanged, config hash 2153948ebed51150). It is given the race budget once,
with no budget chosen per function: the mode plans 10 x D, then doubles the plan as the run goes
on. Per shown race (instances 1-5) AMM's best of N seeds is kept, as for the live race: the
earliest to 1e-8, else the lowest final value; runs reaching 1e-8 in fewer than 4 evaluations
are discarded; later seeds stop at the best evaluation count so far. Seed 0 is also kept on its
own (one run, no selection). Nothing in race/data changes. Results: race/tuning/replay/.
"""

from __future__ import annotations

import argparse
import json
import statistics as st
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import joint_opt as J  # noqa: E402
import record as R  # noqa: E402
import sweep_report as S  # noqa: E402

OUT = HERE / "tuning" / "replay"
MIN_EVALS = J.MIN_EVALS


class AMMReplay(R.AMM):
    def __init__(self) -> None:
        super().__init__()
        import amm_optimizer

        self.config = amm_optimizer.presets.with_changes("c46", anytime="replay")


def run_capped(problem, fopt, k, rep, cap):
    import contextlib
    import os
    import warnings

    import numpy as np

    solver = AMMReplay()
    rec = J.Capped(problem, fopt, solver.penalty, cap)
    entropy = [R.SEED_NAMESPACE, k, problem.id_function, R.DIM, k] + ([rep] if rep else [])
    solver.begin(np.random.SeedSequence(entropy))
    restarts = 0
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        while not rec.done and restarts < R.MAX_RESTARTS:
            x0 = rec.lower + (rec.upper - rec.lower) * solver.start_rng.rand(R.DIM)
            with contextlib.suppress(R.Stop):
                solver.solve(rec, x0, R.BUDGET - len(rec.values))
            restarts += 1
    r = np.minimum.accumulate(np.asarray(rec.values) - fopt)
    hit = np.flatnonzero(r <= R.FINISH)
    return {"finish": int(hit[0]) + 1 if len(hit) else None, "best": float(r[-1])}


def worker(pairs, seeds, part: Path) -> None:
    import amm_optimizer

    assert hasattr(amm_optimizer.presets, "with_changes") and \
        amm_optimizer.presets.with_changes("c46", anytime="replay").variant.anytime == "replay"
    with part.open("w", encoding="utf-8") as out:
        for f, k in pairs:
            problem = R.bbob(f, k)
            fopt = round(float(R.landscape(problem, 3)["f_opt"]), 2)
            best, single = None, None
            for rep in range(seeds):
                cap = best[0] - 1 if best and best[0] < 10**9 else R.BUDGET
                o = run_capped(problem, fopt, k, rep, cap)
                if rep == 0:
                    single = o
                if o["finish"] is not None and o["finish"] < MIN_EVALS:
                    continue
                if o["finish"] is None and cap < R.BUDGET:
                    continue
                cand = (o["finish"] if o["finish"] is not None else 10**9, o["best"], rep)
                if best is None or cand[:2] < best[:2]:
                    best = cand
            out.write(json.dumps({"f": f, "k": k, "single": single,
                                  "best_of": {"rep": best[2], "finish": best[0] if best[0] < 10**9 else None,
                                              "best": best[1]}}) + "\n")
            out.flush()


def report() -> None:
    races, _ = S.load()
    rows = {}
    for p in sorted(OUT.glob("part_*.jsonl")):
        for ln in p.read_text().splitlines():
            if ln:
                r = json.loads(ln)
                rows[(r["f"], r["k"])] = r
    shown = [(f, k) for f in range(1, 25) for k in range(1, 6)]
    versions = {
        "current (budget + seed)": lambda kk: races[kk]["amm"],
        "replay + seed": lambda kk: rows[kk]["best_of"],
        "replay, one run": lambda kk: rows[kk]["single"],
    }
    lines = ["## Wins over the 120 shown races", "",
             "| AMM version | wins vs SLSQP + HCMA (ties count for each) | SLSQP | HCMA | wins vs all five | reaches 1e-8 |",
             "|---|---|---|---|---|---|"]
    for name, fn in versions.items():
        w = {"amm": 0, "slsqp": 0, "hcma": 0}
        for kk in shown:
            for x in S.first({"amm": fn(kk), "slsqp": races[kk]["slsqp"], "hcma": races[kk]["hcma"]}):
                w[x] += 1
        lines.append(f"| {name} | {w['amm']} | {w['slsqp']} | {w['hcma']} | "
                     f"{S.wins(races, shown, fn, S.COMP)} | {sum(fn(kk)['finish'] is not None for kk in shown)} |")
    spec = json.loads((HERE / "tuning" / "per_function_budget.json").read_text())["per_function"]
    lines += ["", "## Median evaluations to 1e-8 over the 5 shown instances, and AMM wins of 5 vs all five", "",
              "| f | current: budget | current | wins | replay + seed | wins | replay, one run | wins | SLSQP | HCMA | Nelder-Mead | CMA-BIPOP | NGOpt |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for f in range(1, 25):
        keys = [(f, k) for k in range(1, 6)]
        cells = [f"f{f}", str(spec[str(f)].get("told", "schedule"))]
        for name, fn in versions.items():
            cells += [S.med([fn(kk)["finish"] for kk in keys]), str(S.wins(races, keys, fn, S.COMP))]
        cells += [S.med([races[kk][c]["finish"] for kk in keys]) for c in S.COMP]
        lines.append("| " + " | ".join(cells) + " |")
    text = "\n".join(lines) + "\n"
    (OUT / "comparison.md").write_text(text, encoding="utf-8")
    print(text)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seeds", type=int, default=100)
    ap.add_argument("--jobs", type=int, default=14)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--worker", help=argparse.SUPPRESS)
    ap.add_argument("--pairs", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    if a.worker:
        worker([tuple(map(int, p.split("_"))) for p in a.pairs.split(",")], a.seeds, OUT / f"part_{a.worker}.jsonl")
        return 0
    if not a.report:
        pairs = [(f, k) for f in range(1, 25) for k in range(1, 6)]
        chunks = [pairs[i::a.jobs] for i in range(a.jobs)]
        procs = [subprocess.Popen([sys.executable, __file__, "--worker", str(i), "--seeds", str(a.seeds),
                                   "--pairs", ",".join(f"{f}_{k}" for f, k in c)], stdout=subprocess.DEVNULL)
                 for i, c in enumerate(chunks) if c]
        if any(p.wait() for p in procs):
            print("a worker failed")
            return 1
    report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
