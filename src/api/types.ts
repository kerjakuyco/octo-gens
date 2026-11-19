/**
 * The contract between the React UI and the Rust core.
 *
 * Every type here mirrors a `serde` struct in
 * `crates/octogens-core/src/studio/view.rs` (camelCase on the wire), and
 * `crates/octogens-core/tests/contract.rs` fails if the two drift apart.
 * Decimal amounts cross the bridge as strings so no precision is lost; format
 * them for display, never do money math on them. Indicator readings (RSI,
 * moving averages, levels, percentages) are plain numbers.
 *
 * Octo Gens trades perpetual futures on one exchange. `mainnet` is real money;
 * `testnet` is the exchange's practice network with test funds. Every chat message is
 * answered by a language model; there are no rule-based agents.
 */

export type Network = "mainnet" | "testnet";
export type Side = "buy" | "sell";
export type Timeframe = "15m" | "1h" | "4h" | "1d";
/** `none` until a model is connected. */
export type Provider = "none" | "openrouter" | "cloudflare" | "ollama" | "lmstudio";
export type Effort = "auto" | "low" | "medium" | "high";
export type Theme = "system" | "light" | "dark";
export type Trend = "uptrend" | "downtrend" | "mixed" | "unknown";

/** A perpetual market on the watchlist. */
export interface InstrumentView {
  /** Exchange symbol, e.g. `BTCUSDT`. Symbols may contain non-ASCII characters. */
  symbol: string;
  /** Base asset, e.g. `BTC`. */
  base: string;
  /** Quote and margin asset, e.g. `USDT`. */
  quote: string;
  /** Added by the user rather than part of the default watchlist. */
  custom: boolean;
}

export interface QuoteView {
  symbol: string;
  /** Last traded price. */
  price: string;
  /** Mark price, which liquidations and unrealized P/L use. */
  markPrice: string | null;
  indexPrice: string | null;
  /** Current funding rate in percent per funding interval, e.g. `0.01`. Positive means longs pay shorts. */
  fundingRatePct: number | null;
  /** ISO-8601 UTC time of the next funding payment. */
  nextFunding: string | null;
  /** 24h percent change. */
  changePct: number | null;
  high24h: string | null;
  low24h: string | null;
  /** 24h volume in base units. */
  volume24h: string | null;
  /** 24h volume in the quote asset. */
  quoteVolume24h: string | null;
  /** Completed daily closes, oldest first (at most 90). */
  closes: string[];
  /** ISO-8601 UTC timestamp of the price. */
  asOf: string;
  /** Where the price is from: `Mainnet` or `Testnet`. */
  source: string;
}

/** One row of the market screener: every market on the active network has one. */
export interface MarketRow {
  symbol: string;
  base: string;
  quote: string;
  price: string;
  markPrice: string | null;
  /** 24h percent change. */
  changePct: number | null;
  /** 24h volume in the quote asset. */
  quoteVolume24h: string | null;
  /** Percent per funding interval. */
  fundingRatePct: number | null;
  nextFunding: string | null;
}

export interface BookLevel {
  price: string;
  size: string;
  /** Size resting from the best price down to this level, inclusive. */
  total: string;
}

/** The top of the order book, best prices first on both sides. */
export interface OrderBookView {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  mid: string;
  /** Best ask minus best bid, in basis points of the mid. */
  spreadBps: number | null;
  /** Share of the resting size shown that sits on the bid side, 0 to 100. */
  bidSharePct: number | null;
  asOf: string;
}

export interface TradeView {
  /** ISO-8601 UTC. */
  time: string;
  price: string;
  size: string;
  /** The side that took liquidity: `buy` lifted the ask. */
  side: Side;
}

/** `[ISO-8601 UTC time, rate in percent per interval]`, oldest first. */
export type FundingPoint = [string, number];

