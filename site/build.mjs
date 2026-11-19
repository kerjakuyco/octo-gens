// Builds the site into dist/. No dependencies; Node 20 or newer.
//
//   node build.mjs
//   node build.mjs --site-url=https://octoneo.xyz      (what `pnpm run deploy` does)
//   SITE_URL=https://octoneo.example node build.mjs   (the flag wins when both are given)
//
// Pages come from src/pages/*.mjs and share the frame in src/layout.mjs. Everything under
// src/assets/ is copied to /assets/ with a content hash in its name, so it can be cached for a
// year; src/static/ is copied to the root as it is. The build also writes _headers (security
// headers and caching for Cloudflare), robots.txt and, when SITE_URL names the site's origin,
// sitemap.xml with canonical and share links. Without SITE_URL those are left out rather than guessed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOOT, layout } from "./src/layout.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
// `--out=<folder>` builds or checks somewhere other than dist/, so two people can work at once.
const OUT_FLAG = process.argv.find((arg) => arg.startsWith("--out="));
const DIST = OUT_FLAG ? resolve(OUT_FLAG.slice("--out=".length)) : join(ROOT, "dist");

/**
 * Rendered widths, in CSS pixels, for each kind of picture; they follow the layout in site.css.
 * The page is 1136 wide, the text column 760; the gutters are 32 a side, 16 on a phone.
 * `inset` is a wide picture shown in the text column.
 */
const SIZES = {
  wide: "(min-width: 1200px) 1136px, (min-width: 641px) calc(100vw - 64px), calc(100vw - 32px)",
  column: "(min-width: 824px) 760px, (min-width: 641px) calc(100vw - 64px), calc(100vw - 32px)",
  inset: "(min-width: 824px) 760px, (min-width: 641px) calc(100vw - 64px), calc(100vw - 32px)",
  panel: "(min-width: 432px) 400px, calc(100vw - 32px)",
  tab: "(min-width: 1100px) 368px, (min-width: 641px) calc(50vw - 44px), calc(100vw - 32px)",
};

/** A picture named <name>-phone replaces <name> on a phone: a crop that stays legible there. */
const PHONE = { media: "(max-width: 640px)", sizes: "calc(100vw - 32px)" };

function siteUrl() {
  const flag = process.argv.find((arg) => arg.startsWith("--site-url="));
  const raw = (flag ? flag.slice("--site-url=".length) : (process.env.SITE_URL ?? "")).trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_URL is not an address: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error(`SITE_URL must start with https://: ${raw}`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`SITE_URL must be an origin only, such as https://octoneo.example: ${raw}`);
  return url.origin;
}

