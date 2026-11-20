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
| `--out=<folder>` | `build.mjs`, `check.mjs` and `dev.mjs` all take it, to build into, check or serve another folder than `dist/`: two people (or two agents) can preview at once, each on their own `PORT`, without overwriting each other. |
| `pnpm run preview` | Builds, then serves `dist/` with `wrangler dev`, the way Cloudflare will, headers included. |
| `pnpm run deploy` | Builds for https://octoneo.xyz, then deploys with `wrangler deploy`. |

## How it is put together

```
build.mjs           Renders the pages, copies assets with a content hash in their names, writes _headers,
                    robots.txt and, with SITE_URL, sitemap.xml.
check.mjs           Checks the built site. Run by `pnpm run check`.
dev.mjs             Rebuilds on change and serves dist/ (or --out) on this computer.
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

Every page works without JavaScript. The one script, `src/assets/site.js`, opens the Product menu and the menu on narrow screens, marks the section being read in the page index, plays the Assistant card on the home page once when it comes into view, and plays the demo's answers when a prompt is picked; it respects reduced motion.

The look is monochrome and dark only: near-black, white and grey text, hairlines, a white pill for the main action and a dark pill for the second. Colour means something: green and red for up and down, amber for testnet and warnings, and the brand blue only on the "New" chip at the top of the home page. The pictures of the app on the home page and at the top of each feature page are drawn in HTML and CSS, not screenshots.

### The demo and the sample figures

The cards under the home page's headline, the demo window beside "From question to order" and the drawn panels on the feature pages are HTML, not pictures. The demo's three prompts are suggestions the app itself offers, and every figure and sentence in it is what the app's built-in mock answers on testnet with its fictional model, "Lantern 2 Large". `src/demo.mjs` exports those figures, and the cards and the share picture reuse them, so the site agrees with itself. Each page says beside them that they are samples. If the app's answers or cards change, update `src/demo.mjs` from the mock: run the interface with `pnpm dev` in the repository root and ask the same prompts.

### Rules the content keeps

- **The exchange is never named.** Say "a decentralized exchange" or "the exchange". `pnpm run check` fails on the name, in `dist/` and in this folder's sources.
- **Every claim comes from the project's documents:** `README.md`, `docs/assistant.md`, `docs/exchange.md`, `docs/architecture.md`, `SECURITY.md`, `CHANGELOG.md`, `NOTICE.md` and `CONTRIBUTING.md`. No invented features, figures, users or prices.
- **No third-party requests.** No CDNs, analytics, embeds, web fonts or remote pictures. The Content Security Policy in `_headers` enforces it, and `check` fails on any of them. Links to other sites are fine.
- **Type is the system's own.** `system-ui, -apple-system, Roboto, "Noto Sans", sans-serif` and `ui-monospace, monospace`. No font files.
- **Other companies' names are text only**, never their logos. The footer carries the trademark note from `NOTICE.md`, and pictures with a chart credit TradingView.

On each release, update `VERSION` in `src/site.mjs` (the download page builds its links from it) and `RELEASED` in `src/pages/download.mjs`.

## Headers and caching

`build.mjs` writes `dist/_headers`, which Cloudflare applies to every response:

- A Content Security Policy that allows only this site's own files: `default-src 'self'`, no inline script except the one-line script in the head, which is allowed by its hash, no inline styles, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'` and `frame-ancestors 'none'`. The hash is recomputed on every build.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off camera, microphone, location, payment and USB, `Cross-Origin-Opener-Policy: same-origin` and `X-Frame-Options: DENY`.
- `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`, whose names change with their content, and `public, max-age=0, must-revalidate` for pages, so a deploy shows at once.

Leave off Cloudflare features that add scripts to pages, such as Rocket Loader or automatic Web Analytics: the policy blocks them, and the site makes no third-party requests.

## The site's address

