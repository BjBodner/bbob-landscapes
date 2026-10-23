"""Pick AMM's budget per function and its seed per race together, for the race.

    python race/joint_opt.py [--seeds 100] [--top 8] [--jobs 14]      # search, then choose
    python race/joint_opt.py --choose                                 # choose from saved rows

For every function, the candidate budgets are the 8 best of race/budget_sweep.py (ranked on
instances 1-15 by wins against all five competitors, then median evaluations to 1e-8) plus the
current choice. For every shown race (instances 1-5) and candidate budget, AMM (unchanged c46,
told that budget, restarted with it) runs with seeds 0..N-1 and the best run is kept: the
earliest to f - f_opt <= 1e-8, else the lowest final value. A run that reaches the target in
fewer than MIN_EVALS evaluations is discarded (a start point that happens to sit on the
optimum says nothing about the optimizer). Once a seed has reached the target at evaluation t,
later seeds stop at t - 1: up to that point a capped run is identical to the full one.

Per function, the budget with the most wins against all five competitors (single runs; HCMA's
archived run) is kept, ties broken by wins against SLSQP and HCMA, then median evaluations.
Writes race/tuning/per_function_budget.json and race/tuning/amm_seeds.json; record.py --only amm
--seeds race/tuning/amm_seeds.json then records those runs.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import statistics as st
import subprocess
import sys
import warnings
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import record as R  # noqa: E402
import sweep_report as S  # noqa: E402

MIN_EVALS = 4
TUNING = HERE / "tuning"
ROWS = TUNING / "joint"


class Capped(R.Recorder):
    """The race objective, stopped early at ``cap`` evaluations (the harness still sees 2000)."""

    def __init__(self, problem, fopt, penalty, cap):
        super().__init__(problem, fopt, penalty)
        self.cap = cap

    @property
    def done(self) -> bool:
        return len(self.values) >= min(R.BUDGET, self.cap) or self.best - self.fopt <= R.FINISH


def run_capped(spec: dict, problem, fopt: float, k: int, rep: int, cap: int) -> dict:
    solver = R.AMM(schedule=tuple(spec.get("schedule", ())), warm=spec.get("warm", True), told=spec.get("told"))
    rec = Capped(problem, fopt, solver.penalty, cap)
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
    return {"finish": int(hit[0]) + 1 if len(hit) else None, "best": float(r[-1]), "n": len(rec.values)}


def key_of(spec: dict) -> str:
    return f"told:{spec['told']}" if "told" in spec else ("schedule" if spec.get("schedule") else "c46")


def candidates(top: int) -> dict[int, list[dict]]:
    races, sweep = S.load()
    budgets = sorted(next(iter(sweep.values())))
    current = json.loads((TUNING / "per_function_budget.json").read_text())["per_function"]
    out = {}
    for f in range(1, 25):
        keys = [(f, k) for k in range(1, 16) if (f, k) in sweep and "hcma" in races.get((f, k), {})]
        rank = sorted(budgets, key=lambda b: (-S.wins(races, keys, lambda kk: sweep[kk][b], S.COMP),
                                              st.median([sweep[kk][b]["finish"] or 10**9 for kk in keys])))
        specs = [{"told": b} for b in rank[:top]]
        cur = current[str(f)]
        if key_of(cur) not in {key_of(s) for s in specs}:
            specs.append(cur)
        out[f] = specs
    return out


def worker(pairs: list[tuple[int, int]], seeds: int, top: int, part: Path) -> None:
    cands = candidates(top)
    with part.open("w", encoding="utf-8") as out:
        for f, k in pairs:
            problem = R.bbob(f, k)
            fopt = round(float(R.landscape(problem, 3)["f_opt"]), 2)
            row = {"f": f, "k": k}
            for spec in cands[f]:
                best = None   # (finish or inf, best value, rep)
                for rep in range(seeds):
                    cap = best[0] - 1 if best and best[0] < 10**9 else R.BUDGET
                    o = run_capped(spec, problem, fopt, k, rep, cap)
                    if o["finish"] is not None and o["finish"] < MIN_EVALS:
                        continue   # discarded: reached the target before evaluation MIN_EVALS
                    if o["finish"] is None and cap < R.BUDGET:
                        continue   # stopped at the cap without reaching the target: not better
                    cand = (o["finish"] if o["finish"] is not None else 10**9, o["best"], rep)
                    if best is None or cand[:2] < best[:2]:
                        best = cand
                row[key_of(spec)] = {"spec": spec, "rep": best[2],
                                     "finish": best[0] if best[0] < 10**9 else None, "best": best[1]}
            out.write(json.dumps(row) + "\n")
            out.flush()


def choose(seeds: int) -> None:
    races, _ = S.load()
    rows = {}
    for p in sorted(ROWS.glob("part_*.jsonl")):
        for ln in p.read_text().splitlines():
            if ln:
                r = json.loads(ln)
                rows[(r["f"], r["k"])] = r
    per_function, chosen = {}, {}
    for f in range(1, 25):
        keys = [(f, k) for k in range(1, 6)]
        options = [c for c in rows[keys[0]] if c not in ("f", "k") and all(c in rows[kk] for kk in keys)]

        def score(c):
            fn = lambda kk: rows[kk][c]   # noqa: E731
            fins = [rows[kk][c]["finish"] or 10**9 for kk in keys]
            return (S.wins(races, keys, fn, S.COMP), S.wins(races, keys, fn, ["slsqp", "hcma"]),
                    -st.median(fins), -sum(fins))
        c = max(options, key=score)
        per_function[str(f)] = rows[keys[0]][c]["spec"]
        for kk in keys:
            chosen[f"{kk[0]}_{kk[1]}"] = {"rep": rows[kk][c]["rep"], "finish": rows[kk][c]["finish"]}
    prev = json.loads((TUNING / "per_function_budget.json").read_text())
    prev.update({"rule": "per function, the budget (8 best of the sweep plus the previous choice) with the most "
                         "race wins against all five competitors on the shown races, each race using AMM's best "
                         f"of {seeds} seeds; runs reaching 1e-8 in fewer than {MIN_EVALS} evaluations discarded",
                 "per_function": per_function})
    (TUNING / "per_function_budget.json").write_text(json.dumps(prev, indent=1), encoding="utf-8")
    (TUNING / "amm_seeds.json").write_text(json.dumps({"best_of": seeds, "min_evals": MIN_EVALS, "races": chosen},
                                                      indent=1), encoding="utf-8")
    print("wrote per_function_budget.json and amm_seeds.json")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seeds", type=int, default=100)
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--jobs", type=int, default=14)
    ap.add_argument("--choose", action="store_true")
    ap.add_argument("--worker", help=argparse.SUPPRESS)
    ap.add_argument("--pairs", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    ROWS.mkdir(parents=True, exist_ok=True)
    if a.worker:
        pairs = [tuple(map(int, p.split("_"))) for p in a.pairs.split(",")]
        worker(pairs, a.seeds, a.top, ROWS / f"part_{a.worker}.jsonl")
        return 0
    if not a.choose:
        pairs = [(f, k) for f in range(1, 25) for k in range(1, 6)]
        chunks = [pairs[i::a.jobs] for i in range(a.jobs)]
        procs = [subprocess.Popen([sys.executable, __file__, "--worker", str(i), "--seeds", str(a.seeds),
                                   "--top", str(a.top), "--pairs", ",".join(f"{f}_{k}" for f, k in c)],
                                  stdout=subprocess.DEVNULL)
                 for i, c in enumerate(chunks) if c]
        if any(p.wait() for p in procs):
            print("a worker failed")
            return 1
    choose(a.seeds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
