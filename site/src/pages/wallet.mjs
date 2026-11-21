import { mark } from "../logos.mjs";
import { code, doc, docPage, facts, icon, literal, out, reference, table, ui, uiButton } from "../site.mjs";

const APPROVAL = `user=<your wallet>&nonce=<microseconds>&agentName=OctoNeo&agentAddress=<API wallet>
&expired=<milliseconds>&signatureChainId=56
&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=`;

/**
 * The head's picture: the deposit and the withdrawal pages side by side, as the app serves them on
 * testnet against a stand-in for the exchange with a test wallet: the page's own header, a card for
 * each task, and the line under the cards. The figures are those of the pictures further down this
 * page. The wallet's icon is Rabby's single-colour mark; the page shows the one the wallet reports.
 */
const ADDRESS = "0xE0FA…d27b";

const step = (state, n, title, body = "") =>
  `<li class="ui-step" data-state="${state}"><span class="ui-step-mark">${state === "done" ? icon("check", 12) : n}</span><div class="ui-step-text"><p class="ui-step-title">${title}</p>${body}</div></li>`;

const wallet = `<p class="ui-wallet-row"><span class="ui-wallet-chip"><span class="ui-wallet-icon">${mark("rabby", 13)}</span><strong>Rabby Wallet</strong><code>${ADDRESS}</code></span><span class="ui-wallet-link">Use another wallet</span></p>`;

/** One end of a transfer, as the card's From and To boxes draw it. */
const end = (label, name, detail, mono = false) =>
  `<span class="ui-route-end"><span class="ui-route-label">${label}</span><strong>${name}</strong>${mono ? `<code>${detail}</code>` : `<span>${detail}</span>`}</span>`;
const route = (from, to, note = "") =>
  `<div class="ui-route"><div class="ui-route-ends">${from}<span class="ui-route-arrow">${icon("arrow", 14)}</span>${to}</div>${note ? `<p class="ui-route-note">${note}</p>` : ""}</div>`;
const YOUR_WALLET = (label) => end(label, "Your wallet", ADDRESS, true);
const TRADING = (label) => end(label, "Trading account", "On the exchange, Testnet");

/** The amount: the shares beside its label, the field with its asset, and what there is to move. */
const amount = (value, asset, below) => `<p class="ui-amount-head"><span>Amount</span><span class="ui-pcts"><span>25%</span><span>50%</span><span>75%</span><span>Max</span></span></p>
<p class="ui-amount"><strong class="num">${value}</strong><span class="ui-asset">${asset}</span></p>
<p class="ui-amount-note">${below}</p>`;

const BNB = `<span class="ui-chain">${mark("bnb", 13)}<span>BNB Smart Chain Testnet</span></span>`;
const summary = (rows, [term, value]) =>
  `<dl class="ui-sum">${rows.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join("")}<div class="ui-sum-total"><dt>${term}</dt><dd class="num">${value}</dd></div></dl>`;

const LOCK = `<svg class="icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>`;

