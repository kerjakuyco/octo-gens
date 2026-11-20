import { code, doc, docPage, facts, icon, literal, out, reference, table, ui, uiButton } from "../site.mjs";

const APPROVAL = `user=<your wallet>&nonce=<microseconds>&agentName=OctoNeo&agentAddress=<API wallet>
&expired=<milliseconds>&signatureChainId=56
&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=`;

/**
 * The head's picture: the deposit and the withdrawal pages side by side, as the app serves them on
 * testnet against a stand-in for the exchange with a test wallet. The figures are those of the
 * pictures further down this page.
 */
const step = (state, n, title, body = "") =>
  `<li class="ui-step" data-state="${state}"><span class="ui-step-mark">${state === "done" ? icon("check", 14) : n}</span><div class="ui-step-text"><p class="ui-step-title">${title}</p>${body}</div></li>`;

const wallet = `<p class="ui-step-note">Rabby Wallet <code>0x63DD…7C4e</code></p>`;

const FLOWS = ui({
  className: "ui-wallet",
  label:
    "A sample of the two pages the app serves on your computer, on testnet with a stand-in for the exchange. Deposit to your trading account: the wallet is connected; 250 USDT on BNB Smart Chain Testnet is chosen, with a Deposit 250 USDT button; then allow the amount, send the deposit and wait for the network. Withdraw to your wallet: the wallet is connected; 40 USDT is chosen, with an exchange fee of 0.11 USDT, going to the same wallet, and a Withdraw 40 USDT button; then sign the withdrawal and confirm it is you.",
  caption: "The deposit and withdrawal pages, served by the app on your computer and opened in the browser where your wallet is. Testnet, with a stand-in for the exchange and a test wallet: sample figures.",
  body: `<div class="ui-bar">
<span class="ui-bar-start"><span class="ui-address"><span class="ui-address-host">127.0.0.1</span><span class="ui-muted">served by OctoNeo on this computer</span></span></span>
<span class="ui-bar-end"><span class="ui-net"><strong>Testnet</strong> test funds</span></span>
</div>
<div class="ui-flows">
<section class="ui-flow">
<p class="ui-flow-title">Deposit to your trading account</p>
<p class="ui-flow-lead">You confirm every transaction in your wallet.</p>
<ol class="ui-steps">
${step("done", 1, "Connect your wallet", wallet)}
${step("now", 2, "Choose what to deposit", `<div class="ui-form">
<p class="ui-options"><span data-on>BNB Smart Chain Testnet</span><span>Sepolia</span></p>
<p class="ui-amount"><strong class="num">250</strong><span>USDT</span></p>
<p class="ui-step-note">In your wallet: <span class="num">1,234.56</span> USDT</p>
${uiButton("Deposit 250 USDT", "primary")}
</div>`)}
${step("next", 3, "Allow the amount")}
${step("next", 4, "Send the deposit")}
${step("next", 5, "Wait for the network")}
</ol>
</section>
<section class="ui-flow">
<p class="ui-flow-title">Withdraw to your wallet</p>
<p class="ui-flow-lead">Your wallet signs twice.</p>
<ol class="ui-steps">
${step("done", 1, "Connect your wallet", wallet)}
${step("now", 2, "Choose what to withdraw", `<div class="ui-form">
<p class="ui-options"><span data-on>BNB Smart Chain Testnet</span><span>Sepolia</span></p>
<p class="ui-amount"><strong class="num">40</strong><span>USDT</span></p>
<dl class="ui-facts ui-facts-plain">
<div><dt>Exchange fee</dt><dd class="num">0.11 USDT</dd></div>
<div><dt>Goes to</dt><dd><code>0x63DD…7C4e</code></dd></div>
<div><dt>Daily limit</dt><dd class="num">9,000 of 10,000 USD left</dd></div>
</dl>
${uiButton("Withdraw 40 USDT", "primary")}
</div>`)}
${step("next", 3, "Sign the withdrawal")}
${step("next", 4, "Confirm it is you")}
</ol>
</section>
</div>`,
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
      visual: FLOWS,
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
          lead: "Open Settings, then Wallet, and choose one.",
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
  alt: "The approval page OctoNeo opens in the browser: what your wallet approves, a trading key that can place and cancel perpetual futures orders on testnet, cannot trade spot and cannot withdraw or move your funds, valid for 30 days, then the steps to connect, switch network and sign.",
  caption: "The approval page, served by the app on your computer and opened in the browser where your wallet is. Testnet, with a stand-in for the exchange.",
  kind: "column",
})}
${reference("The four steps of an approval, and what crosses the page", `<ol class="steps-list">
<li>The app creates a new API wallet key and keeps it in memory.</li>
<li>It serves the approval page on ${code("127.0.0.1")}, on a random port, behind a random path, for ten minutes.</li>
<li>The page finds the wallets in your browser and lets you pick one, connects it, and asks it to sign the approval. Confirm the wallet’s prompt within about ten seconds, because the message carries a fresh nonce, a one-time number.</li>
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
          lead: "Deposit and Withdraw are in Settings under Wallet, and on the Account page. Each opens a page the app serves on your computer, in the browser where your wallet is, like the approval does. You never have to visit the exchange’s site.",
          body: `${table({
            head: ["Direction", "What your wallet does", "What the app does"],
            stack: true,
            rows: [
              ["Deposit", "Sends the deposit to the vault, the exchange’s deposit contract, after allowing the vault exactly that amount of the token", "Builds the transactions, checks the vault with the exchange first, and records the deposit under Activity"],
              ["Withdraw", "Signs the withdrawal, then the request that carries it", "Checks both signatures are yours, sends the request once, and records it"],
            ],
          })}
${ctx.figure("wallet-deposit", {
  alt: "The deposit page: the wallet is connected, the network is BNB Smart Chain Testnet, the asset is USDT and the amount is 250, with a Deposit 250 USDT button and the remaining steps: allow the amount, send the deposit, wait for the network.",
  caption: "Depositing on testnet. Your wallet sends the transactions; the app only builds them. Stand-in data.",
  kind: "column",
})}
${reference("The five steps of a deposit", `<ol class="steps-list">
<li>The page lists the networks and assets the exchange accepts now. Tokenized shares are left out.</li>
<li>You choose a network, an asset and an amount. The app checks the vault it knows for that network against the one the exchange reports at that moment. If they differ, nothing is built and the page says so.</li>
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
            alt: "The withdrawal page: network BNB Smart Chain Testnet, asset USDT, amount 40, the amount you can withdraw, the exchange fee, the destination which is your own wallet, the daily limit, and a Withdraw 40 USDT button, then two signing steps.",
            caption: "Withdrawing on testnet. The only destination offered is your own wallet. Stand-in data.",
            kind: "column",
          })}
${reference("The four steps of a withdrawal, and its two signatures", `<ol class="steps-list">
<li>The page shows what the account may withdraw now, per asset and network, with the exchange’s fee and what is left of the daily limit.</li>
<li><strong>First signature: the withdrawal.</strong> Your wallet signs the amount, the fee, the network and the destination, which is your own wallet.</li>
<li><strong>Second signature: the request.</strong> Your wallet signs the request that carries the first signature, which proves to the exchange that you are the one asking. The request is accepted for about a minute, so confirm this prompt promptly.</li>
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
