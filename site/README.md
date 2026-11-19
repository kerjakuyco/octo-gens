# The OctoNeo website

Static pages about OctoNeo, served by [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) as an assets-only Worker named `octoneo`. There is no server code: Cloudflare serves the files in `dist/`.

The pages are written in plain JavaScript modules and built by `build.mjs`, which has no dependencies. The only package is Wrangler, Cloudflare's command-line tool, pinned to 4.157.0.

## What you need

- Node.js 22 or newer. `build.mjs`, `check.mjs` and `dev.mjs` run on Node 20; Wrangler 4.157 needs 22.
- pnpm 10. Corepack picks the version named in `package.json`.

## Commands

Run them in this folder.

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs Wrangler. Nothing else is needed to build. |
| `pnpm run build` | Builds the site into `dist/`. |
| `pnpm run check` | Builds, then checks `dist/`. It fails when an internal link or picture does not resolve, when anything names the exchange, when a page loads anything from another site or has inline code the security policy would block, or when two pages share a title or a description. |
| `pnpm run dev` | Builds, rebuilds when a file in `src/` changes, and serves `dist/` on http://localhost:8788. Refresh the browser after a change. `PORT` picks another port. |
| `pnpm run preview` | Builds, then serves `dist/` with `wrangler dev`, the way Cloudflare will, headers included. |
| `pnpm run deploy` | Builds, then deploys with `wrangler deploy`. |

## How it is put together

```
build.mjs           Renders the pages, copies assets with a content hash in their names, writes _headers,
                    robots.txt and, with SITE_URL, sitemap.xml.
check.mjs           Checks the built site. Run by `pnpm run check`.
dev.mjs             Rebuilds on change and serves dist/ on this computer.
wrangler.jsonc      The assets-only Worker.
src/layout.mjs      The head, header and footer every page shares.
src/site.mjs        Links, icons and small HTML helpers: tables, facts, code blocks, the page index.
src/demo.mjs        The preview of the assistant on the home page.
src/pages/*.mjs     One file per page: its address, title, description and content.
src/assets/         The stylesheet, the script, the icons and the pictures. Served from /assets/ under hashed names.
src/static/         Files served from the root as they are (favicon.ico).
src/og/card.html    The picture shown when a link to the site is shared, before it is rendered.
tools/              Scripts that take the screenshots and render the share picture. Not part of the build.
```

Every page works without JavaScript. The one script, `src/assets/site.js`, opens the menu on narrow screens, marks the section being read in the page index, and plays the preview on the home page; it respects reduced motion.

### The preview on the home page

The conversation at the top of the home page is HTML, not a picture. Its three prompts are suggestions the app itself offers, and every figure and sentence in it is what the app's built-in mock answers on testnet with its fictional model, "Lantern 2 Large". The page says so beside it. If the app's answers or cards change, update `src/demo.mjs` from the mock: run the interface with `pnpm dev` in the repository root and ask the same prompts.

### Rules the content keeps

- **The exchange is never named.** Say "a decentralized exchange" or "the exchange". `pnpm run check` fails on the name, in `dist/` and in this folder's sources.
- **Every claim comes from the project's documents:** `README.md`, `docs/assistant.md`, `docs/exchange.md`, `docs/architecture.md`, `SECURITY.md`, `CHANGELOG.md`, `NOTICE.md` and `CONTRIBUTING.md`. No invented features, figures, users or prices.
- **No third-party requests.** No CDNs, analytics, embeds, web fonts or remote pictures. The Content Security Policy in `_headers` enforces it, and `check` fails on any of them. Links to other sites are fine.
- **Type is the system's own.** `system-ui, -apple-system, Roboto, "Noto Sans", sans-serif` and `ui-monospace, monospace`. No font files.
- **Other companies' names are text only**, never their logos. The footer carries the trademark note from `NOTICE.md`, and pictures with a chart credit TradingView.

When the first release with installers is published, update `src/pages/download.mjs` and the "None published yet" line on it.

## Headers and caching

`build.mjs` writes `dist/_headers`, which Cloudflare applies to every response:

- A Content Security Policy that allows only this site's own files: `default-src 'self'`, no inline script except the one-line script in the head, which is allowed by its hash, no inline styles, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'` and `frame-ancestors 'none'`. The hash is recomputed on every build.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off camera, microphone, location, payment and USB, `Cross-Origin-Opener-Policy: same-origin` and `X-Frame-Options: DENY`.
- `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`, whose names change with their content, and `public, max-age=0, must-revalidate` for pages, so a deploy shows at once.

Leave off Cloudflare features that add scripts to pages, such as Rocket Loader or automatic Web Analytics: the policy blocks them, and the site makes no third-party requests.

## SITE_URL

Set `SITE_URL` to the site's origin, such as `https://octoneo.example`, when you build for a real address. The build then adds a canonical link and absolute `og:url` and `og:image` to every page, a `Sitemap:` line to `robots.txt`, and `sitemap.xml`. Without it those are left out, because they need an absolute address and the build will not guess one.

```sh
SITE_URL=https://octoneo.example pnpm run deploy
```

## Deploying

### With the command line

```sh
pnpm exec wrangler login        # once, opens Cloudflare in your browser
pnpm install && pnpm run deploy
```

The first deploy creates the Worker `octoneo` in your account and prints its `workers.dev` address. Add a custom domain in the dashboard under the Worker's settings, then deploy again with `SITE_URL` set to it. `pnpm exec wrangler deploy --dry-run` shows what would be uploaded without signing in.

### With Cloudflare's Git integration (Workers Builds)

In the Cloudflare dashboard, create a Worker from this Git repository and set:

| Setting | Value |
| --- | --- |
| Root directory | `site` |
| Build command | `pnpm install && pnpm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `SITE_URL`, set to the site's address; `NODE_VERSION=22` if the build image does not read `.node-version` |

The Worker's name in the dashboard must be `octoneo`, the name in `wrangler.jsonc`. Every push to the production branch then builds and deploys the site.

## Pictures

The screenshots in `src/assets/shots/` are of the app's interface running in a browser against its built-in mock: a fictional account and a fictional model, nothing real. Each is saved in light and dark as `<name>-<light|dark>-<pixel width>.webp`, and the build turns them into `<picture>` elements that follow the visitor's color scheme. A picture is shown at one of two widths: 760 pixels, the text column, or 1136, the page. A picture named `<name>-phone` is a crop that replaces `<name>` on screens up to 640 pixels wide, where a whole window would shrink its text past reading. To take them again, after a change to the interface:

```sh
cd ..                                            # the repository root
pnpm build && pnpm exec vite preview --port 4322 --strictPort
cd site                                          # in another terminal
CHROME=/path/to/chrome node tools/screenshots.mjs        # or name the pictures to retake
```

`APP_URL` points the tool at another address, and `CDP_PORT` moves Chrome's debugging port from 9801.

The three pictures of the wallet page (`wallet-*.webp`) are of the page the app opens in your browser, taken against a stand-in for the exchange with a test wallet; `cargo run -p octoneo-core --example wallet_page -- connect` serves that page. They are taken 2200 pixels wide; the 1520 and 760 copies are made from them with `cwebp -q 80 -m 6 -sharp_yuv -resize <width> 0`.

The share picture `src/assets/images/og.png` is rendered from `src/og/card.html`, and the 180-pixel touch icon from the app icon; `CHROME=/path/to/chrome node tools/render-images.mjs` renders both again. The icon in `src/assets/images/icon.svg` is the app icon, `src-tauri/app-icon.svg`, cropped to its tile; `favicon.svg` is `public/favicon.svg`.
