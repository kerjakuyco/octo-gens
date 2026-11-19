# Third-party notices

OctoNeo is licensed under [GPL-3.0-only](LICENSE). It includes or depends on third-party software under its own licenses. The complete dependency lists are `Cargo.lock` and `pnpm-lock.yaml`; each package's license is in its own distribution.

## Lightweight Charts

The price chart is drawn with [Lightweight Charts](https://github.com/tradingview/lightweight-charts), copyright TradingView, Inc., licensed under the Apache License 2.0. As that license's notice asks, the app credits TradingView and links to https://www.tradingview.com beside the chart and in Settings.

## Notable dependencies

| Package | Use | License |
| --- | --- | --- |
| [Tauri](https://tauri.app) | Desktop shell | Apache-2.0 OR MIT |
| [React](https://react.dev) | Interface | MIT |
| [rmcp](https://github.com/modelcontextprotocol/rust-sdk) | Model Context Protocol client | Apache-2.0 |
| [reqwest](https://github.com/seanmonstar/reqwest) | HTTP client | MIT OR Apache-2.0 |
| [rusqlite](https://github.com/rusqlite/rusqlite) with bundled SQLite | Run journal | MIT; SQLite is public domain |
| [k256](https://github.com/RustCrypto/elliptic-curves) and [sha3](https://github.com/RustCrypto/hashes) | Signing requests with the API wallet | Apache-2.0 OR MIT |
| [rust_decimal](https://github.com/paupino/rust-decimal) | Exact decimal arithmetic | MIT |
| [keyring](https://github.com/open-source-cooperative/keyring-rs) | System keychain | MIT OR Apache-2.0 |
| [scraper](https://github.com/rust-scraper/scraper) with [html5ever](https://github.com/servo/html5ever) | Reading the text of a web page | ISC; html5ever is MIT OR Apache-2.0, and its selector engine MPL-2.0 |
| [roxmltree](https://github.com/RazrFalcon/roxmltree) | Reading news feeds | MIT OR Apache-2.0 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | Reading pages that are not UTF-8 | (Apache-2.0 OR MIT) AND BSD-3-Clause |

## News

Headlines come from the public RSS feeds of CoinDesk, Cointelegraph, The Block, Decrypt, The Defiant, crypto.news and Yahoo Finance, and from the press releases of the Federal Reserve. They are shown with the publisher's name and a link to the article, and remain the work of their publishers. OctoNeo stores none of their articles.

## Coin icons

The icons of well-known coins in `src/assets/coins/` are from [Web3 Icons](https://github.com/0xa3k5/web3icons) (`@web3icons/core` 4.0.60), under the MIT license. Each coin's logo is a trademark of its project and is shown only to identify that coin.

OpenRouter, Cloudflare, Ollama, LM Studio, MetaMask, Rabby, TradingView, CoinDesk, Cointelegraph, The Block, Decrypt, The Defiant, crypto.news and Yahoo Finance are trademarks of their owners. OctoNeo is an independent project and is not affiliated with or endorsed by any of them.