export interface FundingView {
  symbol: string;
  /** Current rate in percent per interval. */
  ratePct: number | null;
  /** The current rate over a year, in percent, if it stayed the same. */
  annualPct: number | null;
  nextFunding: string | null;
  /** Hours between funding payments. */
  intervalHours: number | null;
  /** Settled rates, oldest first (about the last two weeks). */
  history: FundingPoint[];
  /** Open contracts in base units. */
  openInterest: string | null;
  /** Open interest valued at the mark price, in the quote asset. */
  openInterestValue: string | null;
}

/** A technical reading of one market on one timeframe. */
export interface TechnicalFrame {
  timeframe: Timeframe;
  trend: Trend;
  /** Percent change over the last five bars. */
  changePct: number | null;
  rsi14: number | null;
  /** MACD histogram: above zero is rising momentum. */
  macd: number | null;
  /** Average true range as a percent of price. */
  atrPct: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  /** Nearest swing lows below the price, nearest first. */
  support: number[];
  /** Nearest swing highs above the price, nearest first. */
  resistance: number[];
}

export interface TechnicalsView {
  symbol: string;
  price: string;
  /** One frame per timeframe, shortest first. */
  frames: TechnicalFrame[];
  asOf: string;
}

/** Position sizing worked out by the assistant's planning tool. */
export interface PlanView {
  symbol: string;
  direction: "long" | "short";
  entry: string;
  stop: string;
  target: string | null;
  qty: string;
  leverage: number;
  /** Position value in the quote asset. */
  notional: string;
  margin: string;
  /** Loss if the stop is hit, in the quote asset. */
  lossAtStop: string;
  /** That loss as a percent of account equity. */
  riskPct: number | null;
  /** Estimated liquidation price. */
  liquidation: string | null;
  /** The stop triggers before the estimated liquidation price. */
  stopSafe: boolean;
  rewardToRisk: number | null;
}

/** A headline the assistant was shown. */
export interface NewsView {
  title: string;
  /** The publisher, e.g. `CoinDesk`. */
  source: string;
  /** An `https` link to the article. Open it with `openExternal`. */
  url: string;
  /** ISO-8601 UTC time it was published, when the publisher said. */
  published: string | null;
}

/**
 * Something the assistant looked at, shown with its answer.
 * `account` carries no data: render the live `Snapshot.account`.
 * `news` has an empty `query` when the assistant asked for the newest headlines.
 */
export type CardView =
  | { kind: "quotes"; quotes: QuoteView[] }
  | { kind: "technicals"; symbol: string; frame: TechnicalFrame }
  | { kind: "book"; book: OrderBookView }
  | { kind: "movers"; rows: MarketRow[] }
  | { kind: "plan"; plan: PlanView }
  | { kind: "news"; query: string; articles: NewsView[] }
  | { kind: "account" };

/** The trading wallet for one network. The app never holds the main wallet's key. */
export interface WalletView {
  network: Network;
  connected: boolean;
  /** Main wallet address, when connected. */
  user: string | null;
  /** Address of the trade-only API wallet the app signs with. Its key stays in the system keychain. */
  agent: string | null;
  /** ISO-8601 UTC time the API wallet's approval ends, when known. */
  expires: string | null;
  /** The exchange refuses account calls until the main wallet has made a first deposit. */
  needsDeposit: boolean;
}

export interface BalanceView {
  asset: string;
  balance: string;
  available: string;
}

export interface PositionView {
  symbol: string;
  side: "long" | "short";
  /** Position size in base units, always positive. */
  qty: string;
  entryPrice: string;
  markPrice: string;
  /** Null when the venue reports none (for example a fully collateralised position). */
  liquidationPrice: string | null;
  leverage: number;
  isolated: boolean;
  /** Position value in the quote asset, always positive. */
  notional: string;
  /** Margin held by the position. */
  margin: string;
  unrealizedPnl: string;
  /** Unrealized P/L as a percent of margin. */
  roePct: number | null;
}