const flows = (ctx) =>
  ui({
    className: "ui-wallet",
    label:
      "A sample of the two pages the app serves on your computer, on testnet with a stand-in for the exchange. Deposit to your trading account: from your wallet to your trading account on the exchange. Rabby Wallet is connected; the amount is 250 USDT, with 25%, 50%, 75% and Max beside it and 1,234.56 USDT in the wallet; a summary says the network is BNB Smart Chain Testnet, the network fee is paid in tBNB by your wallet, the deposit is credited to your trading account, and you deposit 250 USDT. Then a Deposit 250 USDT button, and the steps to come: allow the amount, send the deposit, wait for the network. Withdraw to your wallet: from your trading account to your wallet, and only to your own wallet. The wallet is connected; the amount is 40 USDT of the 1,250.75 USDT you can withdraw; a summary says the network is BNB Smart Chain Testnet, the funds go to your wallet, the exchange fee is about 0.5 USDT and you receive about 39.5 USDT, with 9,000 of the 10,000 USD daily limit left. Then a Withdraw 40 USDT button, and the steps to come: sign the withdrawal, confirm it is you. Under the pages: served by OctoNeo from your own computer, it loads nothing from the internet.",
    caption: "The deposit and withdrawal pages, served by the app on your computer and opened in the browser where your wallet is. Testnet, with a stand-in for the exchange and a test wallet: sample figures.",
    body: `<div class="ui-bar">
<span class="ui-bar-start"><span class="ui-brand"><img src="${ctx.asset("images/octopus.svg")}" width="21" height="20" alt="">OctoNeo</span></span>
<span class="ui-bar-end"><span class="ui-net"><strong>Testnet</strong><span aria-hidden="true">·</span>test funds</span></span>
</div>
<div class="ui-flows">
<section class="ui-flow">
<p class="ui-flow-title">Deposit to your trading account</p>
<p class="ui-flow-lead">Move funds from your wallet to your trading account on the exchange. You confirm every transaction in your wallet.</p>
${route(YOUR_WALLET("From"), TRADING("To"))}
<ol class="ui-steps">
${step("done", 1, "Connect your wallet", wallet)}
${step("now", 2, "Choose what to deposit", `<div class="ui-form">
${amount("250", `USDT${icon("chevronDown", 12)}`, `In your wallet: <span class="num">1,234.56</span> USDT`)}
${summary(
  [
    ["Network", BNB],
    ["Network fee", "Paid in tBNB by your wallet"],
    ["Credited to", "Your trading account"],
  ],
  ["You deposit", "250 USDT"],
)}
${uiButton("Deposit 250 USDT", "primary")}
</div>`)}
${step("next", 3, "Allow the amount")}
${step("next", 4, "Send the deposit")}
${step("next", 5, "Wait for the network")}
</ol>
</section>
<section class="ui-flow">
<p class="ui-flow-title">Withdraw to your wallet</p>
<p class="ui-flow-lead">Move funds from your trading account on the exchange back to your own wallet. Your wallet signs twice.</p>
${route(TRADING("From"), YOUR_WALLET("To"), "Only to your own wallet, the one that trades: this page offers no other destination.")}
<ol class="ui-steps">
${step("done", 1, "Connect your wallet", wallet)}
${step("now", 2, "Choose what to withdraw", `<div class="ui-form">
${amount("40", "USDT", `You can withdraw <span class="num">1,250.75</span> USDT`)}
${summary(
  [
    ["Network", BNB],
    ["Goes to", `<code>${ADDRESS}</code>, your wallet`],
    ["Exchange fee", `about <span class="num">0.5</span> USDT`],
  ],
  ["You receive", "about 39.5 USDT"],
)}
<p class="ui-amount-note">Daily limit: <span class="num">9,000</span> of <span class="num">10,000</span> USD left.</p>
${uiButton("Withdraw 40 USDT", "primary")}
</div>`)}
${step("next", 3, "Sign the withdrawal")}
${step("next", 4, "Confirm it is you")}
</ol>
</section>
</div>
<p class="ui-served">${LOCK}<span>Served by OctoNeo from your own computer. It loads nothing from the internet.</span></p>`,
  });

