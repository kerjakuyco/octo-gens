// A small headless Chrome driver over the DevTools Protocol, used by the tools in this folder.
// Needs Node 22 or newer (global WebSocket) and a Chrome or Chromium binary in $CHROME.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function launch({ port = Number(process.env.CDP_PORT || 9801) } = {}) {
  const binary = process.env.CHROME;
  if (!binary) throw new Error("Set CHROME to the path of a Chrome or Chromium binary.");
  const chrome = spawn(binary, ["--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--remote-debugging-port=${port}`, "about:blank"], {
    stdio: "ignore",
  });
  let target = null;
  for (let attempt = 0; attempt < 100 && !target; attempt += 1) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = tabs.find((tab) => tab.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      // not listening yet
    }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Chrome did not start");

  const ws = new WebSocket(target);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (!data.id) return;
    const entry = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) entry.reject(new Error(data.error.message));
    else entry.resolve(data.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1;
      waiting.set(seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async function waitFor(expression, timeout = 10000) {
    const started = Date.now();
    for (;;) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch {
        // the page is navigating
      }
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${expression}`);
      await sleep(80);
    }
  }

  let view = { width: 1280, height: 800 };
  async function goto(url, { width = 1280, height = 800, scheme = "light", scale = 1, wait = 800 } = {}) {
    view = { width, height };
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: scheme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
    await send("Page.navigate", { url });
    await waitFor("document.readyState === 'complete'", 20000);
    await sleep(wait);
  }

  /** The box of the first element matching `selector`, in page coordinates. */
  async function box(selector) {
    return evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const b = node.getBoundingClientRect();
      return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height };
    })()`);
  }

  /** Saves the viewport, or `clip` in CSS pixels, as WebP or PNG at the device scale set by goto(). */
  async function capture(file, { clip = null, format = "webp", quality = 80 } = {}) {
    const area = clip ?? { x: 0, y: 0, width: view.width, height: view.height };
    const params = { format, captureBeyondViewport: true, clip: { ...area, scale: 1 } };
    if (format !== "png") params.quality = quality;
    const { data } = await send("Page.captureScreenshot", params);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  async function click(selector) {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({ block: "center" });
      const b = node.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (!point) throw new Error(`nothing matches ${selector}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    }
    await sleep(150);
  }

  async function type(text) {
    await send("Input.insertText", { text });
    await sleep(80);
  }

  async function close() {
    send("Browser.close").catch(() => {});
    await sleep(200);
    ws.close();
    chrome.kill();
  }

  return { send, evaluate, waitFor, goto, box, capture, click, type, close };
}
