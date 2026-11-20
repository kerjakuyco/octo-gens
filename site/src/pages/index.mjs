import { SPARK_BTC, demo, scenario } from "../demo.mjs";
import { REPO, RELEASES, VERSION, callout, esc, icon } from "../site.mjs";

/**
 * Every word on the home page, in the order it appears, from the copy deck; the preview of the app
 * has its own words in demo.mjs. Text is HTML. The layout below only places it.
 */
const COPY = {
  title: "OctoNeo | Open-source AI assistant for perpetual futures",
  description:
    "OctoNeo is an open-source desktop AI assistant for perpetual futures on a decentralized exchange. It reads the market and drafts each order; you confirm it.",

  hero: {
    // The pill above the headline: the release, and what it brought. On a phone the words in
    // `wide` are read but not drawn, so the pill keeps to one line.
    news: { chip: "New", text: [["wide", "Version "], ["", `${VERSION}: a full-width market page`]] },
    title: ["Ask about any market.", "Confirm every order."],
    lead: "OctoNeo is an open-source AI assistant for perpetual futures, leveraged contracts that never expire, on a decentralized exchange. It reads the market, sizes trades to your risk and drafts orders.",
    primary: "Download OctoNeo",
    secondary: "View source on GitHub",
    meta: `Version ${VERSION} for Windows, macOS (Apple silicon) and Linux. Open source under GPL-3.0-only. No OctoNeo account, no telemetry.`,
  },

  bento: {
    title: "What OctoNeo does",
    caption:
      "Sample data on testnet, the exchange’s practice network with test funds. The model, the account and the newsrooms are fictional; the figures are illustrative, not live prices.",
  },

  flow: {
    title: "From question to order",
    lead: "The model you connect does the research. The app, not the model, enforces the trading rules. Every order waits for you.",
    primary: "Download OctoNeo",
    secondary: "Every safeguard",
    // Small facts beside the window; each is true of the app today.
    facts: [
      ["3x", "Leverage limit until you raise it"],
      ["4", "Model providers, cloud or local"],
      ["8", "News publishers it reads"],
    ],
  },

  // Big figures, each true of the app today.
  figures: [
    ["0", "OctoNeo servers between you and the exchange"],
    ["3", "Desktop systems: Windows, macOS and Linux"],
    ["GPL-3.0", "Open source, down to the code that signs your orders"],
  ],

  trust: [
    {
      id: "decentral",
      title: "Decentralized: no OctoNeo server in between",
      text: "You trade on a decentralized exchange from your own wallet. OctoNeo runs on your computer and talks directly to the exchange and to the model provider you choose.",
      more: { href: "/safety/", text: "Safety and privacy" },
    },
    {
      id: "wallet",
      title: "Your wallet, your funds",
      text: "OctoNeo trades through a separate key that your own wallet approves for perpetual futures only. That key cannot withdraw, and your wallet’s own key never enters the app.",
      more: { href: "/wallet/", text: "The key, deposits and withdrawals" },
    },
    {
      id: "testnet",
      title: "Practice on testnet first",
      text: "Testnet is the exchange’s practice network: the same order flow, with test funds that have no value. OctoNeo opens on mainnet, where funds are real. When you are ready to trade, switch to Testnet at the top of the window.",
      more: { href: "/download/#start", text: "After you install" },
    },
  ],
  // The status of the live exchange, kept in view as the feature pages keep it. The risk line is in
  // the footer of every page.
  status:
    "<strong>Not yet tried on the live exchange, on either network:</strong> orders, deposits sent from a wallet, and withdrawals. Orders and withdrawals have been checked against a stand-in that follows the exchange’s API documentation, and deposits simulated on their chains without being sent. Start small.",

  start: {
    title: "Start with a question",
    text: "Download OctoNeo, connect a model and ask “BTC outlook”. When you are ready to trade, start on testnet.",
    cards: [
      {
        id: "start-download",
        title: "Download the app",
        text: `Version ${VERSION}, built from this repository by GitHub Actions.`,
        items: [
          "Installers for Windows, macOS (Apple silicon) and Linux",
          "Linux as an AppImage, a .deb or an .rpm package",
          "A SHA-256 checksum for every file on the release page",
          "First-launch steps, since the installers carry no developer certificate",
        ],
        button: { href: "/download/", text: "Download OctoNeo", kind: "brand" },
      },
      {
        id: "start-source",
        title: "Build from source",
        text: "Rust, Node.js 20 or newer, pnpm 10 and Tauri’s system dependencies.",
        items: [
          "Open source under GPL-3.0-only",
          "Read the code that signs your orders",
          "No wallet or model key needed to build or run the tests",
          "The way to run OctoNeo on an Intel Mac",
        ],
        button: { href: REPO, text: "View source on GitHub", kind: "quiet" },
      },
    ],
  },
};

