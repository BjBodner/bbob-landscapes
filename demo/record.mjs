// Records the 30-second demo of index.html, or the link-preview image, with headless Chrome.
//
//   node demo/record.mjs video     -> demo/out/bbob-landscapes-demo.mp4 (1080 x 1080, 30 fps, H.264)
//   node demo/record.mjs preview   -> preview.png (1200 x 627, for og:image)
//
// The page runs on a fake clock (performance.now and requestAnimationFrame are replaced
// before its scripts load), so every frame is rendered and captured exactly 1/30 s apart.
// Clicks, hovers and drags are real mouse events sent through the DevTools protocol; the
// cursor, captions and title cards are overlays drawn only for the recording.
// Needs Chrome (or CHROME=path) and ffmpeg on PATH.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "demo", "out");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const FPS = 30;
const SECONDS = 30;
const mode = process.argv[2] || "video";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- DevTools protocol ---------- */
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(`${JSON.stringify(m.error)}`)); else res(m.result);
      } else if (m.method) {
        for (const l of [...this.listeners]) l(m);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  once(method) {
    return new Promise(res => {
      const l = m => {
        if (m.method !== method) return;
        this.listeners.splice(this.listeners.indexOf(l), 1);
        res(m.params);
      };
      this.listeners.push(l);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/* ---------- injected before the page's own scripts ---------- */
const INJECT = String.raw`(() => {
  let T = 1000;
  const queue = [];
  performance.now = () => T;
  window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  window.__advance = ms => { T += ms; const q = queue.splice(0); for (const cb of q) cb(T); return T; };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (String(type).startsWith("webgl")) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return getContext.call(this, type, attrs);
  };
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent = ${"`"}
      #demo-cursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 99999; pointer-events: none;
        margin: -3px 0 0 -4px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      #demo-ring { position: fixed; z-index: 99998; pointer-events: none; border-radius: 50%;
        border: 3px solid var(--accent); transform: translate(-50%, -50%); }
      #demo-cap { position: fixed; z-index: 99997; transform: translate(-50%, -100%); pointer-events: none;
        background: var(--ink); color: var(--bg); padding: 10px 18px; border-radius: 999px; white-space: nowrap;
        font: 600 21px/1.2 var(--font-ui); box-shadow: 0 6px 20px rgba(0,0,0,.18); }
      #demo-card { position: fixed; inset: 0; z-index: 99996; pointer-events: none; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 18px; text-align: center; padding: 0 40px;
        background: color-mix(in srgb, var(--bg) 88%, transparent); }
      #demo-card .f { font: italic 500 70px/1 var(--font-math); color: var(--ink); }
      #demo-card .t { font: 700 54px/1.02 var(--font-ui); font-stretch: 90%; letter-spacing: -.015em; color: var(--ink); }
      #demo-card .s { font: 400 24px/1.35 var(--font-ui); color: var(--muted); max-width: 26ch; }
      #demo-card .u { font: 500 22px/1.2 var(--font-data); color: var(--ink); padding: 10px 18px;
        border: 1px solid var(--line); border-radius: 10px; background: var(--chip); }
    ${"`"};
    document.head.appendChild(css);
    document.body.insertAdjacentHTML("beforeend",
      '<svg id="demo-cursor" viewBox="0 0 24 24" style="opacity:0"><path d="M3 2v17.2l4.6-4.3 3.2 6.8 2.9-1.3-3.1-6.6h6.3z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
      '<div id="demo-ring" style="opacity:0"></div><div id="demo-cap" style="opacity:0"></div><div id="demo-card" style="opacity:0"></div>');
  });
  window.__demo = s => {
    const c = document.getElementById("demo-cursor");
    c.style.transform = "translate(" + s.x + "px," + s.y + "px)";
    c.style.opacity = s.cursor;
    const r = document.getElementById("demo-ring");
    r.style.opacity = s.ring ? s.ring.o : 0;
    if (s.ring) Object.assign(r.style, { left: s.ring.x + "px", top: s.ring.y + "px", width: 2 * s.ring.r + "px", height: 2 * s.ring.r + "px" });
    const cap = document.getElementById("demo-cap");
    if (cap.textContent !== s.cap) cap.textContent = s.cap;
    Object.assign(cap.style, { opacity: s.capO, left: s.capX + "px", top: s.capY + "px" });
    const card = document.getElementById("demo-card");
    if (card.dataset.html !== s.card) { card.innerHTML = s.card; card.dataset.html = s.card; }
    card.style.opacity = s.cardO;
  };
})();`;

/* ---------- browser ---------- */
const profile = join(tmpdir(), `bbob-demo-${process.pid}`);
const [W, H, DPR] = mode === "preview" ? [1200, 627, 1] : [800, 800, 1.35];
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
  `--window-size=${W},${H}`, "--enable-unsafe-swiftshader", "about:blank",
], { stdio: "ignore" });

let cdp;
try {
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      ws = list.find(t => t.type === "page")?.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!ws) await sleep(150);
  }
  if (!ws) throw new Error("Chrome did not start");
  cdp = new CDP(ws);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  const loaded = cdp.once("Page.loadEventFired");
  const start = "#f8";
  await cdp.send("Page.navigate", { url: pathToFileURL(join(ROOT, "index.html")).href + start });
  await loaded;
  await cdp.eval("document.fonts.ready.then(() => true)");
  await sleep(1200);                                   // the index thumbnails draw on timers
  await cdp.eval("__advance(16)");
  const gl = await cdp.eval("!!document.querySelector('canvas.gl') && !document.getElementById('v-elev').disabled");
  if (!gl) throw new Error("WebGL is not available in headless Chrome");
  mkdirSync(OUT, { recursive: true });

  if (mode === "preview") {
    await cdp.eval("for (let i = 0; i < 40; i++) __advance(1000 / 30); true");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(ROOT, "preview.png"), Buffer.from(shot.data, "base64"));
    console.log("wrote preview.png");
  } else {
    await recordVideo(cdp);
  }
} finally {
  try { await cdp?.send("Browser.close"); } catch { /* already gone */ }
  await sleep(500);
  if (chrome.exitCode === null) chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked; harmless */ }
}

/* ---------- the timeline ---------- */
async function recordVideo(cdp) {
  const file = join(OUT, "bbob-landscapes-demo.mp4");
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS),
    "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise(res => ffmpeg.on("close", res));

  const ui = { x: 600, y: 520, cursor: 0, ring: null, cap: "", capO: 0, capX: 0, capY: 0, card: "", cardO: 0 };
  let frame = 0, ringAt = -99, capTarget = 0;
  const view = await rect("#view");
  ui.capX = view.x + view.w / 2;
  ui.capY = view.y + view.h - 18;

  async function rect(sel) {
    return cdp.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  }
  async function centre(sel) { const r = await rect(sel); return [r.x + r.w / 2, r.y + r.h / 2]; }
  async function mouse(type, extra = {}) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: ui.x, y: ui.y, ...extra });
  }
  async function tick(n = 1, each) {
    for (let i = 0; i < n; i++) {
      if (each) await each(i / Math.max(1, n - 1), i);
      const age = frame - ringAt;
      ui.ring = age < 11 ? { x: ui.x, y: ui.y, r: 8 + age * 2.4, o: 1 - age / 11 } : null;
      ui.capO += Math.sign(capTarget - ui.capO) * Math.min(Math.abs(capTarget - ui.capO), 1 / 6);
      await cdp.eval(`__advance(${1000 / FPS}); __demo(${JSON.stringify(ui)}); true`);
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 94, optimizeForSpeed: false });
      const buf = Buffer.from(shot.data, "base64");
      if (!ffmpeg.stdin.write(buf)) await new Promise(r => ffmpeg.stdin.once("drain", r));
      if (frame % (3 * FPS) === 0) writeFileSync(join(OUT, `frame_${String(frame).padStart(3, "0")}.jpg`), buf);
      frame++;
    }
  }
  const secs = s => Math.max(1, Math.round(s * FPS));
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const hold = s => tick(secs(s));
  async function moveTo(target, s, hover = true) {
    const [x1, y1] = typeof target === "string" ? await centre(target) : target;
    const x0 = ui.x, y0 = ui.y;
    await tick(secs(s), async t => {
      ui.x = x0 + (x1 - x0) * ease(t); ui.y = y0 + (y1 - y0) * ease(t);
      if (hover) await mouse("mouseMoved");
    });
  }
  async function click() {
    await mouse("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
    await mouse("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
    ringAt = frame;
  }
  async function drag(dx, dy, s) {
    const x0 = ui.x, y0 = ui.y;
    await mouse("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
    await tick(secs(s), async t => {
      ui.x = x0 + dx * ease(t); ui.y = y0 + dy * Math.sin(Math.PI * t);
      await mouse("mouseMoved", { button: "left", buttons: 1 });
    });
    await mouse("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
  }
  function caption(text) {
    if (text) { ui.cap = text; capTarget = 1; } else capTarget = 0;
  }
  async function fadeCard(to, s) {
    const from = ui.cardO;
    await tick(secs(s), async t => { ui.cardO = from + (to - from) * t; });
  }
  async function scrollIndex(to, s) {
    const from = await cdp.eval("document.getElementById('index').scrollTop");
    await tick(secs(s), async t => {
      await cdp.eval(`document.getElementById('index').scrollTop = ${from + (to - from) * ease(t)}`);
    });
  }
  const fn = k => `.fbtn[data-k="${k}"]`;

  // 0 - 2.6 s: title card over a turning Rosenbrock
  ui.card = '<div class="f">f(x)</div><div class="t">BBOB Landscape Atlas</div>' +
    '<div class="s">The 24 COCO benchmark functions, in 2-D</div>';
  ui.cardO = 1;
  await hold(1.9);
  await fadeCard(0, 0.7);

  // hover readout
  ui.x = view.x + view.w * 0.85; ui.y = view.y + view.h * 0.62; ui.cursor = 1;
  caption("Exact COCO values: hover to read f(x)");
  await moveTo([view.x + view.w * 0.55, view.y + view.h * 0.58], 0.9);
  await hold(0.5);
  await moveTo([view.x + view.w * 0.42, view.y + view.h * 0.5], 0.8);
  await hold(0.7);

  // heat map and back
  caption("Heat map or elevation map");
  await moveTo("#v-heat", 0.7);
  await click();
  await hold(1.6);
  await moveTo("#v-elev", 0.5);
  await click();
  await hold(1.3);

  // log and linear
  caption("Log or linear scale");
  await moveTo("#s-lin", 0.5);
  await click();
  await hold(1.1);
  await moveTo("#s-log", 0.4);
  await click();
  await hold(0.6);

  // a tour of the index
  caption("24 functions in 5 groups, each classified");
  for (const k of [0, 2, 6, 11, 15]) {
    await moveTo(fn(k), 0.45);
    await click();
    await hold(0.95);
  }
  await scrollIndex(400, 0.5);
  for (const k of [19, 20, 23]) {
    await moveTo(fn(k), 0.45);
    await click();
    await hold(0.95);
  }

  // drag
  caption("Drag to turn and tilt");
  await moveTo([view.x + view.w * 0.3, view.y + view.h * 0.55], 0.5, false);
  await drag(view.w * 0.42, -view.h * 0.12, 1.5);
  await hold(0.5);

  // end card
  caption(null);
  ui.card = '<div class="t">BBOB Landscape Atlas</div><div class="u">bjbodner.github.io/bbob-landscapes</div>' +
    '<div class="s">Open source · built with cocoex and three.js</div>';
  ui.cursor = 0;
  await fadeCard(1, 0.5);
  if (frame < SECONDS * FPS) await tick(SECONDS * FPS - frame);

  ffmpeg.stdin.end();
  await done;
  console.log(`wrote ${file}: ${frame} frames, ${(frame / FPS).toFixed(2)} s`);
}
