import { TRADINGVIEW, code, doc, docPage, facts, literal, out, reference, table } from "../site.mjs";

const chartBy = `Chart by ${out(TRADINGVIEW, "TradingView")}.`;

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
      picture: ctx.figure("markets", {
        alt: "The Markets page: top gainer, top loser, highest funding and most traded at the top, then a sortable table of markets with price, 24h change, volume and funding, and the market panel on the right.",
        caption: `Markets, most traded first, beside the market panel. Sample data from the app’s built-in mock. ${chartBy}`,
        kind: "wide",
        eager: true,
      }),
      sections: [
        {
          id: "screener",
          title: "A screener of every market",
          body: `<p><strong>Markets</strong> lists every perpetual market the exchange is trading, most traded first, with its price, 24h change, volume and funding. Sort by any column, search, and add a market to your watchlist with its star.</p>
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
          body: `<div class="callout" role="note"><p><strong>Not yet tried on the live exchange, on either network:</strong> orders, deposits sent from a wallet and withdrawals. Orders and withdrawals have been checked against a stand-in that follows the exchange’s API documentation, and deposits by simulating them on their chains without sending them. Practice on testnet, then start small.</p></div>
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
