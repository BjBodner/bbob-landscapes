/* Optimizer Race: recorded runs of six optimizers on one bbob function in 2-D, replayed together
   on the landscape. One clock counts evaluations, so at every moment each optimizer has made the
   same number of them. Each × is one evaluation (the last 10 of each optimizer, fading with age);
   the ring is the best point so far, which moves only when a better one is found. The track
   above the stage shows each optimizer's best f(x) − f_opt on a log scale, with the finish line
   at 10⁻⁸ (COCO's final target). The first optimizer to cross it wins; when every optimizer on
   the track has finished, or after 1000 × D evaluations, the next function starts.

   BBOBRace.mount(element, options) builds the race inside element. Options:
     base      URL of the folder holding index.json and data/ (default "race/")
     hash      keep #f8-s2 style links in the address bar (default false)
     keys      "global": shortcuts anywhere on the page; "local" (default): only while focus is inside
     autoplay  start playing and advance through the functions (default true; off with reduced motion)
     start     { f: 1..24, seed: 1..5 } (default f15, seed 1)
     confetti  true for confetti with the winner's banner (default false)
     controls  "open" to show the controls drawer at first (default closed; the viewer's choice is remembered)
     loopFrom  after f24 the automatic sequence returns to this function (default 15: the first
               14 functions finish in a few dozen evaluations, so the loop skips them)
     on        the optimizers shown at first (default AMM, SLSQP and HCMA)
     note      HTML appended to the footer note
     source    URL of the source code, shown as a footer link when given
   Needs three.js r128, src/bbob-meta.js and src/landscape.js. */
