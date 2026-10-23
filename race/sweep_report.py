"""Summarise race/budget_sweep.py: evaluations to 1e-8 per function and optimizer, and race wins.

    python race/sweep_report.py [--c46-index PATH]

Competitors: instances 1-5 from race/data (the recorded races), instances 6-15 from
race/tuning/part_*.jsonl (tune_amm.py). AMM told budget B: race/tuning/sweep_*.jsonl.
Writes race/tuning/sweep_matrix.md and prints it.

Race rules: the first to f - f_opt <= 1e-8 wins (ties share); when nobody gets there, the lowest
final value wins. "Global B" is one budget for every function, chosen on instances 6-15 by wins
against all five competitors. "Per-function B" is chosen for each function on instances 1-5,
the races that are shown: it knows the function and the outcome, so it is a selection, not a
setting AMM could use on an unknown problem.
"""

from __future__ import annotations

import argparse
import json
import statistics as st
from pathlib import Path

HERE = Path(__file__).resolve().parent
TUNING = HERE / "tuning"
COMP = ["slsqp", "hcma", "nelder_mead", "cma_bipop", "ngopt"]
NAMES = {"slsqp": "SLSQP", "hcma": "HCMA", "nelder_mead": "Nelder-Mead", "cma_bipop": "CMA-BIPOP", "ngopt": "NGOpt"}


def load():
    races = {}   # (f, k) -> {arm: {"finish", "best"}}
    for p in sorted((HERE / "data").glob("f*_i*.json")):
        d = json.loads(p.read_text())
        races[(d["function"], d["instance"])] = {n: {"finish": r["finish"], "best": r["best"]} for n, r in d["runs"].items()}
    for p in sorted(TUNING.glob("part_*.jsonl")):
        for ln in p.read_text().splitlines():
            if ln:
                r = json.loads(ln)
                races.setdefault((r["f"], r["k"]), {}).update({n: r[n] for n in COMP if n in r})
    sweep = {}
    for p in sorted(TUNING.glob("sweep_*.jsonl")):
        for ln in p.read_text().splitlines():
            if ln:
                r = json.loads(ln)
                sweep[(r["f"], r["k"])] = {int(b): v for b, v in r.items() if b not in ("f", "k")}
    return races, sweep


def first(field: dict) -> set:
    fin = {n: v["finish"] for n, v in field.items() if v["finish"] is not None}
    if fin:
        m = min(fin.values())
        return {n for n, v in fin.items() if v == m}
    b = min(v["best"] for v in field.values())
    return {n for n, v in field.items() if v["best"] == b}


def wins(races, keys, amm_of, rivals) -> int:
    return sum("amm" in first({"amm": amm_of(k), **{n: races[k][n] for n in rivals}}) for k in keys)


def med(vals) -> str:
    done = [v for v in vals if v is not None]
    n = len(vals)
    if len(done) * 2 <= n:
        return f"– ({len(done)}/{n})"
    m = int(st.median([v if v is not None else 10**9 for v in vals]))
    return f"{m}" + ("" if len(done) == n else f" ({len(done)}/{n})")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--c46-index", type=Path, help="race/index.json as recorded with plain c46")
    a = ap.parse_args(argv)
    races, sweep = load()
    budgets = sorted(next(iter(sweep.values())))
    shown = [(f, k) for f in range(1, 25) for k in range(1, 6) if (f, k) in sweep]
    held = [(f, k) for f in range(1, 25) for k in range(6, 16) if (f, k) in sweep and "hcma" in races.get((f, k), {})]
    amm_b = lambda b: (lambda key: sweep[key][b])   # noqa: E731

    # one budget for every function, chosen on the held-out instances
    held_wins = {b: wins(races, held, amm_b(b), COMP) for b in budgets}
    g = max(budgets, key=lambda b: (held_wins[b], -b))
    # per function, chosen on the shown instances (a selection that knows the function)
    per_f = {}
    for f in range(1, 25):
        keys = [(f, k) for k in range(1, 6)]
        score = {b: (wins(races, keys, amm_b(b), COMP), wins(races, keys, amm_b(b), ["slsqp", "hcma"]),
                     -st.median([sweep[k][b]["finish"] or 10**9 for k in keys])) for b in budgets}
        per_f[f] = max(budgets, key=lambda b: score[b])

    sched = lambda key: races[key]["amm"]   # noqa: E731
    c46 = None
    if a.c46_index:
        ix = json.loads(a.c46_index.read_text())
        c46 = {(r["function"], r["instance"]): {"finish": r["finish"]["amm"], "best": r["best"]["amm"]} for r in ix["races"]}
    arms = [("c46, whole budget", (lambda key: c46[key]) if c46 else None),
            ("schedule 5-10-30-100 x D (race now)", sched),
            (f"one budget for all: B = {g}", amm_b(g)),
            ("best B per function (selection)", lambda key: sweep[key][per_f[key[0]]])]

    lines = ["# AMM budget sweep: bbob in 2-D, races of 1000 x D = 2000 evaluations", ""]
    lines += ["## Wins over the 120 shown races (instances 1-5)", "",
              "| AMM version | vs SLSQP + HCMA | vs all five | reaches 1e-8 |", "|---|---|---|---|"]
    for name, fn in arms:
        if fn is None:
            continue
        lines.append(f"| {name} | {wins(races, shown, fn, ['slsqp', 'hcma'])} | {wins(races, shown, fn, COMP)} | "
                     f"{sum(fn(k)['finish'] is not None for k in shown)} |")
    lines += ["", f"Held-out check (instances 6-15, 240 races, vs all five): B = {g} wins {held_wins[g]}; "
              f"best per-budget counts: " + ", ".join(f"{b}: {held_wins[b]}" for b in sorted(held_wins, key=lambda b: -held_wins[b])[:6]), ""]
    head = ["f"] + [NAMES[c] for c in COMP] + ["AMM schedule", f"AMM B={g}", "AMM best B", "best B"]
    lines += ["## Median evaluations to 1e-8 over the 5 shown instances ((n/5) = runs that got there; – = fewer than 3)", "",
              "| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for f in range(1, 25):
        keys = [(f, k) for k in range(1, 6)]
        row = [f"f{f}"] + [med([races[k][c]["finish"] for k in keys]) for c in COMP]
        row += [med([sched(k)["finish"] for k in keys]), med([sweep[k][g]["finish"] for k in keys]),
                med([sweep[k][per_f[f]]["finish"] for k in keys]), str(per_f[f])]
        sw = wins(races, keys, lambda key: sweep[key][per_f[f]], COMP)
        lines.append("| " + " | ".join(row) + f" |  <!-- wins {sw}/5 -->")
    lines += ["", "## Wins per function with the best per-function B (of 5, vs all five)", "",
              " ".join(f"f{f}:{wins(races, [(f, k) for k in range(1, 6)], lambda key: sweep[key][per_f[f]], COMP)}" for f in range(1, 25))]
    text = "\n".join(lines) + "\n"
    (TUNING / "sweep_matrix.md").write_text(text, encoding="utf-8")
    (TUNING / "sweep_choice.json").write_text(json.dumps({"global_B": g, "held_out_wins": held_wins,
                                                          "per_function_B": per_f}, indent=1), encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
