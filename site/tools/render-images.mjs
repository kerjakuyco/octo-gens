// Renders the two pictures that are drawn rather than photographed:
//   src/og/card.html            -> src/assets/images/og.png       (1200 x 630, for link previews)
//   src/assets/images/icon.svg  -> src/assets/images/apple-touch-icon.png (180 x 180, full bleed: iOS rounds the corners)
//
//   CHROME=/path/to/chrome node tools/render-images.mjs [og] [apple-touch-icon]
//
// With no names it renders both; name one to render only that picture. CDP_PORT moves Chrome's
// debugging port from 9801. The size of og.png is printed, with a warning above 300 KB.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const NAMES = ["og", "apple-touch-icon"];
const only = new Set(process.argv.slice(2));
const unknown = [...only].filter((name) => !NAMES.includes(name));
if (unknown.length) throw new Error(`No picture named ${unknown.join(", ")}; the pictures are ${NAMES.join(" and ")}.`);
const wanted = (name) => only.size === 0 || only.has(name);

const page = await launch();
const rendered = [];
try {
  if (wanted("og")) {
    const og = join(SRC, "assets", "images", "og.png");
    await page.goto(pathToFileURL(join(SRC, "og", "card.html")).href, { width: 1200, height: 630, scale: 1 });
    await page.capture(og, { format: "png" });
    const kb = Math.round(statSync(og).size / 1000);
    rendered.push(`og.png (${kb} KB)`);
    if (kb > 300) console.warn(`og.png is ${kb} KB: some chat apps leave pictures over 300 KB out of link previews.`);
  }

  if (wanted("apple-touch-icon")) {
    // The tile without its rounded corners, filling the square.
    const icon = readFileSync(join(SRC, "assets", "images", "icon.svg"), "utf8").replace(/rx="186"/, 'rx="0"');
    const html = `<!doctype html><html><body style="margin:0;background:#1a3aa6">${icon.replace("<svg ", '<svg width="180" height="180" ')}</body></html>`;
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { width: 180, height: 180, scale: 1 });
    await page.capture(join(SRC, "assets", "images", "apple-touch-icon.png"), { format: "png" });
    rendered.push("apple-touch-icon.png");
  }
  console.log(`rendered ${rendered.join(" and ")}`);
} finally {
  await page.close();
}
