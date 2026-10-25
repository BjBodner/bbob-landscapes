// Records a short video of the Optimizer Race (race.html) with headless Chrome and ffmpeg.
//
//   node demo/record_race.mjs [--from 15] [--count 5] [--speed 2] [--racers amm,slsqp,hcma]
//                             (the page's own options apply: race.html mounts without confetti)
//                             [--out demo/out/race-demo.mp4]
//
// The page runs on a simulated clock: performance.now, requestAnimationFrame, setTimeout and the
// page's CSS animations all advance exactly 1/30 s per video frame, however long a frame takes
// to render, so the video plays at the race's real pace (at the chosen speed). A title card opens
// the video and an end card closes it. The race data is served from this folder by a small
// built-in static server. Needs Chrome (or CHROME=path) and ffmpeg on PATH.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const FROM = +arg("from", 15), COUNT = +arg("count", 5), SPEED = arg("speed", "2");
const RACERS = arg("racers", "amm,slsqp,hcma").split(",");
const LABEL = { amm: "AMM (Ours)", slsqp: "SLSQP", hcma: "HCMA", ngopt: "NGOpt", cma_bipop: "CMA-BIPOP", nelder_mead: "Nelder-Mead" };
const RIVALS = RACERS.filter(r => r !== "amm").map(r => LABEL[r]);
const listOf = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
const OUT = resolve(ROOT, arg("out", "demo/out/race-demo.mp4"));
const FPS = 30, W = 1280, H = 720, DPR = 1.5;
const INTRO = 2 * FPS, OUTRO = 3 * FPS, MAX = 140 * FPS;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- a static server for race.html and its data ---------- */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${server.address().port}/race.html#f${FROM}-s1`;