export interface OpenOrderView {
  /** Venue order id; pass it to `cancelOrder`. */
  id: string;
  clientId: string;
  symbol: string;
  side: Side;
  /** Venue order type, e.g. `LIMIT`, `STOP_MARKET`, `TAKE_PROFIT_MARKET`. */
  type: string;
  price: string | null;
  /** Trigger price of a stop or take-profit order. */
  stopPrice: string | null;
  qty: string;
  filled: string;
  reduceOnly: boolean;
  status: string;
  /** ISO-8601 UTC. */
  time: string;
}

/** The futures account of the connected wallet on the active network. */
export interface AccountView {
  /** Margin balance: wallet balance plus unrealized P/L. */
  equity: string;
  walletBalance: string;
  /** Free to open new positions. */
  available: string;
  unrealizedPnl: string;
  /** Initial margin in use by positions and open orders. */
  marginUsed: string;
  balances: BalanceView[];
  positions: PositionView[];
  orders: OpenOrderView[];
  /**
   * The exchange's Multi-Assets mode is on for this account: every asset backs every position, and a new
   * position can only use cross margin. Tickets then use cross whatever `RiskView.isolated` says.
   */
  multiAssets: boolean;
  /** ISO-8601 UTC time this was read from the exchange. */
  asOf: string;
}

/** Limits applied to every ticket, whoever drafts it. */
export interface RiskView {
  /** Highest leverage a ticket may use. */
  maxLeverage: number;
  /** New positions use isolated margin (true) or cross margin (false). */
  isolated: boolean;
}

export interface McpView {
  /** Name the user gave the server; pass it to the `mcp*` calls. */
  id: string;
  name: string;
  version: string;
  transport: "stdio" | "http";
  tools: number;
}

/** What is stored for one model provider. Secrets never reach the UI. */
export interface ProviderView {
  /** Never `none`. */
  id: Provider;
  /** `OpenRouter`, `Cloudflare AI Gateway`, `Ollama`, `LM Studio`. */
  name: string;
  /** Runs on this computer: no key, nothing leaves the machine. */
  local: boolean;
  /** A key or token is stored. Always false for local providers. */
  hasKey: boolean;
  /** Model last used with this provider, or empty. */
  model: string;
  /** Short display name of that model, or empty. */
  label: string;
  /** Cloudflare account id, or empty. */
  account: string;
  /** Cloudflare gateway id; `default` unless changed. */
  gateway: string;
  /** Address of the local server, e.g. `http://127.0.0.1:11434`. Empty for cloud providers. */
  url: string;
}

export interface AssistantView {
  provider: Provider;
  /** Model id, empty until one is connected. */
  model: string;
  /** Short display name of the model, or empty. */
  label: string;
  /** A model is connected and the assistant can answer. */
  ready: boolean;
  /** The selected model supports configurable reasoning effort. */
  reasoning: boolean;
  effort: Effort;
  /** The assistant may draft mainnet tickets (the user still confirms each one). Testnet tickets are always allowed. */
  liveTickets: boolean;
  /** The assistant may search the news and read web pages. On unless the user turned it off. */
  webSearch: boolean;
  /** One entry per provider, in display order. */
  providers: ProviderView[];
}

export interface StepView {
  /** Tool or stage name, e.g. `get_quote` or `model`. */
  name: string;
  /** Short argument summary, e.g. `BTCUSDT 4h`. */
  detail: string;
  status: "running" | "ok" | "error";
  ms: number;
  /** Truncated result or error text for the trace. */
  preview: string;
}

export interface UsageView {
  promptTokens: number;
  completionTokens: number;
  /** Cost in USD as reported by the provider, when available. */
  cost: number | null;
}

