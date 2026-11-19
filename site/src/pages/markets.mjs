import { TRADINGVIEW, callout, chip, code, doc, docPage, facts, literal, network, out, reference, table, ui, uiFacts } from "../site.mjs";

const chartBy = `Chart by ${out(TRADINGVIEW, "TradingView")}.`;

/* -------------------------------------------------------- the head's picture */

// The market panel for BTC as the app's built-in mock shows it on testnet: the figures are the
// mock's, read from the app's own screenshots on this page (the panel, Book and Funding). The
// candles are a sample drawn to the same shape; the last one is the mock's own.

/** A small random number generator with a fixed seed, so every build draws the same sample. */
function random(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 96 four-hour candles, 3 to 19 November. The last day ends on the mock's 24h figures. */
function candles() {
  const rand = random(7);
  // Where the closes pass, by candle: a dip, a rally, a range, then the last day.
  const path = [
    [0, 59100], [6, 59350], [12, 59000], [18, 59550], [22, 58800], [26, 58050], [30, 58600], [34, 59400],
    [40, 60600], [46, 61800], [52, 62800], [56, 63150], [60, 62300], [64, 61900], [68, 62450], [72, 62050],
    [76, 62550], [80, 63050], [84, 63300], [89, 63528.7],
  ];
  const at = (i) => {
    const k = path.findIndex(([index]) => index >= i);
    const [i1, v1] = path[k];
    if (i1 === i || k === 0) return v1;
    const [i0, v0] = path[k - 1];
    return v0 + ((v1 - v0) * (i - i0)) / (i1 - i0);
  };
  const out = [];
  let open = 59020;
  for (let i = 0; i <= 89; i += 1) {
    const close = i === 89 ? 63528.7 : at(i) + (rand() - 0.5) * 340;
    const high = Math.max(open, close) + rand() * 170;
    const low = Math.min(open, close) - rand() * 170;
    out.push([open, high, low, close]);
    open = close;
  }
  // The last 24 hours: up to the 24h high, down to the 24h low, and the mock's last candle.
  out.push(
    [63528.7, 64225.14, 63410.2, 64010.4],
    [64010.4, 64118.9, 63352.6, 63421.3],
    [63421.3, 63486.1, 62488.4, 62611.9],
    [62611.9, 62826.5, 62233.01, 62540.2],
    [62540.2, 63118.7, 62497.3, 63029.86],
    [63029.86, 63374.44, 62877.28, 62925.18],
  );
  return out;
}

function ema(values, length) {
  const k = 2 / (length + 1);
  const out = [];
  values.forEach((value, i) => out.push(i === 0 ? value : value * k + out[i - 1] * (1 - k)));
  return out;
}

/**
 * The chart: candles, two moving averages, the levels the mock reports and volume underneath. It
 * stretches to its box, so lines keep their width with a non-scaling stroke; the price scale is
 * text beside it, so it stays legible at any width.
 */
function chart() {
  const bars = candles();
  const W = 960;
  const H = 400;
  const TOP = 64600;
  const BOTTOM = 57400;
  const PLOT = 300;
  const y = (price) => ((TOP - price) / (TOP - BOTTOM)) * PLOT;
  const step = W / bars.length;
  const n = (v) => v.toFixed(1);
  const wick = { up: "", down: "" };
  const body = { up: "", down: "" };
  const volume = { up: "", down: "" };
  const rand = random(11);
  bars.forEach(([o, h, l, c], i) => {
    const side = c >= o ? "up" : "down";
    const x = step * i + step / 2;
    wick[side] += `M${n(x)} ${n(y(h))}V${n(y(l))}`;
    const top = y(Math.max(o, c));
    const height = Math.max(1, y(Math.min(o, c)) - top);
    body[side] += `M${n(x - step * 0.32)} ${n(top)}h${n(step * 0.64)}v${n(height)}h${n(-step * 0.64)}z`;
    const v = 18 + rand() * 52 + (i > 89 ? 18 : 0);
    volume[side] += `M${n(x - step * 0.32)} ${H}v${n(-v)}h${n(step * 0.64)}v${n(v)}z`;
  });
  const closes = bars.map(([, , , c]) => c);
  const line = (values) => values.map((v, i) => `${n(step * i + step / 2)},${n(y(v))}`).join(" ");
  const level = (price, cls) => `<path class="ui-level ${cls}" d="M0 ${n(y(price))}H${W}"/>`;
  // The price scale is text over the chart's box. The page's CSS cannot be inline, so pages.css
  // places each label by the share of the box it names in data-top or data-left; a label whose
  // value pages.css does not list sits at the top, which a change here makes plain at once.
  // The three levels are stacked around the last price, as the app's chart stacks them.
  const pct = (price) => ((y(price) / H) * 100).toFixed(2);
  // 62,000 is left out: it would sit under the stacked levels, as it does in the app.
  const marks = [64000, 60000, 58000].map(
    (price) => `<span class="ui-axis-mark num" data-top="${pct(price)}">${price.toLocaleString("en-US")}.00</span>`,
  );
  const levels = [
    [63132.23, "down"],
    [62925.18, "last"],
    [62800.51, "up"],
  ].map(
    ([price, tone]) =>
      `<span class="ui-axis-level num" data-tone="${tone}" data-top="${pct(62925.18)}">${price.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>`,
  );
  const days = [
    [17, "6"],
    [47, "11"],
    [77, "16"],
  ].map(([i, day]) => `<span class="ui-axis-day" data-left="${(((step * i + step / 2) / W) * 100).toFixed(2)}">${day}</span>`);
  return `<div class="ui-chart">
<div class="ui-chart-plot">
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
<path class="ui-grid" d="${[64000, 62000, 60000, 58000].map((p) => `M0 ${n(y(p))}H${W}`).join("")}"/>
<path class="ui-volume up" d="${volume.up}"/><path class="ui-volume down" d="${volume.down}"/>
${level(63132.23, "down")}${level(62800.51, "up")}${level(62925.18, "last")}
<polyline class="ui-ema ui-ema-50" points="${line(ema(closes, 50))}"/>
<polyline class="ui-ema ui-ema-20" points="${line(ema(closes, 20))}"/>
<path class="ui-wick up" d="${wick.up}"/><path class="ui-wick down" d="${wick.down}"/>
<path class="ui-body up" d="${body.up}"/><path class="ui-body down" d="${body.down}"/>
</svg>
<div class="ui-axis-days">${days.join("")}</div>
</div>
<div class="ui-axis">${marks.join("")}${levels.join("")}</div>
</div>`;
}

/** The mock's order book for BTC: price, size and running total, asks above the price, bids below. */
const ASKS = [
  ["62,927.81", "0.296", "4.15"],
  ["62,927.80", "0.363", "3.854"],
  ["62,927.79", "1.065", "3.491"],
  ["62,927.77", "0.378", "2.426"],
  ["62,927.74", "0.524", "2.048"],
  ["62,927.72", "0.403", "1.524"],
  ["62,927.71", "0.751", "1.121"],
  ["62,927.70", "0.37", "0.37"],
];
const BIDS = [
  ["62,922.66", "1.051", "1.051"],
  ["62,922.65", "1.31", "2.361"],
  ["62,922.64", "0.916", "3.277"],
  ["62,922.63", "0.968", "4.245"],
];

function book() {
  const depth = 4.245;
  // The depth bar is the running total, as a share of the deepest side shown, in tenths.
  const row = ([price, size, total], tone) =>
    `<li class="ui-book-row" data-tone="${tone}" data-depth="${Math.round((Number(total) / depth) * 10)}"><span class="num ${tone}">${price}</span><span class="num">${size}</span><span class="num">${total}</span></li>`;
  return `<section class="ui-col ui-book">
<p class="ui-col-title">Book</p>
<p class="ui-book-head"><span>Price</span><span>Size (BTC)</span><span>Total</span></p>
<ol class="ui-book-rows">${ASKS.map((r) => row(r, "down")).join("")}</ol>
<p class="ui-book-mid"><strong class="num">62,925.18</strong><span>Spread 0.80 bps</span></p>
<ol class="ui-book-rows">${BIDS.map((r) => row(r, "up")).join("")}</ol>
</section>`;
}

/** Two weeks of settled funding, every eight hours: a sample between the mock's own bounds. */
function funding() {
  const rand = random(3);
  const rates = Array.from({ length: 42 }, (_, i) => (i === 33 || i === 34 ? 0.0289 : 0.008 + rand() * 0.0175));
  const W = 42 * 6;
  const bars = rates.map((rate, i) => `M${i * 6 + 0.6} 60v${(-(rate / 0.0289) * 56).toFixed(1)}h4.8v${((rate / 0.0289) * 56).toFixed(1)}z`).join("");
  return `<section class="ui-col ui-funding">
<p class="ui-col-title">Funding</p>
<div class="ui-tiles">
<div><span>Rate</span><strong class="num up">+0.0183%</strong></div>
<div><span>Annualised</span><strong class="num">+20.04%</strong></div>
</div>
<svg class="ui-funding-bars" viewBox="0 0 ${W} 60" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${bars}"/></svg>
<p class="ui-funding-range"><span>5 Nov, 23:00</span><span>19 Nov, 15:00</span></p>
${uiFacts([
  ["Interval", "8h"],
  ["Direction", "Longs pay"],
  ["Open interest", "3.8K BTC"],
  ["Value", "238.1M USDT"],
])}
</section>`;
}

const PANEL = ui({
  className: "ui-market",
  label:
    "A sample of the market panel for BTC on testnet: the price 62,925.18, down 0.95% in 24 hours, with mark and index price, funding, open interest, volume and the 24-hour range; a 4h candlestick chart with two moving averages, resistance at 63,132.23 and support at 62,800.51; the order book around the price with a spread of 0.80 basis points; and funding at +0.0183% every 8 hours, longs paying.",
  caption: `A slice of the market panel, drawn with the sample figures of the app’s built-in mock and candles that illustrate them: not live prices. In the app the chart is by ${out(TRADINGVIEW, "TradingView")}.`,
  body: `<div class="ui-bar">
<span class="ui-bar-start"><span class="ui-pair"><strong>BTC</strong> / USDT</span><strong class="ui-price num">62,925.18</strong>${chip("−0.95%", "down")}<span class="ui-muted">24h</span></span>
<span class="ui-bar-end">${network("Testnet")}${chip("Sample")}</span>
</div>
${uiFacts(
  [
    ["Mark", "62,920.15"],
    ["Index", "62,912.60"],
    ["Funding", "+0.0183%", "up"],
    ["Next funding", "03:40:17"],
    ["Open interest", "238.1M"],
    ["24h volume", "1.3B"],
    ["24h high", "64,225.14"],
    ["24h low", "62,233.01"],
  ],
  "ui-stats",
)}
<div class="ui-market-body">
<section class="ui-col ui-chart-col">
<div class="ui-chart-tools"><span class="ui-segments"><span>15m</span><span>1h</span><span data-on>4h</span><span>1d</span></span><span class="ui-legend"><span class="ui-legend-20">EMA 20</span><span class="ui-legend-50">EMA 50</span></span></div>
${chart()}
<p class="ui-ohlc num"><span>O 63,029.86</span><span>H 63,374.44</span><span>L 62,877.28</span><span>C <span class="down">62,925.18</span></span></p>
</section>
${book()}
${funding()}
</div>`,
});

export default {
  path: "/markets/",
  title: "Markets and orders | OctoNeo",
  description:
    "A screener of every market, a chart on four timeframes, the order book, funding and open interest, technical readings, and how an OctoNeo ticket becomes an order.",
  render: (ctx) =>
    docPage({
      path: "/markets/",
      title: "Every market, read straight from the exchange",
      lead: "Market data needs no wallet, no account and no model. The app opens on mainnet prices, and the screener, the chart and the market panel all read directly from the exchange’s public API.",
      visual: PANEL,
      sections: [
        {
          id: "screener",
          title: "A screener of every market",
          body: `<p><strong>Markets</strong> lists every perpetual market the exchange is trading, most traded first, with its price, 24h change, volume and funding. Sort by any column, search, and add a market to your watchlist with its star.</p>
${ctx.figure("markets", {
  alt: "The Markets page: top gainer, top loser, highest funding and most traded at the top, then a sortable table of markets with price, 24h change, volume and funding, and the market panel on the right.",
  caption: `Markets, most traded first, beside the market panel. Sample data from the app’s built-in mock. ${chartBy}`,
  kind: "inset",
})}
${reference("How market names are matched, and what the watchlist starts with", facts([
  ["Names", `Matched without guessing: ${code("BTCUSDT")}, ${code("btc/usdt")}, ${code("$BTC")}, ${code("BTC-PERP")} and ${code("btc")} all mean ${code("BTCUSDT")}. A bare asset prefers its USDT market, then USD1, then USDC.`],
  ["Unknown names", "A name the exchange does not list is an error. It is never replaced by something similar."],
  ["Watchlist", "Starts with the major markets the network lists. Markets you add are remembered, and shown on every network that lists them."],
], "facts-wide"))}`,
        },
        {
          id: "panel",
          title: "The market panel",
          lead: "Beside the conversation, the panel shows the market in focus and follows what the assistant looks at: a chart on 15m, 1h, 4h and 1d, the mark price, funding and the time to the next payment.",
          body: `<div class="panel-figures">
${ctx.figure("panel", {
  alt: "The head of the market panel: BTC price, 24h change, mark and index price, funding, next funding time, open interest, 24h volume, high and low, and a 4h candlestick chart with two moving averages.",
  caption: `The panel’s head and chart. ${chartBy}`,
  kind: "panel",
})}
<div class="panel-tabs-text">
${table({
  head: ["Tab", "What it shows"],
  stack: true,
  rows: [
    ["Book", "The best bids and asks with their running size, the spread, the share of resting size on each side, and the latest trades."],
    ["Funding", "The rate now and what it comes to over a year, two weeks of settled rates, and open interest."],
    ["Technicals", "Trend, RSI, MACD, ATR, moving averages, support and resistance on four timeframes side by side."],
    ["Watchlist", "Your markets, each with a 90-day sparkline."],
  ],
})}
<p>Everything in the panel is public data read on demand. None of it needs a wallet or a model, and none of it is kept between launches.</p>
</div>
</div>
<div class="tab-figures">
${ctx.figure("tab-book", { alt: "The Book tab: asks and bids with size and running total, the spread, and the share of resting size on each side.", caption: "Book", kind: "tab" })}
${ctx.figure("tab-funding", { alt: "The Funding tab: the rate now, the annualized rate, the time to the next payment, a bar chart of two weeks of settled rates, the interval, who pays, and open interest.", caption: "Funding", kind: "tab" })}
${ctx.figure("tab-technicals", { alt: "The Technicals tab: trend, RSI, MACD and ATR on 15m, 1h, 4h and 1d, and the nearest resistance and support levels on the 4h chart.", caption: "Technicals", kind: "tab" })}
${ctx.figure("tab-watchlist", { alt: "The Watchlist tab: markets with price, 24h change and a 90-day sparkline each.", caption: "Watchlist", kind: "tab" })}
</div>`,
        },
        {
          id: "requests",
          title: "Requests to the exchange",
          lead: "The market panel asks only for the market on screen, and only while the window is in view.",
          body: `${reference("What each part asks for, and how often", facts([
            ["Watchlist and screener", "Two requests each, however many markets, because the price and funding endpoints answer for every market at once."],
            ["Sparklines", "Daily history, read again every ten minutes."],
            ["Order book", "Twenty levels a side and the last forty trades, every four seconds while the Book tab is open."],
            ["Funding", "Two weeks of settled funding, with open interest."],
            ["Technicals", "Candles for a reading on each timeframe."],
            ["Retries", "A public read is retried once when no answer arrives. A signed request is sent exactly once."],
          ], "facts-wide"))}
<p>The full list of requests, signed and unsigned, is in ${out(doc("docs/exchange.md", "what-the-app-asks-the-exchange"), "docs/exchange.md")}.</p>`,
        },
        {
          id: "orders",
          title: "How a ticket becomes an order",
          lead: "Every order starts as a ticket: what it does to your position, its value, the margin it needs and an estimated liquidation price. Ask the assistant for one, or use Trade in the market panel, which needs no model.",
          body: `${callout(`<p><strong>Not yet tried on the live exchange, on either network:</strong> orders, deposits sent from a wallet and withdrawals. Orders and withdrawals have been checked against a stand-in that follows the exchange’s API documentation, and deposits by simulating them on their chains without sending them. Practice on testnet, then start small.</p>`)}
<h3>Checked before you see it</h3>
${reference("Seven checks, and what happens when one fails", table({
  head: ["Check", "If it fails"],
  stack: true,
  rowHeaders: false,
  rows: [
    ["The quantity is rounded down to the market’s step and must reach its smallest order and smallest value", "The ticket is refused, with the market’s limit"],
    ["Leverage must be within your limit: 3x by default, 50x at most", "Refused"],
    ["On USDT-margined markets, the margin must fit in the available balance", "Refused, with both figures"],
    ["A stop-loss must be on the losing side of the price, and inside the estimated liquidation price for isolated margin", "Refused"],
    ["An order against a position may shrink or close it, never flip it", "Refused; close first"],
    ["A ticket from the assistant that opens or adds to a position must carry a stop-loss", "Refused, and the model is told why"],
    ["The network, the wallet and the risk limits must not change while the ticket is priced", "The ticket is discarded"],
  ],
}))}
<h3>Checked again when you confirm</h3>
<p>A ticket can wait while you read it, and the market does not. So when you press Place order, the app checks again before it sends anything, in this order:</p>
<ol class="steps-list">
<li><strong>The position</strong> must be exactly as it was when the ticket was drafted: the same size and direction, and for an addition the same leverage and margin mode. Otherwise nothing is sent.</li>
<li><strong>The price.</strong> For an order that opens or adds, nothing is sent if the mark price has moved more than 1% since the draft, or if the stop-loss is no longer on the losing side and inside the estimated liquidation price.</li>
<li><strong>The market’s settings.</strong> For a new position, the margin mode and leverage are set if they differ from the ticket.</li>
<li><strong>The order</strong> goes out as a market order, with the ticket’s id as its client order id.</li>
<li><strong>Its protection.</strong> The stop-loss and take-profit follow as reduce-only orders for the quantity that filled, triggered by the mark price.</li>
<li><strong>Leftovers.</strong> If the ticket closed the whole position and it is now flat, the reduce-only orders left on it are canceled, so they cannot act on the next position you open in that market. After a partial fill they stay, because they still guard what is left.</li>
</ol>
<p>The receipt says what happened, including what did not: a partial fill, a stop-loss the exchange did not confirm (the position may then be open without one), or orders that could not be canceled. If an order’s answer goes missing, the app does not read that as a refusal. It looks the order up by its client id, up to three times, and says plainly whether it was placed, most likely was not, or could not be checked.</p>
<h3>What a ticket can be</h3>
${reference("Order type, leverage and margin, one position per market, closing, and mainnet", facts([
  ["Order type", "Market orders, sized in the asset or by value. Limit orders are not supported yet."],
  ["Leverage and margin", "A new position uses the ticket’s leverage, up to your limit, and isolated margin unless you choose cross. An existing position keeps the leverage and margin mode it has. An account in Multi-Assets mode gets cross margin, and the ticket says so."],
  ["One position per market", "The app keeps one net position per market. An account in hedge mode is shown with an explanation and is not traded."],
  ["Closing", "Ask the assistant, or press Close on a position under Account. Either drafts a ticket for the whole position. One order never flips a long into a short."],
  ["Mainnet", "A mainnet ticket asks you to check an acknowledgment box before it can be sent."],
], "facts-wide"))}
${reference("How the estimated liquidation price is worked out", `<p>The estimate on a ticket is worked out as follows, where ∓ is minus for a long and plus for a short:</p>
${literal("entry × (1 ∓ (1 / leverage − maintenance margin))", "How the estimated liquidation price is worked out")}
<p>It ignores fees, funding and the exchange’s margin tiers, so it is a guide to how much room a stop has; the exchange’s own figure appears under Account once the position is open. No estimate is shown for cross margin, where liquidation depends on the whole account.</p>`)}`,
        },
        {
          id: "account",
          title: "Account and activity",
          body: `<p><strong>Account</strong> shows your equity, your positions with the exchange’s liquidation prices, and your open orders, read from the exchange again every 15 seconds while the window is in view. <strong>Activity</strong> lists what the app did on the exchange: each order and cancellation, step by step, and each deposit and withdrawal.</p>
${ctx.figure("account", {
  alt: "The Account page on testnet: equity, available margin, margin used, unrealized profit and loss, wallet balance, three positions with size, value, entry, mark, liquidation and margin, and open orders below.",
  caption: `Account, with three open positions on testnet. Sample data from the app’s built-in mock. ${chartBy}`,
  kind: "inset",
})}`,
        },
        {
          id: "errors",
          title: "Errors from the exchange",
          lead: "The exchange’s errors are turned into something you can act on.",
          body: reference("Each error, and what the app says instead", table({
            head: ["The exchange says", "The app says"],
            rows: [
              [code("-5050"), "Trading and account data start after the wallet’s first deposit"],
              [code("-1022"), "The API wallet’s signature was rejected; its approval may have expired or been revoked"],
              [code("-4168"), "The account is in Multi-Assets mode, which allows only cross margin; draft the ticket again"],
              [`${code("-1021")}, ${code("-4225")}, ${code("-4226")}`, "The request’s timing was rejected; check this computer’s clock"],
              ["HTTP 403", "Your network or region may be blocked"],
              ["HTTP 418 or 429", "The exchange is rate limiting the app; wait a minute"],
              ["Anything else", "The exchange’s own message and code"],
            ],
          })),
        },
        {
          id: "testnet",
          title: "Practice on testnet",
          body: `<p>Switch to <strong>Testnet</strong> at the top of the window for the same order flow with test funds. Each network has its own wallet, its own market list and its own clock, so switching never mixes them, and a ticket that is waiting expires when you switch.</p>`,
        },
      ],
    }),
};
