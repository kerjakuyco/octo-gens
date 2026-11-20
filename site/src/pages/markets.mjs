import { TRADINGVIEW, chip, code, doc, docPage, facts, icon, literal, network, out, reference, table, ui, uiButton } from "../site.mjs";

const chartBy = `Chart by ${out(TRADINGVIEW, "TradingView")}.`;

/* -------------------------------------------------------- the head's picture */

// A market's page for BTC as the app's built-in mock shows it on testnet: the figures are the
// mock's, as the app shows them on that page and in its Book and Funding tabs. The candles are a
// sample drawn to the same shape; the last one is the mock's own.

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

/**
 * The buttons above the chart, as a new installation has them: the two moving averages and the
 * levels on, EMA 200 and the Bollinger bands off. Each swatch is the line it draws.
 */
const OVERLAYS = [
  ["EMA 20/50", "ema", true],
  ["EMA 200", "ema200", false],
  ["BB", "bb", false],
  ["S/R", "sr", true],
]
  .map(([label, kind, on]) => `<span class="ui-overlay"${on ? " data-on" : ""}><span class="ui-swatch" data-kind="${kind}"></span>${label}</span>`)
  .join("");

/**
 * The figures above the chart, each with what the app reads from it underneath. The dot on the
 * 24h range is where the price sits in it, placed by pages.css from data-at, as the chart's labels are.
 */
const RANGE = [62233.01, 64225.14];
const METRICS = [
  ["Mark", "62,920.15", '<small class="up">+1.2 bps</small>'],
  ["Index", "62,912.60", ""],
  ["Funding", '<span class="up">+0.0183%</span>', "<small>03:40:17 · +20.04%/yr</small>"],
  ["Open interest", "238.1M", "<small>3.8K BTC</small>"],
  ["24h volume", "1.3B", "<small>21K BTC</small>"],
  [
    "24h range",
    "62,233.01 – 64,225.14",
    `<span class="ui-gauge"><span data-at="${Math.round(((62925.18 - RANGE[0]) / (RANGE[1] - RANGE[0])) * 100)}"></span></span>`,
  ],
];

