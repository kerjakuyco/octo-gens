import { REPO, ISSUES, chip, code, doc, docPage, esc, facts, icon, out, reference, shell, table } from "../site.mjs";

const LAYOUT = [
  "crates/octoneo-core/    Trading core in Rust: exchange client, wallet signing, indicators,",
  "                        news, model providers, assistant. No UI.",
  "src-tauri/              Desktop shell: window, keychain, one command per core action.",
  "src/                    Interface in React and TypeScript.",
  "docs/                   Architecture, the assistant, the exchange.",
  "scripts/                Smoke test for the built app.",
].join("\n");

/**
 * The head's picture: a window on the repository, with an excerpt of the code that writes the
 * approval your wallet signs. The excerpt is copied from the file as it is; if the function
 * changes there, change it here. The tree lists folders and files that exist.
 */
const SOURCE_FILE = "crates/octoneo-core/src/exchange/mod.rs";

/** The excerpt, line by line: comments, then code with its string and the one field that matters. */
const EXCERPT = [
  ["comment", "/// The message a main wallet signs to approve an API wallet for perpetual"],
  ["comment", "/// trading only. The field order is fixed by the exchange; `canWithdraw` is always false."],
  [
    "code",
    `<span class="tok-kw">pub fn</span> <span class="tok-fn">approval_message</span>(user: &amp;Address, nonce: <span class="tok-kw">u64</span>, agent: &amp;Address, expires_ms: <span class="tok-kw">i64</span>) -&gt; <span class="tok-kw">String</span> {`,
  ],
  ["code", `    <span class="tok-fn">format!</span>(`],
  [
    "code",
    `        <span class="tok-str">"user={user}&amp;<wbr>nonce={nonce}&amp;<wbr>agentName={AGENT_NAME}&amp;<wbr>agentAddress={agent}&amp;<wbr>expired={expires_ms}&amp;<wbr>signatureChainId={APPROVAL_CHAIN_ID}&amp;<wbr>canSpotTrade=false&amp;<wbr>canPerpTrade=true&amp;<wbr><mark>canWithdraw=false</mark>&amp;<wbr>ipWhitelist="</span>`,
  ],
  ["code", "    )"],
  ["code", "}"],
];

const TREE = [
  [0, "folder", "crates/octoneo-core/src"],
  [1, "folder", "assistant"],
  [1, "folder", "exchange"],
  [2, "file", "funding.rs"],
  [2, "file", "mod.rs", true],
  [2, "file", "signing.rs"],
  [1, "folder", "llm"],
  [1, "folder", "web"],
  [0, "folder", "src-tauri"],
  [0, "folder", "src"],
  [0, "folder", "docs"],
];

const SOURCE = `<figure class="ui-figure ui-code-figure">
<div class="ui ui-code">
<div class="ui-bar">
<span class="ui-bar-start"><span class="code-window-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="ui-path">${SOURCE_FILE}</span></span>
<span class="ui-bar-end">${chip("Rust")}${chip("GPL-3.0-only")}</span>
</div>
<div class="ui-code-body">
<ul class="ui-tree" aria-hidden="true">
${TREE.map(([depth, kind, name, on]) => `<li data-depth="${depth}"${on ? " data-on" : ""}>${icon(kind, 15)}<span>${esc(name)}</span></li>`).join("\n")}
</ul>
<pre class="ui-source"><code>${EXCERPT.map(([kind, line]) => {
  const indent = /^ */.exec(line)[0].length;
  const html = kind === "comment" ? `<span class="tok-comment">${esc(line)}</span>` : line;
  return `<span class="ui-line"${indent ? ` data-indent="${indent}"` : ""}>${html}</span>`;
}).join("\n")}</code></pre>
</div>
<p class="ui-terminal"><span class="ui-prompt" aria-hidden="true">$</span> cargo test -p octoneo-core</p>
</div>
<figcaption>The approval your wallet signs, from ${out(doc(SOURCE_FILE), SOURCE_FILE)}: ${code("canWithdraw")} is always ${code("false")}, and there is no setting that changes it.</figcaption>
</figure>`;