/* ------------------------------------------------------------ the bento */

// Sample data the bento draws beyond the conversations in demo.mjs. Each is the app's own: the Book
// tab of a market's page and Settings, Models are the app's built-in mock, as the pictures on the
// Markets and Models pages show; the deposit is the wallet page against a stand-in, as on the Wallet page.
const BOOK = {
  asks: [
    ["62,927.71", "0.751", 1.121],
    ["62,927.70", "0.37", 0.37],
  ],
  mid: "62,925.18",
  spread: "0.80 bps",
  bids: [
    ["62,922.66", "1.051", 1.051],
    ["62,922.65", "1.31", 2.361],
  ],
};
const DEPOSIT = { networks: ["BNB Smart Chain Testnet", "Sepolia"], asset: "USDT", amount: "250", steps: ["Allow the amount", "Send the deposit", "Wait for the network"] };
const MODELS = [
  ["OpenRouter", "Cloud · Lantern 2 Large", "In use"],
  ["Cloudflare AI Gateway", "Cloud", "Connect"],
  ["Ollama", "On this computer · reef:8b", "Use"],
  ["LM Studio", "On this computer", "Connect"],
];

// Arrows that are not the app's: after "Explore", and in the release pill.
const svg = (d, size, className) =>
  `<svg class="icon ${className}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
const ARROW = svg("M5 12h14m-6-6 6 6-6 6", 16, "b-arrow");
const ARROW_OUT = svg("M7.5 16.5 16.5 7.5M9 7.5h7.5V15", 14, "announce-arrow");

const chip = (text, tone = "") => `<span class="b-chip"${tone ? ` data-tone="${tone}"` : ""}>${text}</span>`;
const facts = (pairs, className = "b-facts") =>
  `<dl class="${className}">${pairs.map(([term, value, tone = ""]) => `<div><dt>${term}</dt><dd class="num${tone ? ` ${tone}` : ""}">${value}</dd></div>`).join("")}</dl>`;
/** A drawn button: a picture of one, so it is a span, not a control. */
const drawnButton = (text, kind) => `<span class="b-button b-button-${kind}">${text}</span>`;

/**
 * One panel of the grid: its name, a slice of the app drawn in HTML, which is read as a picture by
 * its label, and a link to the page about it. The name comes first for assistive technology; the
 * stylesheet draws it under the picture, beside the link, which covers the whole panel.
 */
function panel({ key, label, href, explore, area, ui, attrs = "" }) {
  return `<li class="b-card b-${key}">
<h3 class="b-label">${label}</h3>
<div class="b-ui b-ui-${key}" role="img" aria-label="${esc(area)}"${attrs}>
${ui}
</div>
<a class="b-link" href="${href}">Explore<span class="visually-hidden"> ${explore}</span>${ARROW}</a>
</li>`;
}

function bento() {
  const eth = scenario("eth");
  const plan = eth.cards.find((c) => c.kind === "plan");
  const fact = (name) => plan.facts.find(([term]) => term === name)[1];
  const ticketFact = (name) => eth.ticket.facts.find(([term]) => term === name)[1];
  const btc = scenario("btc");
  const quote = btc.cards.find((c) => c.kind === "quote");
  const book = btc.cards.find((c) => c.kind === "book");
  const news = scenario("news");
  const headlines = news.cards.find((c) => c.kind === "news").rows;

  // The market's line: the sparkline the app draws for BTC, at the size of the panel.
  const line = SPARK_BTC;
  const area = `0,22 ${line} 56,22`;
  // Bars are drawn against a deeper book than the rows shown, as the app's Book tab lists more rows.
  const deepest = 1.25 * Math.max(...BOOK.asks.map((r) => r[2]), ...BOOK.bids.map((r) => r[2]));
  const depth = (total, side) => {
    const w = ((total / deepest) * 100).toFixed(1);
    return `<svg class="b-depth" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect x="${side === "ask" ? (100 - w).toFixed(1) : "0"}" width="${w}" height="10"/></svg>`;
  };
  const bookRow = ([price, size, total], side) =>
    `<div class="b-book-row b-${side}">${depth(total, side)}<span class="num b-book-price">${price}</span><span class="num">${size}</span></div>`;

  const panels = [
    panel({
      key: "assistant",
      label: "Assistant",
      href: "/assistant/",
      explore: "the assistant",
      attrs: " data-play-once",
      area: `Sample conversation on testnet. Asked “${eth.prompt}”, the assistant checks the ETH price, the 4h chart and the account, then plans a ${fact("Size")} long at 3x: entry ${plan.entry}, stop-loss ${plan.stop}, take-profit ${plan.target}. ${eth.ticket.why} The ticket waits for you to place it.`,
      ui: `<p class="b-bubble">${esc(eth.prompt)}</p>
