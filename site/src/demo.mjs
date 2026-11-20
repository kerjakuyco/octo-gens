// The home page's preview of the assistant: three of the app's suggestion prompts, drawn the way the
// app draws them. Every figure and sentence below is what the app's built-in mock answers on testnet
// with its fictional model, so it is sample data, not live prices. The page shows the first
// conversation finished; picking a prompt, or Replay, has the script in site.js play one step by step.
// The bento grid on the home page draws its Assistant, Markets and Safety cards from the same
// conversations (`scenario`, `SPARK_BTC`), so the page agrees with itself.
import { esc, followChips, icon } from "./site.mjs";

const SAMPLE_NOTE =
  "Sample conversation on testnet, the exchange’s practice network with test funds. The model and the account are fictional; the figures are illustrative, not live prices.";
const NEWS_NOTE = "Sample headlines from invented newsrooms. OctoNeo itself reads seven real publishers.";

const SPARK_ETH =
  "0.0,20.0 1.9,16.6 3.9,15.2 5.8,16.3 7.7,12.8 9.7,9.2 11.6,10.0 13.5,6.9 15.4,9.3 17.4,7.3 19.3,7.1 21.2,4.7 23.2,6.6 25.1,8.3 27.0,5.0 29.0,2.0 30.9,2.5 32.8,4.7 34.8,7.8 36.7,8.2 38.6,10.6 40.6,8.1 42.5,9.2 44.4,8.0 46.3,3.5 48.3,4.3 50.2,2.9 52.1,4.7 54.1,5.7 56.0,8.3";
export const SPARK_BTC =
  "0.0,7.0 1.9,11.0 3.9,12.4 5.8,11.0 7.7,14.2 9.7,17.4 11.6,14.7 13.5,16.4 15.4,18.2 17.4,20.0 19.3,18.5 21.2,18.5 23.2,19.0 25.1,18.5 27.0,19.4 29.0,18.4 30.9,15.5 32.8,15.2 34.8,14.5 36.7,13.7 38.6,10.1 40.6,6.8 42.5,3.1 44.4,3.1 46.3,3.1 48.3,2.0 50.2,4.9 52.1,4.6 54.1,6.0 56.0,7.7";