(function (root) {
"use strict";

const B = root.BBOBLandscape, M = root.BBOB_META;
const OPTIMIZERS = [
  { id: "hcma", name: "HCMA", short: "HCMA" },
  { id: "slsqp", name: "SLSQP", short: "SLSQP" },
  { id: "nelder_mead", name: "Nelder-Mead", short: "N-M" },
  { id: "ngopt", name: "NGOpt", short: "NGOpt" },
  { id: "cma_bipop", name: "CMA-BIPOP", short: "BIPOP" },
  { id: "amm", name: "AMM (Ours)", short: "AMM (Ours)" },
];
const DEFAULT_ON = ["amm", "slsqp", "hcma"];
const TRAIL = 10;                      // samples shown per optimizer
const HOLD_MS = 3000;                  // the final frame before the next function
const GLIDE_MS = 250;                  // a best ring moving to a new best point
const BANNER_MS = 2800;
const LOG_START = 1, LOG_FINISH = -8;  // the track: 10^1 (and above) to the finish at 10^-8
const RATE0 = 15, RATE1 = 0.12;        // clock: 15 + 0.12 t evaluations per second at 1x
const SPEEDS = [0.5, 1, 2, 4];
const DOMAIN = 5;
const ZOOM_HEAT = 0.89;                // the heat map's camera distance (1 leaves room to turn the surface)
const ORD = n => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function bytes(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

const FLAG = `<svg viewBox="0 0 26 22" aria-hidden="true"><path d="M3 21V2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<g transform="translate(3.9 2.2)"><rect width="18" height="11" rx="1" fill="#fff" stroke="#13212b" stroke-width="1"/>
<path fill="#13212b" d="M0 0h4.5v3.67H0zM9 0h4.5v3.67H9zM4.5 3.67H9v3.67H4.5zM13.5 3.67H18v3.67h-4.5zM0 7.33h4.5V11H0zM9 7.33h4.5V11H9z"/></g></svg>`;

function mount(el, o = {}) {
  const base = (o.base || "race/").replace(/\/?$/, "/");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const on = new Set(o.on || DEFAULT_ON);
  el.classList.add("bbob-race");
  const sideId = "br-side-" + Math.random().toString(36).slice(2, 9);
  el.innerHTML = `
<div class="br-app">
  <nav class="br-index" data-index aria-label="The 24 bbob functions">
    <div class="br-brand"><b>Optimizer race</b><span>bbob · 2-D · 24 functions</span></div>
  </nav>
  <div class="br-main">
    <header class="br-head">
      <h2 class="br-title"><span class="fsym" data-fsym><i>f</i><sub></sub></span><span class="fname" data-fname></span></h2>
      <p class="br-goal"><b>The goal:</b> reach the global minimum <span class="br-goal-star" aria-hidden="true">★</span>. The first optimizer whose best point gets within 10<sup>−8</sup> of it wins.</p>
    </header>
    <div class="br-stagewrap">
      <div class="br-view" data-stage>
        <div class="br-axes" data-axes></div>
        <div class="br-clock" data-clock aria-hidden="true"></div>
        <div class="br-tip" data-tip hidden></div>
        <div class="br-win" data-win hidden></div>
        <div class="br-notice" data-notice hidden></div>
      </div>
      <div class="br-vtrack" data-track role="group" aria-label="Race track: each optimizer's distance to the global minimum, best f(x) − f_opt so far on a log scale, from 10 at the top to the finish line at 10⁻⁸ at the bottom">
        <div class="br-vt-title">Distance to the global minimum <span>(best f − f<sub>opt</sub>)</span></div>
        <div class="br-vt-body">
          <div class="br-vscale" aria-hidden="true"><div class="sp-top"></div><div class="ticks" data-scale></div><div class="sp-bot"></div></div>
          ${OPTIMIZERS.map(m => `<div class="br-col" data-row="${m.id}" style="--oc: var(--r-${m.id})" title="${m.name}">
            <div class="br-col-name">${m.short}</div>
            <div class="br-col-val val">–</div>
            <div class="br-col-rail" aria-hidden="true"><div class="br-run"></div></div>
            <div class="br-col-end"><span class="place" hidden></span><span class="br-lend"></span></div>
          </div>`).join("")}
        </div>
        <div class="br-vt-finish">${FLAG}<span><b>Finish</b>: within 10<sup>−8</sup> of the global minimum</span></div>
      </div>
    </div>
    <p class="br-sr" data-live aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></p>
    <footer class="br-foot">
      <span data-raceline></span>
      <details class="br-how" data-how><summary title="How this race was run"><span class="br-info" aria-hidden="true">i</span><span class="br-vh">How this race was run</span></summary>
        <div class="br-how-body">
          <p data-runsnote>Single recorded runs, one per optimizer; an illustration, not a benchmark.</p>
          <p data-ammnote></p>
          <p>HCMA: COCO data archive (Loshchilov 2013), logged samples only.${o.note ? " " + o.note : ""}</p>
        </div>
      </details>
      <span class="br-keys"><kbd>Space</kbd> play · <kbd>R</kbd> restart · <kbd>↑</kbd> <kbd>↓</kbd> function · <kbd>1</kbd>–<kbd>5</kbd> seed</span>
      ${o.source ? `<span><a href="${o.source}" target="_blank" rel="noopener">Source code and data</a> · functions from <a href="https://github.com/numbbo/coco" target="_blank" rel="noopener">COCO</a></span>` : ""}
    </footer>
  </div>
  <aside class="br-side" data-side data-open="false" aria-label="Race controls">
    <button type="button" class="br-side-toggle" data-side-toggle aria-expanded="false" aria-controls="${sideId}" title="Show the controls">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 1h2.8l.4 1.9 1.2.7 1.8-.7 1.4 2.4-1.4 1.3v1.4l1.4 1.3-1.4 2.4-1.8-.7-1.2.7-.4 1.9H6.6l-.4-1.9-1.2-.7-1.8.7-1.4-2.4L3.2 8.7V7.3L1.8 6l1.4-2.4 1.8.7 1.2-.7zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/></svg><span class="br-side-label">Controls</span>
    </button>
    <div class="br-side-body" id="${sideId}">
    <div class="br-sec"><div class="br-eyebrow" data-eyebrow></div><ul class="br-pills" data-pills aria-label="Classification"></ul></div>
    <div class="br-sec" role="group" aria-label="Optimizers in the race"><span class="br-lab">Racers</span><div class="br-opts">${
      OPTIMIZERS.map(m => `<button type="button" class="br-opt" data-o="${m.id}" style="--oc: var(--r-${m.id})" aria-pressed="false"><i aria-hidden="true"></i>${m.name}</button>`).join("")}</div></div>
    <div class="br-sec br-inline" role="group" aria-label="Seed"><span class="br-lab">Seed</span><div class="br-seg" data-seeds>${
      [1, 2, 3, 4, 5].map(s => `<button type="button" data-s="${s}" aria-pressed="false" aria-label="Seed ${s}">${s}</button>`).join("")}</div></div>
    <div class="br-sec br-inline" role="group" aria-label="Playback">
      <button type="button" class="br-tbtn" data-play aria-pressed="true"><svg viewBox="0 0 12 12" aria-hidden="true" data-play-icon></svg><span data-play-label>Pause</span></button>
      <button type="button" class="br-tbtn" data-restart aria-label="Restart this race (R)"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5a4.5 4.5 0 1 1-4.3 3.2l1.4.4A3 3 0 1 0 6 3v1.6L3.2 2.3 6 0z"/></svg>Restart</button>
      <div class="br-seg" data-speeds aria-label="Speed">${SPEEDS.map(v => `<button type="button" data-v="${v}" aria-pressed="false">${v === 0.5 ? "½" : v}×</button>`).join("")}</div>
    </div>
    <div class="br-sec br-inline">
      <div class="br-seg" role="group" aria-label="View"><button type="button" data-view="heat" aria-pressed="true">Heat map</button><button type="button" data-view="elevation" aria-pressed="false">Elevation</button></div>
      <div class="br-seg" role="group" aria-label="Landscape colours"><button type="button" data-cmap="atlas" aria-pressed="true">Atlas</button><button type="button" data-cmap="muted" aria-pressed="false">Muted</button></div>
      <button type="button" class="br-tbtn" data-optimum aria-pressed="true" title="Show the global minimum"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.5 3.6 3.7.3-2.8 2.4.9 3.7L6 8.8 2.7 10.8l.9-3.7L.8 4.7l3.7-.3z"/></svg>Goal</button>
    </div>
    </div>
  </aside>
</div>`;
  const q = s => el.querySelector(s), qa = s => [...el.querySelectorAll(s)];
  const how = q("[data-how]");   // the setup popover closes on a click elsewhere or on Escape
  document.addEventListener("click", e => { if (how.open && !how.contains(e.target)) how.open = false; });
  how.addEventListener("keydown", e => { if (e.key === "Escape") { how.open = false; how.querySelector("summary").focus(); } });

  /* ---------- state ---------- */
  const state = {
    k: 0, seed: 1, view: "heat", cmap: "atlas", optimum: true,
    playing: o.autoplay !== false && !reduceMotion, speed: 1,
    clock: 0, phase: "loading", holdUntil: 0, inView: true,
  };
  let INDEX = null, race = null, token = 0, banner = null;
  const disp = {};
  const cache = new Map();
  const colours = {}, outlines = {};
  let fontUI = "system-ui, sans-serif";
  let confetti = [];

  /* ---------- colours ---------- */
  function hexOf(c) {   // any CSS colour to #rrggbb, through a canvas
    const cx = hexOf.ctx || (hexOf.ctx = document.createElement("canvas").getContext("2d"));
    cx.fillStyle = "#000"; cx.fillStyle = c;
    return cx.fillStyle;
  }
  function luminance(hex) {
    const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4));
    return .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
  }
  let luts = { atlas: B.LUT, muted: B.LUT };
  function readTheme() {
    const cs = getComputedStyle(el);
    for (const m of OPTIMIZERS) {
      const c = hexOf(cs.getPropertyValue(`--r-${m.id}`).trim() || "#888");
      colours[m.id] = c;
      outlines[m.id] = luminance(c) > .4 ? "#0c1318" : "#ffffff";
    }
    colours.pin = hexOf(cs.getPropertyValue("--pin").trim() || "#13212b");
    fontUI = cs.getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";
    colours.stage = hexOf(cs.getPropertyValue("--stage").trim() || "#f8fafb");
    const stops = cs.getPropertyValue("--muted-map").split(",").map(s => hexOf(s.trim())).filter(Boolean);
    luts.muted = B.ramp(stops.length > 1 ? stops : ["#f5f7f8", "#9eabb3"]);
    if (stage) stage.setLut(luts[state.cmap]);
    if (INDEX) drawThumbs();
  }

  /* ---------- index of the 24 functions ---------- */
  const index = q("[data-index]"), buttons = [];
  for (let g = 1; g <= 5; g++) {
    const sec = document.createElement("section");
    sec.className = "br-group";
    sec.innerHTML = `<h3><span class="gnum">${g}</span>${M.GROUPS[g][0]}</h3>`;
    M.META.forEach((m, k) => {
      if (m.group !== g) return;
      const b = document.createElement("button");
      b.type = "button"; b.className = "br-fbtn";
      b.setAttribute("aria-label", `f${k + 1} ${m.name}`);
      b.innerHTML = `<canvas width="44" height="44" aria-hidden="true"></canvas><span class="num">f${k + 1}</span><span class="nm">${m.name}</span>`;
      b.addEventListener("click", () => select(k, state.seed));
      buttons[k] = b;
      sec.appendChild(b);
    });
    index.appendChild(sec);
  }
  function drawThumbs() {
    const lut = luts[state.cmap];
    buttons.forEach((b, k) => {
      const src = INDEX.thumbs[k + 1];
      if (!src) return;
      const h = bytes(src), cv = b.querySelector("canvas"), s = cv.width, ctx = cv.getContext("2d");
      const img = ctx.createImageData(s, s);
      for (let i = 0; i < s * s; i++) {
        const t = h[i], p = 4 * i;
        img.data[p] = lut[4 * t]; img.data[p + 1] = lut[4 * t + 1]; img.data[p + 2] = lut[4 * t + 2]; img.data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }
  function reveal(b) {   // scroll the index only, never the host page
    const ir = index.getBoundingClientRect(), br = b.getBoundingClientRect();
    if (br.top < ir.top) index.scrollTop -= ir.top - br.top + 8;
    else if (br.bottom > ir.bottom) index.scrollTop += br.bottom - ir.bottom + 8;
    if (br.left < ir.left) index.scrollLeft -= ir.left - br.left + 8;
    else if (br.right > ir.right) index.scrollLeft += br.right - ir.right + 8;
  }

  /* ---------- the stage ---------- */
  const view = q("[data-stage]"), tip = q("[data-tip]");
  let stage = null;
  function makeStage(N) {
    stage = B.create({
      container: view, axes: q("[data-axes]"), N, lo: -DOMAIN, hi: DOMAIN, view: "heat", angle: 0,
      reduceMotion, themeElement: el, pinVar: "--pin", lut: luts[state.cmap], contour: .6,
      label: "The landscape with every optimizer's latest samples and best point; drag to turn, scroll to zoom",
      overlay: drawOverlay,
      onNoGL() {
        q('[data-view="elevation"]').disabled = true;
        const n = q("[data-notice]");
        n.hidden = false;
        n.textContent = "Elevation needs WebGL, which this browser did not provide; the heat map is drawn in 2-D.";
      },
      onPoint: (cx, cy) => readout(cx, cy),
      onDrag: () => { tip.hidden = true; },
      onLeave: () => { tip.hidden = true; },
    });
    stage.showPin(false);   // the optimum is drawn on the overlay, so it is not confused with a best ring
    stage.state.zoom = ZOOM_HEAT;   // the top-down map needs no room for turning, so it fills more of the stage
  }

  /* ---------- data ---------- */
  function fileOf(k, seed) { return `f${k + 1}_i${seed}.json`; }
  function load(k, seed) {
    const name = fileOf(k, seed);
    if (!cache.has(name)) {
      const v = (INDEX.races.find(r => r.file === name) || {}).v;   // content hash: a new recording is a new URL
      cache.set(name, fetch(base + "data/" + name + (v ? "?v=" + v : "")).then(r => {
        if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
        return r.json();
      }).then(decodeRace));
      cache.get(name).catch(() => cache.delete(name));
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    return cache.get(name);
  }
  function decodeRace(d) {
    const xr = INDEX.x_range, runs = {};
    for (const m of OPTIMIZERS) {
      const r = d.runs[m.id], S = r.samples;
      const xb = bytes(r.x), rb = bytes(r.r);
      const xq = new Uint16Array(xb.buffer), rq = new Int16Array(rb.buffer);
      const x = new Float32Array(2 * S), lg = new Float32Array(S), best = new Int32Array(S);
      for (let i = 0; i < 2 * S; i++) x[i] = xq[i] / 65535 * 2 * xr - xr;
      let b = 0;
      for (let i = 0; i < S; i++) { lg[i] = rq[i] / 1000; if (lg[i] < lg[b]) b = i; best[i] = b; }
      runs[m.id] = { S, x, lg, best, finish: r.finish, t: r.t ? new Uint16Array(bytes(r.t).buffer) : null };
    }
    const land = d.landscape, codes = B.decode(land.data), N = Math.round(Math.sqrt(codes.length));
    return { f: d.function, seed: d.instance, land, N, codes, runs, fields: {} };
  }
  function countAt(run, T) {   // samples made by evaluation T
    if (!run.t) return Math.min(T, run.S);
    let lo = 0, hi = run.S;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (run.t[mid] <= T) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* ---------- selection ---------- */
  function select(k, seed, opts = {}) {
    state.k = k; state.seed = seed;
    const m = M.META[k];
    q("[data-eyebrow]").textContent = `Group ${m.group} of 5 · ${M.GROUPS[m.group][1]}`;
    q("[data-fsym] sub").textContent = k + 1;
    q("[data-fname]").textContent = m.name;
    q("[data-pills]").innerHTML = m.pills.map(([c, t]) =>
      `<li class="br-pill" title="${M.CATS[c]}" style="--c: var(--c-${c})"><i aria-hidden="true"></i><span>${t}</span></li>`).join("");
    buttons.forEach((b, i) => b.setAttribute("aria-current", i === k ? "true" : "false"));
    qa("[data-s]").forEach(b => b.setAttribute("aria-pressed", +b.dataset.s === seed));
    if (opts.scroll !== false) reveal(buttons[k]);
    if (o.hash) try { history.replaceState(null, "", `#f${k + 1}-s${seed}`); } catch (e) { /* sandboxed */ }
    const my = ++token;
    state.phase = "loading";
    hideBanner(true);
    load(k, seed).then(r => {
      if (my !== token) return;
      if (!stage) makeStage(r.N);
      race = r;
      if (!r.fields.log) r.fields.log = B.field(r.land, r.codes, r.N, "log");
      stage.setField(r.fields.log, opts.blend !== false && !!stage.current);
      q("[data-raceline]").innerHTML = `bbob f${r.f}, instance ${r.seed} · budget ${INDEX.budget} = 1000 × D · x<sub>opt</sub> = (${B.coord(r.land.x_opt[0])}, ${B.coord(r.land.x_opt[1])})`;
      q("[data-notice]").hidden = !!stage.state.renderer;
      restart();
      load(nextK(k), seed).catch(() => {});   // the next race, ahead of time
    }).catch(err => {
      if (my !== token) return;
      const n = q("[data-notice]");
      n.hidden = false;
      n.textContent = `Could not load the race data (${err.message}).`;
    });
  }
  function restart() {
    if (!race) return;
    state.clock = 0; state.phase = "race";
    for (const m of OPTIMIZERS) disp[m.id] = { m: 0, bi: -1, p: 0, ring: null, shown: "" };
    announced = null;
    confetti = [];
    hideBanner(true);
    tip.hidden = true;
    lastLive = "";
  }
  const loopFrom = (o.loopFrom || 15) - 1;
  function nextK(k) { return k + 1 >= 24 ? loopFrom : k + 1; }   // f24 wraps to loopFrom
  function next() { select(nextK(state.k), state.seed); }

  /* ---------- controls ---------- */
  const side = q("[data-side]"), sideBtn = q("[data-side-toggle]"), SIDE_KEY = "bbob-race-controls";
  function setSide(open) {   // the drawer is closed by default; the viewer's choice is remembered
    side.dataset.open = open;
    sideBtn.setAttribute("aria-expanded", open);
    sideBtn.title = open ? "Hide the controls" : "Show the controls";
    try { localStorage.setItem(SIDE_KEY, open ? "1" : "0"); } catch (e) { /* storage blocked */ }
  }
  let sideOpen = o.controls === "open";
  try { const v = localStorage.getItem(SIDE_KEY); if (v !== null) sideOpen = v === "1"; } catch (e) { /* storage blocked */ }
  setSide(sideOpen);
  sideBtn.addEventListener("click", () => setSide(side.dataset.open !== "true"));
  function setOn(id, show) {
    if (show) on.add(id); else on.delete(id);
    q(`[data-o="${id}"]`).setAttribute("aria-pressed", show);
    q(`[data-row="${id}"]`).hidden = !show;
    el.style.setProperty("--lanes", Math.max(1, on.size));
  }
  OPTIMIZERS.forEach(m => setOn(m.id, on.has(m.id)));
  qa("[data-o]").forEach(b => b.addEventListener("click", () => setOn(b.dataset.o, !on.has(b.dataset.o))));
  qa("[data-s]").forEach(b => b.addEventListener("click", () => select(state.k, +b.dataset.s)));
  function setPlaying(p) {
    state.playing = p;
    q("[data-play]").setAttribute("aria-pressed", p);
    q("[data-play-label]").textContent = p ? "Pause" : "Play";
    q("[data-play-icon]").innerHTML = p
      ? '<rect x="2" y="1.5" width="2.6" height="9" rx=".6"/><rect x="7.4" y="1.5" width="2.6" height="9" rx=".6"/>'
      : '<path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z"/>';
    if (p && state.phase === "hold") state.holdUntil = Math.max(state.holdUntil, performance.now() + 600);
  }
  q("[data-play]").addEventListener("click", () => setPlaying(!state.playing));
  q("[data-restart]").addEventListener("click", () => { restart(); setPlaying(true); });
  function setSpeed(v) {
    state.speed = v;
    qa("[data-v]").forEach(b => b.setAttribute("aria-pressed", +b.dataset.v === v));
  }
  qa("[data-v]").forEach(b => b.addEventListener("click", () => setSpeed(+b.dataset.v)));
  function setView(v) {
    if (!stage || !stage.setView(v)) return;
    state.view = v;
    stage.state.zoom = v === "heat" ? ZOOM_HEAT : 1;
    qa("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === v));
    tip.hidden = true;
  }
  qa("[data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  function setCmap(c) {
    state.cmap = c;
    qa("[data-cmap]").forEach(b => b.setAttribute("aria-pressed", b.dataset.cmap === c));
    if (stage) stage.setLut(luts[c]);
    if (INDEX) drawThumbs();
  }
  qa("[data-cmap]").forEach(b => b.addEventListener("click", () => setCmap(b.dataset.cmap)));
  q("[data-optimum]").addEventListener("click", () => {
    state.optimum = !state.optimum;
    q("[data-optimum]").setAttribute("aria-pressed", state.optimum);
  });
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key.toLowerCase();
    if (k === "arrowdown" || k === "j") { e.preventDefault(); select((state.k + 1) % 24, state.seed); buttons[state.k].focus({ preventScroll: true }); }
    else if (k === "arrowup" || k === "k") { e.preventDefault(); select((state.k + 23) % 24, state.seed); buttons[state.k].focus({ preventScroll: true }); }
    else if (/^[1-5]$/.test(k)) select(state.k, +k);
    else if (k === "r") { restart(); setPlaying(true); }
    else if (k === "h") setView("heat");
    else if (k === "e") setView("elevation");
    else if (k === " " && !(t instanceof HTMLButtonElement)) { e.preventDefault(); setPlaying(!state.playing); }
  }
  if (o.keys === "global") document.addEventListener("keydown", onKey);
  else {
    el.tabIndex = -1;
    el.addEventListener("keydown", onKey);
    view.addEventListener("pointerdown", () => el.focus({ preventScroll: true }));
  }

  /* ---------- the track ---------- */
  const scale = q("[data-scale]");
  function drawScale() {   // a label per decade (every other one, counted from the finish, when short)
    const h = scale.clientHeight, n = LOG_START - LOG_FINISH, stride = h / n < 17 ? 2 : 1;
    let html = "";
    for (let e = LOG_START; e >= LOG_FINISH; e--) {
      if (e !== LOG_START && (e - LOG_FINISH) % stride) continue;
      if (e !== LOG_START && stride > 1 && e - LOG_FINISH === n - 1) continue;   // too close to the start label
      const p = (LOG_START - e) / n;
      html += `<span style="top:${(100 * p).toFixed(2)}%">${e === LOG_START ? "≥" : ""}10${B.sup(e)}</span>`;
    }
    scale.innerHTML = html;
  }
  if (root.ResizeObserver) new ResizeObserver(drawScale).observe(scale);
  const position = lg => Math.min(1, Math.max(0, (LOG_START - lg) / (LOG_START - LOG_FINISH)));

  /* ---------- the winner ---------- */
  let announced = null, lastLive = "";
  const live = q("[data-live]"), win = q("[data-win]");
  function nameOf(id) { return OPTIMIZERS.find(m => m.id === id).name; }
  function hideBanner(now) {
    if (banner) { clearTimeout(banner.t1); clearTimeout(banner.t2); banner = null; }
    if (now) { win.hidden = true; win.className = "br-win"; return; }
    win.classList.add("out");
    setTimeout(() => { if (!banner) win.hidden = true; }, 500);
  }
  function letters(text) {
    return [...text].map((c, i) => `<span style="--i:${i}">${c === " " ? "&nbsp;" : c}</span>`).join("");
  }
  function showBanner(kind, ids, extra) {
    hideBanner(true);
    const id = ids[0];
    let name, sub, colour = colours[id], outline = outlines[id];
    if (kind === "win") {
      name = nameOf(id);
      sub = `wins! It reached 10<sup>−8</sup> after ${extra} evaluations.`;
    } else if (kind === "tie") {
      name = "Dead heat!";
      colour = colours.pin; outline = colours.stage;
      sub = `${ids.map(nameOf).join(" and ")} reached 10<sup>−8</sup> after ${extra} evaluations.`;
    } else {
      name = nameOf(id);
      sub = `Photo finish: nobody reached 10<sup>−8</sup> in ${INDEX.budget} evaluations; this one got closest, to ${B.num(Math.pow(10, extra), 2)}.`;
    }
    win.className = "br-win" + (kind === "photo" ? " small" : "");
    win.style.setProperty("--wc", colour);
    win.style.setProperty("--wo", outline);
    win.innerHTML = `<div class="br-win-row">${kind === "photo" ? "" : `<span class="br-win-flag" style="color:${colours.pin}">${FLAG}</span>`}<div class="br-win-name">${letters(name)}</div></div><div class="br-win-sub">${sub}</div>`;
    win.hidden = false;
    live.textContent = `${kind === "tie" ? "Dead heat: " + ids.map(nameOf).join(" and ") : nameOf(id) + (kind === "photo" ? " is closest at the end" : " wins")} on f${state.k + 1}, seed ${state.seed}.`;
    banner = { t1: setTimeout(() => hideBanner(false), BANNER_MS) };
    if (o.confetti && !reduceMotion && kind !== "photo") burst(ids.map(i => colours[i]));
  }
  function burst(cols) {
    const w = view.clientWidth, h = view.clientHeight;
    for (let i = 0; i < 150; i++) {
      const a = -Math.PI / 2 + (Math.random() - .5) * 2.2, v = 260 + Math.random() * 420;
      confetti.push({
        x: w / 2 + (Math.random() - .5) * w * .3, y: h * .5, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        r: Math.random() * Math.PI, vr: (Math.random() - .5) * 14, s: 5 + Math.random() * 6,
        c: Math.random() < .2 ? colours.pin : cols[i % cols.length], life: 2.2 + Math.random() * 1.2,
      });
    }
  }

  /* ---------- drawing: samples, best rings, the optimum, confetti ---------- */
  function cross(ctx, x, y, s, col, out, lw = 2) {
    ctx.beginPath();
    ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
    ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s);
    ctx.strokeStyle = out; ctx.lineWidth = lw + 2.2; ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
  }
  function star(ctx, x, y, r, col, out) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r;
      ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.strokeStyle = out; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = col; ctx.fill();
  }
  const clampD = v => Math.max(-DOMAIN, Math.min(DOMAIN, v));
  let frameDt = 0;
  function drawOverlay(ctx, project, w, h) {
    if (race) {
      ctx.lineCap = "round";
      const labels = [], rings = [], todo = [];   // labels are drawn last, on top, and never overlap
      const overlaps = (x, w, top, hgt) =>
        labels.some(b => x - w / 2 < b.x + b.w / 2 && x + w / 2 > b.x - b.w / 2 && top < b.top + b.h && top + hgt > b.top) ||
        rings.some(c => Math.max(Math.abs(x - c.x) - w / 2, 0) ** 2 + Math.max(top - c.y, c.y - (top + hgt), 0) ** 2 < (c.r + 2) ** 2);
      function label(text, x, y, size, weight, col, out, dir = -1, below = null) {   // dir -1: above y, +1: below y
        ctx.font = `${weight} ${size}px ${fontUI}`;
        const w = ctx.measureText(text).width, hgt = size + 2;
        let top = dir < 0 ? y - hgt : y;
        for (let tries = 0; tries < 12 && overlaps(x, w, top, hgt); tries++) top += dir * (hgt / 2 + 1);
        if (dir < 0 && top < 26 && below !== null) {   // pushed into the clock: put it under the marker
          top = below;
          for (let tries = 0; tries < 12 && overlaps(x, w, top, hgt); tries++) top += hgt / 2 + 1;
        }
        labels.push({ x, w, top, h: hgt });
        ctx.globalAlpha = 1;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.lineJoin = "round"; ctx.lineWidth = 3.5; ctx.strokeStyle = out;
        ctx.strokeText(text, x, top);
        ctx.fillStyle = col; ctx.fillText(text, x, top);
      }
      let goal = null;
      if (state.optimum) {   // the goal: the global minimum
        const [px, py] = project(race.land.x_opt[0], race.land.x_opt[1]);
        ctx.globalAlpha = .95;
        star(ctx, px, py, 8, colours.pin, colours.stage);
        goal = [px, py];
      }
      const shown = OPTIMIZERS.filter(m => on.has(m.id));
      for (const m of shown) {   // samples, oldest first; AMM's are larger
        const run = race.runs[m.id], d = disp[m.id], big = m.id === "amm";
        for (let j = Math.max(0, d.m - TRAIL); j < d.m; j++) {
          let x = run.x[2 * j], y = run.x[2 * j + 1], a = 1 - (d.m - 1 - j) / TRAIL;
          if (Math.abs(x) > DOMAIN || Math.abs(y) > DOMAIN) { x = clampD(x); y = clampD(y); a *= .5; }
          const [px, py] = project(x, y);
          ctx.globalAlpha = a;
          cross(ctx, px, py, big ? 7 : 5, colours[m.id], outlines[m.id], big ? 2.8 : 2);
        }
      }
      const tnow = performance.now();
      const at = id => {   // the best point's screen position, gliding after an improvement
        const g = disp[id].ring, u = reduceMotion ? 1 : ease(Math.min(1, (tnow - g.t0) / GLIDE_MS));
        return project(clampD(g.fx + (g.tx - g.fx) * u), clampD(g.fy + (g.ty - g.fy) * u));
      };
      const rivals = shown.filter(m => m.id !== "amm" && disp[m.id].ring);
      const amm = shown.find(m => m.id === "amm" && disp[m.id].ring);
      rivals.forEach((m, i) => {   // the others' best rings, nested so they stay visible together
        const [px, py] = at(m.id), r = 7 + 3 * i;
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
        ctx.strokeStyle = outlines[m.id]; ctx.lineWidth = 5; ctx.stroke();
        ctx.strokeStyle = colours[m.id]; ctx.lineWidth = 2.6; ctx.stroke();
        rings.push({ x: px, y: py, r });
        todo.push([m.short, px, py - r - 3, 10, 650, colours[m.id], outlines[m.id], -1, py + r + 3]);
      });
      if (amm) {   // AMM's bull's-eye on top of every ring, and its label placed first
        const [px, py] = at("amm"), c = colours.amm, o = outlines.amm;
        ctx.globalAlpha = 1;
        for (const [r, lw] of [[14, 2.8], [8.5, 2.6]]) {
          ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
          ctx.strokeStyle = o; ctx.lineWidth = lw + 2.6; ctx.stroke();
          ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(px, py, 3.4, 0, 2 * Math.PI);
        ctx.fillStyle = c; ctx.fill(); ctx.strokeStyle = o; ctx.lineWidth = 1.5; ctx.stroke();
        rings.push({ x: px, y: py, r: 14 });
        todo.unshift(["AMM (Ours)", px, py - 17, 13, 800, c, o, -1, py + 17]);
      }
      for (const a of todo) label(...a);
      if (goal) label("global minimum", goal[0], goal[1] + 10, 10.5, 600, colours.pin, colours.stage, 1);
    }
    if (confetti.length) {
      const dt = frameDt;
      confetti = confetti.filter(p => (p.life -= dt) > 0);
      for (const p of confetti) {
        p.vy += 900 * dt; p.vx *= 1 - 1.2 * dt; p.vy *= 1 - .6 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / .6);
        ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- hover readout (as in the Atlas) ---------- */
  function readout(cx, cy) {
    if (!race || !stage.current) return;
    const hit = stage.pick(cx, cy), N = race.N;
    if (!hit || Math.abs(hit[0]) > 1 || Math.abs(hit[1]) > 1) { tip.hidden = true; return; }
    const i = Math.round((hit[0] + 1) / 2 * (N - 1)), j = Math.round((hit[1] + 1) / 2 * (N - 1));
    const x1 = -DOMAIN + 2 * DOMAIN * i / (N - 1), x2 = -DOMAIN + 2 * DOMAIN * j / (N - 1);
    const lv = stage.current.logv[j * N + i], delta = lv === -Infinity ? 0 : Math.pow(10, lv);
    tip.innerHTML = `x = (${B.coord(x1)}, ${B.coord(x2)})<br>f − f<sub>opt</sub> = ${B.num(delta)}`;
    const r = view.getBoundingClientRect();
    tip.style.left = `${Math.min(cx - r.left, r.width - 190)}px`;
    tip.style.top = `${cy - r.top}px`;
    tip.hidden = false;
  }

  /* ---------- one frame ---------- */
  let last = performance.now();
  function frame() {
    const tnow = performance.now(), dt = Math.min(0.1, (tnow - last) / 1000);
    last = tnow;
    frameDt = dt;
    if (race && state.phase !== "loading") step(tnow, dt);
    if (stage && state.inView) stage.draw();
    requestAnimationFrame(frame);
  }
  function step(tnow, dt) {
    const budget = INDEX.budget;
    if (state.phase === "race" && state.playing && state.inView) {
      state.clock = Math.min(budget, state.clock + dt * (RATE0 + RATE1 * state.clock) * state.speed);
    }
    const T = Math.floor(state.clock);
    const shown = OPTIMIZERS.filter(m => on.has(m.id));
    const k = 1 - Math.exp(-dt * 14);
    for (const m of OPTIMIZERS) {
      const run = race.runs[m.id], d = disp[m.id];
      d.m = countAt(run, T);
      let target = 0;
      if (d.m > 0) {
        const bi = run.best[d.m - 1];
        if (bi !== d.bi) {
          const tx = run.x[2 * bi], ty = run.x[2 * bi + 1];
          if (!d.ring) d.ring = { fx: tx, fy: ty, tx, ty, t0: 0 };
          else {
            const u = reduceMotion ? 1 : ease(Math.min(1, (tnow - d.ring.t0) / GLIDE_MS));
            d.ring = { fx: d.ring.fx + (d.ring.tx - d.ring.fx) * u, fy: d.ring.fy + (d.ring.ty - d.ring.fy) * u, tx, ty, t0: tnow };
          }
          d.bi = bi;
        }
        target = position(run.lg[bi]);
      } else { d.ring = null; d.bi = -1; }
      d.p = reduceMotion || state.clock === 0 ? target : d.p + (target - d.p) * k;
      if (target - d.p < 1e-4) d.p = target;
    }
    // standings: finishers by finishing evaluation (ties share a place), then the rest by best value
    const done = id => race.runs[id].finish !== null && race.runs[id].finish <= T;
    const fin = shown.filter(m => done(m.id)).sort((a, b) => race.runs[a.id].finish - race.runs[b.id].finish);
    const place = {};
    fin.forEach((m, i) => {
      const prev = fin[i - 1];
      place[m.id] = prev && race.runs[prev.id].finish === race.runs[m.id].finish ? place[prev.id] : i + 1;
    });
    const ended = shown.length > 0 && (fin.length === shown.length || state.clock >= budget);
    if (ended && fin.length < shown.length) {
      const rest = shown.filter(m => !done(m.id)).sort((a, b) => bestLog(a.id, T) - bestLog(b.id, T));
      rest.forEach((m, i) => { place[m.id] = fin.length + i + 1; });
    }
    for (const m of OPTIMIZERS) paintLane(m.id, place[m.id], done(m.id) ? race.runs[m.id].finish : null, T);
    // the winner: the first finishers among the optimizers on the track
    if (fin.length) {
      const first = race.runs[fin[0].id].finish;
      const ids = fin.filter(m => race.runs[m.id].finish === first).map(m => m.id);
      const key = ids.join(",");
      if (announced !== key) { announced = key; showBanner(ids.length > 1 ? "tie" : "win", ids, first); }
    } else if (announced && !announced.startsWith("photo")) {
      announced = null; hideBanner(true);
    }
    if (ended && state.phase === "race") {
      if (!fin.length) {
        const best = shown.slice().sort((a, b) => bestLog(a.id, T) - bestLog(b.id, T))[0];
        announced = "photo:" + best.id;
        showBanner("photo", [best.id], bestLog(best.id, T));
      }
      state.phase = "hold";
      state.holdUntil = tnow + HOLD_MS;
    }
    if (state.phase === "hold" && state.playing && o.autoplay !== false && tnow >= state.holdUntil) next();
    // the clock in the corner
    const clock = q("[data-clock]");
    const nextIn = state.phase === "hold" && state.playing && o.autoplay !== false
      ? ` · next: f${nextK(state.k) + 1} in ${Math.max(0, Math.ceil((state.holdUntil - tnow) / 1000))} s` : "";
    const text = shown.length
      ? `Evaluation <b>${T}</b> / ${budget}${state.playing ? "" : " · paused"}${nextIn}`
      : "Turn on at least one optimizer to race";
    if (clock.dataset.t !== text) { clock.innerHTML = text; clock.dataset.t = text; }
  }
  function bestLog(id, T) {
    const run = race.runs[id], n = countAt(run, T);
    return n ? run.lg[run.best[n - 1]] : Infinity;
  }
  function paintLane(id, place, finish, T) {
    const row = q(`[data-row="${id}"]`), d = disp[id];
    if (row.hidden) return;
    row.querySelector(".br-run").style.setProperty("--p", d.p.toFixed(4));
    const lg = bestLog(id, T);
    const val = lg === Infinity ? "–" : B.num(Math.pow(10, lg), 2);
    const pl = place ? ORD(place) : "";
    const key = `${val}|${pl}|${finish ?? ""}`;
    if (d.shown === key) return;
    d.shown = key;
    row.querySelector(".val").innerHTML = val;
    const p = row.querySelector(".place");
    p.hidden = !place; p.textContent = pl;
    row.querySelector(".br-lend").textContent = finish ?? "";
  }

  /* ---------- visibility and theme ---------- */
  if (root.IntersectionObserver) {
    new IntersectionObserver(es => { state.inView = es[es.length - 1].isIntersecting; last = performance.now(); })
      .observe(el);
  }
  document.addEventListener("visibilitychange", () => { last = performance.now(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", readTheme);
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  /* ---------- start ---------- */
  function hashed() {
    const m = /^#f(\d{1,2})(?:-s([1-5]))?$/.exec(location.hash || "");
    return m && +m[1] >= 1 && +m[1] <= 24 ? { f: +m[1], seed: m[2] ? +m[2] : 1 } : null;
  }
  setPlaying(state.playing);
  setSpeed(1);
  readTheme();
  fetch(base + "index.json", { cache: "no-cache" }).then(r => r.json()).then(ix => {   // always revalidated
    INDEX = ix;
    if (ix.amm_note) q("[data-ammnote]").textContent = ix.amm_note;
    if (ix.runs_note) q("[data-runsnote]").textContent = ix.runs_note;
    drawThumbs();
    drawScale();
    const s = (o.hash && hashed()) || o.start || { f: 15, seed: 1 };
    select(s.f - 1, s.seed, { blend: false, scroll: false });
    if (o.hash) addEventListener("hashchange", () => { const h = hashed(); if (h) select(h.f - 1, h.seed); });
  }).catch(err => {
    const n = q("[data-notice]");
    n.hidden = false;
    n.textContent = `Could not load the race index (${err.message}).`;
  });
  requestAnimationFrame(frame);
  return { select: (f, seed) => select(f - 1, seed), state, get race() { return race; } };
}

root.BBOBRace = { mount, OPTIMIZERS };
})(window);
