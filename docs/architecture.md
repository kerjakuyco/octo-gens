# Architecture

OctoNeo has three layers. Each one knows only about the layer below it.

```
┌──────────────────────────────────────────────────────────────┐
│ src/            Interface (React, TypeScript)                 │
│                 Renders a Snapshot, sends commands.           │
│                 No network access, no secrets.                │
├──────────────────────── Tauri IPC ───────────────────────────┤
│ src-tauri/      Desktop shell (Rust)                          │
│                 Window, system keychain, one command per      │
│                 studio action. No trading logic.              │
├──────────────────────────────────────────────────────────────┤
│ crates/octoneo-core/   Trading core (Rust)                   │
│                 Exchange client, wallet signing, indicators,  │
│                 news, the assistant loop, MCP client.         │
│                 No UI code.                                   │
└──────────────────────────────────────────────────────────────┘
       │               │                  │                │
   The exchange  A model provider    News publishers   MCP tool
   (mainnet,     (OpenRouter,        (public feeds     servers
   testnet)      Cloudflare AI       and articles,
                 Gateway, Ollama,    while web search
                 LM Studio)          is on)
```

## The core

`crates/octoneo-core` is an ordinary Rust library. It can be built, tested and run without Tauri, a web view or Node (`cargo test -p octoneo-core`, or the examples `probe` and `news`).

| Module | Responsibility |
| --- | --- |
| `model`, `instruments` | Domain types for perpetual futures, and the default watchlist. Money is `rust_decimal::Decimal`, never a float. |
| `exchange` | The exchange's futures client: market data (prices, candles, order book, trades, funding, open interest), the account, orders. `exchange::signing` holds the API wallet key and makes the EIP-712 signatures. `exchange::funding` knows the networks funds move on and builds a deposit's transactions and a withdrawal's messages for the trader's own wallet. |
| `connect` | The page served on this computer through which a browser wallet approves the API wallet, deposits and withdraws. |
| `indicators` | Deterministic technical readings, so the model never does arithmetic. |
| `llm` | The model providers. `chat` streams Chat Completions with tool calls for OpenRouter, Cloudflare AI Gateway and LM Studio; `ollama` speaks Ollama's own API. A `Connection` hides which one it is from the agent loop. |
| `assistant` | The system prompt, the tool definitions, and the agent loop. |
| `web` | News and web pages: reads the publishers' feeds and the headlines filed under a share's ticker, matches a search against them on this computer, and reads one page at a time for the assistant. For the News page it lists the newest stories with their pictures and the markets they name, and fetches a story's picture (only one a feed offered, only jpeg, png, webp, gif or avif, at most 4 MB). `web::guard` decides which addresses may be read at all. |
| `mcp` | Model Context Protocol client for tool servers. |
| `store` | Preferences, the run journal, and the `SecretStore` trait. |
| `studio` | The one object that owns the desk's state and offers every action. |

### The studio

`Studio` is the only thing the shell talks to. Every action returns a `Snapshot`: everything the interface renders. That keeps the interface a pure function of the snapshot and makes the core easy to test, because a test calls the same methods the interface does.

State sits behind short locks that are never held across a network call, so the interface stays responsive while the assistant works. Actions that would change the desk under a running turn (switching network, changing wallets or the model, switching conversation) are refused until the turn ends.

There is one `ExchangeClient` per network. Each holds its own wallet, market list and clock offset, so switching network never mixes them.

### An order

Orders follow one path whoever asks for them, the trader's form or the assistant:

1. `Studio::draft_ticket` reads the mark price and the account, checks the order against both and against the risk limits, and keeps the result as the draft. Nothing is sent.
2. The interface shows the ticket. `Studio::submit_ticket` takes the draft, so a second click finds nothing to send.
3. The position is read again, the market is set up, the market order goes out, then its stop-loss and take-profit.
4. The outcome is journaled and kept with the ticket: a receipt, or the reason it was not confirmed.

[exchange.md](exchange.md) lists the checks and the requests.

### A chat turn

Every message goes to the connected model. There is no router in front of it and no rule-based fallback behind it: with no model connected, `Studio::ask` refuses the turn before it starts.

1. The model gets the standing instructions, earlier turns of the open conversation, and the message with a `<desk>` block describing the network, the account and the risk limits right now.
2. `assistant::run` loops: ask the model, run the tools it calls, hand the results back. It ends when the model answers in words, the tool budget is used up, or you press Stop.
3. Steps, text and cards stream to the interface as `TurnEvent`s. A card is something the model looked at (a quote, a technical reading, an order book, headlines, a plan), shown with the answer so the answer does not have to retell it.
4. The finished run goes to the journal, cards included.