export default {
  path: "/wallet/",
  title: "Wallet, deposits and withdrawals | OctoNeo",
  description:
    "Your own wallet approves a trade-only key for OctoNeo that cannot withdraw. Deposits and withdrawals start in the app and are confirmed by your wallet, every time. Withdrawals need a wallet that signs across networks, such as Rabby; MetaMask cannot.",
  render: (ctx) =>
    docPage({
      path: "/wallet/",
      title: "Wallet, deposits and withdrawals",
      lead: "OctoNeo trades through a separate key that your own wallet approves for perpetual futures only. That key cannot withdraw, and the app never sees your wallet’s own key. Deposits and withdrawals start in the app and are confirmed by your wallet, every time. Withdrawals need a wallet that signs across networks, such as Rabby; MetaMask cannot.",
      visual: flows(ctx),
      sections: [
        {
          id: "key",
          title: "A key that can trade and nothing else",
          body: `<p>The exchange lets a wallet approve an agent, an <strong>API wallet</strong>, that may trade for it. OctoNeo asks for a narrow approval: perpetual futures only, no spot trading, no withdrawal.</p>
${reference("The message your wallet signs", literal(APPROVAL, "The approval your wallet signs"))}
<p>${code("canWithdraw")} is always ${code("false")}; there is no setting that changes it. The key lives in your system keychain, and the approval lasts as long as you choose, from 7 to 180 days. Each network, mainnet and testnet, has its own wallet.</p>`,
        },
        {
          id: "connect",
          title: "Two ways to connect",
          lead: "Open Settings, then Wallets, and choose one.",
          body: `${table({
            head: ["Way", "What happens", "Good for"],
            stack: true,
            rows: [
              ["Approve in a browser wallet", "The app creates a key on your computer and opens a page it serves locally. Your wallet (MetaMask, Rabby and others) signs one approval for that key.", "Most people"],
              ["Paste an API wallet key", "You create an API wallet on the exchange’s own API wallet page, which the app opens for you, and paste its key with your wallet address.", "Hardware wallets, or keys you manage yourself"],
            ],
          })}
<h3>Approving in a browser wallet</h3>
<p>A desktop app cannot talk to a wallet extension, because extensions live in the browser. So the app serves one small page on your computer and opens it in your browser.</p>
${ctx.figure("wallet-connect", {
  alt: "The approval page OctoNeo opens in the browser, on testnet: a card that says what your wallet approves, a trading key made on this computer that can place and cancel perpetual futures orders, cannot trade spot and cannot withdraw or move your funds, valid for 30 days. Below it the steps: the wallet is connected, it is on BNB Smart Chain, and a Sign approval button with a note to confirm within 10 seconds.",
  caption: "The approval page, served by the app on your computer and opened in the browser where your wallet is. Testnet, with a stand-in for the exchange.",
  kind: "column",
})}
${reference("The four steps of an approval, and what crosses the page", `<ol class="steps-list">
<li>The app creates a new API wallet key and keeps it in memory.</li>
<li>It serves the approval page on ${code("127.0.0.1")}, on a random port, behind a random path, for ten minutes.</li>
<li>The page finds the wallets in your browser and lets you pick one, connects it, asks it to switch to BNB Smart Chain, the network the message names, and asks it to sign the approval. Confirm the wallet’s prompt within about ten seconds, because the message carries a fresh nonce, a one-time number.</li>
<li>The app checks that the signature came from the account that connected, sends it to the exchange, and on success stores the key in your keychain. The page shuts down.</li>
</ol>
<p>What crosses that page is your wallet’s address and one signature. The page loads nothing from the internet, answers only its own secret path and only the requests of its own task, and refuses requests that arrive under another host name.</p>`)}
<h3>Pasting an API wallet key</h3>
<p>The app tries a pasted key against the exchange before storing it. It refuses a key that belongs to the wallet address you entered: that would be your main wallet’s key, which must never be pasted anywhere.</p>`,
        },
        {
          id: "first",
          title: "Before your first trade",
          body: facts(
            [
              ["Deposit first", "The exchange serves an account only after the wallet’s first deposit, on testnet too. Until then the app shows the wallet as waiting for its deposit, with a Deposit button."],
              ["One-way mode", "The app keeps one net position per market. An account in hedge mode is shown with an explanation and is not traded."],
              ["Ending access", "Disconnect forgets the key on this computer. The approval itself ends on its expiry date, or sooner if you remove it on the exchange’s API wallet page."],
            ],
            "facts-wide",
          ),
        },
        {
          id: "deposit",
          title: "Deposit from your wallet",
          lead: "Deposit and Withdraw are in Settings under Wallets, and on the Account page. Each opens a page the app serves on your computer, in the browser where your wallet is, like the approval does. You never have to visit the exchange’s site.",
          body: `${table({
            head: ["Direction", "What your wallet does", "What the app does"],
            stack: true,
            rows: [
              ["Deposit", "Sends the deposit to the vault, the exchange’s deposit contract, after allowing the vault exactly that amount of the token", "Builds the transactions, checks the vault with the exchange first, and records the deposit under Activity"],
              ["Withdraw", "Signs the withdrawal, then the request that carries it", "Checks both signatures are yours, sends the request once, and records it"],
            ],
          })}
${ctx.figure("wallet-deposit", {
  alt: "The deposit page: from your wallet to your trading account on testnet. The wallet is connected; the amount is 250 USDT, with 25%, 50%, 75% and Max beside it and 1,234.56 USDT in the wallet; a summary says the network is BNB Smart Chain Testnet, the gas is paid in tBNB by your wallet, the deposit is credited to your trading account, and you deposit 250 USDT. Then a Deposit 250 USDT button and the remaining steps: allow the amount, send the deposit, wait for the network.",
  caption: "Depositing on testnet. Your wallet sends the transactions; the app only builds them. Stand-in data.",
  kind: "column",
})}
${reference("The five steps of a deposit", `<ol class="steps-list">
<li>The page lists the networks and assets the exchange accepts now. Tokenized shares are left out.</li>
<li>You choose an amount, and the network and the asset when there is more than one. When the page can read your wallet’s balance there, it shows it under the amount, with 25%, 50%, 75% and Max; for a network’s own coin, Max keeps some for gas. The app checks the vault it knows for that network against the one the exchange reports at that moment. If they differ, nothing is built and the page says so.</li>
<li>For a token, your wallet first allows the vault to take exactly that amount, unless an earlier allowance already covers it. A network’s own coin needs no allowance.</li>
<li>Your wallet sends the deposit to the vault, for your own wallet’s account.</li>
<li>The page waits for the network to confirm it and tells the app the result. The exchange credits the account a little later, usually within a few minutes.</li>
</ol>`)}
<p>The deposit and its transaction hash are recorded under Activity. Each transaction costs the network’s gas, paid by your wallet. A deposit is a transaction on a public network: once your wallet has sent it, neither the app nor the exchange can undo it, so check the network and the amount in your wallet’s prompt.</p>`,
        },
        {
          id: "networks",
          title: "Where funds move",
          body: `${table({
            head: ["Trading network", "Funds move on"],
            rows: [
              ["Mainnet", "BNB Smart Chain, Ethereum, Arbitrum One"],
              ["Testnet", "BNB Smart Chain Testnet, Sepolia"],
            ],
          })}
<p>The vault on each network is fixed in the app and compared with the one the exchange reports before any transaction is built. The addresses are listed in ${out(doc("docs/exchange.md", "depositing"), "docs/exchange.md")}; check a deposit’s destination against them in your wallet’s prompt.</p>`,
        },
        {
          id: "withdraw",
          title: "Withdraw to your wallet",
          lead: "The exchange carries out a withdrawal only when your own wallet has signed it twice. The key the app holds takes no part.",
          body: `${ctx.figure("wallet-withdraw", {
            alt: "The withdrawal page: from your trading account on testnet to your wallet, and only to your own wallet. The amount is 40 USDT of the 1,250.75 USDT you can withdraw; a summary says the network is BNB Smart Chain Testnet, the funds go to your wallet, the exchange fee is about 0.5 USDT and you receive about 39.5 USDT, with 9,000 of the 10,000 USD daily limit left. Then a Withdraw 40 USDT button and two signing steps.",
            caption: "Withdrawing on testnet. The only destination offered is your own wallet. Stand-in data.",
            kind: "column",
          })}
${reference("The four steps of a withdrawal, and its two signatures", `<ol class="steps-list">
<li>The page shows what the account may withdraw now, per asset and network, with 25%, 50%, 75% and Max of it. As you type an amount, it shows the exchange’s fee, what you receive and what is left of the daily limit. The fee is set when the app prepares the withdrawal, so until then the fee and what you receive are marked about; the exact figures appear with the first signature.</li>
<li><strong>First signature: the withdrawal.</strong> Your wallet signs the amount, the fee, the network and the destination, which is your own wallet.</li>
<li><strong>Second signature: the request.</strong> Your wallet signs the request that carries the first signature, which proves to the exchange that you are the one asking. The request is accepted for about a minute, so the page counts down 45 seconds for this prompt: confirm it before they run out.</li>
<li>The app checks that both signatures came from the connected wallet, sends the request once, and records the exchange’s id for it under Activity.</li>
</ol>`)}
<p>If no clear answer comes back, the app does not treat that as a refusal. It tells you the withdrawal may or may not have been accepted, and to check your balance before asking again.</p>
<h3>Which wallets can withdraw</h3>
<p>The second signature names the exchange’s own network. MetaMask signs typed data only for the network it is on, and that network cannot be added to a wallet, so MetaMask refuses the second signature; when it does, nothing has been sent and nothing is withdrawn. Rabby and other wallets that sign across networks can sign it. Deposits need no cross-network signature.</p>`,
        },
        {
          id: "own",
          title: "Only your own wallet",
          body: `<p>The page must be opened with the wallet that is connected in the app. A deposit is credited to that wallet’s account, and a withdrawal is paid out to that wallet. There is no field for another address.</p>
<h3>What to check in your wallet</h3>
<ul class="checks">
<li>The approval must say ${code("canWithdraw=false")}.</li>
<li>A withdrawal must name your own address as its destination, and the amount you typed.</li>
<li>A deposit must go to the vault listed for its network.</li>
<li>Choose a short approval period, and remove the API wallet on the exchange’s API wallet page when you stop using the app on a computer.</li>
<li>Never type a seed phrase or your wallet’s private key into OctoNeo, or into any chat. The app never needs them.</li>
</ul>`,
        },
      ],
    }),
};
