# BBOB Landscape Atlas

**Live:** https://bjbodner.github.io/bbob-landscapes/

An interactive viewer of the 24 noiseless **bbob** benchmark functions of the [COCO platform](https://github.com/numbbo/coco) in two dimensions. Each landscape turns slowly, as a heat map or as an elevation map.

[![The viewer showing f8, Rosenbrock](preview.png)](https://bjbodner.github.io/bbob-landscapes/)

* **Exact values.** Every landscape is evaluated with `cocoex` on a 201 × 201 grid over the search domain [−5, 5]², for bbob instance 1 (the 2019 suite). Hover over the surface, or tap it, to read x, f(x) − f_opt and f(x) at a grid point.
* **Two views, two scales.** The heat map and the elevation map can each show f(x) − f_opt on a log or a linear scale. Contour lines are drawn at equal steps of the colour scale.
* **The optimum.** It is marked from COCO's own `x_opt`, with its f_opt in the footer.
* **The classification.** Each function shows its bbob group (separable; low or moderate conditioning; high conditioning and unimodal; multimodal with adequate global structure; multimodal with weak global structure) and pills for its modality, separability, local surface, conditioning and global structure, as described in the bbob function definitions [2].
* **Navigation.** Use the side index, the arrow keys, or a link to one function such as [`#f15`](https://bjbodner.github.io/bbob-landscapes/#f15). <kbd>H</kbd> and <kbd>E</kbd> switch the view, <kbd>L</kbd> switches the scale, and <kbd>Space</kbd> pauses the rotation. Drag to turn and tilt.

## Rebuild

```bash
pip install -r requirements.txt
python build.py                 # writes index.html
python build.py --instance 7    # another bbob instance
```

`build.py` fills `template.html` with the grid values, stored as log10(f(x) − f_opt) quantised to 16 bits, and writes a single self-contained `index.html`. The page loads three.js r128 from cdnjs and its fonts from Google Fonts.

`demo/record.mjs` records the 30-second demo video (`node demo/record.mjs video`) and the link-preview image (`node demo/record.mjs preview`). It drives the page in headless Chrome on a fake clock, and needs ffmpeg.

## References

1. N. Hansen, A. Auger, R. Ros, O. Mersmann, T. Tušar, D. Brockhoff, *COCO: A platform for comparing continuous optimizers in a black-box setting* (2021), Optimization Methods and Software 36(1).
2. N. Hansen, S. Finck, R. Ros, A. Auger, *Real-Parameter Black-Box Optimization Benchmarking 2009: Noiseless Functions Definitions* (2009), INRIA Research Report RR-6829.

## License

Apache-2.0. three.js is MIT-licensed. COCO is BSD-licensed.
