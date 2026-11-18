# Changelog

Notable changes to Octo Gens. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

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