/** A market order waiting for the trader to confirm. Nothing is sent until `submitTicket`. */
export interface TicketView {
  /** Client order id; pass it to `submitTicket`. */
  id: string;
  network: Network;
  symbol: string;
  side: Side;
  /** Quantity in base units. */
  qty: string;
  /** Reference price used for the estimates. */
  price: string;
  /** Estimated order value in the quote asset. */
  notional: string;
  /** Leverage the position will use. */
  leverage: number;
  /** Estimated margin the order needs; `0` for reduce-only orders. */
  margin: string;
  /** The order can only shrink an existing position. */
  reduceOnly: boolean;
  /** Stop-loss trigger price placed with the order, if any. */
  stopLoss: string | null;
  /** Take-profit trigger price placed with the order, if any. */
  takeProfit: string | null;
  /** Rough liquidation price of the resulting position. An estimate, not the venue's figure. */
  estLiquidation: string | null;
  /** What the order does to the account in plain words, e.g. `Opens a 0.01 BTC long at 3x`. */
  effect: string;
  /** Why the assistant proposed it; empty for manual tickets. */
  rationale: string;
}

/** One unit of work: a chat turn, or something the app did on the exchange (an order, a cancellation). */
export interface RunView {
  id: string;
  /** Conversation the run belongs to; empty for runs that are not chat turns. */
  thread: string;
  /** Who produced it: `Assistant` for chat turns, `Execution` for orders and cancellations. */
  agent: string;
  /** The user's prompt, or a short title for non-chat runs. */
  title: string;
  network: Network;
  /** ISO-8601 UTC start time. */
  time: string;
  status: "running" | "complete" | "failed" | "stopped";
  steps: StepView[];
  /** Markdown answer, or the error text when the run failed. */
  output: string;
  /** Model reasoning summary, when the model exposes one. */
  reasoning: string;
  ms: number;
  /** Ticket drafted by this run, if any. */
  ticket: TicketView | null;
  /** What the assistant looked at, in the order it looked. */
  cards: CardView[];
  usage: UsageView | null;
  /** Model id that answered, empty for non-chat runs. */
  model: string;
}

/** A conversation in the sidebar. */
export interface ThreadView {
  id: string;
  /** The first message, shortened. */
  title: string;
  /** ISO-8601 UTC time of the latest turn. */
  time: string;
  /** Network the conversation started on. */
  network: Network;
  /** Number of turns. */
  turns: number;
}

/** A browser approval that is waiting for the user's wallet. */
export interface PendingConnectView {
  network: Network;
  /** Local page to open in the browser where the wallet extension lives. */
  url: string;
}

/** Everything the UI renders. Most commands return a fresh copy. */
export interface Snapshot {
  version: string;
  network: Network;
  /** Symbol shown in the market panel. */
  focus: string;
  /** Why market data could not be loaded, or empty. */
  feedError: string;
  /** Watchlist, in display order. */
  instruments: InstrumentView[];
  /** Latest quotes by symbol. A watchlist symbol may be missing until fetched. */
  quotes: Record<string, QuoteView>;
  /** One entry per network, mainnet first. */
  wallets: WalletView[];
  /** Account of the active network's wallet; null when no wallet is connected or it has not loaded. */
  account: AccountView | null;
  /** Why the account could not be read, or empty. */
  accountError: string;
  /** Why the last wallet approval ended without a wallet, or empty. Cleared when another one starts. */
  connectError: string;
  assistant: AssistantView;
  risk: RiskView;
  theme: Theme;
  /** Open conversation id. */
  thread: string;
  /** Conversations, latest first. */
  threads: ThreadView[];
  /** The open conversation's turns, oldest first. */
  turns: RunView[];
  /** What the app did on the exchange outside chat turns (orders, cancellations), newest first. */
  activity: RunView[];
  /** Ticket awaiting confirmation, if any. */
  draft: TicketView | null;
  /** Outcome text by ticket id for tickets submitted this session. */
  receipts: Record<string, string>;
  /**
   * Why a confirmed ticket was not carried out, by ticket id. The text may say the
   * order has to be checked on the exchange, so it stays with the ticket.
   */
  failures: Record<string, string>;
  /** Attached MCP tool servers. */
  servers: McpView[];
  /** A wallet approval in progress, if any. */
  pendingConnect: PendingConnectView | null;
  /** An assistant turn is running. */
  busy: boolean;
}

