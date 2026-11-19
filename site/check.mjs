// Checks the built site in dist/. `pnpm run check` builds first, then runs this.
//
// It fails when:
//   - an internal href, src or srcset does not resolve to a built file, or a #fragment to an id
//   - any text the site serves, or any of its sources, names the exchange
//   - a page loads anything from another site, or has inline styles, inline handlers, or an
//     inline script whose hash the Content-Security-Policy does not allow
//   - a page's <title> or meta description is missing or used by another page
//   - a page lacks lang="en", one <h1>, unique ids, or width, height and alt on an image
//   - _headers, robots.txt or the 404 page is missing, or a picture is over 400 KB
// No dependencies; Node 20 or newer.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

if (!existsSync(DIST)) {
  console.error("dist/ does not exist. Run `node build.mjs` first, or `pnpm run check`, which builds.");
  process.exit(1);
}

function walk(dir, skip = new Set()) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

const rel = (base, file) => relative(base, file).split(sep).join("/");
const built = walk(DIST);
const TEXT = /\.(?:html|css|js|mjs|txt|xml|svg|json|jsonc|md)$|(?:^|\/)_headers$/;

const origin = (() => {
  const raw = (process.env.SITE_URL ?? "").trim();
  return raw ? new URL(raw).origin : "";
})();

/* -------------------------------------------------- the exchange's name */

// Spelled in two parts so that this file does not trip its own check. Words that only contain
// the letters, such as "faster" or "master", are not the name.
const NAME = new RegExp(`(?<![a-z])${"as"}${"ter"}(?!isk|oid)`, "gi");
const sources = walk(ROOT, new Set(["node_modules", "dist", ".wrangler", "pnpm-lock.yaml"])).filter((f) => TEXT.test(f.split(sep).join("/")));
for (const [base, list, label] of [
  [DIST, built.filter((f) => TEXT.test(rel(DIST, f))), "dist"],
  [ROOT, sources, "site"],
]) {
  for (const file of list) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(NAME)) {
      const around = content.slice(Math.max(0, match.index - 30), match.index + 30).replace(/\s+/g, " ");
      fail(`${label}/${rel(base, file)}`, `names the exchange: "…${around}…"`);
    }
  }
}

/* ------------------------------------------------------------- headers */

const headersFile = join(DIST, "_headers");
let csp = "";
if (!existsSync(headersFile)) {
  fail("_headers", "missing");
} else {
  const headers = readFileSync(headersFile, "utf8");
  csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? "";
  if (!csp) fail("_headers", "no Content-Security-Policy");
  for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'none'", "object-src 'none'"]) {
    if (!csp.includes(directive)) fail("_headers", `the CSP lacks ${directive}`);
  }
  if (/unsafe-inline|unsafe-eval|\*/.test(csp)) fail("_headers", "the CSP allows inline code, eval or any host");
  if (/https?:/.test(csp)) fail("_headers", "the CSP allows another site");
  for (const header of ["X-Content-Type-Options: nosniff", "Referrer-Policy:", "Permissions-Policy:"]) {
    if (!headers.includes(header)) fail("_headers", `missing ${header}`);
  }
  if (!/\/assets\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/.test(headers)) fail("_headers", "assets are not cached as immutable");
}
const allowedScripts = new Set([...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]));

/* --------------------------------------------------------------- pages */

const pages = built.filter((f) => f.endsWith(".html"));
const pageInfo = new Map();
const ATTR = /([^\s=/]+)(?:\s*=\s*"([^"]*)")?/g;
const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*\/?>/g;
const decode = (value) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const ids = new Set();
  for (const [, id] of html.matchAll(/\sid="([^"]+)"/g)) {
    if (ids.has(id)) fail(rel(DIST, file), `id "${id}" is used twice`);
    ids.add(id);
  }
  pageInfo.set(file, { html, ids });
}

