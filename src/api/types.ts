/**
 * The contract between the React UI and the Rust core.
 *
 * Every type here mirrors a `serde` struct in
 * `crates/octogens-core/src/studio/view.rs` (camelCase on the wire), and
 * `crates/octogens-core/tests/contract.rs` fails if the two drift apart.
 * Decimal amounts cross the bridge as strings so no precision is lost; format
 * them for display, never do money math on them.
 */

export type Feed = "sample" | "binance" | "bybit" | "okx";
export type VenueId = Exclude<Feed, "sample">;
export type Side = "buy" | "sell";
export type Timeframe = "15m" | "1h" | "4h" | "1d";
export type Destination = "paper" | "exchange";
export type Provider = "builtin" | "openrouter" | "ollama";
export type Effort = "auto" | "low" | "medium" | "high";
export type Theme = "system" | "light" | "dark";

export interface InstrumentView {
  /** Canonical pair, e.g. `BTC/USDT` or `TSLAX/USDT`. */
  pair: string;
  /** Display ticker, e.g. `BTC` or `TSLAx`. */
  ticker: string;
  name: string;
  kind: "crypto" | "xstock";
  /** Underlying equity for tokenized stocks, e.g. `TSLA`. */
  underlying: string | null;
  /** Added by the user rather than part of the built-in universe. */
  custom: boolean;
}

export interface QuoteView {
  pair: string;
  price: string;
  /** Percent change: 24h on live feeds, versus the previous close on the sample tape. */
  changePct: number | null;
  high24h: string | null;
  low24h: string | null;
  /** 24h volume in base units. */
  volume24h: string | null;
  /** 24h volume in USDT. */
  quoteVolume24h: string | null;
  bid: string | null;
  ask: string | null;
  /** Completed daily closes, oldest first (at most 90). */
  closes: string[];
  /** ISO-8601 UTC timestamp of the price. */
  asOf: string;
  /** Human-readable source, e.g. `Sample tape` or `Binance spot`. */
  source: string;
  /** True when the prices are fictional sample data. */
  sample: boolean;
}

export interface HoldingView {
  pair: string;
  qty: string;
  value: string;
  cost: string;
  pnl: string;
}

export interface FillView {
  id: string;
  pair: string;
  side: Side;
  qty: string;
  price: string;
  status: string;
  /** ISO-8601 UTC. */
  submitted: string;
}

export interface AccountView {
  cash: string;
  equity: string;
  holdings: HoldingView[];
  /** Most recent first. */
  orders: FillView[];
}

export interface McpView {
  name: string;
  version: string;
  transport: "official" | "stdio" | "http";
  tools: number;
}

export interface VenueView {
  id: VenueId;
  name: string;
  /** API credentials are loaded, so balances and live tickets are available. */
  credentials: boolean;
  /** The credentials are stored in the system keychain. */
  remembered: boolean;
  /** An extra MCP server attached to this venue, if any. */
  mcp: McpView | null;
  /** Pinned npm package of the venue's official MCP server, if it publishes one. */
  officialPackage: string | null;
}

export interface AssistantView {
  provider: Provider;
  /** Model id, empty for the built-in agents. */
  model: string;
  /** Short label for the UI, e.g. `OpenRouter · anthropic/claude-…`. */
  label: string;
  /** An OpenRouter key is stored. The key itself never reaches the UI. */
  hasKey: boolean;
  /** The selected model can call tools, so the full agent loop is active. */
  tools: boolean;
  /** The selected model supports configurable reasoning effort. */
  reasoning: boolean;
  effort: Effort;
  /** The assistant may draft live exchange tickets (the user still confirms each one). */
  liveTickets: boolean;
}

