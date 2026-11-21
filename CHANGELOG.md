# Changelog

Notable changes to OctoNeo. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- **Every market in the order form and on Grid bots.** Both listed only the markets on your watchlist. They now open a searchable list of every market the exchange lists, the watchlist first and then the most traded, each with its price and its move today, and a market off the watchlist is loaded with its own price, funding and levels once picked.

## 0.10.0

Account and Activity, redesigned around your positions and your grid bots.

### Changed

- **Account, redesigned.** Plain names (equity, free margin, exposure, funding over the next eight hours) and calmer cards. A position a grid bot trades says so and links to the bot. Open orders mark a bot's orders and filter by whose they are, and cancelling a bot's order, or every order in its market, asks first: you can cancel only your own, cancel them all, or stop the bot instead. A line under the summary shows your bots at work, and **Ask AI** fills `/portfolio` rather than sending anything.
- **Activity, redesigned.** Two views. **What the app did** is a timeline by day of orders, tickets, deposits and withdrawals and grid bot events, filtered by kind and network, each opening to the steps behind it. **Journal** holds your entries with a plain form, filters, search and how each setup did. A stopped grid bot can be logged in the journal, and **Grid bot** is a setup of its own. **Review with AI** fills `/journal`.

## 0.9.0

Grid bots, on their own page and in the chat, and commands in the message box for trading, research and analysis.

### Added

- **Grid bots.** **Grid bots** in the sidebar sets up a bot that buys low and sells high inside a price range, with limit orders waiting on both sides: Neutral, Long or Short, even steps in price or in percent, up to 50 grids, margin and leverage up to your limit, an optional start price, and stop prices outside the range. A dry run shows each order's size and value, the profit per completed trade and the estimated liquidation price before anything is sent. Your bots show their completed trades and profit and loss, and stop with or without closing their position. A bot places its replacement orders and watches its stop prices while the app is open; its waiting orders stay on the exchange when the app is closed. Only an order the exchange reports as filled counts as a fill, so a bot whose orders were cancelled elsewhere stops instead of trading on.
- **Grid bots in the chat.** Ask the assistant for a grid, or use `/grid`: it reads the market's levels, works the bot out as a dry run and drafts it in the conversation, where you start it or discard it. `/bots` asks how your bots are doing, and **Ask AI** on a market's page can plan one.
- **Commands in the message box.** Type `/`, or press **Commands** under the box, for what the assistant is asked most, in four groups: trade (`/long`, `/short`, `/plan`, `/close`, `/reduce`), research (`/outlook`, `/why`, `/news`, `/movers`, `/watchlist`, `/funding`), analysis (`/technicals`, `/levels`, `/book`, `/compare`) and your account (`/portfolio`, `/journal`). Pick one and set what it takes as chips beside it: the market, the risk, the leverage up to your limit, a take-profit at the next level, the timeframe, or how much of a position to close. Add anything else in your own words; the box shows, word for word, the message the command will send. A command only writes the message, so the assistant answers it as if you had typed it, and a trade still ends in a ticket you confirm. The box says what a command is missing, such as a wallet or web search, with a button to fix it, and shows the network you are on while you set up a trade. `/` anywhere outside a text field opens the commands.
- **Name a market with `$`.** Type `$` and a few letters, or press **Market** under the box, to pick a market from a list with its price and its move today. For `/close` and `/reduce` the list holds only your open positions, with their size and profit or loss.
- **Next steps under an answer.** Suggestions pick up where an answer left off: trade the market it read, or read what it has not yet, such as the news or the order book. A trade suggestion fills the box for you to look over; it is never sent by itself.
- **Your earlier messages.** `↑` in an empty box brings back what you asked earlier in the conversation.

### Changed

- **A livelier conversation.** The commands and the market list open and close smoothly, a new message rises into place, the line that says what the assistant is doing shimmers while it works, and a button takes you back to the latest message when you have scrolled up. With reduced motion turned on in your system, nothing moves.

## 0.8.0

A trading journal on the Activity page, and an Account page that reads like a portfolio. The news no longer includes a publisher whose articles need a subscription, and long chat titles fit the sidebar.

### Added

- **A trading journal.** **Activity** now keeps a journal of your trades. Log one from a position under **Account**, from a fill in the history, or from scratch, with its setup (trend follow, breakout, mean reversion, funding carry, support and resistance, liquidity sweep, or macro and news), entry and exit, size, profit or loss, the reward to risk you planned, a three-point checklist (stop respected, sized within risk, followed the plan), your thesis and the lesson. A summary shows the profit and loss you logged, your win rate, your best setup and how often you kept to your rules. Filter by outcome, setup and network, or search, and ask the assistant to review one entry, with its notes, or your journal's figures: win rate, profit and loss, profit factor, how often you kept to your rules and your best setup. The journal starts empty, and is kept on this computer in the app window's own storage.
- **Account, as a portfolio.** **Account** opens with your equity, free collateral and margin, directional exposure and estimated funding carry, and how much of your margin is in use. Positions filter by side and orders by market, collateral is listed by asset, and a button asks the assistant to review your positions, margin and liquidation risk.
- **Pages for long lists.** Positions, open orders, the journal and the history come a page at a time.

