"""Build index.html: the 24 bbob landscapes in 2-D, evaluated with cocoex.

Usage:
    python build.py [--instance 1] [--grid 201] [--fragment PATH]

Evaluates every bbob function of one instance (default 1, the 2019 suite) on a
regular grid over the search domain [-5, 5]^2, reads the exact optimum with
``Problem._best_parameter``, and writes ``index.html``: a self-contained page
(three.js from cdnjs) with the values f(x) - f_opt embedded as quantised
log10 values.

``--fragment`` also writes the page without its document skeleton, as the
claude.ai Artifact publisher expects it.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "template.html"
OUT = ROOT / "index.html"
SITE = "https://bjbodner.github.io/bbob-landscapes/"
LOW, HIGH = -5.0, 5.0
DECADES = 15.0  # the quantised log10 range below each function's maximum
LEVELS = 65534  # codes 1..65535; code 0 is f(x) = f_opt exactly
BODY_START = '<div class="app">'  # the template's head part ends here
SHARE = f"""<meta property="og:type" content="website">
<meta property="og:title" content="BBOB Landscape Atlas">
<meta property="og:description" content="The 24 bbob benchmark functions of the COCO platform in 2-D, as rotating heat maps and elevation maps.">
<meta property="og:url" content="{SITE}">
<meta property="og:image" content="{SITE}preview.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="627">
<meta name="twitter:card" content="summary_large_image">
"""


def best_parameter(problem) -> np.ndarray:
    """x_opt, which cocoex only prints to a file in the working directory."""
    here, tmp = os.getcwd(), tempfile.mkdtemp()
    os.chdir(tmp)
    try:
        problem._best_parameter("print")
        return np.atleast_1d(np.loadtxt("._bbob_problem_best_parameter.txt"))
    finally:
        os.chdir(here)


def landscape(problem, grid: int) -> dict:
    axis = np.linspace(LOW, HIGH, grid)
    x_opt = best_parameter(problem)
    f_opt = float(problem(x_opt))
    # rows are x2 (from LOW to HIGH), columns x1
    values = np.array([[problem(np.array([a, b])) for a in axis] for b in axis])
    delta = values - f_opt
    if delta.min() < -1e-9 * max(1.0, abs(f_opt)):
        raise SystemExit(f"{problem.id}: a grid value is below f(x_opt)")
    positive = delta[delta > 0]
    top = float(np.log10(positive.max()))
    floor = max(float(np.log10(positive.min())), top - DECADES)
    logs = np.log10(np.maximum(delta, 10.0**floor))
    codes = np.where(
        delta > 0,
        1 + np.rint((logs - floor) / (top - floor) * LEVELS),
        0,
    ).astype("<u2")
    return {
        "id": problem.id_function,
        "x_opt": [round(float(v), 6) for v in x_opt],
        "f_opt": round(f_opt, 2),
        "log_lo": floor,
        "log_hi": top,
        "data": base64.b64encode(codes.tobytes()).decode("ascii"),
    }


def inline(text: str) -> str:
    """Replace each /*__INLINE path__*/ marker with the file at that path (the page stays one file)."""
    return re.sub(r"/\*__INLINE (\S+)__\*/", lambda m: (ROOT / m.group(1)).read_text(encoding="utf-8"), text)


def build(instance: int, grid: int) -> dict:
    import cocoex

    suite = cocoex.Suite("bbob", "", f"dimensions: 2 instance_indices: {instance}")
    functions = [landscape(p, grid) for p in suite]
    return {
        "source": f"cocoex {cocoex.__version__}, bbob suite (year 2019)",
        "instance": instance,
        "grid": grid,
        "domain": [LOW, HIGH],
        "functions": functions,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--instance", type=int, default=1)
    parser.add_argument("--grid", type=int, default=201)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--fragment", type=Path, help="also write the Artifact page")
    args = parser.parse_args(argv)

    data = build(args.instance, args.grid)
    payload = json.dumps(data, separators=(",", ":"))
    fragment = inline(TEMPLATE.read_text(encoding="utf-8")).replace("__LANDSCAPES__", payload)
    head, body = fragment.split(BODY_START, 1)
    page = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, '
        'viewport-fit=cover">\n'
        + SHARE
        + head
        + "</head>\n<body>\n"
        + BODY_START
        + body
        + "\n</body>\n</html>\n"
    )
    args.out.write_text(page, encoding="utf-8", newline="\n")
    print(f"wrote {args.out} ({len(page) / 1e6:.2f} MB)")
    if args.fragment:
        args.fragment.write_text(fragment, encoding="utf-8", newline="\n")
        print(f"wrote {args.fragment}")


if __name__ == "__main__":
    sys.exit(main())
