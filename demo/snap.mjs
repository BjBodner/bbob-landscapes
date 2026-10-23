// Deterministic screenshots of a page of this repo, for parity checks and previews.
//
//   node demo/snap.mjs OUT_DIR PAGE NAME=HASH:STEPS [NAME=HASH:STEPS ...]
//
// PAGE is index.html or race.html; HASH is the URL hash (e.g. f8); STEPS is a ';'-separated
// list run in the page before the shot: "ms:N" advances the fake clock by N ms (in 1/30 s
// frames), "click:SELECTOR" clicks an element, "js:CODE" evaluates CODE. Options from the
// environment: W, H, DPR (viewport), SCHEME (light or dark), MOTION (reduce).
// The clock is fake (performance.now and requestAnimationFrame are replaced before the page's
// scripts run), so the same steps give the same pixels.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [W, H, DPR] = [+(process.env.W || 1280), +(process.env.H || 800), +(process.env.DPR || 1)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [outDir, page, ...shots] = process.argv.slice(2);
if (!outDir || !page || !shots.length) {
  console.error("usage: node demo/snap.mjs OUT_DIR PAGE NAME=HASH:STEPS ...");
  process.exit(2);
}

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

const INJECT = String.raw`(() => {
  let T = 1000;
  const queue = [];
  performance.now = () => T;
  window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  window.__advance = ms => { T += ms; const q = queue.splice(0); for (const cb of q) cb(T); return T; };
  window.__errors = [];
  addEventListener("error", e => window.__errors.push(String(e.message)));
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (String(type).startsWith("webgl")) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return getContext.call(this, type, attrs);
  };
})();`;

const profile = join(tmpdir(), `bbob-snap-${process.pid}`);
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
  "--allow-file-access-from-files", `--window-size=${W},${H}`, "--enable-unsafe-swiftshader", "about:blank",
], { stdio: "ignore" });

let cdp;
try {
  let ws = null;
  const portFile = join(profile, "DevToolsActivePort");   // Chrome picks a free port and writes it here
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const port = existsSync(portFile) ? readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim() : "";
      if (!port) throw new Error("no port yet");
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      ws = list.find(t => t.type === "page")?.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!ws) await sleep(150);
  }
  if (!ws) throw new Error("Chrome did not start");
  cdp = new CDP(ws);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: W < 600 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-color-scheme", value: process.env.SCHEME || "light" },
    { name: "prefers-reduced-motion", value: process.env.MOTION || "no-preference" }] });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  mkdirSync(outDir, { recursive: true });
  for (const spec of shots) {
    const [name, rest] = spec.split(/=(.*)/s);
    const [hash, steps = ""] = rest.split(/:(.*)/s);
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: (/^https?:/.test(page) ? page : pathToFileURL(resolve(ROOT, page)).href) + `?shot=${encodeURIComponent(name)}` + (hash ? `#${hash}` : "") });
    await loaded;
    await cdp.eval("document.fonts.ready.then(() => true)");
    await sleep(900);
    await cdp.eval("__advance(16)");
    for (const step of steps.split(";").filter(Boolean)) {
      const [kind, arg] = step.split(/:(.*)/s);
      if (kind === "ms") await cdp.eval(`for (let i = 0; i < Math.round(${+arg} / (1000 / 30)); i++) __advance(1000 / 30); true`);
      else if (kind === "click") await cdp.eval(`document.querySelector(${JSON.stringify(arg)}).click(); true`);
      else if (kind === "js") await cdp.eval(arg);
      else if (kind === "wait") await sleep(+arg);
      else throw new Error(`unknown step ${step}`);
    }
    await cdp.eval("__advance(1000 / 30)");
    const errors = await cdp.eval("window.__errors");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
    console.log(`${name}.png${errors.length ? "  ERRORS: " + errors.join(" | ") : ""}`);
  }
} finally {
  try { await cdp?.send("Browser.close"); } catch { /* already gone */ }
  await sleep(400);
  if (chrome.exitCode === null) chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked; harmless */ }
}
