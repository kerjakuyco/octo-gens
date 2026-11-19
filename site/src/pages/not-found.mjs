// Served by Cloudflare, with status 404, for any address that is not a page or a file.
// It can appear at any depth, so every link and asset on it is absolute.
export default {
  path: "/404.html",
  output: "404.html",
  title: "Page not found | OctoNeo",
  description: "There is no page at this address on the OctoNeo site. The links here lead to the pages that exist.",
  indexable: false,
  render: (ctx) => `
<div class="wrap notfound">
  <img class="notfound-icon" src="${ctx.asset("images/icon.svg")}" width="72" height="72" alt="">
  <h1>There is no page at this address</h1>
  <p class="page-lead">Check the address for a typo, or go to one of the pages below.</p>
  <ul class="index index-tight">
    <li><a href="/">Home</a><p>What OctoNeo is, and a preview of the assistant.</p></li>
    <li><a href="/assistant/">The assistant</a><p>How it researches, what it shows, and the tickets it drafts.</p></li>
    <li><a href="/models/">Models</a><p>OpenRouter, Cloudflare AI Gateway, Ollama and LM Studio.</p></li>
    <li><a href="/markets/">Markets and orders</a><p>The screener, the market panel, and how a ticket becomes an order.</p></li>
    <li><a href="/news/">News</a><p>Eight publishers, searched on your computer.</p></li>
    <li><a href="/wallet/">Wallet and funds</a><p>The trade-only key, deposits and withdrawals.</p></li>
    <li><a href="/safety/">Safety and privacy</a><p>What the assistant cannot do, and where your data lives.</p></li>
    <li><a href="/download/">Get OctoNeo</a><p>No installers yet: how to build OctoNeo from source.</p></li>
    <li><a href="/open-source/">Open source</a><p>The license, the architecture, and how to contribute.</p></li>
  </ul>
</div>
`,
};
