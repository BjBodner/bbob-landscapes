"""Record the Optimizer Race: every sample of six optimizers on the 24 bbob functions in 2-D.

Usage (the atm_v2 virtual environment has cocoex, cma, nevergrad and scipy; amm-optimizer
0.3.0 comes from PyPI or from its source tree on PYTHONPATH):

    python race/record.py                      # all 24 functions, instances 1-5
    python race/record.py --functions 8,15 --instances 1 --jobs 1
    python race/record.py --verify 12          # re-run 12 random runs, compare trace hashes

One race is one bbob function and one instance k (k = 1..5, the "seed" of the page). Every
optimizer gets the same problem and a budget of 1000 x D = 2000 evaluations. The runs follow
the harness of the AMM final test (FT1): the same restart loop, start points uniform in
[-5, 5]^2, a stop at the budget or at the first f - f_opt <= 1e-8 (COCO's final target),
and seed k for the start points and the optimizer (SeedSequence([0x41544D, k, f, 2, k])).
f_opt is used only to stop the run and to report f - f_opt; no optimizer is given it.

    amm          amm_optimizer.minimize(..., config=presets.get("c46"), bounds=(-5, 5)),
                 points clipped to the box with penalty |x - clip(x)|^2 (as in FT1)
    slsqp        scipy SLSQP, bounds [-5, 5]^2, maxiter = budget, ftol 1e-14, restarted
    nelder_mead  scipy Nelder-Mead, xatol = fatol = 1e-10, restarted (not an FT1 arm)
    ngopt        nevergrad NGOpt, Array bounded to [-5, 5]^2, one worker
    cma_bipop    pycma fmin2(restarts=9, bipop=True), sigma0 2, bounds [-5, 5]
    hcma         not run: read from the COCO data archive (Loshchilov 2013,
                 2013/HCMA_loshchilov_noiseless), run k of instance k. The archive logs every
                 improvement across a 10^0.2 level (.dat) and samples at log-spaced
                 evaluation counts (.tdat), so only those samples exist for HCMA.

Output: race/data/f{f}_i{k}.json per race and race/index.json. Each file holds a 161 x 161
landscape (quantised as in build.py) and, per optimizer, the samples (x quantised to 16 bits
over [-8, 8], log10(f - f_opt) in thousandths of a decade) with a SHA-256 of the
full-precision trace, so --verify can check that a re-run is identical.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import hashlib
import inspect
import json
import os
import platform
import random
import re
import subprocess
import sys
import tarfile
import warnings
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
from build import landscape  # noqa: E402  (the Atlas's own grid and quantisation)

DIM = 2
BUDGET = 1000 * DIM
FINISH = 1e-8
GRID = 161
SEED_NAMESPACE = 0x41544D  # the FT1 harness's namespace ("ATM")
MAX_RESTARTS = 10_000
X_RANGE = 8.0  # x is stored over [-8, 8]; the page pins points outside [-5, 5] to the frame
LOG_FLOOR = -12.0
OPTIMIZERS = ["amm", "slsqp", "nelder_mead", "ngopt", "cma_bipop", "hcma"]
HCMA_ARCHIVE = "2013/HCMA_loshchilov_noiseless"
OUT = HERE / "data"


class Stop(Exception):
    """Raised on the call after the last allowed evaluation, or after the finish."""


# ---------------------------------------------------------------- objective ----
class Recorder:
    """The FT1 harness's BoxedObjective plus a record of every evaluation."""

    def __init__(self, problem, fopt: float, penalty: float | None) -> None:
        self.problem, self.fopt, self.penalty = problem, fopt, penalty
        self.lower = np.asarray(problem.lower_bounds, dtype=float)
        self.upper = np.asarray(problem.upper_bounds, dtype=float)
        self.xs: list[np.ndarray] = []
        self.values: list[float] = []
        self.best = float("inf")
        self.best_x: np.ndarray | None = None

    @property
    def done(self) -> bool:
        return len(self.values) >= BUDGET or self.best - self.fopt <= FINISH

    def __call__(self, x) -> float:
        if self.done:
            raise Stop
        x = np.array(x, dtype=float)
        clipped = x if self.penalty is None else np.clip(x, self.lower, self.upper)
        value = float(self.problem(clipped))
        if self.penalty and (x != clipped).any():
            value += self.penalty * float(np.sum((x - clipped) ** 2))
        self.xs.append(x)
        self.values.append(value)
        if value < self.best:
            self.best, self.best_x = value, x
        return value


