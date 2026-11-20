import { ADVISORY, chip, code, doc, docPage, icon, network, out, reference, table, ui, uiButton, uiFacts } from "../site.mjs";

const risks = (rows) => table({ head: ["Risk", "Protection"], stack: true, rows });

/**
 * The head's picture: a mainnet ticket from the app's built-in mock, waiting for the box that says
 * the order executes with real funds, beside what the app reads again when you place it (from "How
 * a ticket becomes an order" on the markets page).
 */
const TICKET = ui({
  className: "ui-safety",
  label:
    "A sample mainnet ticket in OctoNeo: Long BTC-USDT, a market order, marked Mainnet, live funds. It opens a 0.016 BTC long at 3x with isolated margin, with a stop-loss at 61,344.95, and risks about 0.96% of equity. The box I understand this order executes with real funds on Mainnet is not checked, so Place live order cannot be pressed. Beside it, what the app reads again when you place it: the position, the mark price within 1% of the draft and the stop-loss inside the estimated liquidation price; then the order is sent once, as a market order, and its stop-loss and take-profit follow as reduce-only orders.",
  caption: "A mainnet ticket cannot be sent until you check a box saying you understand it executes with real funds. Sample figures from the app’s built-in mock.",
  body: `<div class="ui-safety-body">
<div class="ui-card ui-ticket">
<div class="ui-card-head"><span class="ui-ticket-title">${chip("Long", "up")}<span class="ui-symbol">BTC-USDT</span>${chip("Market")}</span>${network("Mainnet · Live funds")}</div>
<p class="ui-ticket-effect">Opens a 0.016 BTC long at 3x with isolated margin</p>
${uiFacts(
  [
    ["Order size", "0.016 BTC"],
    ["Notional", "1,005.25 USDT"],
    ["Leverage", "3x"],
    ["Initial margin", "335.08 USDT"],
    ["Est. liq. price", "42,199.37"],
    ["Stop-loss", "61,344.95"],
    ["Take-profit", "65,793.63"],
  ],
  "ui-facts-two",
)}
<p class="ui-ticket-why">Risks about 0.96% of equity, 23.73 USDT, if the stop at 61,344.95 is hit.</p>
<p class="ui-check"><span class="ui-checkbox"></span>I understand this order executes with real funds on Mainnet.</p>
<div class="ui-actions">${uiButton("Place live order", "disabled")}${uiButton("Discard", "ghost")}</div>
</div>
<div class="ui-card ui-confirm">
<p class="ui-confirm-title">When you place it</p>
<p class="ui-confirm-lead">Read again before anything is sent</p>
<ol class="ui-confirm-list">
<li>${icon("check", 14)}<span>The position, exactly as it was when the ticket was drafted</span></li>
<li>${icon("check", 14)}<span>The mark price, within 1% of the draft</span></li>
<li>${icon("check", 14)}<span>The stop-loss, on the losing side and inside the estimated liquidation price</span></li>
<li>${icon("check", 14)}<span>Then one market order, sent once</span></li>
<li>${icon("check", 14)}<span>Its stop-loss and take-profit follow, reduce-only</span></li>
</ol>
</div>
</div>`,
});

