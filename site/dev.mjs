// Builds the site, rebuilds it when a source changes, and serves dist/ on this computer.
// No dependencies; Node 20 or newer.
//
//   node dev.mjs            http://localhost:8788
//   PORT=9000 node dev.mjs
//
// The server behaves like Cloudflare's asset handling closely enough for development: a page's
// address without its trailing slash is redirected to it, an unknown address gets 404.html with
// status 404, and the rules in _headers are applied. Refresh the browser after a rebuild.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PORT || 8788);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** Each build runs in its own process, so edited page modules are always read afresh. */
function build() {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, encoding: "utf8" });
  if (result.status === 0) console.log(`Built in ${Date.now() - started} ms.`);
  else console.error(result.stderr || result.stdout);
  rules = readRules();
}

/** The rules of dist/_headers: a path pattern and the headers it adds. */
function readRules() {
  const file = join(DIST, "_headers");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      out.push({ pattern, headers: [] });
    } else if (out.length) {
      const at = line.indexOf(":");
      out.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return out;
}

let rules = [];
build();

let timer = null;
const rebuild = () => {
  clearTimeout(timer);
  timer = setTimeout(build, 120);
};
watch(join(ROOT, "src"), { recursive: true }, rebuild);
watch(join(ROOT, "build.mjs"), rebuild);

function send(response, status, file, path) {
  const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" };
  for (const rule of rules) if (rule.pattern.test(path)) for (const [name, value] of rule.headers) headers[name] = value;
  response.writeHead(status, headers);
  response.end(readFileSync(file));
}

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const file = normalize(join(DIST, ...path.split("/").filter(Boolean)));
  if (!file.startsWith(DIST + sep) && file !== DIST) {
    response.writeHead(400).end();
    return;
  }
  const isFile = existsSync(file) && statSync(file).isFile();
  if (isFile && !file.endsWith(`${sep}_headers`)) return send(response, 200, file, path);
  const index = join(file, "index.html");
  if (existsSync(index)) {
    if (!path.endsWith("/")) {
      response.writeHead(307, { Location: `${path}/` }).end();
      return;
    }
    return send(response, 200, index, path);
  }
  send(response, 404, join(DIST, "404.html"), path);
}).listen(PORT, () => console.log(`Serving dist/ on http://localhost:${PORT}`));