# ------------------------------------------------------------------ solvers ----
def _patch_ngopt_metamodel() -> None:
    """nevergrad 1.0.12's MetaModel calls float() on a 1-D array, which numpy 2.5 rejects.

    The same in-memory fix as the FT1 harness (benchmarks/quick_scan.py, NGOptSolver).
    """
    import nevergrad.optimization.metamodel as mm

    if getattr(mm, "_race_patched", False):
        return
    source = inspect.getsource(mm.learn_on_k_best)
    old = "return float(model.predict(trans(np.asarray(x, dtype=X[0].dtype).flatten()[None, :])))"
    if old in source:
        new = (
            "return float(np.ravel(model.predict(trans("
            "np.asarray(x, dtype=X[0].dtype).flatten()[None, :])))[0])"
        )
        exec(compile(source.replace(old, new), mm.__file__, "exec"), mm.__dict__)  # noqa: S102
        import nevergrad.optimization.optimizerlib as lib

        lib.learn_on_k_best = mm.learn_on_k_best
    mm._race_patched = True


class Solver:
    """One optimizer. ``begin`` splits the seed into start points and the optimizer stream."""

    penalty: float | None = None  # None: evaluated where asked (FT1's --penalty raw)

    def begin(self, seed: np.random.SeedSequence) -> None:
        start_seed, optimizer_seed = seed.spawn(2)
        self.start_rng = np.random.RandomState(start_seed.generate_state(4))
        self.rng = np.random.RandomState(optimizer_seed.generate_state(4))

    def solve(self, fun, x0: np.ndarray, budget: int) -> None:
        raise NotImplementedError


class AMM(Solver):
    """amm_optimizer.minimize with the c46 preset, unchanged.

    ``schedule`` (budget multiples of D): instead of one run with the whole budget, a run
    with each budget in turn and then one with whatever is left, so an easy function is
    finished by a short run while a hard one still gets a long one (AMM plans for the
    budget it is given). ``warm``: each later run starts from the best point so far,
    otherwise from a new uniform point. ``told``: every run is told this budget instead, and
    the harness restarts it from a new uniform point until the race budget is spent. The run
    never sees f_opt; it stops only because the harness stops it at the target or at the budget.
    """

    penalty = 1.0  # FT1 ran AMM with the default penalty

    def __init__(self, schedule: tuple[float, ...] = (), warm: bool = True, told: int | None = None) -> None:
        import amm_optimizer

        self.minimize = amm_optimizer.minimize
        self.config = amm_optimizer.presets.get("c46")
        self.schedule, self.warm, self.told = tuple(schedule), warm, told

    def solve(self, fun, x0, budget):
        if self.told:
            self.minimize(fun, x0, min(self.told, budget), rng=self.rng, config=self.config, bounds=(-5.0, 5.0))
            return
        start, x = len(fun.values), np.asarray(x0, dtype=float)
        for stage in [int(round(m * DIM)) for m in self.schedule] + [None]:
            left = budget - (len(fun.values) - start)
            if left <= 0:
                return
            self.minimize(fun, x, left if stage is None else min(stage, left), rng=self.rng,
                          config=self.config, bounds=(-5.0, 5.0))
            if self.warm and fun.best_x is not None:
                x = np.clip(fun.best_x, fun.lower, fun.upper)
            else:
                x = fun.lower + (fun.upper - fun.lower) * self.start_rng.rand(DIM)


class SLSQP(Solver):
    def solve(self, fun, x0, budget):
        from scipy.optimize import minimize

        minimize(fun, x0, method="SLSQP", bounds=[(-5.0, 5.0)] * DIM,
                 options={"maxiter": budget, "ftol": 1e-14})