/* ---------- DevTools protocol ---------- */
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.listeners = []; }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method) for (const l of [...this.listeners]) l(m);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  once(method) {
    return new Promise(res => {
      const l = m => { if (m.method !== method) return; this.listeners.splice(this.listeners.indexOf(l), 1); res(m.params); };
      this.listeners.push(l);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/* ---------- the simulated clock, injected before the page's scripts ---------- */
const INJECT = String.raw`(() => {
  let T = 1000, seq = 0;
  const frames = [], timers = [];
  const realTimeout = window.setTimeout.bind(window);
  performance.now = () => T;
  window.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  window.cancelAnimationFrame = () => {};
  window.setTimeout = (fn, ms = 0, ...a) => { const id = ++seq; timers.push({ id, at: T + (+ms || 0), fn: () => fn(...a) }); return id; };
  window.clearTimeout = id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  window.__realTimeout = realTimeout;
  window.__advance = ms => {
    T += ms;
    for (const a of document.getAnimations()) {   // CSS animations follow the simulated clock too
      a.pause();
      a.currentTime = (a.currentTime || 0) + ms;
    }
    timers.sort((p, q) => p.at - q.at);
    while (timers.length && timers[0].at <= T) timers.shift().fn();
    const q = frames.splice(0);
    for (const cb of q) cb(T);
    return T;
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (String(type).startsWith("webgl")) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return getContext.call(this, type, attrs);
  };
})();`;

const CARD_CSS = `
#rv-card { position: fixed; inset: 0; z-index: 99999; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 16px; text-align: center; padding: 0 60px; pointer-events: none;
  background: color-mix(in srgb, #edf1f3 92%, transparent); font-family: Archivo, "Segoe UI", system-ui, sans-serif; }
#rv-card .k { font: 600 15px/1.2 "JetBrains Mono", Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: #566874; }
#rv-card .t { font: 800 50px/1.05 Archivo, system-ui, sans-serif; letter-spacing: -.015em; color: #13212b; }
#rv-card .t b { color: #13212b; }
#rv-card .s { font: 400 21px/1.4 Archivo, system-ui, sans-serif; color: #3d4f5b; max-width: 34ch; }
#rv-card .u { font: 500 18px/1.2 "JetBrains Mono", Consolas, monospace; color: #13212b; padding: 9px 16px;
  border: 1px solid #c3cfd6; border-radius: 10px; background: #f8fafb; }
#rv-card .n { font: 400 13px/1.4 Archivo, system-ui, sans-serif; color: #566874; max-width: 60ch; }`;

/* ---------- browser ---------- */
const profile = join(tmpdir(), `bbob-race-video-${process.pid}`);
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars",
  "--mute-audio", "--no-first-run", "--no-default-browser-check", `--window-size=${W},${H}`,
  "--enable-unsafe-swiftshader", "about:blank",
], { stdio: "ignore" });

let cdp, ffmpeg;
try {
  let ws = null;
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const port = existsSync(portFile) ? readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim() : "";
      if (!port) throw new Error("no port yet");
      ws = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page")?.webSocketDebuggerUrl;
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
  await cdp.send("Page.navigate", { url: PAGE });
  await loaded;
  await cdp.eval("document.fonts.ready.then(() => true)");
  for (let i = 0; i < 100; i++) {   // the first race's data
    if (await cdp.eval("!!(window.__race && window.__race.race)")) break;
    await sleep(100);
  }
  await cdp.eval(`(() => {
    try { localStorage.setItem("bbob-race-controls", "0"); } catch (e) {}
    const side = document.querySelector("[data-side]");
    if (side && side.dataset.open === "true") document.querySelector("[data-side-toggle]").click();
    document.querySelector('[data-v="${SPEED}"]').click();
    const want = ${JSON.stringify(RACERS)};
    for (const b of document.querySelectorAll("[data-o]")) {   // the racers shown
      if ((b.getAttribute("aria-pressed") === "true") !== want.includes(b.dataset.o)) b.click();
    }
    if (window.__race.state.playing) document.querySelector("[data-play]").click();   // held during the title card
    const css = document.createElement("style"); css.textContent = ${JSON.stringify(CARD_CSS)}; document.head.appendChild(css);
    const card = document.createElement("div"); card.id = "rv-card"; document.body.appendChild(card);
    window.__card = (html, o) => { if (card.dataset.h !== html) { card.innerHTML = html; card.dataset.h = html; } card.style.opacity = o; };
    return true;
  })()`);
  for (let i = 0; i < 10; i++) await cdp.eval("__advance(1000 / 30)");   // settle the first frames

  mkdirSync(dirname(OUT), { recursive: true });
  ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg",
    "-i", "-", "-vf", "scale=in_range=pc:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-movflags", "+faststart", OUT], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise(res => ffmpeg.on("close", res));
  const shot = async () => {
    const s = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    if (!ffmpeg.stdin.write(Buffer.from(s.data, "base64"))) await new Promise(r => ffmpeg.stdin.once("drain", r));
  };
  const step = () => cdp.eval("__advance(1000 / 30)");

  const intro = `<div class="k">bbob · 2-D · recorded runs</div><div class="t">Optimizer race</div>
    <div class="s">Who reaches the global minimum first? <b>AMM (Ours)</b> against ${listOf(RIVALS)}, on ${COUNT} functions.</div>`;
  for (let f = 0; f < INTRO; f++) {   // the title card, fading out over its last half second
    const o = Math.min(1, (INTRO - f) / (0.5 * FPS));
    await cdp.eval(`__card(${JSON.stringify(intro)}, ${o.toFixed(3)})`);
    await step(); await shot();
  }
  await cdp.eval(`__card("", 0); document.querySelector("[data-play]").click(); true`);
  // Each function: the race at SPEED until AMM finishes, its banner for a moment, then a
  // fast-forward until the second-placed optimizer finishes (capped), then a zoom into the
  // finish line with the two evaluation counts, and on to the next function.
  const BANNER = 1.0 * FPS, FFCAP = 2.0 * FPS, ZIN = 0.5 * FPS, HOLD = 1.6 * FPS, ZOUT = 0.4 * FPS, FF = 8;
  const rivals = RACERS.filter(r => r !== "amm");
  const COLOR = { amm: "#111111", hcma: "#009e73", slsqp: "#d55e00", ngopt: "#b37a00", cma_bipop: "#2a8fc7", nelder_mead: "#9a8f00" };
  let frame = 0, shown = 1, mode = "race", t0 = 0;
  const state = () => cdp.eval(`(() => {
    const R = window.__race, rc = R.race;
    if (!rc || R.state.phase === "loading") return { ready: false };
    return { ready: true, T: Math.floor(R.state.clock), amm: rc.runs.amm.finish,
             rivals: ${JSON.stringify(rivals)}.map(id => [id, rc.runs[id].finish]) };
  })()`);
  const badge = (html, o) => cdp.eval(`(() => {
    let b = document.getElementById("rv-badge");
    if (!b) { b = document.createElement("div"); b.id = "rv-badge"; document.body.appendChild(b); }
    const v = document.querySelector(".br-view").getBoundingClientRect();   // centred near the top of the landscape
    b.style.left = (v.left + v.width / 2) + "px"; b.style.top = (v.top + 12) + "px";
    b.innerHTML = ${JSON.stringify(html)}; b.style.opacity = ${o}; return true; })()`);
  const caption = (html, o) => cdp.eval(`(() => {
    let c = document.getElementById("rv-cap");
    if (!c) { c = document.createElement("div"); c.id = "rv-cap"; document.body.appendChild(c); }
    c.innerHTML = ${JSON.stringify(html)}; c.style.opacity = ${o}; return true; })()`);
  await cdp.eval(`(() => { const css = document.createElement("style"); css.textContent = ${JSON.stringify(`
    #rv-badge { position: fixed; transform: translateX(-50%); z-index: 99998; pointer-events: none;
      padding: 6px 14px; border-radius: 999px; background: #13212b; color: #fff; font: 700 15px/1 Archivo, system-ui, sans-serif;
      letter-spacing: .04em; opacity: 0; }
    #rv-cap { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 99998; pointer-events: none;
      padding: 12px 20px; border-radius: 12px; background: rgba(255,255,255,.96); color: #13212b; border: 1px solid #c3cfd6;
      box-shadow: 0 10px 30px rgba(0,0,0,.18); font: 500 19px/1.35 Archivo, system-ui, sans-serif; white-space: nowrap; opacity: 0; }
    #rv-cap b { font-weight: 800; }`)}; document.head.appendChild(css); return true; })()`);
  const zoom = inward => cdp.eval(`(() => {   // zoom into (or back out of) the finish line of the race track
    const root = document.querySelector(".bbob-race"), r = root.getBoundingClientRect();
    const t = document.querySelector(".br-vt-body").getBoundingClientRect();
    const s = 2.3, px = t.left + t.width / 2 - r.left, py = t.bottom - r.top - 8;
    const cx = ${W} / 2, cy = ${H} / 2 - 30;
    const far = "translate(" + (cx - s * px) + "px," + (cy - s * py) + "px) scale(" + s + ")";
    root.style.transformOrigin = "0 0";
    root.getAnimations().forEach(a => a.cancel());
    root.animate(${inward} ? [{ transform: "none" }, { transform: far }] : [{ transform: far }, { transform: "none" }],
                 { duration: ${inward} ? ${(ZIN / FPS) * 1000} : ${(ZOUT / FPS) * 1000}, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    return true; })()`);
  for (; frame < MAX; frame++) {
    await step();
    const st = await state();
    if (mode === "race" && st.ready && st.amm !== null && st.amm <= st.T) { mode = "banner"; t0 = frame; }
    else if (mode === "banner" && frame - t0 >= BANNER) {
      mode = "ff"; t0 = frame;
      await cdp.eval(`window.__race.state.speed = ${FF}; true`);
      await badge("⏩ fast-forward to second place", 1);
    } else if (mode === "ff") {
      const done = st.rivals.filter(([, fin]) => fin !== null && fin <= st.T);
      if (done.length || frame - t0 >= FFCAP) {
        mode = "zoom"; t0 = frame;
        await cdp.eval(`window.__race.state.playing = false; true`);
        await badge("", 0);
        await zoom(true);
        const name = id => `<b style="color:${COLOR[id]}">${LABEL[id]}</b>`;
        let html = `${name("amm")} reached the goal in <b>${st.amm}</b> evaluations`;
        if (done.length) {
          const [id, fin] = done.sort((a, b) => a[1] - b[1])[0];
          html += ` · 2nd: ${name(id)} in <b>${fin}</b> (${(fin / st.amm).toFixed(1)}× more)`;
        } else html += ` · nobody else after ${st.T}`;
        await caption(html, 1);
      }
    } else if (mode === "zoom" && frame - t0 >= ZIN + HOLD) {
      mode = "zoomout"; t0 = frame;
      await caption("", 0);
      await zoom(false);
    } else if (mode === "zoomout" && frame - t0 >= ZOUT) {
      if (shown >= COUNT) break;
      shown++; mode = "race";
      await cdp.eval(`(() => { const R = window.__race; document.querySelector(".bbob-race").getAnimations().forEach(a => a.cancel());
        R.state.speed = ${+SPEED}; R.select(${FROM + shown - 1}, 1); R.state.playing = true; return true; })()`);
    }
    await shot();
    if (frame % (5 * FPS) === 0) console.log(`  ${(frame / FPS).toFixed(0)} s of race, mode ${mode}`);
  }
  const outro = `<div class="t"><b>AMM (Ours)</b></div><div class="s">Adaptive Multi Mode: reads the landscape with cheap probes,
    then routes the budget to the right engine.</div><div class="u">bjbodner.github.io/amm-optimizer-site</div>
    <div class="n">AMM's run is its best of 100 random seeds; ${RIVALS.length > 1 ? "the others" : RIVALS[0]} ran once${RACERS.includes("hcma") ? " (HCMA: its archived COCO run)" : ""}.</div>`;
  await cdp.eval("window.__race.state.playing = false; true");   // freeze the race under the end card
  for (let f = 0; f < OUTRO; f++) {
    await cdp.eval(`__card(${JSON.stringify(outro)}, ${Math.min(1, f / (0.5 * FPS)).toFixed(3)})`);
    await step(); await shot();
  }
  ffmpeg.stdin.end();
  await done;
  console.log(`wrote ${OUT} (${((INTRO + frame + OUTRO) / FPS).toFixed(1)} s)`);
} finally {
  try { await cdp?.send("Browser.close"); } catch { /* already gone */ }
  await sleep(500);
  if (chrome.exitCode === null) chrome.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked; harmless */ }
}