/** The built file an internal address serves, or null. */
function target(address) {
  const path = decodeURI(address.split(/[?#]/)[0]);
  if (path.endsWith("/")) {
    const index = join(DIST, ...path.split("/").filter(Boolean), "index.html");
    return existsSync(index) ? index : null;
  }
  const file = join(DIST, ...path.split("/").filter(Boolean));
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const titles = new Map();
const descriptions = new Map();
const external = new Set();

for (const [file, { html, ids }] of pageInfo) {
  const where = rel(DIST, file);
  const check = (condition, what) => condition || fail(where, what);

  check(/^<!doctype html>/i.test(html), "does not start with <!doctype html>");
  check(/<html lang="en">/.test(html), 'lacks <html lang="en">');
  check((html.match(/<h1[\s>]/g) ?? []).length === 1, "does not have exactly one <h1>");

  const title = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1].trim());
  check(title.length === 1 && title[0], "needs one non-empty <title>");
  if (title[0]) titles.set(title[0], [...(titles.get(title[0]) ?? []), where]);
  const description = [...html.matchAll(/<meta name="description" content="([^"]*)">/g)].map((m) => m[1].trim());
  check(description.length === 1 && description[0], "needs one non-empty meta description");
  if (description[0]) descriptions.set(description[0], [...(descriptions.get(description[0]) ?? []), where]);

  for (const [, body] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!body.trim()) continue;
    const hash = createHash("sha256").update(body).digest("base64");
    check(allowedScripts.has(hash), `has an inline script the CSP does not allow (sha256-${hash})`);
  }
  check(!/<style[\s>]/i.test(html), "has a <style> element, which the CSP blocks");

  for (const [, tag, attrText] of html.matchAll(TAG)) {
    const name = tag.toLowerCase();
    const attrs = new Map([...attrText.matchAll(ATTR)].map(([, key, value]) => [key.toLowerCase(), value === undefined ? "" : decode(value)]));
    if (["iframe", "frame", "object", "embed", "applet", "base", "form"].includes(name)) fail(where, `has a <${name}>`);
    if (attrs.has("style")) fail(where, `<${name}> has a style attribute, which the CSP blocks`);
    for (const key of attrs.keys()) if (key.startsWith("on")) fail(where, `<${name}> has an inline ${key} handler`);

    const resource = (value, what) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return fail(where, `<${name}> loads ${what} from another site: ${value}`);
      if (!value.startsWith("/")) return fail(where, `<${name}> ${what} is not an absolute path: ${value}`);
      if (!target(value)) fail(where, `<${name}> ${what} does not resolve: ${value}`);
    };

    if (name === "img" || name === "source") {
      if (attrs.has("src")) resource(attrs.get("src"), "src");
      if (attrs.has("srcset")) for (const candidate of attrs.get("srcset").split(",")) resource(candidate.trim().split(/\s+/)[0], "srcset");
    }
    if (name === "img") {
      for (const required of ["alt", "width", "height"]) if (!attrs.has(required)) fail(where, `<img ${attrs.get("src")}> has no ${required}`);
    }
    if (name === "script" && attrs.has("src")) resource(attrs.get("src"), "src");
    if (name === "link") {
      const relValue = attrs.get("rel") ?? "";
      if (relValue === "canonical") {
        if (!origin) fail(where, "has a canonical link without SITE_URL");
        else if (!attrs.get("href").startsWith(`${origin}/`)) fail(where, `canonical link is not on ${origin}`);
      } else {
        resource(attrs.get("href") ?? "", "href");
      }
    }
    if (name === "meta" && ["og:image", "og:url"].includes(attrs.get("property"))) {
      const content = attrs.get("content");
      if (!origin) fail(where, `has ${attrs.get("property")} without SITE_URL`);
      else if (!content.startsWith(`${origin}/`)) fail(where, `${attrs.get("property")} is not on ${origin}`);
      else if (attrs.get("property") === "og:image" && !target(content.slice(origin.length))) fail(where, `og:image does not resolve: ${content}`);
    }
    if (name === "a" && attrs.has("href")) {
      const href = attrs.get("href");
      if (href.startsWith("#")) {
        if (href.length > 1 && !ids.has(decodeURIComponent(href.slice(1)))) fail(where, `links to #${href.slice(1)}, which is not on the page`);
      } else if (href.startsWith("/") && !href.startsWith("//")) {
        const page = target(href);
        if (!page) {
          const bare = href.split(/[?#]/)[0];
          fail(where, target(`${bare}/`) ? `links to ${href} without its trailing slash` : `links to ${href}, which does not exist`);
        } else if (href.includes("#")) {
          const fragment = decodeURIComponent(href.split("#")[1]);
          if (fragment && !pageInfo.get(page)?.ids.has(fragment)) fail(where, `links to ${href}, but that page has no #${fragment}`);
        }
      } else if (/^https?:\/\//.test(href)) {
        external.add(href);
      } else if (!/^mailto:/.test(href)) {
        fail(where, `has a link that is neither internal nor http(s): ${href}`);
      }
    }
    for (const key of ["aria-controls", "aria-labelledby", "aria-describedby"]) {
      if (!attrs.has(key)) continue;
      for (const id of attrs.get(key).split(/\s+/)) if (!ids.has(id)) fail(where, `${key} points at #${id}, which is not on the page`);
    }
  }
}

for (const [title, where] of titles) if (where.length > 1) fail(where.join(", "), `share the title "${title}"`);
for (const [text, where] of descriptions) if (where.length > 1) fail(where.join(", "), `share the description "${text.slice(0, 60)}…"`);

/* ------------------------------------------------- stylesheets, scripts */

for (const file of built.filter((f) => f.endsWith(".css"))) {
  const css = readFileSync(file, "utf8");
  if (/@import/.test(css)) fail(rel(DIST, file), "uses @import");
  if (/@font-face/.test(css)) fail(rel(DIST, file), "loads a font");
  for (const [, address] of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (address.startsWith("data:") || address.startsWith("#")) continue;
    if (!address.startsWith("/") || address.startsWith("//") || !target(address)) fail(rel(DIST, file), `url(${address}) is not a file of this site`);
  }
}
for (const file of built.filter((f) => f.endsWith(".js"))) {
  const js = readFileSync(file, "utf8");
  if (/https?:\/\/|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\(/.test(js)) fail(rel(DIST, file), "makes or names a network request");
}

/* ------------------------------------------------- the rest of the site */

if (!existsSync(join(DIST, "404.html"))) fail("404.html", "missing");
if (!existsSync(join(DIST, "robots.txt"))) fail("robots.txt", "missing");
if (origin && !existsSync(join(DIST, "sitemap.xml"))) fail("sitemap.xml", "missing although SITE_URL is set");
if (!origin && existsSync(join(DIST, "sitemap.xml"))) fail("sitemap.xml", "written without SITE_URL");
if (existsSync(join(DIST, "sitemap.xml"))) {
  for (const [, loc] of readFileSync(join(DIST, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)) {
    if (!loc.startsWith(`${origin}/`) || !target(loc.slice(origin.length))) fail("sitemap.xml", `${loc} is not a page of this site`);
  }
}
for (const file of built.filter((f) => /\.(?:webp|png|jpe?g|avif|gif|svg)$/.test(f))) {
  const size = statSync(file).size;
  if (size > 400 * 1024) fail(rel(DIST, file), `is ${(size / 1024).toFixed(0)} KB, over 400 KB`);
}
if (built.some((f) => /\.(?:woff2?|ttf|otf|eot)$/.test(f))) fail("dist", "contains a font file");

/* -------------------------------------------------------------- report */

if (problems.length) {
  console.error(`Check failed with ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `Check passed: ${pageInfo.size} pages, ${built.length} files. Internal links and assets resolve, no third-party resources, ` +
    `titles and descriptions are unique, and the exchange is not named. ${external.size} outbound links.`,
);
