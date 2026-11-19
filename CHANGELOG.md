# Changelog

Notable changes to Octo Gens. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.5.0

A new interface built around the conversation, four ways to connect a model, much more market data, and the news. Every message is now answered by a model: the rule-based agents and typed orders are gone.

### Added

- **A chat-first interface.** Conversations in a sidebar, a centred thread, one message box. The market panel, the account and settings are a click away and never in the way.
- **Conversations.** Each chat is kept, listed by date, and can be reopened or deleted. A launch starts a new one.
- **Cards in answers.** What the assistant looked at is shown with its answer: quotes, a technical reading, the order book, market movers, a position plan, your account. A reopened conversation shows what was read at the time.
- **Cloudflare AI Gateway** as a model provider: your account ID, an API token and a model such as `openai/gpt-4.1` or one of Cloudflare's own.
- **LM Studio** as a model provider. The app loads the model with enough context for the assistant.
- **Ollama models can now use tools**, so a model on your computer does everything a cloud model does: research, sizing and drafting tickets.
- **A market screener** of every market the exchange lists, with price, 24h change, volume and funding, sorted and searched as you like.
- **Order book and latest trades** for the market on screen.
- **Funding**: the rate now, what it comes to over a year, two weeks of settled rates, and open interest.
- **Technical readings** on 15m, 1h, 4h and 1d side by side: trend, RSI, MACD, ATR, moving averages, support and resistance.
- **News.** Ask why a market is moving, or for the day's headlines. The assistant reads the latest reports from CoinDesk, Cointelegraph, The Block, Decrypt, The Defiant, crypto.news, Yahoo Finance and the Federal Reserve, says who reported what and how long ago, and shows the headlines with links. For a share, a fund or a commodity the exchange lists, it also reads the news Yahoo Finance files under that ticker. It can read the article behind one, or a page you paste a link to. This works with every model provider, needs no key, and can be turned off in **Settings** under *Tools*.
- **Coin icons** for well-known coins, wherever a market is named. A market whose ticker could mean something else keeps its letters.
- An assistant tool for the biggest gainers, losers and most traded markets across the whole exchange.
- A new OpenRouter key is checked with OpenRouter when you paste it, not at your first question.
- **A new app icon**: a white octopus on blue.

### Changed

- **Every message goes to the model you connected.** Tell it `long 0.01 BTC` and it reads the price and your account, picks a stop-loss if you gave none, and drafts the ticket in the same turn. You still confirm every order.
- A model must be able to call tools to be connected. One that cannot is refused, with the reason.
- The assistant answers more briefly and in plainer words, and explains a term such as funding or liquidation the first time it matters.
- Settings, the wallet and tool servers are in one Settings window. Trading limits apply as you change them, each list of models says what its figures mean, a wallet's card links to deposits and withdrawals, and a local model server that is not running says what to start.
- The app, its documentation and the assistant's instructions say "the exchange" instead of naming it.
- **Markets** lists the most traded markets first.
- The app opens on a new conversation instead of the last one.
- The journal keeps 2,000 runs instead of 300, and a deleted conversation is overwritten on disk.
- Requests to a model on this computer never go through a system proxy.
- Turning off mainnet tickets from the assistant also discards one that is waiting.
- An account in Multi-Assets mode, where only cross margin exists, now gets cross-margin tickets instead of an error when the order is confirmed. Settings shows that the margin choice does not apply.
- The app's mark is no longer drawn inside the window; the icon is for the Dock and the installer.
- While a setting is being applied, for example a local model being loaded, messages and other changes wait for it.

### Removed

- **The built-in agents.** Without a connected model nothing answers; the app asks you to connect one.
- **Typed orders** (`long 0.01 BTC`, `close BTC`) and `@server` commands as a path that bypassed the model. The Trade form, **Close** on a position and **Cancel** on an order work without a model, as before.
- The explain-only mode for models without tool calling.

### Upgrading from 0.4

- Your OpenRouter key and model carry over. If you had chosen *Built-in agents*, connect a model at the first launch.
- An Ollama model chosen in 0.4 stays selected. If it cannot use tools, the first answer says so; pick one that can in Settings.
- Earlier conversations appear in the sidebar.