const SCENARIOS = [
  {
    id: "eth",
    prompt: "Long ETH, 1% risk",
    note: SAMPLE_NOTE,
    summary: "Checked ETH price, 4h chart, account and 1 more, drafted a ticket",
    phases: ["Checking ETH price", "Checking 4h chart", "Checking account", "Checking position size", "Drafting a ticket"],
    steps: [
      { name: "Model", detail: "Lantern 2 Large, round 1", at: -1 },
      {
        name: "Price",
        detail: "ETHUSDT",
        preview: '{"quotes":[{"symbol":"ETHUSDT","last_price":1778.89,"change_24h_pct":-1.16,"funding_rate_pct":0.0101}]}',
        at: 0,
      },
      {
        name: "Chart",
        detail: "ETHUSDT 4h",
        preview:
          '{"symbol":"ETHUSDT","timeframe":"4h","trend":"mixed","rsi_14":52.6,"atr_pct":1.03,"support":[1770.02,1756.57,1749.47],"resistance":[1784.78,1797.55,1810.14]}',
        at: 1,
      },
      { name: "Account", detail: "", preview: "equity 10000.00 USDT, 0 open position(s), 0 open order(s)", at: 2 },
      {
        name: "Position size",
        detail: "ETHUSDT",
        preview: '{"quantity":7.026,"margin_usdt":4166.17,"loss_at_stop_usdt":99.99,"stop_is_inside_liquidation":true}',
        at: 3,
      },
      { name: "Ticket", detail: "open_long 7.026 ETHUSDT", preview: '{"drafted":true,"effect":"Opens a 7.026 ETH long at 3x with isolated margin"}', at: 4 },
      { name: "Model", detail: "Lantern 2 Large, round 2", at: 5 },
    ],
    cards: [
      { kind: "quote", at: 0, base: "ETH", price: "1,778.89", change: "−1.16%", tone: "down", funding: "+0.0101%", spark: SPARK_ETH, rising: true },
      {
        kind: "technicals",
        at: 1,
        base: "ETH",
        frame: "4h",
        trend: "Mixed",
        rsi: 52.6,
        macd: ["Rising", "up"],
        atr: "1.03%",
        support: "1,770.02",
        resistance: "1,784.78",
      },
      { kind: "account", at: 2, equity: "10,000.00", available: "10,000.00", pnl: "0.00" },
      {
        kind: "plan",
        at: 3,
        base: "ETH",
        side: "Long 3x",
        entry: "1,778.89",
        stop: "1,764.66",
        target: "1,807.36",
        facts: [
          ["Size", "7.026 ETH"],
          ["Value", "12,498.51 USDT"],
          ["Margin", "4,166.17 USDT"],
          ["Loss at stop", "99.99 USDT (1%)"],
          ["Est. liquidation", "1,194.82"],
          ["Reward to risk", "2.0 : 1"],
        ],
      },
    ],
    answer: `<p><strong>A 7.026 ETH long risks about 1% of equity.</strong></p>
<ul>
<li>Entry near 1,778.89, stop at 1,764.66, target 1,807.36.</li>
<li>That is 12,498.51 USDT of ETH on 4,166.17 USDT of margin at 3x.</li>
<li>The stop triggers well before the estimated liquidation at 1,194.82.</li>
</ul>
<p>The ticket is ready. Nothing is sent until you place it. This is testnet: practice funds.</p>`,
    ticket: {
      at: 4,
      action: "Long",
      pair: "ETH-USDT",
      effect: "Opens a 7.026 ETH long at 3x with isolated margin",
      facts: [
        ["Order size", "7.026 ETH"],
        ["Notional", "12,498.51 USDT"],
        ["Leverage", "3x"],
        ["Initial margin", "4,166.17 USDT"],
        ["Est. liq. price", "1,194.82"],
        ["Stop-loss", "1,764.66"],
        ["Take-profit", "1,807.36"],
      ],
      why: "Risks about 1% of equity, 99.99 USDT, if the stop at 1,764.66 is hit.",
    },
  },
  {
    id: "btc",
    prompt: "BTC outlook",
    note: SAMPLE_NOTE,
    summary: "Checked BTC price, 4h chart and order book",
    phases: ["Checking BTC price", "Checking 4h chart", "Checking order book"],
    steps: [
      { name: "Model", detail: "Lantern 2 Large, round 1", at: -1 },
      {
        name: "Price",
        detail: "BTCUSDT",
        preview: '{"quotes":[{"symbol":"BTCUSDT","last_price":62925.18,"change_24h_pct":-0.95,"funding_rate_pct":0.0183}]}',
        at: 0,
      },
      {
        name: "Chart",
        detail: "BTCUSDT 4h",
        preview:
          '{"symbol":"BTCUSDT","timeframe":"4h","trend":"mixed","rsi_14":50.8,"atr_pct":0.97,"support":[62800.51,61872.04,61516.28],"resistance":[63132.23,63606.89,64243.6]}',
        at: 1,
      },
      { name: "Order book", detail: "BTCUSDT", preview: '{"symbol":"BTCUSDT","spread_bps":0.8,"bid_share_pct":58.1}', at: 2 },
      { name: "Model", detail: "Lantern 2 Large, round 2", at: 3 },
    ],
    cards: [
      { kind: "quote", at: 0, base: "BTC", price: "62,925.18", change: "−0.95%", tone: "down", funding: "+0.0183%", spark: SPARK_BTC, rising: false },
      {
        kind: "technicals",
        at: 1,
        base: "BTC",
        frame: "4h",
        trend: "Mixed",
        rsi: 50.8,
        macd: ["Falling", "down"],
        atr: "0.97%",
        support: "62,800.51",
        resistance: "63,132.23",
      },
      { kind: "book", at: 2, base: "BTC", bid: "62,922.66", ask: "62,927.70", spread: "0.80 bps", bids: 58 },
    ],
    answer: `<p><strong>BTC is without a clear trend on the 4h chart</strong>, last at 62,925.18 USDT.</p>
<ul>
<li>Price is between the 20 and 50 EMAs.</li>
<li>RSI 14 reads 50.8: neutral.</li>
<li>Nearest support is 62,800.51; resistance is 63,132.23.</li>
<li>Funding is +0.0183% per 8 hours, so longs pay shorts.</li>
<li>Bids hold 58% of the depth shown.</li>
</ul>
<p>A 4h close below 62,800.51 would break the setup. This is testnet: prices can differ from mainnet.</p>`,
    // The next steps the app offers under this answer: a trade or a grid bot to look over in the message
    // box, or a question it has not read yet.
    follow: [
      ["Long BTC", "trendUp", "up", "/long"],
      ["Short BTC", "trendDown", "down", "/short"],
      ["Grid BTC", "grid", "", "/grid"],
      ["Why is BTC moving?", "news", "", ""],
    ],
  },
  {
    id: "news",
    prompt: "Market news",
    note: NEWS_NOTE,
    summary: "Checked the news",
    phases: ["Reading the news"],
    steps: [
      { name: "Model", detail: "Lantern 2 Large, round 1", at: -1 },
      {
        name: "News",
        detail: "",
        preview:
          '{"query":"","results":[["The Brine Report","What BTC holders are watching this week"],["Kelp Desk","Funding on BTC perpetuals stays positive after the move"],["Tidewire","BTC slides 0.9% in a day as traders cut leverage"]]}',
        at: 0,
      },
      { name: "Model", detail: "Lantern 2 Large, round 2", at: 1 },
    ],
    cards: [
      {
        kind: "news",
        at: 0,
        rows: [
          ["What BTC holders are watching this week", "The Brine Report", "5h"],
          ["Funding on BTC perpetuals stays positive after the move", "Kelp Desk", "5h"],
          ["BTC slides 0.9% in a day as traders cut leverage", "Tidewire", "6h"],
        ],
      },
    ],
    answer: `<p><strong>The Brine Report has the newest report on BTC:</strong> what BTC holders are watching this week.</p>
<ul>
<li>3 headlines from the last day, the oldest 6h ago.</li>
<li>News explains a move. It does not say what comes next, so the stop stays where the chart puts it. This is testnet: prices can differ from mainnet.</li>
</ul>`,
    follow: [["Top movers", "bolt", "", ""]],
  },
];

