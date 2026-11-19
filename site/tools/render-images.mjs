// Renders the two pictures that are drawn rather than photographed:
//   src/og/card.html            -> src/assets/images/og.png       (1200 x 630, for link previews)
//   src/assets/images/icon.svg  -> src/assets/images/apple-touch-icon.png (180 x 180, full bleed: iOS rounds the corners)
//
//   CHROME=/path/to/chrome node tools/render-images.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const page = await launch();
try {
  await page.goto(pathToFileURL(join(SRC, "og", "card.html")).href, { width: 1200, height: 630, scale: 1 });
  await page.capture(join(SRC, "assets", "images", "og.png"), { format: "png" });

  // The tile without its rounded corners, filling the square.
  const icon = readFileSync(join(SRC, "assets", "images", "icon.svg"), "utf8").replace(/rx="186"/, 'rx="0"');
  const html = `<!doctype html><html><body style="margin:0;background:#1a3aa6">${icon.replace("<svg ", '<svg width="180" height="180" ')}</body></html>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { width: 180, height: 180, scale: 1 });
  await page.capture(join(SRC, "assets", "images", "apple-touch-icon.png"), { format: "png" });
  console.log("rendered og.png and apple-touch-icon.png");
} finally {
  await page.close();
}