class NelderMead(Solver):
    def solve(self, fun, x0, budget):
        from scipy.optimize import minimize

        minimize(fun, x0, method="Nelder-Mead",
                 options={"maxfev": budget, "xatol": 1e-10, "fatol": 1e-10})


class NGOpt(Solver):
    def solve(self, fun, x0, budget):
        import nevergrad as ng

        _patch_ngopt_metamodel()
        param = ng.p.Array(init=np.asarray(x0, dtype=float)).set_bounds(-5.0, 5.0)
        param.random_state = np.random.RandomState(int(self.rng.randint(1, 2**31 - 1)))
        optimizer = ng.optimizers.NGOpt(parametrization=param, budget=budget, num_workers=1)
        optimizer.minimize(lambda x: float(fun(np.asarray(x, dtype=float))))


class CMABipop(Solver):
    def solve(self, fun, x0, budget):
        import cma

        first = [True]

        def start():
            if first[0]:
                first[0] = False
                return np.array(x0, dtype=float)
            return self.rng.uniform(-4, 4, DIM)

        opts = {"maxfevals": budget, "verbose": -9,
                "seed": int(self.rng.randint(1, 2**31 - 1)), "bounds": [-5, 5]}
        cma.fmin2(fun, start, 2.0, opts, restarts=9, bipop=True)


# How AMM runs in the race, per function: the setting with the most race wins on the shown
# races, from the budget sweep (race/budget_sweep.py, race/sweep_report.py), stored in
# race/tuning/per_function_budget.json. The page says that the budget was tuned per function.
PER_FUNCTION = HERE / "tuning" / "per_function_budget.json"
RACE_AMM: dict[int, dict] = ({int(f): v for f, v in json.loads(PER_FUNCTION.read_text())["per_function"].items()}
                             if PER_FUNCTION.exists() else {})


def race_amm(function: int) -> AMM:
    spec = RACE_AMM.get(function, {})
    return AMM(schedule=tuple(spec.get("schedule", ())), warm=spec.get("warm", True), told=spec.get("told"))


SOLVERS = {"amm": race_amm, "slsqp": SLSQP, "nelder_mead": NelderMead, "ngopt": NGOpt, "cma_bipop": CMABipop}


def amm_note() -> str:
    """One line for the page: what kind of optimizer AMM is (the schedule is in index.json, amm_race)."""
    return ("AMM is budget-aware: it plans for the whole evaluation budget and uses most of it to give itself "
            "the best chance of reaching the global optimum, not just the nearest local one. For this demo, the "
            "budget AMM is told was tuned for each function.")


CALLS = {
    "amm": "amm_optimizer.minimize(f, x0, B, rng, config=presets.get('c46'), bounds=(-5, 5)) with the budget B "
           "tuned per function (race/tuning/per_function_budget.json), restarted with the same B until the race "
           "budget is spent; points clipped to the box with penalty |x - clip(x)|^2",
    "slsqp": "scipy.optimize.minimize(f, x0, method='SLSQP', bounds=[(-5, 5)] * 2, "
             "options={'maxiter': budget, 'ftol': 1e-14}), restarted",
    "nelder_mead": "scipy.optimize.minimize(f, x0, method='Nelder-Mead', "
                   "options={'maxfev': budget, 'xatol': 1e-10, 'fatol': 1e-10}), restarted",
    "ngopt": "nevergrad NGOpt(parametrization=Array(init=x0).set_bounds(-5, 5), budget, num_workers=1)",
    "cma_bipop": "cma.fmin2(f, start, 2.0, {maxfevals: budget, bounds: [-5, 5], seed}, restarts=9, bipop=True)",
    "hcma": f"COCO data archive {HCMA_ARCHIVE} (Loshchilov 2013), run of instance k; logged samples only",
}


def run(name: str, problem, fopt: float, k: int) -> Recorder:
    """The FT1 restart loop (benchmarks/run_bbob.py, solve_problem) for one optimizer."""
    solver = SOLVERS[name](problem.id_function) if name == "amm" else SOLVERS[name]()
    rec = Recorder(problem, fopt, solver.penalty)
    solver.begin(np.random.SeedSequence([SEED_NAMESPACE, k, problem.id_function, DIM, k]))
    restarts = 0
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        while not rec.done and restarts < MAX_RESTARTS:
            x0 = rec.lower + (rec.upper - rec.lower) * solver.start_rng.rand(DIM)
            with contextlib.suppress(Stop):
                solver.solve(rec, x0, BUDGET - len(rec.values))
            restarts += 1
    return rec