function metrics() {
  return `<dl class="ui-facts ui-stats">${METRICS.map(([term, value, under]) => `<div><dt>${term}</dt><dd class="num">${value}${under}</dd></div>`).join("")}</dl>`;
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

/** The tabs beside the chart, on Book. */
function book() {
  const depth = 4.245;
  // The depth bar is the running total, as a share of the deepest side shown, in tenths.
  const row = ([price, size, total], tone) =>
    `<li class="ui-book-row" data-tone="${tone}" data-depth="${Math.round((Number(total) / depth) * 10)}"><span class="num ${tone}">${price}</span><span class="num">${size}</span><span class="num">${total}</span></li>`;
  return `<section class="ui-col ui-book">
<p class="ui-segments ui-tabs"><span data-on>Book</span><span>Funding</span><span>Technicals</span><span>Watchlist</span></p>
<p class="ui-book-head"><span>Price</span><span>Size (BTC)</span><span>Total</span></p>
<ol class="ui-book-rows">${ASKS.map((r) => row(r, "down")).join("")}</ol>
<p class="ui-book-mid"><strong class="num">62,925.18</strong><span>Spread 0.80 bps</span></p>
<ol class="ui-book-rows">${BIDS.map((r) => row(r, "up")).join("")}</ol>
</section>`;
}

const PAGE = ui({
  className: "ui-market",
  label:
    "A sample of a market’s page for BTC on testnet. At the top, Back to Markets and the market’s name. The price 62,925.18, down 0.95% in 24 hours, with Watching, Ask AI and Trade. The mark price, 1.2 basis points above the index; funding at +0.0183% with the time to the next payment and its yearly rate; open interest, 24-hour volume and the 24-hour range. A 4h candlestick chart with EMA 20/50 and support and resistance turned on, EMA 200 and the Bollinger bands off, resistance at 63,132.23 and support at 62,800.51. Beside it, the Book tab: the order book around the price, with a spread of 0.80 basis points.",
  caption: `A market’s page, drawn with the sample figures of the app’s built-in mock and candles that illustrate them: not live prices. In the app the chart is by ${out(TRADINGVIEW, "TradingView")}.`,
  body: `<div class="ui-bar">
<span class="ui-bar-start"><span class="ui-back">${icon("back", 15)}<span>Markets</span></span><span class="ui-bar-sep"></span><span class="ui-pair"><strong>BTC</strong> / USDT${icon("chevronDown", 14)}</span></span>
<span class="ui-bar-end">${network("Testnet")}${chip("Sample")}</span>
</div>
<div class="ui-market-head">
<p class="ui-market-quote"><strong class="ui-price num">62,925.18</strong>${chip("−0.95%", "down")}<span class="ui-muted">24h</span></p>
<p class="ui-market-actions">${uiButton(`${icon("star", 14)}Watching`, "outline")}${uiButton(`${icon("assistant", 14)}Ask AI${icon("chevronDown", 14)}`, "outline")}${uiButton("Trade", "primary")}</p>
</div>
${metrics()}
<div class="ui-market-body">
<section class="ui-col ui-chart-col">
<div class="ui-chart-tools"><span class="ui-segments"><span>15m</span><span>1h</span><span data-on>4h</span><span>1d</span></span><span class="ui-overlays">${OVERLAYS}</span></div>
${chart()}
<p class="ui-ohlc num"><span>O 63,029.86</span><span>H 63,374.44</span><span>L 62,877.28</span><span>C <span class="down">62,925.18</span></span></p>
</section>
${book()}
</div>`,
});

export default {
  path: "/markets/",
  title: "Markets and orders | OctoNeo",
  description:
    "A screener of every market, a page for each one with its chart, readings, order book and funding, how an OctoNeo ticket becomes an order, your account, your trading journal and grid bots.",
  render: (ctx) =>
    docPage({
      path: "/markets/",
      title: "Every market, read straight from the exchange",
      lead: "Market data needs no wallet, no account and no model. The app opens on mainnet prices, and the screener and each market’s page read directly from the exchange’s public API.",
      visual: PAGE,
      sections: [
        {
          id: "screener",
          title: "A screener of every market",
          body: `<p><strong>Markets</strong> lists every perpetual market the exchange is trading, most traded first, with its price, 24h change, volume and funding. Sort by any column, search, add a market to your watchlist with its star, and pick one to open its page.</p>
${ctx.figure("markets", {
  alt: "The Markets page beside the sidebar: top gainer, top loser, highest funding and most traded at the top, then a sortable table of markets with price, 24h change, volume and funding.",
  caption: "Markets, most traded first. Sample data from the app’s built-in mock.",
  kind: "inset",
})}
${reference("How market names are matched, and what the watchlist starts with", facts([
  ["Names", `Matched without guessing: ${code("BTCUSDT")}, ${code("btc/usdt")}, ${code("$BTC")}, ${code("BTC-PERP")} and ${code("btc")} all mean ${code("BTCUSDT")}. A bare asset prefers its USDT market, then USD1, then USDC.`],
  ["Unknown names", "A name the exchange does not list is an error. It is never replaced by something similar."],
  ["Watchlist", "Starts with the major markets the network lists. Markets you add are remembered, and shown on every network that lists them."],
], "facts-wide"))}`,
        },
        {
          id: "market",
          title: "A page for each market",
          lead: "Pick a market under Markets, in an answer or among your positions, and it opens on a page of its own beside the sidebar. Back returns to where you were, and the market’s name at the top switches to another: it lists your watchlist, and searches every market as you type.",
          body: `${ctx.figure("market", {
  alt: "The page for ETH on testnet, opened from Account: Back and the market’s name at the top; the price with Watching, Ask AI and Trade; a 5x long with its profit and Close, and its stop-loss and take-profit orders with Cancel; the mark and index prices, funding, open interest, 24h volume and the 24h range; a 4h candlestick chart under its overlay buttons, with moving averages, support and resistance and the long’s entry drawn on it; and the order book beside it.",
  caption: `ETH’s page, opened from a long under Account. Sample data from the app’s built-in mock. ${chartBy}`,
  kind: "inset",
})}
${facts([
  ["Figures", "The mark price and its gap to the index, funding with the time to the next payment and its yearly rate, open interest, 24h volume, and where the price sits in its 24h range."],
  ["Chart", "Candles and volume on 15m, 1h, 4h or 1d. Buttons above it turn on EMA 20 and 50, EMA 200, Bollinger bands, and support and resistance. The app remembers your choice and the timeframe."],
  ["Your position", "With a wallet connected, your position in the market and its open orders, with Close and Cancel as under Account. Orders draws the entry, the liquidation price and each order on the chart."],
  ["Ask AI", "With a model connected: the market’s outlook, why it is moving, or a long or a short planned on 1% risk. The question goes to the assistant, in the open conversation."],
])}
<h3>Trend, volatility and flow</h3>
<p>Two cards under the chart read the market without a model. <strong>Trend &amp; MAs</strong> says how many of the four timeframes trend up or down, how far each moved over its last five bars, and how far the price is from EMA 20, 50 and 200; click a timeframe to chart it. <strong>Volatility &amp; Flow</strong>, on the chart’s timeframe, places the price between the Bollinger bands and gives their width, ATR, realized volatility over 30 bars, the range of the last 20 bars, and relative volume: the last finished bar’s volume against the average of the 20 before it.</p>
${ctx.figure("structure", {
  alt: "Two cards for ETH: Trend & MAs, marked Mixed, with 15m, 1h, 4h and 1d and how far each moved, then EMA 20, 50 and 200 and the price’s distance from each; and Volatility & Flow on 4h, with relative volume of 1.50 times marked, the price’s place between the Bollinger bands and their width, ATR, realized volatility and the 20-bar range.",
  caption: "The readings under ETH’s chart, on 4h. Sample data from the app’s built-in mock.",
  kind: "column",
})}
<h3>The tabs beside the chart</h3>
${table({
  head: ["Tab", "What it shows"],
  stack: true,
  rows: [
    ["Book", "The best bids and asks with their running size, the spread, the share of resting size on each side, and the latest trades, with the share of their value bought and sold."],
    ["Funding", "The rate now and what it comes to over a year, two weeks of settled rates, and open interest."],
    ["Technicals", "Trend, RSI, MACD and ATR on four timeframes side by side, and the support and resistance of the chart’s timeframe. Click a support level to open the order form on a long with it as the stop-loss, or a resistance level as the take-profit."],
    ["Watchlist", "Your markets, each with a 90-day sparkline."],
  ],
})}
<div class="tab-figures">
${ctx.figure("tab-book", { alt: "The Book tab: asks and bids with size and running total, and the spread.", caption: "Book", kind: "tab" })}
${ctx.figure("tab-funding", { alt: "The Funding tab: the rate now, the annualized rate, the time to the next payment, a bar chart of two weeks of settled rates, the interval, who pays, and open interest.", caption: "Funding", kind: "tab" })}
${ctx.figure("tab-technicals", { alt: "The Technicals tab: trend, RSI, MACD and ATR on 15m, 1h, 4h and 1d, and the nearest resistance and support levels on the 4h chart, with a note that a click sets one as the stop-loss or take-profit.", caption: "Technicals", kind: "tab" })}
${ctx.figure("tab-watchlist", { alt: "The Watchlist tab: markets with price, 24h change and a 90-day sparkline each.", caption: "Watchlist", kind: "tab" })}
</div>
<p>The market data on the page is public and read on demand. None of it needs a wallet or a model, and none of it is kept between launches.</p>`,
        },
        {
          id: "requests",
          title: "Requests to the exchange",
          lead: "A market’s page asks only for the market on screen, and only while the window is in view.",
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
          lead: "Every order starts as a ticket: what it does to your position, its value, the margin it needs and an estimated liquidation price. Ask the assistant for one, or use Trade on a market’s page, which needs no model.",
          body: `<h3>The order form</h3>
<p><strong>Trade</strong> opens the order form. Pick Buy / Long or Sell / Short, and set the size in the coin or in USDT, or as a share of your available margin. Leverage is set on a slider with presets, up to your limit, and the stop-loss and take-profit sit side by side in one section. Reduce-only makes an order that can only trim or close the position. Before you go on, a summary shows the estimated entry at the mark price, the notional value, the initial margin and the estimated liquidation price. Review turns the form into a ticket, which you place or go back to edit.</p>
${ctx.figure("order-form", {
  alt: "The order form for BTC-USDT Perp on testnet, a market order with isolated margin. Buy / Long is chosen. The order value is 500 USDT, about 0.0079 BTC at the mark price, with shares of the available margin from 10% to Max below it. Leverage is 3x on a slider, with presets up to the 10x limit. The stop-loss is 61,661.75 and the take-profit 65,436.96, set with the quick offsets, which would lose 10.00 or make 20.00 USDT: reward to risk 1 to 2.0. Reduce-only is off. The summary gives the estimated entry at the mark, 62,920.15, a notional value of 500.00 USDT, an initial margin of 166.67 USDT and an estimated liquidation price of 44,044.10, above the button Review Long BTC, 500.00 USDT.",
  caption: "The order form, a long of 500 USDT at 3x with a stop-loss and a take-profit from its quick offsets. Sample figures from the app’s built-in mock.",
  kind: "column",
})}
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
  ["Closing", "Ask the assistant, or press Close on a position under Account or on its market’s page. Either drafts a ticket for the whole position. One order never flips a long into a short."],
  ["Mainnet", "A mainnet ticket asks you to check an acknowledgment box before it can be sent."],
], "facts-wide"))}
${reference("How the estimated liquidation price is worked out", `<p>The estimate on a ticket is worked out as follows, where ∓ is minus for a long and plus for a short:</p>
${literal("entry × (1 ∓ (1 / leverage − maintenance margin))", "How the estimated liquidation price is worked out")}
<p>It ignores fees, funding and the exchange’s margin tiers, so it is a guide to how much room a stop has; the exchange’s own figure appears under Account once the position is open. No estimate is shown for cross margin, where liquidation depends on the whole account.</p>`)}`,
        },
        {
          id: "account",
          title: "Your account, as a portfolio",
          lead: "Account opens with your equity, free collateral and margin, directional exposure and estimated funding carry, and how much of your margin is in use. It is read from the exchange again every 15 seconds while the window is in view.",
          body: `${ctx.figure("account", {
  alt: "The Account page on testnet beside the sidebar. At the top, the wallet’s address, isolated margin with a 10x leverage limit and a trade-only key, and Deposit, Withdraw, AI Risk Check, Refresh and Place Order. Four cards: equity of 9,990.59 USDT with the wallet balance and unrealized profit and loss; 7,300.78 USDT of free collateral, with 2,689.81 USDT, 26.9% of equity, in use as margin; directional exposure, split between long and short; and the estimated funding carry, with two of three positions holding a stop-loss. Tabs for positions, open orders, collateral and the journal, then two positions, a SOL short at 3x and an ETH long at 5x, each with its size, value, entry, mark and liquidation prices and margin, its stop-loss, and for ETH a take-profit and the reward to risk, with buttons to log it in the journal, add to it, trim it by half and close it.",
  caption: "Account on testnet: the summary, then each position with its stop-loss and take-profit. Sample data from the app’s built-in mock.",
  kind: "inset",
})}
${facts([
  ["Summary", "Equity, with the wallet balance and the unrealized profit or loss. Free collateral, with the margin in use as a share of equity and the effective leverage: what your positions are worth against your equity. Directional exposure, your longs against your shorts. And the estimated funding carry, what your positions pay or receive at the current funding rates, with how many of them have a stop-loss."],
  ["Positions", "Filter by side, and sort by size, unrealized profit, return on margin or nearness to liquidation. Each position shows its size, value, entry, mark and liquidation prices and margin, and its stop-loss and take-profit with the reward to risk between them. Close drafts a ticket for the whole position, two more buttons open the order form to add to it or to trim it by half, and Journal starts an entry for it in your trading journal."],
  ["Open orders", "Filter by market, and sort by market, type, price, distance from the mark price, quantity or time. Cancel one order, or every order in a market."],
  ["Collateral", "Listed by asset: the balance, what is free and what is held as margin. Beside it, your wallet, the trade-only key the app trades with, when its approval expires, and Deposit and Withdraw."],
  ["Ask the assistant", "With a model connected, a button asks the assistant to review your positions, your margin and your liquidation risk."],
], "facts-wide")}`,
        },
        {
          id: "journal",
          title: "A trading journal",
          lead: "Activity keeps a journal of your trades. Log one from a position under Account, from a fill in the history, or from scratch. Starting from a position or a fill, the app enters what it knows: the market, the side, the leverage, the entry and the size.",
          body: `${ctx.figure("journal", {
  alt: "The Activity page on testnet beside the sidebar, open on the trading journal. At the top, filters for the network, and Export MD, AI Coach Review and Log Trade. Four cards: 466.10 USDT of logged profit and loss; a win rate of 66.7% over three closed trades; 93% of the checklist kept; and Liquidity Sweep as the top setup. Tabs for the journal, the history and the setups, filters by outcome and setup, and a search. Then two sample entries, both still open: an ETH long at 5x on a trend follow and a SOL short at 3x on support and resistance, each with its planned reward to risk, three of three rules kept, its profit or loss, its thesis and its review, and AI Critique, Trade and Edit.",
  caption: "The trading journal under Activity, with invented sample entries from the app’s built-in mock. In the desktop app the journal starts empty.",
  kind: "inset",
})}
${facts([
  ["An entry", "The market, the side, the leverage and the outcome; the setup; the entry and exit, the size, the profit or loss and the reward to risk you planned. A three-point checklist asks whether you respected the stop, sized within your risk and followed the plan, and two notes hold your thesis and the lesson."],
  ["Setups", "Seven: trend follow, breakout, mean reversion, funding carry, support and resistance, liquidity sweep, and macro and news."],
  ["Summary", "The profit and loss you logged, your win rate, your best setup and how often you kept to your rules. A tab beside the journal compares your setups."],
  ["Filters", "By outcome, setup and network, or search the market, the setup and your notes."],
  ["Review", "With a model connected, ask the assistant to review one entry, with its notes, or the journal's figures: win rate, profit and loss, profit factor, how often you kept to your rules and your best setup."],
], "facts-wide")}
<p>Beside the journal, Activity lists what the app did on the exchange: each order and cancellation, step by step, and each deposit and withdrawal. Positions, open orders, the journal and the history come a page at a time.</p>
<p>The journal starts empty. It is kept on your computer in the app window’s own storage, not in the data folder that holds your conversations, and it is not encrypted. It reaches a model only when you ask the assistant to review it, in that message. <a href="/safety/#data">Where the rest of your data lives</a>.</p>`,
        },
        {
          id: "grid-bots",
          title: "Grid bots",
          lead: "A grid bot splits a price range into levels and keeps an order waiting at each one: buys below the price, sells above it. When a buy fills it places a sell one level up, and when that sells it buys again one level down. Each buy and its sell is a completed trade, which earns the gap between two levels less the fees.",
          body: `${ctx.figure("grid-bots", {
  alt: "The Grid bots page on testnet beside the sidebar. Four tiles: two bots running, 1,850.00 USDT of margin in use, +266.07 USDT of profit and loss and 44 completed trades. Under Your bots, a neutral BTC bot at 3x running for a day and fourteen hours, with its range from 59,144.90 to 66,695.40 and the price inside it, 19 completed trades, six buy and six sell orders and its latest note; below it, a long ETH bot at 4x.",
  caption: "Grid bots on testnet, with sample bots from the app’s built-in mock.",
  kind: "inset",
})}
${facts([
  ["Direction", "Neutral starts with no position. Long buys a position first and sells it off as the price climbs the range; Short sells first and buys it back as the price falls."],
  ["Range and grids", "The lowest and highest price and up to 50 grids between them, in even price steps or even percentage steps. Suggested ranges come from the market’s support and resistance."],
  ["Margin and leverage", "How much of your balance the bot uses, at a leverage up to your limit."],
  ["Start and stop", "Optional: a price the bot waits for before it places its orders, and prices below and above the range where it stops and can close its position."],
  ["Review", "A dry run shows each order’s size and value, the profit per completed trade after fees and the estimated liquidation price before anything is sent. On mainnet you tick an acknowledgement."],
  ["Your bots", "Running and stopped, each with its range and the price, profit and loss, completed trades, its orders and its latest note. Stopping asks whether to close the position too."],
], "facts-wide")}
<p>Ask the assistant for a grid, or use ${code("/grid")}: it reads the market’s levels, works the bot out as a dry run and drafts it in the conversation, where you start it or discard it. Starting checks the draft against the live price again.</p>
${ctx.figure("grid-draft", {
  alt: "A grid bot the assistant drafted on testnet: a neutral grid on BTC-USDT, 10 grids from 61,872.04 to 63,606.89 with 250.00 USDT at 3x. A bar marks the buy levels below the price and the sell levels above it. Six buy and four sell orders of 0.001 BTC each, 0.23% to 0.24% per grid, estimated liquidation prices below and above, the reason for the range, and Start grid bot and Discard.",
  caption: "A grid bot drafted in the conversation, waiting for you to start it. Sample data from the app’s built-in mock.",
  kind: "column",
})}
<p>A bot places its replacement orders and watches its stop prices while OctoNeo is open; its waiting orders stay on the exchange when you close the app. Only an order the exchange reports as filled counts as a fill, so an order cancelled elsewhere leaves its level empty, and a bot whose orders are all gone stops. One bot runs in a market, and it shares that market’s position with anything else you trade there.</p>`,
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
          title: "Mainnet and testnet",
          body: `<p>Switch to <strong>Testnet</strong> at the top of the window for the same order flow with test funds. Each network has its own wallet, its own market list and its own clock, so switching never mixes them, and a ticket that is waiting expires when you switch.</p>`,
        },
      ],
    }),
};