export interface StepView {
  /** Tool or stage name, e.g. `get_quote` or `openrouter.chat`. */
  name: string;
  /** Short argument summary, e.g. `BTC/USDT · 4h`. */
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

export interface TicketView {
  /** Client order id; pass it to `submitTicket`. */
  id: string;
  pair: string;
  side: Side;
  /** Quantity in base units. */
  qty: string;
  /** Reference price used for the estimate. */
  price: string;
  /** Estimated value in USDT. */
  value: string;
  feed: Feed;
  destination: Destination;
  /** Why the assistant proposed it; empty for manual tickets. */
  rationale: string;
}

export interface RunView {
  id: string;
  /** Conversation the run belongs to. */
  thread: string;
  /** Who produced it, e.g. `Assistant`, `Order agent`, `Pattern agent`. */
  agent: string;
  /** The user's prompt, or a short title for non-chat runs. */
  title: string;
  feed: Feed;
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
  usage: UsageView | null;
  /** Model id that answered, empty for built-in agents. */
  model: string;
}

export interface WatchView {
  pair: string;
  /** Maximum trade value in USDT. */
  budget: string;
  feed: Feed;
}

/** Everything the UI renders. Most commands return a fresh copy. */
export interface Snapshot {
  version: string;
  feed: Feed;
  /** Pair shown in the market panel. */
  focus: string;
  /** Why the focused quote could not be loaded, or empty. */
  feedError: string;
  /** Watchlist, in display order. */
  instruments: InstrumentView[];
  /** Latest quotes by pair. A watchlist pair may be missing until fetched. */
  quotes: Record<string, QuoteView>;
  /** Paper account of the active feed. */
  account: AccountView;
  venues: VenueView[];
  assistant: AssistantView;
  theme: Theme;
  /** Current conversation id. */
  thread: string;
  /** Run journal, newest first. Filter by `thread` for the open conversation. */
  runs: RunView[];
  /** Ticket awaiting confirmation, if any. */
  draft: TicketView | null;
  /** Outcome text by ticket id for tickets submitted this session. */
  receipts: Record<string, string>;
  /** Active pattern-agent watch, if any. */
  watch: WatchView | null;
  /** Node.js is installed, so official exchange MCP servers can be launched. */
  nodeRuntime: boolean;
  /** An assistant turn is running. */
  busy: boolean;
}

/** `[openTimeMs, open, high, low, close, volume]`, oldest first. */
export type CandleRow = [number, string, string, string, string, string];

export interface CandleSeries {
  pair: string;
  timeframe: Timeframe;
  rows: CandleRow[];
  source: string;
  sample: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Context window in tokens. */
  context: number;
  /** USD per million prompt tokens; null when pricing varies. */
  promptPrice: number | null;
  /** USD per million completion tokens; null when pricing varies. */
  completionPrice: number | null;
  /** Supports tool calling (needed for the full agent loop). */
  tools: boolean;
  reasoning: boolean;
  free: boolean;
  /** Unix seconds the model was listed. */
  created: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  schema: unknown;
  readOnly: boolean;
}

export interface BalanceRow {
  asset: string;
  total: string;
}

export interface TicketRequest {
  pair: string;
  side: Side;
  /** Base units. Provide this or `quoteAmount`. */
  qty?: string;
  /** USDT to spend or receive. Provide this or `qty`. */
  quoteAmount?: string;
  destination: Destination;
}

export interface CredentialsRequest {
  venue: VenueId;
  key: string;
  secret: string;
  /** OKX only. */
  passphrase?: string;
  /** Store in the system keychain instead of this session only. */
  remember: boolean;
}

export type McpConnectRequest =
  | { venue: VenueId; transport: "official"; key?: string; secret?: string; testnet?: boolean; profile?: "market" | "demo" | "live" }
  | { venue: VenueId; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { venue: VenueId; transport: "http"; url: string; token?: string };

export interface AssistantRequest {
  provider: Provider;
  model: string;
  /** New OpenRouter key; omit or leave empty to keep the stored one. */
  key?: string;
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
  | { type: "ticket"; ticket: TicketView }
  | { type: "finished"; run: RunView };

/** The backend the UI talks to. Implemented by the Tauri bridge and by the browser mock. */
export interface Backend {
  boot(): Promise<Snapshot>;
  snapshot(): Promise<Snapshot>;
  setFeed(feed: Feed): Promise<Snapshot>;
  selectPair(pair: string): Promise<Snapshot>;
  refreshQuotes(): Promise<Snapshot>;
  candles(pair: string, timeframe: Timeframe): Promise<CandleSeries>;
  watchAdd(symbol: string): Promise<Snapshot>;
  watchRemove(pair: string): Promise<Snapshot>;
  /** Runs one turn. Rejects only for invalid input; a failed run resolves with `status: "failed"`. */
  ask(prompt: string, onEvent: (event: TurnEvent) => void): Promise<Snapshot>;
  stopTurn(): Promise<void>;
  newThread(): Promise<Snapshot>;
  prepareTicket(request: TicketRequest): Promise<Snapshot>;
  submitTicket(id: string): Promise<Snapshot>;
  dismissTicket(): Promise<Snapshot>;
  runPattern(pair: string, budget: string): Promise<Snapshot>;
  startWatch(pair: string, budget: string): Promise<Snapshot>;
  stopWatch(): Promise<Snapshot>;
  setCredentials(request: CredentialsRequest): Promise<Snapshot>;
  clearCredentials(venue: VenueId): Promise<Snapshot>;
  balances(venue: VenueId): Promise<BalanceRow[]>;
  mcpConnect(request: McpConnectRequest): Promise<Snapshot>;
  mcpDisconnect(venue: VenueId): Promise<Snapshot>;
  mcpTools(venue: VenueId): Promise<ToolInfo[]>;
  mcpCall(venue: VenueId, name: string, args: unknown): Promise<string>;
  listModels(key?: string): Promise<ModelInfo[]>;
  saveAssistant(request: AssistantRequest): Promise<Snapshot>;
  setTheme(theme: Theme): Promise<Snapshot>;
  openExternal(url: string): Promise<void>;
  /** Subscribes to snapshots pushed by background work (pattern watch). Returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}