## 0.4.0

Octo Gens now trades perpetual futures on a decentralised exchange with your own web3 wallet. Binance, Bybit and OKX, the sample tape and the simulated paper account are gone; the testnet is the place to practise.

### Added

- **Perpetual futures**, long and short, on mainnet and on testnet. Market data needs no account.
- **Wallet connection.** Your wallet approves a trade-only API wallet in the browser, or you paste an API wallet key made on the exchange's own site. The approval excludes withdrawal, and your wallet's own key never enters the app.
- **An Account page** with equity, positions, liquidation prices and open orders, read from the exchange. Positions can be closed and orders cancelled from it.
- **Leverage and margin on tickets**, held to risk limits you set: a leverage limit (3x until you raise it) and isolated or cross margin.
- **Stop-loss and take-profit** on a ticket, placed as reduce-only orders after the entry. A stop beyond the estimated liquidation price is refused.
- **Typed orders** `long 0.01 BTC`, `short 0.5 ETH 5x` and `close BTC`.
- Mark price, funding rate and the time to the next funding in the market panel.
- A market search over everything the exchange lists.
- Assistant tools for the account and for sizing leveraged positions, with a liquidation check.
- A ticket the exchange did not confirm keeps the reason, including when the order has to be checked on the exchange.
- A ticket is checked again when you confirm it: against the position, and against the mark price if it opens or adds to one.
- An order whose answer is lost is looked up by its client id before anything is reported.

### Changed

- The assistant must attach a stop-loss to any order that opens or adds to a position, and may draft mainnet tickets only after you allow it. Testnet tickets are always allowed.
- Tool servers are attached under a name of your choice instead of per exchange. The assistant still may call only tools marked read-only.
- The smoke test runs the real window against a stand-in for the exchange and checks that a signed order arrives.

### Removed

- Binance, Bybit and OKX: market data, API keys and orders. Exchange API keys remembered by 0.3 are deleted from the system keychain on the first launch.
- The sample tape and the paper account. Their files (`spot-usdt-*.sqlite3`) are left in the data folder and no longer read; you can delete them.
- The daily pattern agent and its watch.
- Watchlist additions from 0.3, which named spot pairs.

## 0.3.0

Octo Gens was rewritten as a Tauri app: a Rust core with a React interface. Earlier releases were a Python app; paper accounts in your data folder carry over.

### Added

- **A tool-calling assistant.** With an OpenRouter model that supports tools, the assistant plans its own research and drafts tickets. Answers and the steps behind them stream as they happen, and a turn can be stopped.
- **Assistant tools:** quotes, multi-timeframe technical readings, candles, order-book depth, cross-exchange prices, watchlist scan, portfolio, position sizing from a stop, and ticket drafting.
- **Technical readings** computed by the app: EMA 20/50/200, RSI, MACD, ATR, realized volatility, Bollinger bands, range and swing levels.
- **Live market data with no setup.** Pick Binance, Bybit or OKX and prices load; no connection step, no keys.
- **Candlestick chart** with 15m, 1h, 4h and 1d timeframes.
- **A watchlist you can extend** with any token the active exchange lists, and a larger built-in set.
- **Order tickets sized in USDT** as well as in tokens, and checked against the paper account before you confirm.
- **Optional keychain storage** for exchange API keys, which are verified with a balance read when added.
- **Light and dark themes** that follow the system or your choice.
- **Conversations** that keep context across turns and reopen after a restart.
- A fallback to Binance's public market-data host on networks that block the main one.
- Linux builds.

### Changed

- The OpenRouter key is stored in the system keychain. A key left in `preferences.json` by an earlier release is moved there on first launch.
- Live tickets drafted by the assistant are off until you allow them in Settings, and sending any live order requires ticking an acknowledgement.
- Market data and orders use native adapters instead of a bundled helper process.
- The model browser shows tool support, context size and prices, and saving checks the model against the catalog.

### Removed

- The bundled per-exchange MCP helper (`OctoVenue`). Official, custom and remote MCP servers are still supported.
- Unused code from earlier prototypes: the Alpaca broker adapter and the Yahoo Finance and Coinbase feeds.