The site lives at https://octoneo.xyz, with www.octoneo.xyz as a second name for it. `pnpm run deploy` builds with `--site-url=https://octoneo.xyz`, which adds a canonical link and absolute `og:url` and `og:image` to every page, a `Sitemap:` line to `robots.txt`, and `sitemap.xml`.

`pnpm run build`, `check` and `dev` leave those out, because they need an absolute address. To build for another address, pass `--site-url=` or set `SITE_URL` (the flag wins):

```sh
node build.mjs --site-url=https://octoneo.example
```

## Deploying

### With the command line

```sh
pnpm exec wrangler login        # once, opens Cloudflare in your browser
pnpm install && pnpm run deploy
```

Deploying creates or updates the Worker `octoneo` and attaches the custom domains in `wrangler.jsonc` (octoneo.xyz and www.octoneo.xyz). Cloudflare creates their DNS records and certificates, which only works when octoneo.xyz is a zone in the same Cloudflare account as the Worker. The Worker also stays reachable at its `workers.dev` address. `pnpm exec wrangler deploy --dry-run` shows what would be uploaded without signing in.

### With Cloudflare's Git integration (Workers Builds)

The Worker `octoneo` is connected to this repository: a push to `main` that changes a file in `site/` builds and deploys the site. Its settings are in the Cloudflare dashboard, under the Worker's Settings, Build:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `site` |
| Build command | `pnpm install --frozen-lockfile` |
| Deploy command | `pnpm run deploy` (builds for octoneo.xyz, then deploys) |
| Build watch paths | Include `site/*`, so a push that changes only the app does not rebuild the site |
| Build variables | `NODE_VERSION=22` if the build image does not read `.node-version` |

**The root directory must be `site`.** With the repository root, the build runs the app's own `pnpm run build`, and `wrangler deploy` publishes the desktop app's web interface in place of the website, on every push.

The Worker's name in the dashboard must be `octoneo`, the name in `wrangler.jsonc`. `pnpm run deploy` from this folder still works by hand, but the next push that changes `site/` deploys `main` again, so push what you deploy.

## Pictures

The screenshots in `src/assets/shots/` are of the app's interface running in a browser against its built-in mock: a fictional account and a fictional model, nothing real. Each is saved in light and dark as `<name>-<light|dark>-<pixel width>.webp`, and the build turns the dark ones into `<picture>` elements: the site is dark only. It publishes only the pictures a page shows; the light copies and the pictures no page uses stay in the folder for later. Pictures sit in the text column of the feature pages, 760 pixels wide at most. A picture named `<name>-phone` is a crop that replaces `<name>` on screens up to 640 pixels wide, where a whole window would shrink its text past reading. To take them again, after a change to the interface:

```sh
cd ..                                            # the repository root
pnpm build && pnpm exec vite preview --port 4322 --strictPort
cd site                                          # in another terminal
CHROME=/path/to/chrome node tools/screenshots.mjs        # or name the pictures to retake
```

`APP_URL` points the tool at another address, and `CDP_PORT` moves Chrome's debugging port from 9801.

The three pictures of the wallet page (`wallet-*.webp`) are of the page the app opens in your browser, taken against a stand-in for the exchange with a test wallet; `cargo run -p octoneo-core --example wallet_page -- connect` serves that page. They are taken 2200 pixels wide; the 1520 and 760 copies are made from them with `cwebp -q 80 -m 6 -sharp_yuv -resize <width> 0`.

The share picture `src/assets/images/og.png` is rendered from `src/og/card.html`, and the 180-pixel touch icon from the app icon; `CHROME=/path/to/chrome node tools/render-images.mjs` renders both again. The icon in `src/assets/images/icon.svg` is the app icon, `src-tauri/app-icon.svg`, cropped to its tile, and is the source of the touch icon; `favicon.svg` is `public/favicon.svg`. The site's own mark, in the header, the footer, the 404 page and the share picture, is `octopus.svg`: the app icon's white octopus without its tile. The share picture embeds it, so render the picture again after changing it.
