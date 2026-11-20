# Security

OctoNeo holds a key that can trade on your exchange account, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Use **Report a vulnerability** under the repository's [Security tab](https://github.com/kerjakuyco/octo-neo/security/advisories/new), which opens a private advisory visible only to the maintainers.

Include what you found, how to reproduce it, and what an attacker could do with it. Never include a real key or seed phrase; revoke any key that was exposed while testing.

Fixes are released for the latest version only.

## How the app protects you

| Risk | Protection |
| --- | --- |
| The app's key is stolen | It is an API wallet approved for perpetual trading only: no spot trading, no withdrawal. It lives in the system keychain. The approval expires, and you can remove it on the exchange at any time. |
| Your own wallet's key is exposed | It never enters the app. Connecting needs your address and one signature made in your wallet. A pasted key that belongs to the wallet address itself is refused. |
| The model places a trade you did not want, or moves funds | No tool can place, change or cancel an order, and none can deposit or withdraw. The assistant drafts a ticket and you confirm it. Mainnet tickets from the assistant are off by default, and turning them off again discards one that is waiting. |
| The model opens a reckless position | A ticket from the assistant needs a stop-loss inside the estimated liquidation price, and no ticket may exceed your leverage limit (3x until you raise it). |
| A double click sends an order twice | A draft is consumed by its first submission. Orders are sent once and never retried. |
| A lost answer hides an order that was taken | Orders carry a client id. When an answer goes missing or the exchange's side fails, the app looks the order up before saying anything, and tells you plainly if it could not find out. |
| A ticket is confirmed after the market has moved | The position and the mark price are read again at confirmation. If the position changed, the price moved more than 1%, or the stop-loss no longer protects the position, nothing is sent. |
| A page in your browser hijacks the wallet page | The page your wallet works on (for an approval, a deposit or a withdrawal) is served on this computer only, on a random port behind a random path, for ten minutes (twenty for a deposit or a withdrawal). It answers only that path and only the requests of its own task, refuses other host names, loads nothing from the internet, and every signature must come from the account that connected. |
| Someone withdraws your funds through the app | The key the app holds cannot withdraw. A withdrawal needs two signatures from your own wallet, made in your browser each time, and it names that wallet as its only destination: there is no field for another address. The app checks that both signatures came from the connected wallet before it sends anything. |
| A deposit is sent to the wrong contract | The vault on each network is fixed in the app, and compared with the one the exchange reports before any transaction is built. If they differ, nothing is built. A token deposit allows the vault exactly the amount you deposit, never an open-ended allowance. |
| Keys leak to disk, a model or the interface | Preferences, the journal and snapshots never contain a key. Keys never enter prompts, tool results or the web view. Answers and errors are scrubbed of the model provider's key before they are shown or stored. |
| A mistyped or revoked provider key is stored | A new OpenRouter key is shown to OpenRouter, and a Cloudflare token is proved with one short chat, before either is kept. A key that is turned away replaces nothing. |
| A model on this computer is reached through someone else's server | Requests to Ollama and LM Studio go to the address you set, never through a system proxy, and are never redirected. |
| A deleted conversation stays on disk | Deleting a conversation removes its turns from the journal and overwrites the space they took. |
| A hostile page or tool output hijacks the app | The web view has no network access and can only call the app's own commands. The model is told to treat tool output as data, and the rules above hold even if it is fooled. |
| An article opened on the News page reaches into the app | It opens in a separate browser view inside the window. That view cannot call the app's commands: Tauri refuses commands from remote pages, the interface's permissions name only its own web view, and every command checks which web view asked. It moves only to public `https` pages, refuses downloads and other schemes, and keeps no cookies or storage once closed. Story pictures are fetched by the core, only ones a feed offered, and only real images. |
| A news article tells the model what to do | What the assistant reads on the web reaches the model marked as data. Whatever it is talked into, it can still only draft a ticket you must confirm. |
| A page makes the model send your figures somewhere | The assistant can read only a page a news search showed it, or one you gave it a link to. A link it made up, or one it changed, is never requested, so nothing of yours can leave inside an address. |
| The assistant is pointed at something on your own network | Only public `https` pages are read. Addresses on this computer or on a private network are refused by name, by number, after a redirect, and when the connection is made. |
| A signed request is replayed | Each request carries a nonce the exchange accepts once, within about a minute, and is signed for one network. HTTP redirects are never followed. |
| A tool server does more than read | The assistant may call only tools a server marks read-only. |

## What you should do

- **Never type a seed phrase or your wallet's private key into OctoNeo**, or into any chat. The app never needs them.
- Read what your wallet asks you to sign. The approval must say `canWithdraw=false`. A withdrawal must name your own address as its destination, and the amount you typed. A deposit must go to the vault listed in [docs/exchange.md](docs/exchange.md#depositing).
- Choose a short approval period, and remove the API wallet on the exchange's API wallet page when you stop using the app on a computer.
- Keep the leverage limit low.
- Attach only tool servers you trust. A local command runs with your user's permissions.
- Give a Cloudflare API token only the *Workers AI Read* permission. The app needs nothing more.
- Keep the app up to date.

## Limits you should know

- **Anyone who can run programs as you can use the key.** Software running under your user account can ask the keychain for it, or drive the app. The key cannot withdraw, but it can trade.
- **The journal is not encrypted.** It keeps your conversations and what the assistant quoted, which can include account figures. It never contains keys.
- **A cloud model sees what you ask it.** Your messages, the tool results it gathers and the account summary in each message go to the provider you chose (OpenRouter, or Cloudflare and the provider behind your gateway). A model on this computer keeps all of that here; only the requests to the exchange, to news publishers while web search is on, to any tool server you attached, and the check for a newer release on GitHub when the app starts, leave.
- **News publishers see that you read them.** With web search on, the app downloads the public feeds of eight news publishers, the pictures of the stories on the News page, and the articles the assistant reads, from your computer. They see your network address, as any site you visit does. An article you open on the News page loads as the publisher made it, with its own scripts, trackers and ads, as in a browser. What you type is not sent to them, except the ticker of a share, a fund or a commodity you ask about, which goes to Yahoo Finance. Turn web search off in **Settings** under *Tools* to stop it.
- **The news can be wrong.** A headline is one newsroom's report. The assistant is told to say who reported it and when, and not to trade on it, but it cannot check it.
- **A local server's address is yours to choose.** If you point Ollama or LM Studio at another machine, your conversations go to that machine.
- **A deposit cannot be taken back.** It is a transaction on a public network. Once your wallet has sent it, neither the app nor the exchange can undo it, so check the network and the amount in your wallet's prompt.
- **The exchange checks the deposit before the signature.** A wallet that has never deposited cannot be verified, so a wrong pasted key shows up only after the first deposit.
- **The liquidation price on a ticket is an estimate.** It ignores fees, funding and margin tiers. The exchange's own figure appears once the position is open.
- **A stop-loss is placed after the entry.** If the exchange refuses it, the position is open without one and the ticket says so. Stops trigger market orders and can fill worse than their trigger.
- If your system has no keychain, keys are kept in memory for the session and the wallet must be connected again next launch.
- `OCTONEO_MAINNET_URL` and `OCTONEO_TESTNET_URL` send a network's requests, signed ones included, to another origin. They exist for tests.
- Installers are not signed with a developer certificate or notarized, because this repository holds no certificates. macOS builds carry an ad-hoc signature only, so macOS and Windows warn before the first launch of a downloaded copy.