<p class="b-activity">${icon("check", 14)}<span>${esc(eth.summary)}</span></p>
<div class="b-plan">
<div class="b-head"><span class="b-symbol">${plan.base} <span class="b-muted">Plan</span></span>${chip(plan.side, "up")}</div>
${facts([["Entry", plan.entry], ["Stop-loss", plan.stop, "down"], ["Take-profit", plan.target, "up"]], "b-levels")}
${facts([["Size", fact("Size")], ["Loss at stop", fact("Loss at stop")]])}
</div>
<p class="b-reply"><strong>A ${fact("Size")} long risks about 1% of equity.</strong> The ticket is ready. Nothing is sent until you place it.</p>`,
    }),
    panel({
      key: "markets",
      label: "Markets",
      href: "/markets/",
      explore: "markets",
      area: `Sample BTC market on testnet: last price ${quote.price} USDT, ${quote.change.replace("−", "down ")} in 24 hours, with a line of recent prices and the order book: best ask ${book.ask}, best bid ${book.bid}, spread ${book.spread}.`,
      ui: `<div class="b-quote">
<span class="b-pair"><span class="b-symbol">${quote.base}</span><span class="b-muted"> / USDT</span></span>
<span class="b-price num">${quote.price}</span>${chip(quote.change, "down")}
</div>
<svg class="b-chart" viewBox="0 0 56 22" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polygon class="b-chart-area" points="${area}"/><polyline class="b-chart-line" points="${line}"/></svg>
<div class="b-book">
<div class="b-book-head"><span>Price</span><span>Size (${quote.base})</span></div>
${BOOK.asks.map((r) => bookRow(r, "ask")).join("\n")}
<div class="b-book-mid"><span class="num">${BOOK.mid}</span><span class="num">Spread ${BOOK.spread}</span></div>
${BOOK.bids.map((r) => bookRow(r, "bid")).join("\n")}
</div>`,
    }),
    panel({
      key: "safety",
      label: "Safety",
      href: "/safety/",
      explore: "safety",
      area: `Sample ticket on testnet: ${eth.ticket.action} ${eth.ticket.pair}. ${eth.ticket.effect}, stop-loss ${ticketFact("Stop-loss")}, take-profit ${ticketFact("Take-profit")}. Nothing reaches the exchange until you place the ticket.`,
      ui: `<div class="b-ticket">
<div class="b-head"><span class="b-ticket-title">${chip(eth.ticket.action, "up")}<span class="b-symbol">${eth.ticket.pair}</span></span>${chip("Testnet", "warn")}</div>
<p class="b-effect">${eth.ticket.effect}</p>
${facts([["Quantity", ticketFact("Quantity")], ["Leverage", ticketFact("Leverage")], ["Stop-loss", ticketFact("Stop-loss")], ["Take-profit", ticketFact("Take-profit")]])}
<div class="b-buttons">${drawnButton("Place order", "primary")}${drawnButton("Dismiss", "ghost")}</div>
</div>`,
    }),
    panel({
      key: "wallet",
      label: "Wallet",
      href: "/wallet/",
      explore: "the wallet",
      area: `Sample deposit on testnet, on the page OctoNeo serves on your computer: ${DEPOSIT.amount} ${DEPOSIT.asset} on ${DEPOSIT.networks[0]}. Your wallet allows the amount and sends the deposit, then the network confirms it.`,
      ui: `<p class="b-title">Deposit to your trading account</p>
<div class="b-field"><span class="b-field-label">Network</span><span class="b-options">${DEPOSIT.networks.map((n, i) => `<span class="b-option"${i ? "" : " data-selected"}>${n}</span>`).join("")}</span></div>
<div class="b-amount"><span class="b-amount-value num">${DEPOSIT.amount}</span><span class="b-amount-unit">${DEPOSIT.asset}</span></div>
${drawnButton(`Deposit ${DEPOSIT.amount} ${DEPOSIT.asset}`, "primary")}
<ol class="b-steps">${DEPOSIT.steps.map((step) => `<li>${step}</li>`).join("")}</ol>`,
    }),
    panel({
      key: "models",
      label: "Models",
      href: "/models/",
      explore: "models",
      area: "Settings, Models: OpenRouter in use with the fictional model Lantern 2 Large, Cloudflare AI Gateway in the cloud, Ollama on this computer, and LM Studio on this computer. Your own key, or a model on your own computer.",
      ui: `<p class="b-title">Models</p>