# --------------------------------------------------------------------- HCMA ----
class HCMAArchive:
    """Reads the 2-D runs of HCMA from the archive's .tgz without extracting it."""

    def __init__(self, path: Path | None) -> None:
        if path is None:
            import cocopp

            found = cocopp.archives.bbob.get(HCMA_ARCHIVE, remote=False)
            path = Path(found)
        self.path = path
        self.tar = tarfile.open(path, "r:gz") if path.is_file() else None

    def _read(self, suffix: str) -> str:
        if self.tar is not None:
            member = next(m for m in self.tar.getmembers() if m.name.endswith(suffix))
            return self.tar.extractfile(member).read().decode("ascii")
        return next(self.path.rglob("*" + suffix.split("/")[-1])).read_text()

    def run(self, f: int, k: int) -> dict:
        info = self._read(f"/bbobexp_f{f}.info").splitlines()
        line = next(ln for i, ln in enumerate(info)
                    if ln.startswith(f"data_f{f}/bbobexp_f{f}_DIM{DIM}.dat")
                    and f"DIM = {DIM}," in info[i - 2])
        order = [int(p.split(":")[0]) for p in line.split(", ")[1:]]
        block = order.index(k)
        rows: dict[int, tuple[float, float, float, float]] = {}
        fopts = set()
        for ext in ("dat", "tdat"):
            blocks = re.split(r"^%.*$", self._read(f"/data_f{f}/bbobexp_f{f}_DIM{DIM}.{ext}"),
                              flags=re.M)[1:]
            header = re.findall(r"^%.*Fopt \(([^)]+)\)", self._read(
                f"/data_f{f}/bbobexp_f{f}_DIM{DIM}.{ext}"), flags=re.M)
            fopts.add(float(header[block]))
            for ln in blocks[block].strip().splitlines():
                v = ln.split()
                evals = int(float(v[0]))
                rows[evals] = (float(v[1]), float(v[2]), float(v[5]), float(v[6]))
        (fopt,) = fopts
        evals, xs, regrets = [], [], []
        best = float("inf")
        for e in sorted(rows):
            if e > BUDGET:
                break
            regret, best_regret, x1, x2 = rows[e]
            evals.append(e)
            xs.append((x1, x2))
            regrets.append(regret)
            best = min(best, regret, best_regret)
            if best <= FINISH:
                break
        return {"fopt": fopt, "t": evals, "x": xs, "r": regrets}


# ------------------------------------------------------------------ encoding ----
def b64(a: np.ndarray) -> str:
    return base64.b64encode(a.tobytes()).decode("ascii")


def encode(xs, regrets, evals=None) -> dict:
    x = np.asarray(xs, dtype=float).reshape(-1, DIM)
    r = np.maximum(np.asarray(regrets, dtype=float), 10.0**LOG_FLOOR)
    qx = np.rint((np.clip(x, -X_RANGE, X_RANGE) + X_RANGE) / (2 * X_RANGE) * 65535).astype("<u2")
    qr = np.clip(np.rint(np.log10(r) * 1000), -32768, 32767).astype("<i2")
    best = np.minimum.accumulate(r)
    hit = np.flatnonzero(best <= FINISH)
    t = np.arange(1, len(r) + 1) if evals is None else np.asarray(evals)
    out = {
        "n": int(t[-1]) if len(t) else 0,
        "samples": int(len(r)),
        "finish": int(t[hit[0]]) if len(hit) else None,
        "best": float(f"{best[-1]:.4g}") if len(r) else None,
        "x": b64(qx),
        "r": b64(qr),
        "sha256": hashlib.sha256(x.tobytes() + np.asarray(regrets, dtype=float).tobytes()).hexdigest(),
    }
    if evals is not None:
        out["t"] = b64(np.asarray(evals, dtype="<u2"))
    return out


