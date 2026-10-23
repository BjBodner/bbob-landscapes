"""Sweep the budget AMM is told: evaluations to f - f_opt <= 1e-8 on every bbob function in 2-D.

    python race/budget_sweep.py [--instances 1-15] [--jobs 12]

AMM (amm-optimizer 0.3.0, preset c46, unchanged) is told a budget B and run in the race harness
(race/record.py): when a run of B evaluations ends without reaching the target, the harness
restarts it from a new uniform point with the same B, until the race budget (1000 x D = 2000) is
spent. B runs over 10, 30, ..., 290 and 300, 350, ..., 1000. Results: race/tuning/sweep_*.jsonl.
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

BUDGETS = list(range(10, 300, 20)) + list(range(300, 1001, 50))
OUT = HERE / "tuning"


class AMMFixed(R.AMM):
    """c46 told a fixed budget; the harness restarts it from a new uniform point."""

    def __init__(self, told: int) -> None:
        super().__init__()
        self.told = told

    def solve(self, fun, x0, budget):
        self.minimize(fun, x0, min(self.told, budget), rng=self.rng, config=self.config, bounds=(-5.0, 5.0))


def outcome(regrets) -> dict:
    r = np.minimum.accumulate(np.asarray(regrets, dtype=float))
    hit = np.flatnonzero(r <= R.FINISH)
    return {"finish": int(hit[0]) + 1 if len(hit) else None, "best": float(r[-1]) if len(r) else float("inf")}


def worker(functions, instances, part: Path) -> None:
    for b in BUDGETS:
        R.SOLVERS[f"amm@{b}"] = functools.partial(AMMFixed, b)
    with part.open("w", encoding="utf-8") as out:
        for f in functions:
            for k in instances:
                problem = R.bbob(f, k)
                fopt = round(float(R.landscape(problem, 3)["f_opt"]), 2)
                row = {"f": f, "k": k}
                for b in BUDGETS:
                    rec = R.run(f"amm@{b}", problem, fopt, k)
                    row[str(b)] = outcome(np.asarray(rec.values) - fopt)
                out.write(json.dumps(row) + "\n")
                out.flush()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--instances", default="1-15")
    ap.add_argument("--functions", default="1-24")
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--worker", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    OUT.mkdir(exist_ok=True)
    functions, instances = R.ids(a.functions), R.ids(a.instances)
    if a.worker:
        worker(functions, instances, OUT / f"sweep_{a.worker}.jsonl")
        return 0
    procs = [subprocess.Popen([sys.executable, __file__, "--worker", str(i), "--functions",
                               ",".join(map(str, functions[i::a.jobs])), "--instances", a.instances],
                              stdout=subprocess.DEVNULL)
             for i in range(a.jobs) if functions[i::a.jobs]]
    return 1 if any(p.wait() for p in procs) else 0


if __name__ == "__main__":
    sys.exit(main())