/** One of the conversations, by id: "eth", "btc" or "news". */
export function scenario(id) {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`demo: no conversation ${id}`);
  return found;
}

const at = (value) => ` data-at="${value}"`;

function fact(term, value, tone = "") {
  return `<div class="d-fact"><dt>${term}</dt><dd class="num${tone ? ` ${tone}` : ""}">${value}</dd></div>`;
}

function rsiBar(value) {
  // The band between 30 and 70, and where the reading sits on 0 to 100.
  const x = ((value / 100) * 56).toFixed(1);
  return `<span class="d-rsi"><svg class="d-rsi-track" viewBox="0 0 56 8" width="56" height="8" aria-hidden="true" focusable="false"><rect class="d-rsi-rail" x="0" y="2" width="56" height="4" rx="2"/><rect class="d-rsi-band" x="16.8" y="2" width="22.4" height="4"/><circle class="d-rsi-dot" cx="${x}" cy="4" r="4"/></svg><span class="num">${value.toFixed(1)}</span></span>`;
}

function shareBar(bids) {
  return `<div class="d-share"><svg class="d-share-bar" viewBox="0 0 100 6" preserveAspectRatio="none" width="100%" height="6" aria-hidden="true" focusable="false"><rect class="d-share-ask" x="0" y="0" width="100" height="6"/><rect class="d-share-gap" x="${bids - 0.6}" y="0" width="1.2" height="6"/><rect class="d-share-bid" x="0" y="0" width="${bids - 0.6}" height="6"/></svg><div class="d-share-legend num"><span class="up">Bids ${bids}%</span><span class="down">Asks ${100 - bids}%</span></div></div>`;
}

