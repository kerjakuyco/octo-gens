// The frame every page shares: head, header, footer.
import { ADVISORY, NAV, REPO, RELEASES, VERSION, doc, esc, icon, tile } from "./site.mjs";

/**
 * The one inline script: it marks the page as scripted before anything is drawn, so the menu
 * starts closed on a phone instead of flashing open. The build hashes it into the CSP.
 */
export const BOOT = 'document.documentElement.classList.add("js")';

function head(page, ctx) {
  const url = ctx.siteUrl ? `${ctx.siteUrl}${page.path}` : "";
  const social = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="OctoNeo">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    `<meta property="og:description" content="${esc(page.description)}">`,
    `<meta property="og:locale" content="en">`,
  ];
  if (ctx.siteUrl) {
    // Shared links need absolute addresses; without SITE_URL the build leaves them out rather than guess.
    if (page.indexable !== false) social.unshift(`<link rel="canonical" href="${esc(url)}">`);
    if (page.indexable !== false) social.push(`<meta property="og:url" content="${esc(url)}">`);
    social.push(
      `<meta property="og:image" content="${esc(ctx.siteUrl + ctx.asset("images/og.png"))}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="OctoNeo: ask about any market, confirm every order. A sample testnet ticket from the app's built-in mock.">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    );
  }
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#212121" media="(prefers-color-scheme: dark)">
${page.indexable === false ? '<meta name="robots" content="noindex">\n' : ""}<link rel="icon" href="${ctx.asset("images/favicon.svg")}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${ctx.asset("images/apple-touch-icon.png")}">
<link rel="stylesheet" href="${ctx.asset("site.css")}">
<script>${BOOT}</script>
<script src="${ctx.asset("site.js")}" defer></script>
${social.join("\n")}
</head>`;
}

function header(page) {
  const links = NAV.map(
    (item) => `<li><a href="${item.href}"${item.href === page.path ? ' aria-current="page"' : ""}>${item.label}</a></li>`,
  ).join("\n");
  // The menu button comes right before the links it opens, so Tab moves from one into the other.
  // The header's button is quiet: the page's own blue button is the one to press.
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-bar">
    <a class="brand" href="/"${page.path === "/" ? ' aria-current="page"' : ""}>${tile(28)}<span>OctoNeo</span></a>
    <button class="menu-button" type="button" aria-expanded="false" aria-controls="site-nav">
      <span class="menu-open">${icon("menu", 20)}</span><span class="menu-close">${icon("close", 20)}</span><span class="menu-label">Menu</span>
    </button>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul>
${links}
        <li class="nav-github"><a href="${REPO}">GitHub</a></li>
      </ul>
    </nav>
    <a class="button button-quiet button-small header-download" href="/download/"${page.path === "/download/" ? ' aria-current="page"' : ""}>Get OctoNeo</a>
  </div>
</header>`;
}

function footer() {
  const product = [
    ["/assistant/", "The assistant"],
    ["/models/", "Models"],
    ["/markets/", "Markets and orders"],
    ["/news/", "News"],
    ["/wallet/", "Wallet and funds"],
  ];
  const project = [
    ["/safety/", "Safety and privacy"],
    ["/download/", "Get OctoNeo"],
    ["/open-source/", "Open source"],
    [REPO, "Source code on GitHub"],
    [RELEASES, "Releases"],
    [doc("CHANGELOG.md"), "Changelog"],
    [ADVISORY, "Report a vulnerability"],
  ];
  const list = (items) => items.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("\n");
  return `<footer class="site-footer">
  <div class="wrap footer-top">
    <div class="footer-brand">
      <a class="brand" href="/">${tile(28)}<span>OctoNeo</span></a>
      <p>A desktop AI assistant for perpetual futures on a decentralized exchange. Version ${VERSION} for Windows, macOS and Linux.</p>
    </div>
    <nav class="footer-nav" aria-label="Footer">
      <div>
        <h2>Product</h2>
        <ul>
${list(product)}
        </ul>
      </div>
      <div>
        <h2>Project</h2>
        <ul>
${list(project)}
        </ul>
      </div>
    </nav>
  </div>
  <div class="wrap">
    <div class="footer-legal">
      <p><strong>OctoNeo is early software and not financial advice.</strong> Perpetual futures are leveraged: a position can be liquidated and lose its whole margin quickly. Practice on testnet first, and trade on mainnet only with money you can afford to lose.</p>
      <p>OctoNeo is open source under the <a href="${doc("LICENSE")}">GPL-3.0-only license</a>. OpenRouter, Cloudflare, Ollama, LM Studio, MetaMask, Rabby, TradingView, CoinDesk, Cointelegraph, The Block, Decrypt, The Defiant, crypto.news and Yahoo Finance are trademarks of their owners. OctoNeo is an independent project and is not affiliated with or endorsed by any of them.</p>
    </div>
  </div>
</footer>`;
}

export function layout(page, body, ctx) {
  return `<!doctype html>
<html lang="en">
${head(page, ctx)}
<body${page.bodyClass ? ` class="${page.bodyClass}"` : ""}>
${header(page)}
<main id="main" tabindex="-1">
${body}
</main>
${footer()}
</body>
</html>
`;
}