<ul class="b-list">
${MODELS.map(
  ([name, where, action]) =>
    `<li><span class="b-row-main"><span class="b-row-name">${name}${action === "In use" ? chip("In use", "up") : ""}</span><span class="b-row-sub">${esc(where)}</span></span>${action === "In use" ? drawnButton("Change", "outline") : drawnButton(action, "outline")}</li>`,
).join("\n")}
</ul>`,
    }),
    panel({
      key: "news",
      label: "News",
      href: "/news/",
      explore: "news",
      area: `Sample news card for BTC: ${headlines.length} headlines from invented newsrooms, each with its source and how long ago, and an answer that names the newest report.`,
      ui: `<div class="b-head"><span class="b-news-head">${icon("news", 16)}News <span class="b-muted">BTC</span></span></div>
<ul class="b-news-list">
${headlines.map(([title, source, age]) => `<li><span class="b-news-title">${esc(title)}</span><span class="b-news-meta"><span>${esc(source)}</span><span class="num">${age}</span></span></li>`).join("\n")}
</ul>
<p class="b-reply"><strong>The Brine Report has the newest report on BTC:</strong> what BTC holders are watching this week.</p>`,
    }),
  ];
  return `<ul class="bento">
${panels.join("\n")}
</ul>`;
}

/* ----------------------------------------------------------- the page */

const check = icon("check", 18, "checklist-mark");

export default {
  path: "/",
  title: COPY.title,
  description: COPY.description,
  bodyClass: "page-home",
  render: () => `
<section class="hero" aria-labelledby="hero-title">
  <div class="wrap hero-inner">
    <a class="announce" href="${RELEASES}/tag/v${VERSION}"><span class="announce-chip">${COPY.hero.news.chip}</span><span class="announce-text">${COPY.hero.news.text.map(([kind, text]) => (kind ? `<span class="announce-${kind}">${text}</span>` : text)).join("")}</span><span class="announce-go">${ARROW_OUT}</span></a>
    <h1 class="hero-title" id="hero-title">${COPY.hero.title.map((line) => `<span>${line}</span>`).join(" ")}</h1>
    <p class="hero-lead">${COPY.hero.lead}</p>
    <div class="actions hero-actions">
      <a class="button button-brand" href="/download/">${COPY.hero.primary}${icon("chevron", 16)}</a>
      <a class="button button-quiet" href="${REPO}">${COPY.hero.secondary}</a>
    </div>
    <p class="hero-meta">${COPY.hero.meta}</p>
  </div>
</section>

<section class="home-band bento-band" aria-labelledby="bento-title">
  <div class="wrap">
    <h2 class="visually-hidden" id="bento-title">${COPY.bento.title}</h2>
${bento()}
    <p class="bento-caption">${COPY.bento.caption}</p>
  </div>
</section>

<section class="home-band split" aria-labelledby="flow-title">
  <div class="wrap split-grid">
    <div class="split-copy">
      <h2 class="home-title" id="flow-title">${COPY.flow.title}</h2>
      <p class="home-lead">${COPY.flow.lead}</p>
      <div class="actions">
        <a class="button button-brand" href="/download/">${COPY.flow.primary}${icon("chevron", 16)}</a>
        <a class="button button-quiet" href="/safety/">${COPY.flow.secondary}</a>
      </div>
      <dl class="split-facts">
${COPY.flow.facts.map(([figure, text]) => `        <div><dt>${figure}</dt><dd>${text}</dd></div>`).join("\n")}
      </dl>
    </div>
    <div class="split-demo">
${demo()}
    </div>
  </div>
</section>

<div class="home-band figures-band">
  <div class="wrap">
    <dl class="figures">
${COPY.figures.map(([figure, text]) => `      <div><dt>${figure}</dt><dd>${text}</dd></div>`).join("\n")}
    </dl>
  </div>
</div>

<div class="home-band trust">
  <div class="wrap">
    <div class="trust-grid">
${COPY.trust
  .map(
    (item) => `      <section class="trust-item" aria-labelledby="${item.id}-title">
        <h2 id="${item.id}-title">${item.title}</h2>
        <p>${item.text}</p>
        <p class="more"><a href="${item.more.href}">${item.more.text}</a></p>
      </section>`,
  )
  .join("\n")}
    </div>
    ${callout(`<p>${COPY.status}</p>`)}
  </div>
</div>

<section class="home-band start" aria-labelledby="start-title">
  <div class="wrap">
    <div class="start-head">
      <h2 class="home-title" id="start-title">${COPY.start.title}</h2>
      <p class="home-lead">${COPY.start.text}</p>
    </div>
    <div class="start-grid">
${COPY.start.cards
  .map(
    (card) => `      <article class="start-card" aria-labelledby="${card.id}">
        <h3 id="${card.id}">${card.title}</h3>
        <p>${card.text}</p>
        <ul class="checklist">
${card.items.map((item) => `          <li>${check}<span>${item}</span></li>`).join("\n")}
        </ul>
        <a class="button button-${card.button.kind}" href="${card.button.href}">${card.button.text}</a>
      </article>`,
  )
  .join("\n")}
    </div>
  </div>
</section>
`,
};