function card(c) {
  switch (c.kind) {
    case "quote":
      return `<div class="d-card d-card-wide" role="group" aria-label="Prices"${at(c.at)}>
<ul class="d-rows"><li class="d-row d-quote-row">
<span class="d-symbol">${c.base}</span>
<span class="num d-quote-price">${c.price}</span>
<span class="num d-quote-change ${c.tone}">${c.change}</span>
<span class="num d-quote-funding d-muted">Funding ${c.funding}</span>
<svg class="d-spark ${c.rising ? "d-spark-up" : "d-spark-down"}" viewBox="0 0 56 22" width="56" height="22" aria-hidden="true" focusable="false"><polyline points="${c.spark}"/></svg>
</li></ul>
</div>`;
    case "technicals":
      return `<div class="d-card" role="group" aria-label="Chart reading"${at(c.at)}>
<header class="d-card-head"><span class="d-symbol">${c.base} <span class="d-muted">${c.frame}</span></span><span class="d-chip">${c.trend}</span></header>
<dl class="d-facts">
<div class="d-fact"><dt>RSI</dt><dd>${rsiBar(c.rsi)}</dd></div>
${fact("MACD", c.macd[0], c.macd[1])}
${fact("ATR", c.atr)}
${fact("Support", c.support)}
${fact("Resistance", c.resistance)}
</dl>
</div>`;
    case "book":
      return `<div class="d-card" role="group" aria-label="Order book"${at(c.at)}>
<header class="d-card-head"><span class="d-symbol">${c.base} <span class="d-muted">Order book</span></span></header>
<dl class="d-facts">
${fact("Best bid", c.bid, "up")}
${fact("Best ask", c.ask, "down")}
${fact("Spread", c.spread)}
</dl>
${shareBar(c.bids)}
</div>`;
    case "account":
      return `<div class="d-card d-card-wide" role="group" aria-label="Account"${at(c.at)}>
<dl class="d-levels">
${fact("Equity", c.equity)}
${fact("Available", c.available)}
${fact("Unrealized P/L", c.pnl)}
</dl>
<p class="d-card-empty">No open positions</p>
</div>`;
    case "plan":
      return `<div class="d-card d-card-wide" role="group" aria-label="Plan"${at(c.at)}>
<header class="d-card-head"><span class="d-symbol">${c.base} <span class="d-muted">Plan</span></span><span class="d-chip" data-tone="up">${c.side}</span></header>
<dl class="d-levels">
${fact("Entry", c.entry)}
${fact("Stop-loss", c.stop, "down")}
${fact("Take-profit", c.target, "up")}
</dl>
<dl class="d-facts d-facts-two">
${c.facts.map(([term, value]) => fact(term, value)).join("\n")}
</dl>
</div>`;
    case "news":
      return `<div class="d-card d-card-wide" role="group" aria-label="News"${at(c.at)}>
<header class="d-card-head"><span class="d-news-head">${icon("news", 16)}News</span></header>
<ul class="d-rows">
${c.rows
  .map(
    ([title, source, age]) =>
      `<li class="d-row d-news-row"><span class="d-news-title">${esc(title)}</span><span class="d-news-source d-muted">${esc(source)}</span><span class="d-news-age num d-muted">${age}</span></li>`,
  )
  .join("\n")}
</ul>
</div>`;
    default:
      throw new Error(`unknown card ${c.kind}`);
  }
}