export default {
  path: "/open-source/",
  title: "Open source | OctoNeo",
  description:
    "OctoNeo is GPL-3.0-only software: a Rust trading core, a thin Tauri shell and a React interface. How it fits together, how to build and test it, and how to contribute.",
  render: () =>
    docPage({
      path: "/open-source/",
      title: "How OctoNeo is built, and how to contribute",
      lead: `OctoNeo is licensed under GPL-3.0-only. Read the code that signs your orders, build it yourself, and send a pull request. Everything is on ${out(REPO, "GitHub")}.`,
      visual: SOURCE,
      sections: [
        {
          id: "license",
          title: "The license",
          body: `<p>You may run, study, change and share OctoNeo under the ${out(doc("LICENSE"), "GNU General Public License, version 3 only")}. If you distribute it, or a version you changed, you pass on the same freedoms: its source, under the same license. Contributions are accepted under GPL-3.0-only too.</p>
<h3>Third-party notices</h3>
<p>The price chart is drawn with ${out("https://github.com/tradingview/lightweight-charts", "Lightweight Charts")}, copyright TradingView, Inc., under the Apache License 2.0; as that license’s notice asks, the app credits TradingView and links to its site beside the chart and in Settings. The icons of well-known coins are from Web3 Icons, under the MIT license; each coin’s logo is a trademark of its project and is shown only to identify that coin.</p>
${reference("The main packages, what each is used for, and its license", table({
  head: ["Package", "Use", "License"],
  stack: true,
  rows: [
    ["Tauri", "Desktop shell", "Apache-2.0 or MIT"],
    ["React", "Interface", "MIT"],
    ["rmcp", "Model Context Protocol (MCP) client", "Apache-2.0"],
    ["reqwest", "HTTP client", "MIT or Apache-2.0"],
    ["rusqlite, with bundled SQLite", "Run journal", "MIT; SQLite is public domain"],
    ["k256 and sha3", "Signing requests with the API wallet", "Apache-2.0 or MIT"],
    ["rust_decimal", "Exact decimal arithmetic", "MIT"],
    ["keyring", "System keychain", "MIT or Apache-2.0"],
    ["scraper, with html5ever", "Reading the text of a web page", "ISC; html5ever is MIT or Apache-2.0, and its selector engine MPL-2.0"],
    ["roxmltree", "Reading news feeds", "MIT or Apache-2.0"],
    ["encoding_rs", "Reading pages that are not UTF-8", "(Apache-2.0 or MIT) and BSD-3-Clause"],
  ],
}))}
<p>Headlines remain the work of their publishers. They are shown with the publisher’s name and a link to the article, and OctoNeo stores none of their articles. The complete dependency lists are ${code("Cargo.lock")} and ${code("pnpm-lock.yaml")}; ${out(doc("NOTICE.md"), "NOTICE.md")} has the notices.</p>`,
        },
        {
          id: "architecture",
          title: "How it fits together",
          lead: "Three layers, each knowing only about the layer below it.",
          body: `<figure class="layers">
<ol class="layers-stack">
<li><p class="layer-name">Interface <span>React and TypeScript</span></p><p class="layer-path">${code("src/")}</p><p>Renders a snapshot and sends commands. No network access, no secrets.</p></li>
<li><p class="layer-name">Desktop shell <span>Rust, Tauri</span></p><p class="layer-path">${code("src-tauri/")}</p><p>The window, the system keychain, one command per action. No trading logic.</p></li>
<li><p class="layer-name">Trading core <span>Rust</span></p><p class="layer-path">${code("crates/octoneo-core/")}</p><p>Exchange client, wallet signing, indicators, news, the assistant loop, MCP client. No UI code.</p></li>
</ol>
<div class="layers-out">
<p class="layers-out-title">The core talks to</p>
<ul>
<li>The exchange, mainnet and testnet</li>
<li>A model provider: OpenRouter, Cloudflare AI Gateway, Ollama or LM Studio</li>
<li>News publishers, the pictures of their stories and the pages the assistant reads, while web search is on</li>
<li>MCP tool servers you attach</li>
</ul>
</div>
<figcaption>The interface and the shell talk over Tauri’s IPC. The web view runs under a content security policy that allows no network connections except IPC. A news article opens in a second web view, kept apart from the app, which cannot call its commands.</figcaption>
</figure>
<h3>An order</h3>
<p>Orders follow one path whoever asks for them, the trader’s form or the assistant.</p>
${reference("The four steps of an order, from draft to receipt", `<ol class="steps-list">
<li>${code("Studio::draft_ticket")} reads the mark price and the account, checks the order against both and against the risk limits, and keeps the result as the draft. Nothing is sent.</li>
<li>The interface shows the ticket. ${code("Studio::submit_ticket")} takes the draft, so a second click finds nothing to send.</li>
<li>The position is read again, the market is set up, the market order goes out, then its stop-loss and take-profit.</li>
<li>The outcome is journaled and kept with the ticket: a receipt, or the reason it was not confirmed.</li>
</ol>`)}
<h3>A chat turn</h3>
${reference("The four steps of a chat turn, from your message to the journal", `<ol class="steps-list">
<li>The model gets the standing instructions, earlier turns of the open conversation, and your message with a desk block describing the network, the account and the risk limits right now.</li>
<li>The loop asks the model, runs the tools it calls, and hands the results back, until the model answers in words, the tool budget is used up, or you press Stop.</li>
<li>Steps, text and cards stream to the interface as they happen.</li>
<li>The finished run goes to the journal, cards included.</li>
</ol>`)}
<p>The loop has no access to orders. The only tool that touches trading is ${code("propose_order")}, which drafts a ticket. ${out(doc("docs/architecture.md"), "docs/architecture.md")} has the whole picture.</p>`,
        },
        {
          id: "core",
          title: "The trading core",
          lead: `${code("crates/octoneo-core")} is an ordinary Rust library. It can be built, tested and run without Tauri, a web view or Node.`,
          body: `${reference("The core’s modules, and what each is responsible for", table({
            head: ["Module", "Responsibility"],
            stack: true,
            rows: [
              [`${code("model")}, ${code("instruments")}`, "Domain types for perpetual futures, and the default watchlist. Money is an exact decimal, never a float."],
              [code("exchange"), "The exchange’s futures client: market data, the account, orders. It holds the API wallet key and makes the EIP-712 signatures, and builds a deposit’s transactions and a withdrawal’s messages for your own wallet."],
              [code("connect"), "The page served on your computer through which a browser wallet approves the API wallet, deposits and withdraws."],
              [code("indicators"), "Deterministic technical readings, so the model never does arithmetic."],
              [code("llm"), "The model providers, behind one connection the agent loop uses."],
              [code("assistant"), "The system prompt, the tool definitions, and the agent loop."],
              [code("web"), "News and web pages: the feeds, the pages the assistant reads, the News page’s stories and their pictures, and the guard that decides which addresses may be read at all."],
              [code("mcp"), "Model Context Protocol client for tool servers."],
              [code("store"), "Preferences, the run journal, and the store for secrets."],
              [code("studio"), "The one object that owns the desk’s state and offers every action."],
            ],
          }))}
${reference("The repository’s folders", `<pre class="code code-pre" aria-label="The repository's folders"><code>${LAYOUT}</code></pre>`)}`,
        },
        {
          id: "build",
          title: "Build and test",
          lead: `You need ${out("https://rustup.rs", "Rust")} (stable), ${out("https://nodejs.org", "Node.js")} 20 or newer, ${out("https://pnpm.io", "pnpm")} 10, and the ${out("https://tauri.app/start/prerequisites/", "Tauri system dependencies")}. You do not need a wallet or a model key: market data is public, and the tests run against stand-ins for the exchange and for every model provider.`,
          body: `${shell([
            "git clone https://github.com/kerjakuyco/octo-neo.git",
            "cd octo-neo",
            "pnpm install",
            "pnpm tauri dev",
          ])}
${table({
  head: ["To work on", "Run", "Needs"],
  stack: true,
  rows: [
    ["The core", code("cargo test -p octoneo-core"), "Rust only"],
    ["The interface", `${code("pnpm dev")}, in a browser against a mock core`, "Node only"],
    ["The whole app", code("pnpm tauri dev"), "Both"],
  ],
})}
<p>Tests never reach the internet. Four examples run the core without a window, and none of them signs or sends anything.</p>
${reference("The four examples, and what each runs", shell([
  "cargo run -p octoneo-core --example probe     # live market data from both networks",
  "cargo run -p octoneo-core --example news      # the real news feeds",
  "cargo run -p octoneo-core --example funding   # the deposit vaults, each deposit simulated",
  "cargo run -p octoneo-core --example wallet_page -- connect   # the wallet page, against a stand-in",
]))}
<h3>Before you open a pull request</h3>
<p>Run what CI runs:</p>
${shell([
  "cargo fmt --all --check",
  "cargo clippy --workspace --all-targets -- -D warnings",
  "cargo test --workspace",
  "pnpm typecheck && pnpm lint && pnpm test",
])}
<p>If you touched the shell, the interface or the contract between them, also run the end-to-end smoke test, which opens the app window briefly: ${code("pnpm tauri build --debug --no-bundle")}, then ${code("pnpm smoke")}.</p>`,
        },
        {
          id: "contributing",
          title: "Contributing",
          lead: "Bug reports, ideas and pull requests are welcome.",
          body: `${facts([
            ["Report or suggest", `Open an ${out(ISSUES, "issue")} with the issue templates.`],
            ["Fix something", "Issues labeled good first issue are a good start."],
            ["Check against the exchange", `${out(doc("docs/exchange.md", "checking-against-the-exchange"), "docs/exchange.md")} explains how a change is tested against the exchange.`],
            ["Improve the assistant", `${out(doc("docs/assistant.md"), "docs/assistant.md")} covers the prompt and the tools.`],
          ], "facts-wide")}
<h3>What a pull request must keep</h3>
<ul class="checks">
<li><strong>The assistant cannot trade.</strong> No tool that places, changes or cancels an order, and no weakening of the safeguards. Pull requests that do will not be merged.</li>
<li><strong>A model answers, or nothing does.</strong> No rule-based replies and no typed commands.</li>
<li><strong>The app’s key never moves funds.</strong> A deposit is a transaction your own wallet sends, and a withdrawal is signed by your wallet, in your browser, every time.</li>
<li><strong>Secrets stay in the keychain.</strong> Nothing secret in preferences, the journal, logs, snapshots or errors.</li>
<li><strong>Money is exact.</strong> Prices, quantities and balances are decimals; floats are for indicators only.</li>
<li><strong>Small dependencies.</strong> The app holds a key that can trade, so every new dependency is a risk to explain.</li>
<li><strong>Tests that would fail without your change</strong>, beside the code, never reaching the internet.</li>
</ul>
<p>Keep a pull request to one change, and write commit messages in the ${out("https://www.conventionalcommits.org", "Conventional Commits")} style. Everyone taking part follows the ${out(doc("CODE_OF_CONDUCT.md"), "Code of Conduct")}. Security problems go through ${out(doc("SECURITY.md"), "SECURITY.md")}, not a public issue. The full guide is ${out(doc("CONTRIBUTING.md"), "CONTRIBUTING.md")}.</p>`,
        },
        {
          id: "history",
          title: "Version history",
          body: `${table({
            head: ["Version", "What changed"],
            stack: true,
            rows: [
              ["0.8.0", "A trading journal on the Activity page, which the assistant reviews when you ask, and an Account page that reads like a portfolio. Long lists come a page at a time, the news no longer includes a publisher whose articles need a subscription, and long chat titles fit the sidebar."],
              ["0.7.0","A News page that lays out the newsrooms’ stories like a magazine, and opens a story inside the app. The order form and Settings were redesigned, the app says when a newer version is out, and the icon is now white on near-black."],
              ["0.6.0", "A page for each market in place of the market panel: chart overlays, readings on trend, volatility and trading flow, and your position and orders in that market. The sidebar was redesigned, and conversations can be filtered by title."],
              ["0.5.0", "The app is now called OctoNeo. A chat-first interface, four ways to connect a model, a screener, the order book, funding and technical readings, the news, and deposits and withdrawals in the app. Every message is answered by a model."],
              ["0.4.0", "Perpetual futures on a decentralized exchange from your own web3 wallet, on mainnet and testnet: a trade-only key, an Account page, leverage and margin held to your limits, stop-loss and take-profit."],
              ["0.3.0", "Rewritten as a Tauri app, a Rust core with a React interface, with a tool-calling assistant, technical readings computed by the app and a candlestick chart."],
            ],
          })}
<p>Every change is in the ${out(doc("CHANGELOG.md"), "changelog")}.</p>`,
        },
      ],
    }),
};