/** `[openTimeMs, open, high, low, close, volume]`, oldest first. */
export type CandleRow = [number, string, string, string, string, string];

export interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  rows: CandleRow[];
  source: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Context window in tokens; 0 when unknown. */
  context: number;
  /** USD per million prompt tokens; null when unknown or free to run locally. */
  promptPrice: number | null;
  /** USD per million completion tokens; null when unknown. */
  completionPrice: number | null;
  /** Can call tools. The assistant only works with models that can. */
  tools: boolean;
  reasoning: boolean;
  free: boolean;
  /** Unix seconds the model was listed; 0 when unknown. */
  created: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  schema: unknown;
  readOnly: boolean;
}

export interface TicketRequest {
  symbol: string;
  side: Side;
  /** Base units. Provide this or `notional`. */
  qty?: string;
  /** Order value in the quote asset. Provide this or `qty`. */
  notional?: string;
  /** Defaults to the smaller of the risk limit and 3. Ignored for reduce-only orders. */
  leverage?: number;
  reduceOnly?: boolean;
  stopLoss?: string;
  takeProfit?: string;
}

/** Connect with an API wallet created on the exchange's own API wallet page. */
export interface WalletKeyRequest {
  network: Network;
  /** Main wallet address. */
  user: string;
  /** Private key of the API wallet. Sent once to the core, which stores it in the system keychain. */
  agentKey: string;
}

/** Connect by approving a fresh API wallet from a browser wallet. */
export interface WalletBrowserRequest {
  network: Network;
  /** How long the approval lasts, in days (1 to 365). */
  days: number;
}

export interface RiskRequest {
  /** 1 to 50. */
  maxLeverage: number;
  isolated: boolean;
}