export default {
  path: "/safety/",
  title: "Safety and privacy | OctoNeo",
  description:
    "What OctoNeo's assistant can and cannot do, the protections enforced in code, where your data lives, and the limits you should know before you trade.",
  render: (ctx) =>
    docPage({
      path: "/safety/",
      title: "Built so the assistant cannot trade without you",
      lead: "OctoNeo holds a key that can trade on your account, so the rules that matter are enforced in code rather than requested in a prompt. They hold whatever the model says.",
      visual: TICKET,
      sections: [
        {
          id: "can",
          title: "What the assistant can and cannot do",
          body: `${table({
            head: ["It can", "It cannot"],
            rowHeaders: false,
            className: "split",
            rows: [
              ["Read prices, mark prices, funding, candles and order books", "Place, change or cancel an order"],
              ["Find the biggest movers across the whole exchange", "See or handle the keys the app holds"],
              ["Compute trend, momentum, volatility, support and resistance", "Withdraw, transfer or deposit: that is yours to do, with your own wallet"],
              ["Read your account: equity, positions, liquidation prices, open orders", "Draft a mainnet ticket unless you allowed it in Settings"],
              ["Size a long or a short from a stop and a risk percentage, and check the stop against liquidation", "Open or add to a position without a stop-loss"],
              ["Draft a ticket for you to confirm, with a stop-loss", "Call tool-server tools that are not marked read-only"],
              ["Read recent headlines from crypto newsrooms, Yahoo Finance and the Federal Reserve, and the article behind one", "Read a page it was not given: only its news results and links you paste"],
              ["Call read-only tools of a tool server you attached", "Answer without a model: there are no canned replies"],
            ],
          })}`,
        },
        {
          id: "protections",
          title: "How the app protects you",
          body: `<h3>Orders</h3>
${risks([
  ["The model places a trade you did not want, or moves funds", "No tool can place, change or cancel an order, and none can deposit or withdraw. The assistant drafts a ticket and you confirm it. Mainnet tickets from the assistant are off by default, and turning them off again discards one that is waiting."],
  ["The model opens a reckless position", "A ticket from the assistant needs a stop-loss inside the estimated liquidation price, and no ticket may exceed your leverage limit: 3x until you raise it."],
  ["A double click sends an order twice", "A draft is consumed by its first submission. Orders are sent once and never retried."],
  ["A lost answer hides an order that was taken", "Orders carry a client id. When an answer goes missing or the exchange’s side fails, the app looks the order up before saying anything, and tells you plainly if it could not find out."],
  ["A ticket is confirmed after the market has moved", "The position and the mark price are read again at confirmation. If the position changed, the price moved more than 1%, or the stop-loss no longer protects the position, nothing is sent."],
])}
${ctx.figure("settings-trading", {
  alt: "Settings open on Risk & Trading: max leverage 3x, with quick limits from 2x to 20x; isolated margin for new positions; and Draft mainnet tickets switched off, marked Testnet only, with the note that you still confirm every order.",
  caption: "Settings, Risk &amp; Trading, as a new installation has it: leverage limited to 3x, and mainnet tickets from the assistant off.",
  kind: "column",
})}
<h3>Keys and funds</h3>
${reference("Eight risks to your keys and funds, and what guards against each", risks([
  ["The app’s key is stolen", "It is an API wallet approved for perpetual trading only: no spot trading, no withdrawal. It lives in the system keychain. The approval expires, and you can remove it on the exchange at any time."],
  ["Your own wallet’s key is exposed", "It never enters the app. Connecting needs your address and one signature made in your wallet. A pasted key that belongs to the wallet address itself is refused."],
  ["Someone withdraws your funds through the app", "The key the app holds cannot withdraw. A withdrawal needs two signatures from your own wallet, made in your browser each time, and it names that wallet as its only destination. The app checks that both signatures came from the connected wallet before it sends anything."],
  ["A deposit is sent to the wrong contract", "The vault on each network is fixed in the app, and compared with the one the exchange reports before any transaction is built. If they differ, nothing is built. A token deposit allows the vault exactly the amount you deposit, never an open-ended allowance."],
  ["A page in your browser hijacks the wallet page", "The page your wallet works on is served on your computer only, on a random port behind a random path, for ten minutes, or twenty for a deposit or a withdrawal. It answers only that path and the requests of its own task, refuses other host names, loads nothing from the internet, and every signature must come from the account that connected."],
  ["A signed request is replayed", "Each request carries a nonce the exchange accepts once, within about a minute, and is signed for one network. HTTP redirects are never followed."],
  ["Keys leak to disk, a model or the interface", "Preferences, the journal and what the interface is given to draw never contain a key the app holds. Those keys never enter prompts, tool results or the interface. Answers and errors are scrubbed of the model provider’s key before they are shown or stored."],
  ["A mistyped or revoked provider key is stored", "A new OpenRouter key is shown to OpenRouter, and a Cloudflare token is proved with one short chat, before either is kept. A key that is turned away replaces nothing."],
]))}
<h3>The model and the web</h3>
${reference("Eight risks from the model, web pages and tool servers, and what guards against each", risks([
  ["A hostile page or tool output hijacks the app", "The interface has no network access and can only call the app’s own commands. The model is told to treat tool output as data, and the rules above hold even if it is fooled."],
  ["An article opened on the News page reaches into the app", `It opens in a separate browser view inside the window. That view cannot call the app’s commands: Tauri refuses commands from remote pages, the interface’s permissions name only its own web view, and every command checks which web view asked. It moves only to public ${code("https")} pages, refuses downloads and other schemes, and keeps no cookies or storage once closed. Story pictures are fetched by the app’s core, only ones a feed offered, and only real images.`],
  ["A news article tells the model what to do", "What the assistant reads on the web reaches the model marked as data. Whatever it is talked into, it can still only draft a ticket you must confirm."],
  ["A page makes the model send your figures somewhere", "The assistant reads only a page a news search showed it, or one you gave it a link to. A link it made up, or one it changed, is never requested, so nothing of yours can leave inside an address."],
  ["The assistant is pointed at something on your own network", `Only public ${code("https")} pages are read. Addresses on your computer or on a private network are refused by name, by number, after a redirect, and when the connection is made.`],
  ["A tool server does more than read", "The assistant may call only tools a server marks read-only."],
  ["A model on your computer is reached through someone else’s server", "Requests to Ollama and LM Studio go to the address you set, never through a system proxy, and are never redirected."],
  ["A deleted conversation stays on disk", "Deleting a conversation removes its turns from the journal and overwrites the space they took."],
]))}`,
        },
        {
          id: "data",
          title: "Your data stays on your computer",
          lead: "There is no telemetry. The interface has no network access of its own: requests go from the app’s core directly to the exchange, to the model provider you chose, to any tool server you attached and, while web search is on, to news publishers and the sites that serve their pictures, the articles the assistant opens from news results and pages you link. Beyond those, the app asks GitHub for its latest release when it starts, and an article you open on the News page loads in a separate browser view inside the window, as it would in your browser. Nowhere else.",
          body: `${table({
            head: ["What", "Where"],
            stack: true,
            rows: [
              ["Conversations, activity, preferences", `Windows ${code("%LOCALAPPDATA%\\Octo Gens\\")}<br>macOS ${code("~/Library/Application Support/Octo Gens/")}<br>Linux ${code("~/.local/share/octo-gens/")}`],
              ["API wallet keys, OpenRouter key, Cloudflare API token", `Your system keychain, under ${code("org.octogens.desktop")}`],
              ["Your trading journal (what you log under Activity)", "The app window’s own storage on your computer, not the folder above"],
              ["Positions, balances, orders", "On the exchange. The app reads them and keeps no copy between launches."],
              ["Story pictures on the News page", "In memory: the last 64, up to 32 MB. Nothing is kept between launches."],
              ["An article you open", "Its cookies and storage, in memory and only while it is open."],
            ],
          })}
<p>The folder and the keychain entry keep the name the app had before it was called OctoNeo, so an existing installation keeps its wallet, settings and conversations.</p>
<ul class="checks">
<li>With a cloud model, your messages and what the assistant reads for them, including the account summary, go to that provider. With Ollama or LM Studio they stay on your computer.</li>
<li>With web search on, the app downloads the public feeds of seven publishers, the pictures of the stories on the News page, and the articles the assistant reads. What you type is not sent to them, except the ticker of a share, a fund or a commodity, which goes to Yahoo Finance.</li>
<li>An article you open on the News page is loaded by the in-app browser view with the publisher’s own scripts and ads, and keeps no cookies once you close it.</li>
<li>The journal keeps your conversations, which can include account figures the assistant quoted. Deleting a conversation removes it from the journal.</li>
<li>Your trading journal is kept as you typed it, not encrypted. It reaches a model only when you ask the assistant to review it, in that message.</li>
</ul>
${reference("Environment variables, meant for tests", table({
  head: ["Environment variable", "Effect"],
  stack: true,
  rows: [
    [code("OCTONEO_DATA_DIR"), "Use another data folder"],
    [code("OCTONEO_NO_KEYCHAIN"), "Keep keys in memory for the session instead of the system keychain. Meant for tests"],
    [`${code("OCTONEO_MAINNET_URL")}, ${code("OCTONEO_TESTNET_URL")}`, "Send a network’s requests, signed ones included, to another origin. Meant for tests: anything you point them at receives your signed requests"],
  ],
}))}`,
        },
        {
          id: "limits",
          title: "Limits you should know",
          body: `<ul class="checks">
<li><strong>Anyone who can run programs as you can use the key.</strong> Software running under your user account can ask the keychain for it, or drive the app. The key cannot withdraw, but it can trade.</li>
<li><strong>The journal is not encrypted.</strong> It keeps your conversations and what the assistant quoted, which can include account figures, and anything you paste into a message. It never contains the keys the app holds.</li>
<li><strong>Your trading journal is not encrypted either.</strong> What you log under Activity is kept in the app window’s own storage on your computer. It reaches a model only when you ask the assistant to review it.</li>
<li><strong>A cloud model sees what you ask it.</strong> Your messages, the tool results it gathers and the account summary in each message go to the provider you chose: OpenRouter, or Cloudflare and the provider behind your gateway.</li>
<li><strong>News publishers see that you read them.</strong> When the app downloads their feeds, the pictures of their stories and the articles the assistant reads, they see your network address, as any site you visit does. An article you open on the News page loads as the publisher made it, with its own scripts, trackers and ads, as in a browser.</li>
<li><strong>The news can be wrong.</strong> A headline is one newsroom’s report. The assistant is told to say who reported it and when, and not to trade on it, but it cannot check it.</li>
<li><strong>A local server’s address is yours to choose.</strong> If you point Ollama or LM Studio at another machine, your conversations go to that machine.</li>
<li><strong>A deposit cannot be taken back.</strong> Once your wallet has sent it, neither the app nor the exchange can undo it, so check the network and the amount in your wallet’s prompt.</li>
<li><strong>The exchange checks the deposit before the signature.</strong> A wallet that has never deposited cannot be verified, so a wrong pasted key shows up only after the first deposit.</li>
<li><strong>The liquidation price on a ticket is an estimate.</strong> It ignores fees, funding and margin tiers. The exchange’s own figure appears once the position is open.</li>
<li><strong>A stop-loss is placed after the entry.</strong> If the exchange refuses it, the position is open without one and the ticket says so. Stops trigger market orders and can fill worse than their trigger.</li>
<li><strong>No keychain, no memory between launches.</strong> If your system has no keychain, keys are kept in memory for the session and the wallet must be connected again at the next launch.</li>
<li><strong>Installers are not signed with a developer certificate or notarized.</strong> macOS builds carry an ad-hoc signature only, so macOS and Windows will warn before the first launch of a downloaded copy. <a href="/download/#first-launch">What that looks like</a>.</li>
</ul>`,
        },
        {
          id: "you",
          title: "What you should do",
          body: `<ul class="checks">
<li><strong>Never type a seed phrase or your wallet’s private key into OctoNeo</strong>, or into any chat. The app never needs them.</li>
<li>Read what your wallet asks you to sign. The approval must say ${code("canWithdraw=false")}. A withdrawal must name your own address as its destination, and the amount you typed. A deposit must go to the vault listed in ${out(doc("docs/exchange.md", "depositing"), "docs/exchange.md")}.</li>
<li>Choose a short approval period, and remove the API wallet on the exchange’s API wallet page when you stop using the app on a computer.</li>
<li>Keep the leverage limit low.</li>
<li>Attach only tool servers you trust. A local command runs with your user’s permissions.</li>
<li>Give a Cloudflare API token only the Workers AI Read permission. The app needs nothing more.</li>
<li>Keep the app up to date: it tells you when a newer release is out. Fixes are released for the latest version only.</li>
</ul>`,
        },
        {
          id: "report",
          title: "Reporting a vulnerability",
          body: `<p>Please do not open a public issue. Use <strong>Report a vulnerability</strong> under the repository’s Security tab, which opens a private advisory visible only to the maintainers. Include what you found, how to reproduce it, and what an attacker could do with it. Never include a real key or seed phrase, and revoke any key that was exposed while testing.</p>
<div class="actions"><a class="button button-quiet" href="${ADVISORY}">Report a vulnerability</a></div>
<p>The full policy is ${out(doc("SECURITY.md"), "SECURITY.md")}.</p>`,
        },
      ],
    }),
};