The loop has no access to orders. The only tool that touches trading is `propose_order`, which drafts a ticket.

### Conversations

A run that is a chat turn carries the id of its conversation; an order or a cancellation carries none. The journal is the only store: the sidebar's list is a query over it, opening a conversation reads its turns back, and deleting one removes its rows. A launch starts a new conversation and leaves the earlier ones in the list.

### Market data

The market data on a market's page and in the screener is public data read on demand: `market_overview` (every market, in two requests), `candles`, `order_book`, `recent_trades`, `market_funding` (the rate now, two weeks of settled rates, open interest) and `market_technicals` (one reading per timeframe). None of it needs a wallet, and none of it is kept between launches. Some of what a market's page shows is worked out in the interface from that data, for display only: the moving averages and Bollinger bands over the chart, the Bollinger, volatility, relative volume and 20-bar range readings under it, and the split of buying and selling in the latest trades. Every figure the assistant quotes is computed by the core.

## The shell

`src-tauri` is deliberately thin: `lib.rs` maps each command to a `Studio` method, and `keychain.rs` implements `SecretStore` with the system keychain. Turn events travel over a Tauri channel; snapshots from background work (a wallet page finishing in the browser) are emitted as the `snapshot` event. The shell also opens the wallet page in your browser, because the page's address is on this computer and the web view may only open `https` links.

The web view runs under a content security policy that allows no network connections except IPC. Its only capability beyond the app's own commands is opening `https` links in your browser. Story pictures on the News page come from the `newsimg` scheme, which the shell answers with what `Studio::news_picture` fetched.

A news article opens in a second web view, `article.rs`, which the shell adds to the window where the interface leaves room for it. It is a browser view of the publisher's page, kept apart from the app: commands are refused to it (Tauri refuses remote pages, the capability names only the interface's web view, and the invoke handler checks the label of the web view that asked), it may move only to public `https` pages, downloads and new windows are refused, and it is incognito, so the page's cookies and storage go when it closes. Nothing in the interface can be drawn over it, so the interface hides it while a dialog, a menu or the narrow sidebar is open.

## The interface

`src` is a React app with no UI kit and no state library. `src/api/types.ts` is the contract with the core; `src/api/tauri.ts` implements it over IPC and `src/api/mock.ts` implements it in the browser, so the interface can be developed with `pnpm dev` alone.

The contract is enforced. `crates/octoneo-core/tests/contract.rs` serialises real values from the core and fails if their fields differ from the TypeScript declarations, and it fails if the commands the interface calls are not exactly the commands the shell registers.

## Where data lives

| Data | Location | Notes |
| --- | --- | --- |
| Run journal | `journal.sqlite3` in the data folder | Conversations and activity, the last 2,000 runs, with the headlines the assistant was shown (title, publisher, link). A deleted conversation is overwritten, not just unlinked. Output of tool-server tools is never written here |
| News feeds | In memory | Read again after five minutes. Nothing is kept between launches |
| Story pictures | In memory | The last 64, up to 32 MB. Nothing is kept between launches |
| An opened article | In memory | The article view keeps the page's cookies and storage only while it is open |
| Preferences | `preferences.json` | Network, watchlist, risk limits, wallet addresses, the provider and model in use, a Cloudflare account ID, local server addresses. No secrets |
| API wallet keys, OpenRouter key, Cloudflare API token | System keychain | In memory only if no keychain exists |
| Positions, balances, orders | On the exchange | The app reads them; it keeps no copy between launches |

## Testing

| Layer | How it is tested |
| --- | --- |
| Core | Unit tests beside the code. The exchange, all four model providers, the news feeds and MCP are exercised against local mock HTTP servers. The stand-in for the exchange keeps positions and orders, rejects account requests the API wallet did not sign for the right network, and takes a withdrawal only with both of the main wallet's signatures. |
| Contract | `tests/contract.rs`, as above. |
| Interface | Unit tests for the Markdown renderer, formatters, ticket states and the mock backend. |
| Whole app | `pnpm smoke` starts a debug build against a stand-in for the exchange and a stand-in model on this computer. It connects a throwaway wallet and the model, types a message into the real window, lets the model draft a ticket, confirms it, and checks that the signed order and its stop arrived and were journaled. |

Tests never reach the internet. `cargo run -p octoneo-core --example probe` reads live public data from both networks when you want to check the client against the real service, and `cargo run -p octoneo-core --example news` reads the real news feeds and shows which publishers let an app read their pages. `--example funding` checks the deposit vaults against the exchange and simulates each deposit on its chain without sending it, and `--example wallet_page` serves the wallet page against a stand-in for the exchange.