export type McpConnectRequest =
  | { id: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { id: string; transport: "http"; url: string; token?: string };

/**
 * Where to look for models. Anything left out falls back to what is stored
 * for that provider, so the picker can list models without asking again.
 */
export interface ModelsRequest {
  /** Never `none`. */
  provider: Provider;
  /** OpenRouter key or Cloudflare API token. */
  key?: string;
  /** Cloudflare account id. */
  account?: string;
  /** Cloudflare gateway id. */
  gateway?: string;
  /** Address of the local server. */
  url?: string;
}

/**
 * Connects a model. The core checks it can answer and call tools before saving.
 * Naming the model already in use, with no new key, account, gateway or address,
 * only saves `effort` and `liveTickets`: nothing is checked again and no network is needed.
 */
export interface AssistantRequest {
  /** Never `none`. */
  provider: Provider;
  model: string;
  /** New OpenRouter key or Cloudflare API token; omit or leave empty to keep the stored one. */
  key?: string;
  /** Cloudflare account id; omit to keep the stored one. */
  account?: string;
  /** Cloudflare gateway id; omit to keep the stored one (`default` at first). */
  gateway?: string;
  /** Address of the local server; omit to keep the stored one. */
  url?: string;
  effort: Effort;
  liveTickets: boolean;
}

/** Streamed while `ask` runs. */
export type TurnEvent =
  | { type: "started"; run: RunView }
  /** Answer text for the current model round. */
  | { type: "text"; delta: string }
  /** A new model round began; discard interim text shown so far. */
  | { type: "round" }
  | { type: "reasoning"; delta: string }
  /** A step was added (`index === steps.length`) or updated in place. */
  | { type: "step"; index: number; step: StepView }
  /** Something the assistant looked at; append it to the run's cards. */
  | { type: "card"; card: CardView }
  | { type: "ticket"; ticket: TicketView }
  | { type: "finished"; run: RunView };

/** The backend the UI talks to. Implemented by the Tauri bridge and by the browser mock. */
export interface Backend {
  /** Loads markets and watchlist quotes for the last used network. */
  boot(): Promise<Snapshot>;
  snapshot(): Promise<Snapshot>;
  /** Switches between mainnet and testnet: market data, wallet and account all follow. */
  setNetwork(network: Network): Promise<Snapshot>;
  selectSymbol(symbol: string): Promise<Snapshot>;
  /** Refreshes watchlist quotes. */
  refreshQuotes(): Promise<Snapshot>;
  /** Re-reads balances, positions and open orders of the connected wallet. */
  refreshAccount(): Promise<Snapshot>;
  candles(symbol: string, timeframe: Timeframe): Promise<CandleSeries>;
  /** Every market on the active network, in the exchange's order. Sort and filter it in the UI. */
  marketOverview(): Promise<MarketRow[]>;
  /** Twenty levels a side. */
  orderBook(symbol: string): Promise<OrderBookView>;
  /** The latest trades, newest first. */
  recentTrades(symbol: string): Promise<TradeView[]>;
  marketFunding(symbol: string): Promise<FundingView>;
  marketTechnicals(symbol: string): Promise<TechnicalsView>;
  watchAdd(symbol: string): Promise<Snapshot>;
  watchRemove(symbol: string): Promise<Snapshot>;
  /** Runs one turn. Rejects only for invalid input or when no model is connected; a failed run resolves with `status: "failed"`. */
  ask(prompt: string, onEvent: (event: TurnEvent) => void): Promise<Snapshot>;
  stopTurn(): Promise<void>;
  newThread(): Promise<Snapshot>;
  /** Opens an earlier conversation. */
  openThread(id: string): Promise<Snapshot>;
  /** Deletes a conversation and its turns. */
  deleteThread(id: string): Promise<Snapshot>;
  prepareTicket(request: TicketRequest): Promise<Snapshot>;
  submitTicket(id: string): Promise<Snapshot>;
  dismissTicket(): Promise<Snapshot>;
  /** Drafts a reduce-only ticket that closes the whole position in `symbol`. */
  closePosition(symbol: string): Promise<Snapshot>;
  cancelOrder(symbol: string, orderId: string): Promise<Snapshot>;
  cancelAllOrders(symbol: string): Promise<Snapshot>;
  connectWalletKey(request: WalletKeyRequest): Promise<Snapshot>;
  /** Starts a browser approval. The snapshot's `pendingConnect.url` is opened in the browser by the core; the result arrives through `onSnapshot`. */
  connectWalletBrowser(request: WalletBrowserRequest): Promise<Snapshot>;
  cancelWalletConnect(): Promise<Snapshot>;
  /** Forgets the API wallet key on this computer. */
  disconnectWallet(network: Network): Promise<Snapshot>;
  saveRisk(request: RiskRequest): Promise<Snapshot>;
  mcpConnect(request: McpConnectRequest): Promise<Snapshot>;
  mcpDisconnect(id: string): Promise<Snapshot>;
  mcpTools(id: string): Promise<ToolInfo[]>;
  mcpCall(id: string, name: string, args: unknown): Promise<string>;
  /**
   * Models a provider offers. For Ollama and LM Studio these are the models installed on this
   * computer, and the call fails fast when the server is not running. Cloudflare lists its own
   * Workers AI models; other models are typed in by id (`openai/gpt-4.1`).
   */
  listModels(request: ModelsRequest): Promise<ModelInfo[]>;
  saveAssistant(request: AssistantRequest): Promise<Snapshot>;
  /** Forgets a provider's key and model. If it was the one in use, no model is connected afterwards. */
  forgetProvider(provider: Provider): Promise<Snapshot>;
  setTheme(theme: Theme): Promise<Snapshot>;
  /** Lets the assistant search the news and read web pages, or stops it. Works with no model connected. */
  setWebSearch(on: boolean): Promise<Snapshot>;
  openExternal(url: string): Promise<void>;
  /** Subscribes to snapshots pushed by background work (wallet approval, launch). Returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}
