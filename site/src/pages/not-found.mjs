// Served by Cloudflare, with status 404, for any address that is not a page or a file.
// It can appear at any depth, so every link and asset on it is absolute.
const LINKS = [
  ["/", "Home", "What OctoNeo is, and a preview of the assistant."],
  ["/assistant/", "The assistant", "How it researches, what it shows, and the tickets it drafts."],
  ["/models/", "Models", "OpenRouter, Cloudflare AI Gateway, Ollama and LM Studio."],
  ["/markets/", "Markets and orders", "The screener, the market panel, and how a ticket becomes an order."],
  ["/news/", "News", "Eight publishers, searched on your computer."],
  ["/wallet/", "Wallet and funds", "The trade-only key, deposits and withdrawals."],
  ["/safety/", "Safety and privacy", "What the assistant cannot do, and where your data lives."],
  ["/open-source/", "Open source", "The license, the architecture, and how to contribute."],
  ["/download/", "Download", "Installers for Windows, macOS and Linux, and how to build it from source."],
];

export default {
  path: "/404.html",
  output: "404.html",
  title: "Page not found | OctoNeo",
  description: "There is no page at this address on the OctoNeo site. The links here lead to the pages that exist.",
  indexable: false,
  render: (ctx) => `
<div class="page-head page-head-lost">
  <div class="wrap page-intro">
    <img class="notfound-mark" src="${ctx.asset("images/octopus.svg")}" width="67" height="64" alt="">
    <p class="notfound-code">404</p>
    <h1>There is no page at this address</h1>
    <p class="page-lead">Check the address for a typo, or go to one of the pages below.</p>
  </div>
</div>
<div class="wrap notfound">
  <ul class="notfound-links">
${LINKS.map(([href, label, line]) => `    <li><a href="${href}">${label}</a><p>${line}</p></li>`).join("\n")}
  </ul>
</div>
`,
};