### Removed

- **The Defiant is no longer read.** Its articles ask readers to sign in or pay, so its stories could not be read in the app. The News page and the assistant now read seven publishers.

### Fixed

- A long conversation title in the sidebar ran past its edge. It now ends in an ellipsis, and pointing at it shows the whole title.

## 0.7.0

A News page lays out the newsrooms' stories like a magazine, and a story opens right inside the app. The order form and Settings were redesigned, the app now tells you when a newer version is out, and the icon is black.

### Added

- **A News page.** **News** in the sidebar lays out the newest stories from the eight newsrooms like a magazine: a lead story, the next ones beside it, a grid with each story's picture, then the remaining headlines. Narrow it to your watchlist, to crypto or to the economy, or to one newsroom. Each story says who published it and how long ago, and names the markets it is about; pick one to open its page.
- **Read an article without leaving the app.** A story opens in a browser view inside the window, with a way back to the news, a reload button and **Open in browser**. The view cannot reach the app's commands and keeps no cookies once you close it.
- **Update notices.** OctoNeo checks GitHub for a newer release when it starts. When one is out, a note in the sidebar and **Settings**, **About & Updates** show its release notes and link to the download. You can skip a version.

### Changed

- **The order form, redesigned.** Pick **Buy / Long** or **Sell / Short**, set the size in the coin or in USDT, or pick 10, 25, 50 or 75% of your buying power or Max (25 to 100% of the position, for an order that only reduces it), choose leverage on a slider with presets, and add a take-profit and a stop-loss in one place. A summary shows the notional value, the initial margin and the estimated entry and liquidation prices before you confirm the order.
- **Settings, regrouped.** `Cmd+,` (`Ctrl+,` on Windows and Linux) opens Settings, now in groups: Assistant (Models, Tools), Exchange (Wallets, Risk & Trading) and App (General, About & Updates). General holds the theme, with a preview of each, and the chart's defaults.
- **A new app icon.** The white octopus now sits on near-black, the colour of the website, in place of blue.

### Fixed

- On macOS the window buttons sat low and crowded **New chat**. They now line up with the top bar.

## 0.6.0

Every market now has a page of its own: a larger chart with the overlays you choose, readings on trend, volatility and trading flow, and your position and orders in that market. It takes the place of the market panel beside the conversation, and the sidebar was redesigned.

### Added

- **A page for each market.** Pick a market under **Markets**, in an answer or among your positions under **Account**, and it opens on a page of its own beside the sidebar. **Back** returns to where you were. The market's name at the top switches to another: it lists your watchlist, and as you type it searches every market the exchange lists, with each one's price and 24h change. Above the chart are the price, the mark and index prices and the gap between them, funding with the time to the next payment and its yearly rate, open interest, 24h volume, and where the price sits in its 24h range.
- **Chart overlays.** Buttons above the chart turn on EMA 20 and 50, EMA 200, Bollinger bands, and support and resistance. With a position or open orders in the market, *Orders* draws your entry, your liquidation price, and your stop-loss, take-profit and other open orders as lines. What you turn on, and the chart's timeframe, are remembered between launches.
- **Market structure and flow**, under the chart. How many of the four timeframes are trending up or down (for example *3/4 Uptrend*) and how far each moved over its last five bars; click one to chart it. For the chart's timeframe: how far the price is from EMA 20, 50 and 200, where it sits between the Bollinger bands and how wide they are, ATR, realised volatility over 30 bars, the low and high of the last 20 bars, and relative volume, which compares the last finished bar's volume with the average of the 20 before it.
- **Buying and selling pressure.** *Book* shows whether buyers or sellers drove the last forty trades: the share of their value on each side and the difference, updated every four seconds.
- **Your position and orders on the market's page**, with **Close** and **Cancel** as under **Account**: the position's leverage, margin mode, size, entry, liquidation price and unrealised profit, and each open order. **Cancel all** appears when there are several.
- **Ask AI.** With a model connected, a market's page offers four questions for the assistant: the market's outlook, why it is moving (from the news), and a long or a short planned on 1% risk with a stop-loss at a technical level. The question is asked in the open conversation.
- **Levels to orders.** Under *Technicals*, click a support level and the order form opens on Long with that level as the stop-loss; click a resistance level and it is the take-profit. Clicking a timeframe in the table shows it on the chart.
- **Filter your chats.** The search button beside *Chats* in the sidebar keeps the conversations whose title has every word you type.
- **A shortcut for the sidebar.** `Ctrl+B` (Windows, Linux) or `Cmd+B` (macOS) shows or hides it.

### Changed

