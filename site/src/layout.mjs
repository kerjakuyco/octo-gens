// The frame every page shares: head, header, footer.
import { ADVISORY, ISSUES, NAV, REPO, RELEASES, doc, esc, icon } from "./site.mjs";

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
      `<meta property="og:image:alt" content="OctoNeo, open-source AI assistant for perpetual futures: “Ask about any market. Confirm every order.” Beside the headline, a sample order ticket from the app: a 7.026 ETH long at 3x on testnet, with a stop-loss and a Place order button.">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    );
  }
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0a0a">
${page.indexable === false ? '<meta name="robots" content="noindex">\n' : ""}<link rel="icon" href="${ctx.asset("images/favicon.svg")}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${ctx.asset("images/apple-touch-icon.png")}">
<link rel="stylesheet" href="${ctx.asset("site.css")}">
<link rel="stylesheet" href="${ctx.asset("pages.css")}">
<script>${BOOT}</script>
<script src="${ctx.asset("site.js")}" defer></script>
${social.join("\n")}
</head>`;
}

/**
 * The header's links: what the app does under Product, each with a line about it, then the
 * project's own pages. The targets and labels are the ones in NAV.
 */
const PRODUCT = [
  ["/assistant/", "Researches with tools and drafts tickets you confirm."],
  ["/markets/", "Every market, the chart, the order book and orders."],
  ["/wallet/", "A trade-only key that cannot withdraw."],
  ["/models/", "OpenRouter, Cloudflare AI Gateway, Ollama or LM Studio."],
  ["/news/", "Eight publishers, searched on your computer."],
];
const PROJECT = ["/safety/", "/open-source/"];

/**
 * The site's mark beside its name: the app's white octopus, without its tile, which the site draws
 * on dark backgrounds only. The favicon and the touch icon keep the tile, for light browser tabs.
 */
function brand(ctx, attributes = "") {
  return `<a class="brand" href="/"${attributes}><img class="brand-mark" src="${ctx.asset("images/octopus.svg")}" width="27" height="26" alt=""><span>OctoNeo</span></a>`;
}

function header(page, ctx) {
  const item = (href) => {
    const found = NAV.find((entry) => entry.href === href);
    if (!found) throw new Error(`the header links to ${href}, which is not in NAV`);
    return found;
  };
  const current = (href) => (href === page.path ? ' aria-current="page"' : "");
  const inProduct = PRODUCT.some(([href]) => href === page.path);
  const product = PRODUCT.map(
    ([href, line]) =>
      `<li><a class="nav-item" href="${href}"${current(href)}><span class="nav-item-label">${item(href).label}</span><span class="nav-item-line">${line}</span></a></li>`,
  ).join("\n");
  const project = PROJECT.map((href) => `<li><a class="nav-link" href="${href}"${current(href)}>${item(href).label}</a></li>`).join("\n");
  // Without the script, Product is a row of plain links and the menu button is not drawn. With it,
  // Product opens a panel on a wide screen, and on a phone the menu button opens a sheet with the
  // same links. The menu button comes right before the links it opens, so Tab moves from one into
  // the other. GitHub and Download are pills on the bar; in the sheet they are its last links.
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header" data-header>
  <div class="header-bar">
    ${brand(ctx, current("/"))}
    <button class="menu-button" type="button" aria-expanded="false" aria-controls="site-nav">
      <span class="menu-open">${icon("menu", 20)}</span><span class="menu-close">${icon("close", 20)}</span><span class="visually-hidden">Menu</span>
    </button>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul class="nav-list">
        <li class="nav-group" data-nav-group>
          <button class="nav-trigger" id="nav-product-trigger" type="button" aria-expanded="false" aria-controls="nav-product"${inProduct ? " data-current" : ""}>Product${icon("chevronDown", 16, "nav-chevron")}</button>
          <div class="nav-panel" id="nav-product">
            <p class="nav-group-title" aria-hidden="true">Product</p>
            <ul class="nav-items" aria-labelledby="nav-product-trigger">
${product}
            </ul>
          </div>
        </li>
${project}
        <li class="nav-github"><a class="nav-link" href="${REPO}">GitHub</a></li>
      </ul>
      <a class="button button-brand nav-download" href="/download/"${current("/download/")}>Download</a>
    </nav>
    <div class="header-actions">
      <a class="button button-quiet button-small" href="${REPO}">GitHub</a>
      <a class="button button-brand button-small" href="/download/"${current("/download/")}>Download</a>
    </div>
  </div>
</header>`;
}

function footer(ctx) {
  const columns = [
    [
      "Product",
      [
        ["/assistant/", "Assistant"],
        ["/markets/", "Markets"],
        ["/wallet/", "Wallet"],
        ["/models/", "Models"],
        ["/news/", "News"],
      ],
    ],
    [
      "Trust",
      [
        ["/safety/", "Safety"],
        ["/open-source/", "Open source"],
        [ADVISORY, "Report a vulnerability"],
      ],
    ],
    [
      "Install",
      [
        ["/download/", "Download"],
        [RELEASES, "Releases"],
        [doc("CHANGELOG.md"), "Changelog"],
      ],
    ],
    [
      "Project",
      [
        [REPO, "GitHub"],
        [doc("LICENSE"), "License"],
        [ISSUES, "Report an issue"],
      ],
    ],
  ];
  const nav = columns
    .map(
      ([title, links]) => `      <div>
        <h2>${title}</h2>
        <ul>
${links.map(([href, label]) => `          <li><a href="${href}">${label}</a></li>`).join("\n")}
        </ul>
      </div>`,
    )
    .join("\n");
  return `<footer class="site-footer">
  <div class="wrap footer-top">
    <div class="footer-brand">
      ${brand(ctx)}
      <p>An open-source AI assistant for perpetual futures: it does the research, and you place every order.</p>
    </div>
    <nav class="footer-nav" aria-label="Footer">
${nav}
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
${header(page, ctx)}
<main id="main" tabindex="-1">
${body}
</main>
${footer(ctx)}
</body>
</html>
`;
}