_SUITES: list = []  # cocoex frees a problem with its suite, so the suites are kept


def bbob(f: int, k: int):
    """The bbob problem of function f, instance k, in 2-D."""
    import cocoex

    # explicit instance numbers ("instance_indices" would index the default year's list)
    suite = cocoex.Suite("bbob", f"instances: {k}", f"function_indices: {f} dimensions: {DIM}")
    _SUITES.append(suite)
    return suite.get_problem(0)


def race(f: int, k: int, hcma: HCMAArchive) -> dict:
    problem = bbob(f, k)
    land = landscape(problem, GRID)
    fopt = round(float(land["f_opt"]), 2)  # bbob optima are multiples of 0.01 (FT1's exact_fopt)
    runs = {}
    for name in SOLVERS:
        rec = run(name, problem, fopt, k)
        runs[name] = encode(rec.xs, np.asarray(rec.values) - fopt)
    h = hcma.run(f, k)
    if abs(h["fopt"] - fopt) > 1e-9:
        raise SystemExit(f"f{f} i{k}: archive f_opt {h['fopt']} != cocoex f_opt {fopt}")
    runs["hcma"] = encode(h["x"], h["r"], h["t"])
    return {"function": f, "instance": k, "dim": DIM, "budget": BUDGET, "finish": FINISH,
            "landscape": land, "runs": runs}


# ---------------------------------------------------------------------- main ----
def ids(text: str) -> list[int]:
    out = []
    for part in text.split(","):
        lo, _, hi = part.partition("-")
        out.extend(range(int(lo), int(hi or lo) + 1))
    return out


def versions() -> dict:
    import cma
    import cocoex
    import nevergrad
    import scipy

    import amm_optimizer

    return {"amm_optimizer": amm_optimizer.__version__,
            "amm_config_hash": amm_optimizer.presets.get("c46").config_hash(),
            "cma": cma.__version__, "cocoex": cocoex.__version__, "nevergrad": nevergrad.__version__,
            "scipy": scipy.__version__, "numpy": np.__version__, "python": platform.python_version()}


def thumbnail(land: dict, size: int = 44) -> str:
    """The side-index icon: log-scale heights in [0, 255], as the Atlas computes them (atlas.js)."""
    c = np.frombuffer(base64.b64decode(land["data"]), dtype="<u2")
    step = (land["log_hi"] - land["log_lo"]) / 65534
    logv = np.where(c > 0, land["log_lo"] + (c.astype(float) - 1) * step, -np.inf)
    s = np.sort(c)
    first = int(np.count_nonzero(s == 0))
    q = int(s[min(len(s) - 1, first + int(0.005 * (len(s) - first)))])
    hi = land["log_hi"]
    lo = max(land["log_lo"] + (q - 1) * step, hi - 8)
    h = np.where(logv <= lo, 0.0, (logv - lo) / (hi - lo)).reshape(GRID, GRID)
    rows = np.rint((size - 1 - np.arange(size)) / (size - 1) * (GRID - 1)).astype(int)
    cols = np.rint(np.arange(size) / (size - 1) * (GRID - 1)).astype(int)
    img = np.clip(np.rint(h[np.ix_(rows, cols)] * 255), 0, 255).astype(np.uint8)
    return b64(img)


def write_index() -> None:
    files = sorted(OUT.glob("f*_i*.json"), key=lambda p: tuple(map(int, re.findall(r"\d+", p.name))))
    races, thumbs = [], {}
    for p in files:
        d = json.loads(p.read_text())
        races.append({"file": p.name, "function": d["function"], "instance": d["instance"],
                      "finish": {n: r["finish"] for n, r in d["runs"].items()},
                      "best": {n: r["best"] for n, r in d["runs"].items()}})
        if d["instance"] == 1:
            thumbs[d["function"]] = thumbnail(d["landscape"])
    index = {
        "title": "Optimizer Race: bbob in 2-D",
        "recorded": dt.date.today().isoformat(),
        "dim": DIM, "budget": BUDGET, "finish": FINISH, "grid": GRID,
        "x_range": X_RANGE, "log_floor": LOG_FLOOR, "optimizers": OPTIMIZERS,
        "calls": CALLS, "amm_race": {"per_function": {str(f): v for f, v in sorted(RACE_AMM.items())},
                                       "chosen_by": "race/sweep_report.py + race/tuning/per_function_budget.json"},
        "amm_note": amm_note(), "versions": versions(),
        "seeds": "race (f, k): bbob instance k; SeedSequence([0x41544D, k, f, 2, k]) split into "
                 "start points and optimizer stream, as in the FT1 harness",
        "thumbs": thumbs,
        "races": races,
    }
    (HERE / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"wrote {HERE / 'index.json'} ({len(races)} races)")