- **The sidebar was redesigned.** A conversation is deleted with the bin that appears when you point at it, and you confirm on its row. The wallet, **Settings** and a System, Light and Dark switch are at its foot instead of in a menu; the wallet shows its network, or *Deposit* while the account waits for its first deposit. On macOS there is more room between the window's own buttons and the app's. In a narrow window the sidebar slides in over the page and keeps the keyboard until you close it.

### Removed

- **The market panel beside the conversation**, and the button that showed it. Its chart, figures, tabs and **Trade** button are on each market's page, and the conversation has the room beside the sidebar to itself.

## 0.5.0

The app is now called **OctoNeo**. A new interface built around the conversation, four ways to connect a model, much more market data, the news, and deposits and withdrawals without leaving the app. Every message is now answered by a model: the rule-based agents and typed orders are gone.

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
- **Deposits and withdrawals in the app.** *Deposit* and *Withdraw* are in **Settings** under *Wallet* and on the **Account** page. Your own wallet sends the deposit or signs the withdrawal, on a page the app serves on your computer, so you never visit the exchange's site. A deposit goes to the exchange's vault, which the app checks with the exchange first, and the vault is allowed exactly the amount. A withdrawal is signed twice by your wallet and paid out only to that wallet. Both are recorded under **Activity**. Mainnet funds move on BNB Smart Chain, Ethereum and Arbitrum One; testnet funds on BNB Smart Chain Testnet and Sepolia. MetaMask cannot sign a withdrawal, because the exchange asks for a signature that names its own network; Rabby and similar wallets can.
- **Coin icons** for well-known coins, wherever a market is named. A market whose ticker could mean something else keeps its letters.
- An assistant tool for the biggest gainers, losers and most traded markets across the whole exchange.
- A new OpenRouter key is checked with OpenRouter when you paste it, not at your first question.
- **A new app icon**: a white octopus on blue.
- A read-only check of the deposit transactions against the vaults on every network: `cargo run -p octoneo-core --example funding`.

### Changed

- **Every message goes to the model you connected.** Tell it `long 0.01 BTC` and it reads the price and your account, picks a stop-loss if you gave none, and drafts the ticket in the same turn. You still confirm every order.
- A model must be able to call tools to be connected. One that cannot is refused, with the reason.
- The assistant answers more briefly and in plainer words, and explains a term such as funding or liquidation the first time it matters.
- Settings, the wallet and tool servers are in one Settings window. Trading limits apply as you change them, each list of models says what its figures mean, and a local model server that is not running says what to start.
- **The name.** Octo Gens is now OctoNeo, in the app, the installers, the documentation and the code. The repository is now [kerjakuyco/octo-neo](https://github.com/kerjakuyco/octo-neo); the old address redirects there. The data folder, the keychain entry and the app's identifier keep their names, so an existing install keeps its wallet, settings and conversations. `OCTOGENS_*` environment variables are now `OCTONEO_*`.
- **The wallet page** your browser opens was redesigned: it finds the wallets in your browser and lets you pick one, shows each step and where you are in it, and counts down the seconds the exchange gives a signature.
- The app, its documentation and the assistant's instructions say "the exchange" instead of naming it.
- **Markets** lists the most traded markets first.
- The app opens on a new conversation instead of the last one.
- The journal keeps 2,000 runs instead of 300, and a deleted conversation is overwritten on disk.
- Requests to a model on this computer never go through a system proxy.
- Turning off mainnet tickets from the assistant also discards one that is waiting.
- An account in Multi-Assets mode, where only cross margin exists, now gets cross-margin tickets instead of an error when the order is confirmed. Settings shows that the margin choice does not apply.
- Neither the app's mark nor its name is drawn inside the window; the icon is for the Dock and the installer.
- While a setting is being applied, for example a local model being loaded, messages and other changes wait for it.

### Removed

- **The built-in agents.** Without a connected model nothing answers; the app asks you to connect one.
- **Typed orders** (`long 0.01 BTC`, `close BTC`) and `@server` commands as a path that bypassed the model. The Trade form, **Close** on a position and **Cancel** on an order work without a model, as before.
- The explain-only mode for models without tool calling.

### Upgrading from 0.4

- The app installs as OctoNeo, beside any Octo Gens you have. Quit and remove the old app; the new one picks up its wallet, settings and conversations as they are.
- Your OpenRouter key and model carry over. If you had chosen *Built-in agents*, connect a model at the first launch.
- An Ollama model chosen in 0.4 stays selected. If it cannot use tools, the first answer says so; pick one that can in Settings.
- Earlier conversations appear in the sidebar.

## 0.4.0

OctoNeo now trades perpetual futures on a decentralised exchange with your own web3 wallet. Binance, Bybit and OKX, the sample tape and the simulated paper account are gone; the testnet is the place to practise.

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

OctoNeo was rewritten as a Tauri app: a Rust core with a React interface. Earlier releases were a Python app; paper accounts in your data folder carry over.

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
