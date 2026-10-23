/* The BBOB Landscape Atlas page: the index of the 24 functions, the title block, the controls and
   the readout. The renderer is src/landscape.js; build.py inlines both and the grid data. */
(() => {
"use strict";

const DATA = window.BBOB_LANDSCAPES;
const { GROUPS, CATS, META } = window.BBOB_META;
const B = window.BBOBLandscape;
const { LUT, num, neg, sup, coord } = B;

const N = DATA.grid, LO = DATA.domain[0], HI = DATA.domain[1];
const TURN_SECONDS = 72;            // one full turn
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = id => document.getElementById(id);

/* ---------- data ---------- */
const CODES = DATA.functions.map(f => B.decode(f.data));
const fields = new Map();
function field(k, scale) {
  const key = k + scale;
  if (!fields.has(key)) fields.set(key, B.field(DATA.functions[k], CODES[k], N, scale));
  return fields.get(key);
}

/* ---------- index ---------- */
const index = $("index"), buttons = [];
$("brand-sub").textContent = `instance ${DATA.instance} · 24 functions`;
for (let g = 1; g <= 5; g++) {
  const sec = document.createElement("section");
  sec.className = "group";
  sec.innerHTML = `<h2><span class="gnum">${g}</span>${GROUPS[g][0]}</h2>`;
  META.forEach((m, k) => {
    if (m.group !== g) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "fbtn"; b.dataset.k = k;
    b.setAttribute("aria-label", `f${k + 1} ${m.name}`);
    b.innerHTML = `<canvas width="44" height="44" aria-hidden="true"></canvas><span class="num">f${k + 1}</span><span class="nm">${m.name}</span>`;
    b.addEventListener("click", () => select(k));
    buttons[k] = b;
    sec.appendChild(b);
  });
  index.appendChild(sec);
}
function thumbnail(k) {
  const cv = buttons[k].querySelector("canvas"), s = cv.width, ctx = cv.getContext("2d");
  const img = ctx.createImageData(s, s), h = field(k, "log").h;
  for (let r = 0; r < s; r++) for (let c = 0; c < s; c++) {
    const j = Math.round((s - 1 - r) / (s - 1) * (N - 1)), i = Math.round(c / (s - 1) * (N - 1));
    const t = Math.min(255, Math.max(0, Math.round(h[j * N + i] * 255))), o = 4 * (r * s + c);
    img.data[o] = LUT[4 * t]; img.data[o + 1] = LUT[4 * t + 1]; img.data[o + 2] = LUT[4 * t + 2]; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------- state ---------- */
const state = { k: 0, view: "elevation", scale: "log", spin: !reduceMotion, opt: true };
const now = () => performance.now();

/* ---------- renderer ---------- */
const view = $("view"), tip = $("tip");
const stage = B.create({
  container: view, axes: $("axes"), N, lo: LO, hi: HI, reduceMotion,
  onNoGL() {
    $("v-elev").disabled = true;
    state.view = "heat";
    const note = $("notice");
    note.hidden = false;
    note.textContent = "Elevation needs WebGL, which this browser did not provide; the heat map is drawn in 2-D.";
  },
  onPoint: (cx, cy) => readout(cx, cy),
  onDrag: () => { tip.hidden = true; },
  onLeave: () => { tip.hidden = true; },
});

/* ---------- selection ---------- */
function setField(next, blend) {
  stage.setField(next, blend);
  legend();
}

function select(k, opts = {}) {
  state.k = k;
  const m = META[k], f = DATA.functions[k];
  $("eyebrow").textContent = `Group ${m.group} of 5 · ${GROUPS[m.group][1]}`;
  $("fsym").querySelector("sub").textContent = k + 1;
  $("fname").textContent = m.name;
  $("pills").innerHTML = m.pills.map(([c, t]) =>
    `<li class="pill" title="${CATS[c]}" style="--c: var(--c-${c})"><i aria-hidden="true"></i><span>${t}</span></li>`).join("");
  $("desc").innerHTML = m.text;
  $("optline").innerHTML = `<b>x<sub>opt</sub></b> = (${coord(f.x_opt[0])}, ${coord(f.x_opt[1])}) · <b>f<sub>opt</sub></b> = ${neg(f.f_opt.toFixed(2))}`;
  document.title = `f${k + 1} ${m.name} · BBOB Landscape Atlas`;
  buttons.forEach((b, i) => b.setAttribute("aria-current", i === k ? "true" : "false"));
  if (opts.scroll !== false) reveal(buttons[k]);
  try { history.replaceState(null, "", `#f${k + 1}`); } catch (e) { /* sandboxed */ }
  setField(field(k, state.scale), opts.blend !== false);
  stage.setPin(f.x_opt);
  tip.hidden = true;
}

function reveal(b) {   // scroll the index only (scrollIntoView may move the host page)
  const ir = index.getBoundingClientRect(), br = b.getBoundingClientRect();
  if (br.top < ir.top) index.scrollTop -= ir.top - br.top + 8;
  else if (br.bottom > ir.bottom) index.scrollTop += br.bottom - ir.bottom + 8;
  if (br.left < ir.left) index.scrollLeft -= ir.left - br.left + 8;
  else if (br.right > ir.right) index.scrollLeft += br.right - ir.right + 8;
}

function setView(v) {
  if (!stage.setView(v)) return;
  state.view = v;
  $("v-heat").setAttribute("aria-pressed", v === "heat");
  $("v-elev").setAttribute("aria-pressed", v === "elevation");
  tip.hidden = true;
}
function setScale(s) {
  state.scale = s;
  $("s-log").setAttribute("aria-pressed", s === "log");
  $("s-lin").setAttribute("aria-pressed", s === "linear");
  setField(field(state.k, s), true);
  stage.setPin(DATA.functions[state.k].x_opt);
}
function setSpin(on) {
  state.spin = on;
  const b = $("spin");
  b.setAttribute("aria-pressed", on);
  $("spin-label").textContent = on ? "Pause" : "Rotate";
  $("spin-icon").innerHTML = on
    ? '<rect x="2" y="1.5" width="2.6" height="9" rx=".6"/><rect x="7.4" y="1.5" width="2.6" height="9" rx=".6"/>'
    : '<path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5z"/>';
}
function setOpt(on) {
  state.opt = on;
  $("opt").setAttribute("aria-pressed", on);
  stage.showPin(on);
}

/* the colour bar under the controls, with ticks at real values */
function legend() {
  const cv = $("legend"), ctx = cv.getContext("2d"), w = cv.width;
  for (let x = 0; x < w; x++) {
    const t = Math.round(x / (w - 1) * 255);
    ctx.fillStyle = `rgb(${LUT[4 * t]},${LUT[4 * t + 1]},${LUT[4 * t + 2]})`;
    ctx.fillRect(x, 0, 1, cv.height);
  }
  const F = stage.current, ticks = [];
  if (F.scale === "log") {
    let a = Math.ceil(F.lo - 1e-9), b = Math.floor(F.hi + 1e-9);
    const stride = Math.max(1, Math.ceil((b - a + 1) / 6));
    for (let e = a; e <= b; e += stride) ticks.push([(e - F.lo) / (F.hi - F.lo), `10${sup(e)}`]);
    $("legend-lab").innerHTML = "f(x) − f<sub>opt</sub>, log scale";
  } else {
    const raw = F.hi / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    const stepv = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
    for (let v = 0; v <= F.hi * 1.0001; v += stepv) ticks.push([v / F.hi, num(v, 2)]);
    $("legend-lab").innerHTML = "f(x) − f<sub>opt</sub>, linear scale";
  }
  $("ticks").innerHTML = ticks.map(([t, s]) => `<span style="left:${(100 * t).toFixed(2)}%">${s}</span>`).join("");
}

/* ---------- readout ---------- */
function readout(cx, cy) {
  const hit = stage.pick(cx, cy);
  if (!hit || Math.abs(hit[0]) > 1 || Math.abs(hit[1]) > 1) { tip.hidden = true; return; }
  const i = Math.round((hit[0] + 1) / 2 * (N - 1)), j = Math.round((hit[1] + 1) / 2 * (N - 1));
  const x1 = LO + (HI - LO) * i / (N - 1), x2 = LO + (HI - LO) * j / (N - 1);
  const f = DATA.functions[state.k], lv = stage.current.logv[j * N + i];
  const delta = lv === -Infinity ? 0 : Math.pow(10, lv);
  const places = delta > 0 ? Math.min(6, Math.max(0, 2 - Math.floor(Math.log10(delta)))) : 2;
  const fx = delta >= 1e5 ? num(f.f_opt + delta) : neg((f.f_opt + delta).toFixed(places));
  tip.innerHTML = `x = (${coord(x1)}, ${coord(x2)})<br>f − f<sub>opt</sub> = ${num(delta)}<br>f = ${fx}`;
  const r = view.getBoundingClientRect();
  tip.style.left = `${Math.min(cx - r.left, r.width - 190)}px`;
  tip.style.top = `${cy - r.top}px`;
  tip.hidden = false;
}

/* ---------- controls ---------- */
$("v-heat").addEventListener("click", () => setView("heat"));
$("v-elev").addEventListener("click", () => setView("elevation"));
$("s-log").addEventListener("click", () => setScale("log"));
$("s-lin").addEventListener("click", () => setScale("linear"));
$("spin").addEventListener("click", () => setSpin(!state.spin));
$("opt").addEventListener("click", () => setOpt(!state.opt));
document.addEventListener("keydown", e => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === "arrowdown" || k === "arrowright" || k === "j") { e.preventDefault(); select((state.k + 1) % 24); buttons[state.k].focus({ preventScroll: true }); }
  else if (k === "arrowup" || k === "arrowleft" || k === "k") { e.preventDefault(); select((state.k + 23) % 24); buttons[state.k].focus({ preventScroll: true }); }
  else if (k === "h") setView("heat");
  else if (k === "e") setView("elevation");
  else if (k === "l") setScale(state.scale === "log" ? "linear" : "log");
  else if (k === " " && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); setSpin(!state.spin); }
});

/* ---------- loop ---------- */
let last = now();
function frameLoop() {
  const t = now(), dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  if (state.spin && !stage.state.dragging) stage.state.angle += dt * 2 * Math.PI / TURN_SECONDS;
  stage.draw();
  requestAnimationFrame(frameLoop);
}

/* ---------- start ---------- */
function hashed() {   // #f1 .. #f24 links to one function
  const m = /^#f(\d{1,2})$/.exec(location.hash || "");
  return m && +m[1] >= 1 && +m[1] <= 24 ? +m[1] - 1 : null;
}
const startK = hashed() ?? 0;
addEventListener("hashchange", () => { const k = hashed(); if (k !== null && k !== state.k) select(k); });
setSpin(state.spin);
if (state.view === "heat") {
  $("v-heat").setAttribute("aria-pressed", "true"); $("v-elev").setAttribute("aria-pressed", "false");
}
select(startK, { blend: false, scroll: false });
$("srcline").textContent = `${DATA.grid} × ${DATA.grid} grid on [−5, 5]² · bbob instance ${DATA.instance} · ${DATA.source}`;
requestAnimationFrame(frameLoop);
const pending = META.map((_, k) => k);
(function thumbs() {
  const t = now();
  while (pending.length && now() - t < 12) thumbnail(pending.shift());
  if (pending.length) setTimeout(thumbs, 0);
})();
})();