def verify(count: int) -> None:
    files = sorted(OUT.glob("f*_i*.json"))
    picks = random.Random(0).sample([(p, n) for p in files for n in SOLVERS], count)
    for p, name in picks:
        d = json.loads(p.read_text())
        f, k = d["function"], d["instance"]
        problem = bbob(f, k)
        rec = run(name, problem, round(float(d["landscape"]["f_opt"]), 2), k)
        got = encode(rec.xs, np.asarray(rec.values) - round(float(d["landscape"]["f_opt"]), 2))["sha256"]
        ok = got == d["runs"][name]["sha256"]
        print(f"{p.name} {name:12s} {'same' if ok else 'DIFFERENT'}")
        if not ok:
            raise SystemExit("a re-run differs from the recording")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--functions", default="1-24")
    ap.add_argument("--instances", default="1-5")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument("--hcma", type=Path, help="the archive's .tgz or extracted folder")
    ap.add_argument("--verify", type=int, metavar="N", help="re-run N random runs and compare")
    ap.add_argument("--index-only", action="store_true")
    ap.add_argument("--only", help="re-record only these optimizers (comma-separated) into the existing files")
    a = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    if a.verify:
        return verify(a.verify)
    if a.index_only:
        return write_index()
    functions, instances = ids(a.functions), ids(a.instances)
    if a.jobs > 1 and len(functions) > 1:
        chunks = [functions[i::a.jobs] for i in range(a.jobs)]
        procs = [subprocess.Popen([sys.executable, __file__, "--jobs", "1", "--instances", a.instances,
                                   "--functions", ",".join(map(str, c))]
                                  + (["--hcma", str(a.hcma)] if a.hcma else [])
                                  + (["--only", a.only] if a.only else []))
                 for c in chunks if c]
        if any(p.wait() for p in procs):
            raise SystemExit("a worker failed")
        return write_index()
    if a.only:
        names = a.only.split(",")
        unknown = [n for n in names if n not in SOLVERS]
        if unknown:
            raise SystemExit(f"cannot re-run {unknown} (HCMA comes from the archive)")
        for f in functions:
            for k in instances:
                path = OUT / f"f{f}_i{k}.json"
                d = json.loads(path.read_text())
                problem, fopt = bbob(f, k), round(float(d["landscape"]["f_opt"]), 2)
                for n in names:
                    rec = run(n, problem, fopt, k)
                    d["runs"][n] = encode(rec.xs, np.asarray(rec.values) - fopt)
                path.write_text(json.dumps(d, separators=(",", ":")), encoding="utf-8")
                print(f"f{f} i{k}: " + " ".join(f"{n}={d['runs'][n]['finish'] or '-'}" for n in names), flush=True)
        if a.jobs == 1 and len(functions) == 24:
            write_index()
        return None
    hcma = HCMAArchive(a.hcma)
    for f in functions:
        for k in instances:
            d = race(f, k, hcma)
            path = OUT / f"f{f}_i{k}.json"
            path.write_text(json.dumps(d, separators=(",", ":")), encoding="utf-8")
            fin = " ".join(f"{n}={r['finish'] or '-'}" for n, r in d["runs"].items())
            print(f"f{f} i{k}: {path.stat().st_size / 1e3:.0f} kB  finish {fin}", flush=True)
    if a.jobs == 1 and len(functions) == 24:
        write_index()


if __name__ == "__main__":
    sys.exit(main())