function ticket(t) {
  return `<div class="d-card d-ticket" role="group" aria-label="${t.action} ETH order" data-state="pending"${at(t.at)}>
<header class="d-card-head"><span class="d-ticket-title"><span class="d-chip" data-tone="up">${t.action}</span><span class="d-symbol">${t.pair}</span><span class="d-chip">Market</span></span><span class="d-chip">Testnet</span></header>
<p class="d-ticket-effect">${t.effect}</p>
<dl class="d-facts d-facts-two">
${t.facts.map(([term, value]) => fact(term, value)).join("\n")}
</dl>
<p class="d-ticket-why">${t.why}</p>
<div class="d-ticket-actions">
<button type="button" class="d-btn d-btn-primary" data-ticket="place">Place order</button>
<button type="button" class="d-btn d-btn-ghost" data-ticket="dismiss">Discard</button>
</div>
<p class="d-note" data-ticket-note hidden>${icon("check", 16)}<span>Nothing was sent: this is a sample. In OctoNeo, placing a ticket is the only way an order reaches the exchange, and the app checks your position and the price again before it sends anything.</span></p>
<p class="d-dismissed" data-ticket-dismissed hidden>Order draft expired</p>
</div>`;
}

function steps(list) {
  return `<ol class="d-steps">
${list
  .map(
    (step) => `<li class="d-step"${at(step.at)}><span class="d-step-mark">${icon("check", 14)}</span><span class="d-step-body"><span class="d-step-head"><span class="d-step-name">${step.name}</span>${
      step.detail ? `<span class="d-muted d-truncate">${esc(step.detail)}</span>` : ""
    }</span>${step.preview ? `<span class="d-step-preview">${esc(step.preview)}</span>` : ""}</span></li>`,
  )
  .join("\n")}
</ol>`;
}

function panel(s, index) {
  return `<div class="d-panel" role="tabpanel" id="d-panel-${s.id}" aria-labelledby="d-tab-${s.id}" tabindex="0" data-note="${esc(s.note)}"${index ? " hidden" : ""}>
<article class="d-turn">
<div class="d-said"><p class="d-bubble">${esc(s.prompt)}</p></div>
<div class="d-answer">
<details class="d-activity" data-phases="${esc(JSON.stringify(s.phases))}">
<summary><span class="d-activity-text" data-summary="${esc(s.summary)}">${esc(s.summary)}</span>${icon("chevron", 14, "d-activity-chevron")}</summary>
${steps(s.steps)}
</details>
<div class="d-cards">
${s.cards.map(card).join("\n")}
</div>
<div class="d-md" data-stream>
${s.answer}
</div>
${s.ticket ? ticket(s.ticket) : ""}
${s.follow ? followChips(s.follow, " data-follow") : ""}
</div>
</article>
</div>`;
}

export function demo() {
  const tabs = SCENARIOS.map(
    (s, index) =>
      `<button type="button" class="d-suggestion" role="tab" id="d-tab-${s.id}" aria-controls="d-panel-${s.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${esc(s.prompt)}</button>`,
  ).join("\n");
  // The prompts are the tabs of the conversations. They sit under the window, in the order they are
  // seen, so Tab reaches the conversation first; without the script they are not drawn and the
  // first conversation is shown on its own.
  return `<div class="demo" data-demo>
<div class="d-window">
<div class="d-bar" aria-hidden="true">
<span class="d-bar-start"><span class="d-model">Lantern 2 Large ${icon("chevronDown", 16)}</span><span class="d-chip">Sample</span></span>
<span class="d-bar-end">
<span class="d-pill"><span class="d-dot"></span>Testnet ${icon("chevronDown", 14)}</span>
<span class="d-pill d-balance">${icon("wallet", 16)}<span class="num">10,000.00 USDT</span></span>
</span>
</div>
<div class="d-panels">
${SCENARIOS.map(panel).join("\n")}
</div>
<div class="d-composer" aria-hidden="true"><span class="d-composer-text">Ask anything, or type / for commands</span><span class="d-composer-tools"><span class="d-tool">${icon("slash", 15)}Commands</span><span class="d-tool">${icon("dollar", 15)}Market</span><span class="d-send">${icon("send", 18)}</span></span></div>
</div>
<div class="d-suggestions" role="tablist" aria-label="Prompts" hidden>
${tabs}
</div>
<div class="demo-caption">
<p class="demo-note" data-demo-note>${SCENARIOS[0].note}</p>
<button type="button" class="demo-replay" data-demo-replay hidden>Replay</button>
</div>
</div>`;
}