/** Every file under `dir`, as forward-slash paths relative to it, skipping dot files. */
function files(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...files(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const hashOf = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 10);

/** Pixel size of a PNG, WebP or SVG, read from its header. */
function dimensions(name, buffer) {
  const ext = extname(name);
  if (ext === ".png") return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (ext === ".webp") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    throw new Error(`${name}: unknown WebP chunk ${chunk}`);
  }
  if (ext === ".svg") {
    const box = /viewBox="([\d.\s-]+)"/.exec(buffer.toString("utf8"));
    if (!box) return null;
    const [, , width, height] = box[1].trim().split(/\s+/).map(Number);
    return { width, height };
  }
  return null;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export async function build({ quiet = false } = {}) {
  const origin = siteUrl();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // Assets, each under a name that changes when its content does.
  const assets = new Map();
  const emit = (rel, buffer) => {
    const ext = extname(rel);
    const hashed = `${rel.slice(0, -ext.length)}.${hashOf(buffer)}${ext}`;
    write(join(DIST, "assets", ...hashed.split("/")), buffer);
    assets.set(rel, { url: `/assets/${hashed}`, bytes: buffer.length, size: dimensions(rel, buffer) });
  };
  const sources = files(join(SRC, "assets"));
  for (const rel of sources.filter((rel) => !rel.endsWith(".css"))) emit(rel, readFileSync(join(SRC, "assets", ...rel.split("/"))));
  // Each screenshot gets a frame of its own proportions and natural width. The picture fills its frame,
  // so its size is known before it loads without a height of auto, which browsers flag on a lazy image.
  const shots = new Map();
  for (const [rel, entry] of assets) {
    const match = /^shots\/(.+)-(light|dark)-\d+\.webp$/.exec(rel);
    if (!match) continue;
    const [, name, theme] = match;
    const shot = shots.get(name) ?? { light: [], dark: [] };
    shot[theme].push(entry);
    shots.set(name, shot);
  }
  const frames = [];
  const phoneFrames = [];
  for (const [name, shot] of shots) {
    for (const list of [shot.light, shot.dark]) list.sort((a, b) => a.size.width - b.size.width);
    if (!shot.light.length || !shot.dark.length) throw new Error(`shots/${name}: needs a light and a dark picture`);
    // A picture is taken at twice its CSS size at most; the largest copy sets the box.
    const box = (list) => ({ width: Math.round(list.at(-1).size.width / 2), height: Math.round(list.at(-1).size.height / 2) });
    const light = box(shot.light);
    const dark = box(shot.dark);
    if (Math.abs(light.width / light.height - dark.width / dark.height) > 0.01) throw new Error(`shots/${name}: the light and dark pictures differ in shape`);
    shot.box = light;
    const frame = `width:${light.width}px;aspect-ratio:${light.width}/${light.height}`;
    // A phone crop reshapes the frame of the picture it stands in for, on a phone only.
    if (name.endsWith("-phone")) {
      const base = name.slice(0, -"-phone".length);
      if (!shots.has(base)) throw new Error(`shots/${name}: there is no picture named ${base} for it to replace on a phone`);
      phoneFrames.push(`@media ${PHONE.media}{.pic-${base}{${frame}}}`);
    } else {
      frames.push(`.pic-${name}{${frame}}`);
    }
  }
  frames.push(...phoneFrames);

  for (const rel of sources.filter((rel) => rel.endsWith(".css"))) {
    // Comments are for the source; a url() in the stylesheet points at the hashed copy.
    const css = (readFileSync(join(SRC, "assets", ...rel.split("/")), "utf8") + (rel === "site.css" ? `\n/* Picture frames, written by build.mjs. */\n${frames.join("\n")}\n` : ""))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (match, target) => {
        if (/^(?:data:|https?:|\/\/|#)/.test(target)) return match;
        const asset = assets.get(target.replace(/^\.?\//, ""));
        if (!asset) throw new Error(`${rel}: url(${target}) is not an asset`);
        return `url("${asset.url}")`;
      })
      .replace(/\n\s*\n+/g, "\n");
    emit(rel, Buffer.from(css));
  }
  for (const rel of files(join(SRC, "static"))) write(join(DIST, ...rel.split("/")), readFileSync(join(SRC, "static", ...rel.split("/"))));
  // iOS asks for this address on its own when a page is added to the home screen.
  write(join(DIST, "apple-touch-icon.png"), readFileSync(join(SRC, "assets", "images", "apple-touch-icon.png")));

  const asset = (rel) => {
    const found = assets.get(rel);
    if (!found) throw new Error(`no asset ${rel}`);
    return found.url;
  };

  /** A screenshot in both themes: src/assets/shots/<name>-<light|dark>-<pixel width>.webp. */
  function picture(name, { alt, kind, eager = false }) {
    const sizes = SIZES[kind];
    if (!sizes) throw new Error(`${name}: unknown picture kind ${kind}`);
    if (!alt) throw new Error(`${name}: a picture needs alt text`);
    const shot = shots.get(name);
    if (!shot) throw new Error(`no light and dark pictures named ${name}`);
    const srcset = (list) => list.map((v) => `${v.url} ${v.size.width}w`).join(", ");
    const { width, height } = shot.box;
    const loading = eager ? 'fetchpriority="high"' : 'loading="lazy"';
    // The first source that matches is used, so the phone crop comes before the wide picture.
    const phone = shots.get(`${name}-phone`);
    const phoneSources = phone
      ? `<source media="${PHONE.media} and (prefers-color-scheme: dark)" srcset="${srcset(phone.dark)}" sizes="${PHONE.sizes}" width="${phone.box.width}" height="${phone.box.height}">
<source media="${PHONE.media}" srcset="${srcset(phone.light)}" sizes="${PHONE.sizes}" width="${phone.box.width}" height="${phone.box.height}">
`
      : "";
    return `<picture class="pic pic-${name}">
${phoneSources}<source media="(prefers-color-scheme: dark)" srcset="${srcset(shot.dark)}" sizes="${sizes}" width="${width}" height="${height}">
<img src="${shot.light[0].url}" srcset="${srcset(shot.light)}" sizes="${sizes}" width="${width}" height="${height}" alt="${alt.replace(/"/g, "&quot;")}" ${loading} decoding="async">
</picture>`;
  }

  const figure = (name, options) =>
    `<figure class="shot shot-${options.kind}">
${picture(name, options)}
${options.caption ? `<figcaption>${options.caption}</figcaption>` : ""}
</figure>`;

  const ctx = { siteUrl: origin, asset, picture, figure };

  // Pages.
  const pages = [];
  for (const file of readdirSync(join(SRC, "pages")).filter((f) => f.endsWith(".mjs")).sort()) {
    const page = (await import(pathToFileURL(join(SRC, "pages", file)).href)).default;
    if (!page?.path || !page.title || !page.description || typeof page.render !== "function") throw new Error(`${file}: a page needs path, title, description and render`);
    const output = page.output ?? (page.path === "/" ? "index.html" : `${page.path.replace(/^\/|\/$/g, "")}/index.html`);
    if (pages.some((p) => p.output === output)) throw new Error(`${file}: two pages write ${output}`);
    const html = layout(page, page.render(ctx), ctx);
    write(join(DIST, ...output.split("/")), html);
    pages.push({ ...page, output, bytes: Buffer.byteLength(html) });
  }

  // Headers. The one inline script is allowed by its hash; nothing is loaded from anywhere else.
  const bootHash = createHash("sha256").update(BOOT).digest("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${bootHash}'`,
    "style-src 'self'",
    "img-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  // Pages are checked on every visit, so a deploy shows at once and never points at an asset it removed.
  const pageRules = pages
    .filter((p) => p.path.endsWith("/"))
    .map((p) => `${p.path}\n  Cache-Control: public, max-age=0, must-revalidate\n`)
    .join("\n");
  write(
    join(DIST, "_headers"),
    `# Written by build.mjs. Cloudflare applies these to the files in this folder.
/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY

${pageRules}
# Assets carry a hash of their content in their names, so one address never changes.
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
  );

  // The home page first, then the rest by address.
  const indexable = pages.filter((p) => p.indexable !== false).sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
  write(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ""}`);
  if (origin) {
    const urls = indexable.map((p) => `  <url><loc>${origin}${p.path}</loc></url>`).join("\n");
    write(join(DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  }

  const total = [...assets.values()].reduce((sum, a) => sum + a.bytes, 0);
  if (!quiet) {
    console.log(`Built ${pages.length} pages and ${assets.size} assets (${(total / 1024 / 1024).toFixed(1)} MB) into ${OUT_FLAG ? DIST : "dist/"}${origin ? ` for ${origin}` : ""}.`);
    if (!origin) console.log("SITE_URL is not set: no sitemap, canonical links or share image.");
  }
  return { pages, assets, csp, origin };
}

// Run when called as a script, not when imported.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await build();
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export { DIST, ROOT };
