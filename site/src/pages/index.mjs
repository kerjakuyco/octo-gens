import { demo } from "../demo.mjs";
import { REPO, TRADINGVIEW, doc, out, table } from "../site.mjs";

export default {
  path: "/",
  title: "OctoNeo | Open-source AI trading assistant for perpetual futures",
  description:
    "OctoNeo is an open-source desktop AI assistant for perpetual futures on a decentralized exchange. It researches and drafts tickets; you confirm every order, trading from your own wallet's account on the exchange.",
  bodyClass: "page-home",
  render: (ctx) => `
<section class="hero" aria-labelledby="hero-title">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <h1 class="hero-title" id="hero-title"><span>Ask about any market.</span> <span>Confirm every order.</span></h1>
      <p class="hero-lead">OctoNeo is an open-source desktop assistant for perpetual futures on a decentralized exchange. It reads the market, sizes positions from the risk you accept and drafts tickets you confirm in the app.</p>
      <div class="actions">
        <a class="button button-brand" href="/download/">Get OctoNeo</a>
        <a class="button button-quiet" href="${REPO}">View source on GitHub</a>
      </div>
      <p class="hero-meta">Builds on Windows, macOS and Linux. Open source under GPL-3.0-only, with no sign-up and no telemetry.</p>
    </div>
    <div class="hero-demo">
${demo()}
    </div>
  </div>
</section>

<section class="band" aria-labelledby="flow-title">
  <div class="wrap">
    <div class="band-head">
      <h2 id="flow-title">From question to order</h2>
      <p>Every message is answered by the language model you connect. It plans its own research with tools, and the rules around trading are enforced by the app, not left to the model.</p>
    </div>
    <ol class="flow">
      <li>
        <h3>You ask</h3>
        <p>In your own words: “BTC outlook”, “Top movers”, “Long ETH, 1% risk”. There are no commands to learn.</p>
      </li>
      <li>
        <h3>It reads</h3>
        <p>It calls tools for prices, candles, the order book, funding, your account and the news, and shows what it read as cards under the answer.</p>
      </li>
      <li>
        <h3>It drafts</h3>
        <p>It sizes the position from your stop and the risk you accept, checks the stop against the liquidation price, and drafts a ticket with a stop-loss.</p>
      </li>
      <li>
        <h3>You place it</h3>
        <p>Nothing reaches the exchange until you confirm. The app first reads your position and the mark price again, and sends nothing if either has moved away from the ticket. The mark price is the exchange’s reference price, used for liquidation and stops.</p>
      </li>
    </ol>
  </div>
</section>

<section class="band band-rail" aria-labelledby="desk-title">
  <div class="wrap">
    <div class="band-head">
      <h2 id="desk-title">The market beside the conversation</h2>
      <p>The market panel follows what the assistant looks at: a chart on 15m, 1h, 4h and 1d, the order book and latest trades, funding and open interest, and technical readings on four timeframes. It reads straight from the exchange, so none of it needs a wallet or a model.</p>
    </div>
    ${ctx.figure("desk", {
      alt: "OctoNeo's market panel for BTC, with a candlestick chart and the order book, beside the assistant's answer to BTC outlook.",
      caption: `The market panel for BTC beside the assistant’s answer to “BTC outlook”, on testnet. On a phone, the panel alone. Sample data from the app’s built-in mock. Chart by ${out(TRADINGVIEW, "TradingView")}.`,
      kind: "wide",
    })}
    <ul class="index">
      <li><a href="/markets/">Markets and orders</a><p>A screener of every market the exchange lists, the market panel’s four tabs, and how a ticket becomes an order.</p></li>
      <li><a href="/news/">News</a><p>Headlines from eight publishers, searched on your computer, with who reported what and how long ago.</p></li>
      <li><a href="/wallet/">Wallet and funds</a><p>A trade-only key your wallet approves, and deposits and withdrawals your wallet confirms.</p></li>
    </ul>
  </div>
</section>

<section class="band" aria-labelledby="decentral-title">
  <div class="wrap">
    <div class="band-head">
      <h2 id="decentral-title">Decentralized: no OctoNeo server in between</h2>
      <p>OctoNeo runs on your computer and talks to the exchange directly. You need no OctoNeo account, and the app sends no telemetry.</p>
    </div>
    <figure class="topology">
      <div class="topology-side topology-local">
        <h3>On your computer</h3>
        <dl>
          <div><dt>OctoNeo</dt><dd>The interface, the trading core and the assistant.</dd></div>
          <div><dt>Your keys</dt><dd>In the system keychain: the trade-only key your wallet approved, which cannot withdraw, and any model key.</dd></div>
          <div><dt>Your conversations</dt><dd>In a journal on your disk, with what the assistant read.</dd></div>
          <div><dt>Your wallet</dt><dd>In your browser. It approves the trading key and confirms every deposit and withdrawal, on a page OctoNeo serves on your computer. Withdrawals need a wallet that signs across networks, such as Rabby; MetaMask cannot.</dd></div>
          <div><dt>A local model, if you choose</dt><dd>Ollama or LM Studio, which keep your conversations here.</dd></div>
        </dl>
      </div>
      <div class="topology-side topology-remote">
        <h3>Directly from your computer to</h3>
        <dl>
          <div><dt>The exchange</dt><dd>Market data, your account and your orders.</dd></div>
          <div><dt>A cloud model, if you choose</dt><dd>OpenRouter or Cloudflare AI Gateway.</dd></div>
          <div><dt>News publishers</dt><dd>Their public feeds and the articles the assistant opens from news results, while web search is on. A Yahoo Finance headline can lead to another publisher’s site.</dd></div>
          <div><dt>Pages you link</dt><dd>A page you give the assistant a link to, while web search is on.</dd></div>
          <div><dt>Tool servers you attach</dt><dd>Read-only tools for the assistant, only if you add them.</dd></div>
        </dl>
      </div>
      <figcaption>Nowhere else. Your funds stay in your wallet and in your account on the exchange, and the code that signs your requests is open: ${out(doc("docs/exchange.md"), "docs/exchange.md")} lists exactly what the app sends and how.</figcaption>
    </figure>
  </div>
</section>

<section class="band band-rail" aria-labelledby="limits-title">
  <div class="wrap">
    <div class="band-head">
      <h2 id="limits-title">It drafts. You place.</h2>
      <p>The assistant has no tool that places, changes or cancels an order, and none that moves funds. These limits are enforced in code, so they hold whatever the model says.</p>
    </div>
    ${table({
      head: ["It can", "It cannot"],
      rowHeaders: false,
      className: "split",
      rows: [
        ["Read prices, mark prices, funding, candles and order books", "Place, change or cancel an order"],
        ["Find the biggest movers across the whole exchange", "See or handle the keys the app holds"],
        ["Compute trend, momentum, volatility, support and resistance", "Withdraw, transfer or deposit: that is yours to do, with your own wallet"],
        ["Read your account: equity, positions, liquidation prices, open orders", "Draft a mainnet ticket unless you allowed it in Settings"],
        ["Size a long or a short from a stop and a risk percentage", "Open or add to a position without a stop-loss"],
        ["Draft a ticket for you to confirm, with a stop-loss", "Answer without a model: there are no canned replies"],
      ],
    })}
    <p class="more"><a href="/safety/">Every safeguard, and the limits you should know</a></p>
  </div>
</section>

<section class="band" aria-labelledby="models-title">
  <div class="wrap">
    <div class="band-head">
      <h2 id="models-title">Bring your own model</h2>
      <p>Connect a model in the cloud, or run one on your own computer and keep your conversations there. The model must be able to call tools, because that is how the assistant reads the market and drafts tickets. A model on your computer works in a smaller context, so it is handed less.</p>
    </div>
    ${table({
      head: ["Provider", "Where the model runs", "What it needs"],
      stack: true,
      rows: [
        ["OpenRouter", "In the cloud", "An OpenRouter key and a model that supports tools. OpenRouter bills you for what the model uses."],
        ["Cloudflare AI Gateway", "In the cloud", "Your Cloudflare account ID, an API token with the Workers AI Read permission, and a model. Cloudflare bills your account."],
        ["Ollama", "On your computer", "Ollama running, with a model that supports tools."],
        ["LM Studio", "On your computer", "LM Studio with its local server started and a model trained for tool use."],
      ],
    })}
    <p class="more"><a href="/models/">How models are checked, and what a local model is handed</a></p>
  </div>
</section>

<section class="band closing" aria-labelledby="start-title">
  <div class="wrap closing-grid">
    <div>
      <h2 id="start-title">Practice on testnet first</h2>
      <p>OctoNeo opens on mainnet prices, and market data needs no wallet, no account and no model. Switch to Testnet for the same order flow with test funds before you trade real money.</p>
    </div>
    <div class="actions">
      <a class="button button-brand" href="/download/">Get OctoNeo</a>
      <a class="button button-quiet" href="/download/#build">Build from source</a>
    </div>
  </div>
</section>
`,
};
