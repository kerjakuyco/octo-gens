/**
 * An in-browser stand-in for the Rust core.
 *
 * It lets `pnpm dev` run in a plain browser, drives screenshots, and backs the
 * unit tests. Markets, prices, wallets, fills, models and answers are generated
 * here and are entirely fictional. Nothing in this file talks to a network.
 *
 * URL parameters (browser only) force a starting state:
 *   seed=empty|conversation|filled|unconfirmed|expired|live|liveticket
 *                                                    the open conversation
 *   network=mainnet|testnet                          active network (testnet unless seed=liveticket)
 *   wallet=connected|deposit|none|error              wallet of the active network
 *   positions=1|0                                    open positions and resting orders
 *   ticket=long|short|close                          the ticket a seeded conversation drafts
 *   pending=1                                        a browser wallet approval is waiting
 *   provider=none|openrouter|cloudflare|ollama|lmstudio
 *                                                    the model in use (a connected OpenRouter model by default)
 *   local=up|down|retry                              whether Ollama and LM Studio answer (retry: not the first time)
 *   history=1|0                                      earlier conversations in the sidebar
 *   markets=595                                      pad the mainnet market list, to try the screener at size
 *   theme=system|light|dark                          colour theme
 *   mcp=1                                            a tool server is attached
 *   speed=0.25                                       multiplier for scripted delays
 */

import { ago } from "../lib/format";
import { ema } from "../lib/indicators";
import { networkName } from "../lib/network";
import type {
  AccountView,
  AssistantRequest,
  AssistantView,
  Backend,
  BookLevel,
  CandleRow,
  CandleSeries,
  CardView,
  Effort,
  FundingPoint,
  FundingView,
  InstrumentView,
  MarketRow,
  McpConnectRequest,
  McpView,
  ModelInfo,
  ModelsRequest,
  Network,
  OpenOrderView,
  OrderBookView,
  PendingConnectView,
  PlanView,
  PositionView,
  Provider,
  ProviderView,
  QuoteView,
  RiskRequest,
  RiskView,
  RunView,
  Side,
  Snapshot,
  NewsView,
  StepView,
  TechnicalFrame,
  TechnicalsView,
  Theme,
  ThreadView,
  TicketRequest,
  TicketView,
  Timeframe,
  ToolInfo,
  TradeView,
  Trend,
  TurnEvent,
  WalletBrowserRequest,
  WalletKeyRequest,
  WalletView,
} from "./types";

export type MockSeed = "empty" | "conversation" | "filled" | "unconfirmed" | "expired" | "live" | "liveticket";
export type MockWallet = "connected" | "deposit" | "none" | "error";
export type MockTicket = "long" | "short" | "close";
export type MockLocal = "up" | "down" | "retry";

export interface MockOptions {
  seed?: MockSeed;
  network?: Network;
  /** State of the active network's wallet. */
  wallet?: MockWallet;
  /** Start with open positions and resting orders. On for every seed except `empty`. */
  positions?: boolean;
  /** Which ticket a seeded conversation drafts. */
  ticket?: MockTicket;
  /** Start with a browser approval waiting, and never resolve approvals by themselves. */
  pending?: boolean;
  /** The account is in the exchange's Multi-Assets mode, which allows only cross margin. */
  multi?: boolean;
  /** The model in use. `none` starts with no model connected at all. */
  provider?: Provider;
  /** Whether the local model servers answer. `retry` fails the first listing of each. */
  local?: MockLocal;
  /** Earlier conversations in the sidebar. On unless turned off. */
  history?: boolean;
  /** Pad the mainnet market list with generated markets up to this many. */
  markets?: number;
  theme?: Theme;
  /** Start with a tool server attached. */
  mcp?: boolean;
  /** Whether the assistant may read the news. On unless turned off. */
  web?: boolean;
  /** Multiplier for scripted delays. `0` makes every turn finish immediately. */
  speed?: number;
  /** Pause the next streamed answer half-way until `stopTurn` is called. */
  hold?: boolean;
}

/* ------------------------------------------------------------- generators */

const NETWORKS: Network[] = ["mainnet", "testnet"];
const TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d"];
const SOURCES: Record<Network, string> = { mainnet: "Mainnet", testnet: "Testnet" };
const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};
const TIMEFRAME_SWING: Record<Timeframe, number> = { "15m": 0.0022, "1h": 0.0045, "4h": 0.009, "1d": 0.02 };
/** Candles per series. Enough for a 200-bar average to exist. */
const BARS = 240;
const FUNDING_HOURS = 8;
const FUNDING_MS = FUNDING_HOURS * 3_600_000;
/** Maintenance margin rate used for the rough liquidation estimate. */
const MAINTENANCE = 0.005;
const MIN_NOTIONAL = 5;
const EPSILON = 1e-9;
const BOOK_LEVELS = 20;
const DEFAULT_WATCH = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "XLM", "SUI", "LINK", "AVAX", "ADA", "HYPE"];
const ACCOUNT_ERROR = "The exchange did not answer in time. Check the connection, then refresh.";

/** Fictional addresses, shaped like real ones. */
const MAIN_WALLET = "0x51c0A6f2B9e84D73a1F5c2E86b0d94A7f3E21b8C";
const API_WALLETS: Record<Network, string> = {
  mainnet: "0x9F3c27D1e5Ab4068C2d7F1a39B6e508D4c1A72e6",
  testnet: "0x2bE84a1C07d35F96e0A4b8D2c6F173a95E0d4C1f",
};

interface Market {
  symbol: string;
  base: string;
  quote: string;
  anchor: number;
  /** Also listed on the practice network. */
  testnet: boolean;
}

const MARKET_ROWS: [base: string, anchor: number, testnet: boolean, quote?: string][] = [
  ["BTC", 62786.4, true],
  ["ETH", 1770.14, true],
  ["SOL", 96.42, true],
  ["BNB", 584.3, false],
  ["XRP", 1.9312, true],
  ["DOGE", 0.12843, true],
  ["XLM", 0.2846, true],
  ["SUI", 1.872, true],
  ["LINK", 11.943, true],
  ["AVAX", 17.362, true],
  ["ADA", 0.5213, true],
  ["HYPE", 31.284, false],
  ["ARB", 0.31274, true],
  ["1000PEPE", 0.0074123, true],
  ["1000SHIB", 0.011286, false],
  ["TON", 2.7461, true],
  ["TRX", 0.24183, true],
  ["LTC", 71.63, true],
  ["BCH", 402.8, true],
  ["DOT", 3.2142, true],
  ["NEAR", 2.1874, true],
  ["APT", 4.3261, true],
  ["OP", 0.61842, true],
  ["INJ", 9.872, false],
  ["TIA", 1.7643, false],
  ["SEI", 0.18731, false],
  ["ATOM", 3.9421, false],
  ["FIL", 2.4183, false],
  ["UNI", 6.271, false],
  ["AAVE", 172.44, false],
  ["ENA", 0.29362, false],
  ["WLD", 0.71284, false],
  ["TAO", 268.7, false],
  ["ONDO", 0.68431, false],
  ["JUP", 0.37124, false],
  ["PENGU", 0.011934, false],
  ["币安人生", 0.14263, false],
  ["XAU", 3284.6, false, "USD1"],
  ["NVDA", 141.82, false, "USD1"],
  ["TSLA", 318.45, false, "USD1"],
];

const MARKETS: Market[] = MARKET_ROWS.map(([base, anchor, testnet, quote = "USDT"]) => ({
  symbol: `${base}${quote}`,
  base,
  quote,
  anchor,
  testnet,
}));

function hash(text: string): number {
  let value = 2166136261;
  for (let at = 0; at < text.length; at += 1) {
    value ^= text.charCodeAt(at);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** A small seeded generator (mulberry32) so every reload shows the same tape. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random walk of `length` levels that ends exactly at `end`. */
function walk(seed: string, length: number, swing: number, end: number): number[] {
  const next = random(hash(seed));
  const levels = [1];
  for (let step = 1; step < length; step += 1) {
    const drift = 0.18 * swing * Math.sin(step / 9);
    levels.push(levels[step - 1]! * (1 + (next() - 0.49) * 2 * swing + drift));
  }
  const scale = end / levels[length - 1]!;
  return levels.map((level) => level * scale);
}

/** Generated markets that pad the list, so the screener can be tried at the size of the real one. */
function padMarkets(count: number): Market[] {
  const extra: Market[] = [];
  for (let serial = 1; MARKETS.length + extra.length < count; serial += 1) {
    const base = `ALT${String(serial).padStart(3, "0")}`;
    const anchor = Number((10 ** ((hash(base) % 500) / 100 - 2)).toPrecision(5));
    extra.push({ symbol: `${base}USDT`, base, quote: "USDT", anchor, testnet: false });
  }
  return [...MARKETS, ...extra];
}

/** Price decimals for a level, close to the tick sizes the exchange uses. */
function decimals(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 50) return 2;
  if (abs >= 5) return 3;
  if (abs >= 0.5) return 4;
  if (abs >= 0.05) return 5;
  if (abs >= 0.005) return 6;
  return 7;
}

function amount(value: number): string {
  return value.toFixed(decimals(value));
}

/** Decimals of the smallest order step for a market. */
function stepDecimals(market: Market): number {
  if (market.anchor >= 1000) return 3;
  if (market.anchor >= 100) return 2;
  if (market.anchor >= 10) return 1;
  return 0;
}

function trimUnits(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "");
}

function pretty(value: number): string {
  const digits = decimals(value);
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function cash(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function shorten(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
}

function id(): string {
  const next = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return next() + next() + next() + next();
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rough liquidation level of an isolated position; null when it cannot be liquidated. */
function liquidation(entry: number, leverage: number, long: boolean): number | null {
  if (long && leverage <= 1) return null;
  const level = long ? entry * (1 - 1 / leverage + MAINTENANCE) : entry * (1 + 1 / leverage - MAINTENANCE);
  return level > 0 && Number.isFinite(level) ? level : null;
}

const DECIMAL = /^(?:\d{1,12}(?:\.\d{1,8})?|\.\d{1,8})$/;

/** Parses an optional positive decimal; null when the field is empty. */
function positive(raw: string | undefined, what: string): number | null {
  const text = raw?.trim() ?? "";
  if (!text) return null;
  if (!DECIMAL.test(text) || !(Number(text) > 0)) throw new Error(`Enter ${what} as a positive number.`);
  return Number(text);
}

/* -------------------------------------------------------------- indicators */

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function lastOf(values: (number | null)[]): number | null {
  return values[values.length - 1] ?? null;
}

/** Wilder's relative strength index of the latest bar. */
function rsiOf(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** MACD histogram (12, 26, 9) of the latest bar. */
function macdOf(closes: number[]): number | null {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const line: number[] = [];
  for (let index = 0; index < closes.length; index += 1) {
    const quick = fast[index];
    const steady = slow[index];
    if (quick !== null && quick !== undefined && steady !== null && steady !== undefined) line.push(quick - steady);
  }
  const signal = lastOf(ema(line, 9));
  const latest = line[line.length - 1];
  return signal === null || latest === undefined ? null : latest - signal;
}

/** Average true range (Wilder) of the latest bar, in price units. */
function atrOf(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null;
  const ranges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const before = bars[index - 1]!.close;
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - before), Math.abs(bar.low - before)));
  }
  let level = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (let index = period; index < ranges.length; index += 1) level = (level * (period - 1) + ranges[index]!) / period;
  return level;
}

/** Swing lows under the price and swing highs over it, nearest first, with near-duplicates merged. */
function swingLevels(bars: Bar[], price: number): { support: number[]; resistance: number[] } {
  const span = 4;
  const lows: number[] = [];
  const highs: number[] = [];
  for (let index = span; index < bars.length - span; index += 1) {
    const bar = bars[index]!;
    const around = bars.slice(index - span, index + span + 1);
    if (around.every((other) => other.low >= bar.low)) lows.push(bar.low);
    if (around.every((other) => other.high <= bar.high)) highs.push(bar.high);
  }
  const nearest = (levels: number[]): number[] => {
    const kept: number[] = [];
    for (const level of levels) {
      const previous = kept[kept.length - 1];
      if (previous === undefined || Math.abs(level / previous - 1) > 0.004) kept.push(level);
      if (kept.length === 3) break;
    }
    return kept;
  };
  return {
    support: nearest(lows.filter((level) => level < price * 0.999).sort((left, right) => right - left)),
    resistance: nearest(highs.filter((level) => level > price * 1.001).sort((left, right) => left - right)),
  };
}

/* ------------------------------------------------------------------ models */

type ModelRow = [
  id: string,
  name: string,
  context: number,
  promptPrice: number | null,
  completionPrice: number | null,
  tools: boolean,
  reasoning: boolean,
  created: number,
];

function models(rows: ModelRow[]): ModelInfo[] {
  return rows.map(([modelId, name, context, promptPrice, completionPrice, tools, reasoning, created]) => ({
    id: modelId,
    name,
    context,
    promptPrice,
    completionPrice,
    tools,
    reasoning,
    free: promptPrice === 0,
    created,
  }));
}

/** Fictional models, so nobody mistakes the mock list for a real catalog. Only the router keeps its real id. */
const OPENROUTER_MODELS = models([
  ["lantern/lantern-2-large", "Lantern 2 Large", 1_000_000, 3, 15, true, true, 1794000000],
  ["lantern/lantern-2-mini", "Lantern 2 Mini", 400_000, 0.25, 1.25, true, true, 1793200000],
  ["kelpworks/kelp-4", "Kelp 4", 1_048_576, 2, 10, true, true, 1792600000],
  ["kelpworks/kelp-4-flash", "Kelp 4 Flash", 1_048_576, 0.1, 0.4, true, false, 1792500000],
  ["kelpworks/kelp-4-flash:free", "Kelp 4 Flash (free)", 262_144, 0, 0, true, false, 1792400000],
  ["abyssal/trench-xl", "Trench XL", 1_000_000, 8, 40, true, true, 1791900000],
  ["abyssal/trench-s", "Trench S", 200_000, 1, 5, true, false, 1791800000],
  ["brine/brine-r1", "Brine R1", 163_840, 0.55, 2.19, true, true, 1790000000],
  ["tidepool/reef-70b", "Reef 70B", 131_072, 0.4, 0.8, true, false, 1788000000],
  ["tidepool/reef-8b:free", "Reef 8B (free)", 32_768, 0, 0, false, false, 1787000000],
  ["moray/eel-chat-13b", "Eel Chat 13B", 16_384, 0.06, 0.06, false, false, 1780000000],
  ["openrouter/auto", "Auto Router", 2_000_000, null, null, true, false, 1775000000],
]);

/** What Cloudflare lists itself (Workers AI). Models of other providers are typed in by id. */
const WORKERS_AI_MODELS = models([
  ["@cf/tidepool/reef-70b-instruct", "Reef 70B Instruct", 131_072, 0.29, 2.25, true, false, 1788000000],
  ["@cf/kelpworks/kelp-4-flash", "Kelp 4 Flash", 262_144, 0.1, 0.4, true, false, 1792500000],
  ["@cf/brine/brine-r1-distill-32b", "Brine R1 Distill 32B", 80_000, 0.5, 4.88, true, true, 1790000000],
  ["@cf/moray/eel-chat-13b", "Eel Chat 13B", 16_384, 0.06, 0.06, false, false, 1780000000],
]);

/** Models installed on this computer: free to run, context only where the server reports it. */
const LOCAL_MODELS: Record<"ollama" | "lmstudio", ModelInfo[]> = {
  ollama: models([
    ["reef:8b", "reef:8b", 32_768, null, null, true, false, 0],
    ["kelp-coder:14b", "kelp-coder:14b", 65_536, null, null, true, false, 0],
    ["brine-r1:8b", "brine-r1:8b", 32_768, null, null, true, true, 0],
    ["eel-chat:7b", "eel-chat:7b", 8_192, null, null, false, false, 0],
  ]),
  lmstudio: models([
    ["tidepool/reef-8b-instruct", "Reef 8B Instruct", 32_768, null, null, true, false, 0],
    ["kelpworks/kelp-coder-14b", "Kelp Coder 14B", 65_536, null, null, true, false, 0],
    ["moray/eel-chat-7b", "Eel Chat 7B", 8_192, null, null, false, false, 0],
  ]),
};

type RealProvider = Exclude<Provider, "none">;

const PROVIDERS: { id: RealProvider; name: string; local: boolean; url: string }[] = [
  { id: "openrouter", name: "OpenRouter", local: false, url: "" },
  { id: "cloudflare", name: "Cloudflare AI Gateway", local: false, url: "" },
  { id: "ollama", name: "Ollama", local: true, url: "http://127.0.0.1:11434" },
  { id: "lmstudio", name: "LM Studio", local: true, url: "http://127.0.0.1:1234" },
];

/** A fictional Cloudflare account id: 32 hexadecimal characters. */
const CLOUDFLARE_ACCOUNT = "4f8c21d07a9e4b36b5d2c8e1907fa364";

const DOWN: Record<"ollama" | "lmstudio", string> = {
  ollama: "Ollama is not running. Start it, then try again.",
  lmstudio: "LM Studio is not running. Start its local server, then try again.",
};

/** What the core keeps for one provider. The key itself is never part of it. */
interface Stored {
  hasKey: boolean;
  model: string;
  account: string;
  gateway: string;
  url: string;
}

const MCP_TOOLS: ToolInfo[] = [
  {
    name: "search_headlines",
    description: "Recent headlines that mention a token.",
    schema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["query"],
    },
    readOnly: true,
  },
  {
    name: "get_open_interest",
    description: "Open interest history for one perpetual market.",
    schema: {
      type: "object",
      properties: { symbol: { type: "string" }, interval: { type: "string", enum: ["1h", "4h", "1d"] } },
      required: ["symbol"],
    },
    readOnly: true,
  },
  {
    name: "get_unlock_schedule",
    description: "Upcoming token unlocks for one asset.",
    schema: { type: "object", properties: { asset: { type: "string" } }, required: ["asset"] },
    readOnly: true,
  },
  {
    name: "read_note",
    description: "One entry from the trading journal.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    readOnly: true,
  },
  {
    name: "save_note",
    description: "Write an entry to the trading journal. Not marked read-only, so the assistant cannot call it.",
    schema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title", "body"],
    },
    readOnly: false,
  },
];

/* -------------------------------------------------------------- the mock */

/** A one-way position: positive quantity is long, negative is short. */
interface Holding {
  qty: number;
  entry: number;
  leverage: number;
  isolated: boolean;
}

interface Resting {
  id: string;
  clientId: string;
  symbol: string;
  side: Side;
  type: string;
  price: number | null;
  stopPrice: number | null;
  qty: number;
  reduceOnly: boolean;
  time: string;
}

/** What the exchange holds for one wallet: collateral, positions and resting orders. */
interface Book {
  balance: number;
  positions: Map<string, Holding>;
  orders: Resting[];
}

interface Wallet {
  connected: boolean;
  user: string | null;
  agent: string | null;
  expires: string | null;
  needsDeposit: boolean;
  /** Account reads fail, to show the error state. */
  failing: boolean;
}

interface Watched {
  market: Market;
  custom: boolean;
}

/** A conversation and its turns, oldest first. */
interface Thread {
  id: string;
  title: string;
  network: Network;
  runs: RunView[];
}

/** How a turn talks to whoever started it: the interface, or the seeding code. */
interface Driver {
  emit(event: TurnEvent): void;
  /** Waits. Rejects with `Stopped` once the trader stops the turn. */
  pause(ms: number): Promise<void>;
  /** When the turn started, in Unix milliseconds. */
  at: number;
  /** A turn somebody is watching: text streams and steps take time. */
  live: boolean;
}

interface Sizing {
  riskPct: number;
  leverage?: number;
  /** Stop distance as a fraction of the entry, instead of the nearest swing level. */
  stopDistance?: number;
}

class Stopped extends Error {}

function noWallet(): Wallet {
  return { connected: false, user: null, agent: null, expires: null, needsDeposit: false, failing: false };
}

function walletIn(mode: MockWallet, network: Network): Wallet {
  if (mode === "none") return noWallet();
  return {
    connected: true,
    user: MAIN_WALLET,
    agent: API_WALLETS[network],
    expires: daysFromNow(90),
    needsDeposit: mode === "deposit",
    failing: mode === "error",
  };
}

function cloneRun(run: RunView): RunView {
  return { ...run, steps: run.steps.map((step) => ({ ...step })), cards: [...run.cards] };
}

export function createMockBackend(options: MockOptions = {}): Backend {
  const speed = options.speed ?? 1;
  const seed = options.seed ?? "empty";
  let hold = options.hold ?? seed === "live";

  let network: Network = options.network ?? (seed === "liveticket" ? "mainnet" : "testnet");
  let tick = 0;
  let theme: Theme = options.theme ?? "system";
  let open = id().slice(0, 12);
  let threads: Thread[] = [];
  const activity: RunView[] = [];
  let draft: TicketView | null = null;
  let busy = false;
  let stopRequested = false;
  let wake: (() => void) | null = null;
  let pendingConnect: PendingConnectView | null = null;
  let risk: RiskView = { maxLeverage: 10, isolated: true };
  /** Multi-Assets mode on the account: a new position is cross-margined whatever the trader prefers. */
  const crossOnly = options.multi === true;
  const isolatedNow = () => risk.isolated && !crossOnly;
  let orderSeq = 48_213_770;
  const receipts: Record<string, string> = {};
  const failures: Record<string, string> = {};
  const servers = new Map<string, McpView>();
  const listeners = new Set<(snapshot: Snapshot) => void>();

  const universe = padMarkets(options.markets ?? 0);
  const marketsOf = (target: Network): Market[] =>
    target === "mainnet" ? universe : universe.filter((spec) => spec.testnet);

  function findMarket(raw: string, target: Network): Market | undefined {
    const text = raw.trim().replace(/^\$/, "").replace(/[/-]/g, "").toUpperCase();
    if (!text) return undefined;
    const listed = marketsOf(target);
    return (
      listed.find((spec) => spec.symbol.toUpperCase() === text) ??
      listed.find((spec) => spec.base.toUpperCase() === text) ??
      listed.find((spec) => spec.base.toUpperCase() === `1000${text}`)
    );
  }

  const watchlists = {} as Record<Network, Watched[]>;
  const focus: Record<Network, string> = { mainnet: "BTCUSDT", testnet: "BTCUSDT" };
  for (const target of NETWORKS) {
    watchlists[target] = marketsOf(target)
      .filter((spec) => DEFAULT_WATCH.includes(spec.base))
      .map((spec) => ({ market: spec, custom: false }));
  }

  const activeWallet: MockWallet =
    options.wallet ?? (options.pending ? "none" : network === "testnet" || seed === "liveticket" ? "connected" : "none");
  const wallets: Record<Network, Wallet> = {
    mainnet: walletIn(network === "mainnet" ? activeWallet : "none", "mainnet"),
    testnet: walletIn(network === "testnet" ? activeWallet : "connected", "testnet"),
  };
  const books: Record<Network, Book> = {
    mainnet: { balance: 2480.12, positions: new Map(), orders: [] },
    testnet: { balance: 10_000, positions: new Map(), orders: [] },
  };

  /* ---------------------------------------------------------------- models */

  const stored = {} as Record<RealProvider, Stored>;
  for (const provider of PROVIDERS) {
    stored[provider.id] = { hasKey: false, model: "", account: "", gateway: "default", url: provider.url };
  }
  let active: Provider = options.provider ?? "openrouter";
  let effort: Effort = "auto";
  let liveTickets = seed === "liveticket";
  let webSearch = options.web !== false;
  const localDown = options.local === "down";
  const firstTry = new Set<RealProvider>(options.local === "retry" ? ["ollama", "lmstudio"] : []);

  switch (active) {
    case "openrouter":
      stored.openrouter = { ...stored.openrouter, hasKey: true, model: "lantern/lantern-2-large" };
      // A second connected provider, so switching between models has something to switch to.
      stored.ollama = { ...stored.ollama, model: "reef:8b" };
      break;
    case "cloudflare":
      stored.cloudflare = {
        ...stored.cloudflare,
        hasKey: true,
        model: "lantern/lantern-2-mini",
        account: CLOUDFLARE_ACCOUNT,
      };
      break;
    case "ollama":
      stored.ollama = { ...stored.ollama, model: "reef:8b" };
      break;
    case "lmstudio":
      stored.lmstudio = { ...stored.lmstudio, model: "tidepool/reef-8b-instruct" };
      break;
    case "none":
      break;
  }

  function catalog(provider: RealProvider): ModelInfo[] {
    if (provider === "openrouter") return OPENROUTER_MODELS;
    if (provider === "cloudflare") return WORKERS_AI_MODELS;
    return LOCAL_MODELS[provider];
  }

  function modelInfo(provider: Provider, model: string): ModelInfo | undefined {
    if (provider === "none") return undefined;
    // A Cloudflare gateway also fronts models of other providers, typed in by id.
    const known = provider === "cloudflare" ? [...WORKERS_AI_MODELS, ...OPENROUTER_MODELS] : catalog(provider);
    return known.find((candidate) => candidate.id === model);
  }

  function assistantView(): AssistantView {
    const model = active === "none" ? "" : stored[active].model;
    const info = modelInfo(active, model);
    const reasoning = Boolean(info?.reasoning);
    const named = (provider: RealProvider): string => {
      const kept = stored[provider].model;
      return kept ? (modelInfo(provider, kept)?.name ?? kept.slice(kept.lastIndexOf("/") + 1)) : "";
    };
    const providers: ProviderView[] = PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      local: provider.local,
      ...stored[provider.id],
      label: named(provider.id),
      url: provider.local ? stored[provider.id].url : "",
    }));
    return {
      provider: active,
      model,
      label: info?.name ?? model.slice(model.lastIndexOf("/") + 1),
      ready: active !== "none" && model !== "",
      reasoning,
      effort: reasoning ? effort : "auto",
      liveTickets,
      webSearch,
      providers,
    };
  }

  /** Whether a local server answers this time. */
  function localUp(provider: "ollama" | "lmstudio"): void {
    if (localDown || firstTry.delete(provider)) throw new Error(DOWN[provider]);
  }

  function localUrl(provider: RealProvider, raw: string | undefined): string {
    const fallback = PROVIDERS.find((entry) => entry.id === provider)!.url;
    const text = raw?.trim();
    if (text === undefined) return stored[provider].url || fallback;
    if (!/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(text)) {
      throw new Error(`Enter the server's address, for example ${fallback}.`);
    }
    return text.replace(/\/$/, "");
  }

  function cloudflareAccount(raw: string | undefined): string {
    const account = raw?.trim() || stored.cloudflare.account;
    if (!/^[0-9a-f]{32}$/i.test(account)) {
      throw new Error("Enter the Cloudflare account ID: 32 letters and digits, shown on the account's overview page.");
    }
    return account;
  }

  function cloudflareToken(raw: string | undefined): void {
    const token = raw?.trim() ?? "";
    if (!token && !stored.cloudflare.hasKey) {
      throw new Error("Paste a Cloudflare API token with the Workers AI Read permission.");
    }
    if (token && !/^[\w-]{20,}$/.test(token)) {
      throw new Error("Cloudflare rejected the token. It needs the Workers AI Read permission.");
    }
  }

  function openrouterKey(raw: string | undefined): void {
    const key = raw?.trim() ?? "";
    if (key ? !/^sk-or-[\w-]{8,}$/.test(key) : !stored.openrouter.hasKey) {
      throw new Error("Paste an OpenRouter key that starts with sk-or-.");
    }
  }

  function listModels(request: ModelsRequest): ModelInfo[] {
    switch (request.provider) {
      case "openrouter":
        openrouterKey(request.key);
        break;
      case "cloudflare":
        cloudflareAccount(request.account);
        cloudflareToken(request.key);
        break;
      case "ollama":
      case "lmstudio":
        localUrl(request.provider, request.url);
        localUp(request.provider);
        break;
      default:
        throw new Error("Choose a provider first.");
    }
    return catalog(request.provider).map((model) => ({ ...model }));
  }

  function saveAssistant(request: AssistantRequest): void {
    const model = request.model.trim();
    switch (request.provider) {
      case "openrouter": {
        openrouterKey(request.key);
        const info = modelInfo("openrouter", model);
        if (!info) throw new Error("Choose a model from the OpenRouter catalog in Settings.");
        if (!info.tools) throw new Error(`${info.name} cannot use tools. Pick a model that can.`);
        stored.openrouter = { ...stored.openrouter, hasKey: true, model };
        break;
      }
      case "cloudflare": {
        const account = cloudflareAccount(request.account);
        cloudflareToken(request.key);
        const gateway = request.gateway?.trim() || stored.cloudflare.gateway || "default";
        if (!/^[\w-]{1,64}$/.test(gateway)) throw new Error("A gateway ID uses letters, digits, dashes and underscores.");
        if (!/^[\w.@-]+\/[\w.@:/-]+$/.test(model)) {
          throw new Error("Enter the model as provider/model, for example openai/gpt-4.1.");
        }
        const info = modelInfo("cloudflare", model);
        if (info && !info.tools) throw new Error(`${info.name} cannot use tools. Pick a model that can.`);
        stored.cloudflare = { hasKey: true, model, account, gateway, url: "" };
        break;
      }
      case "ollama":
      case "lmstudio": {
        const url = localUrl(request.provider, request.url);
        localUp(request.provider);
        const info = modelInfo(request.provider, model);
        if (!info) {
          throw new Error(
            request.provider === "ollama"
              ? `Ollama did not report ${model || "that model"} as installed. Run \`ollama pull ${model || "<model>"}\` first.`
              : `LM Studio has no model named ${model || "that"}.`,
          );
        }
        if (!info.tools) throw new Error(`${info.name} cannot use tools. Pick a model that can.`);
        stored[request.provider] = { ...stored[request.provider], model, url };
        break;
      }
      default:
        throw new Error("Choose a provider first.");
    }
    active = request.provider;
    effort = request.effort;
    liveTickets = Boolean(request.liveTickets);
  }

  if (options.mcp) {
    servers.set("notes", { id: "notes", name: "desk-notes", version: "1.4.2", transport: "stdio", tools: MCP_TOOLS.length });
  }

  /* ---------------------------------------------------------- market data */

  function market(raw: string): Market {
    const found = findMarket(raw, network);
    if (found) return found;
    const other: Network = network === "mainnet" ? "testnet" : "mainnet";
    const elsewhere = findMarket(raw, other);
    if (elsewhere) {
      throw new Error(
        `${elsewhere.base} is not listed on ${network}. Switch to ${networkName(other)} to see it.`,
      );
    }
    throw new Error(`There is no perpetual market for ${raw.trim() || "that"}. Search the market list for the exact symbol.`);
  }

  /** Where a market trades before the latest tick moves it. The practice network sits a little off mainnet. */
  function level(spec: Market): number {
    return spec.anchor * (network === "testnet" ? 1.0035 : 1);
  }

  function last(spec: Market): number {
    const wobble = (random(hash(`${network}:${spec.symbol}:${tick}`))() - 0.5) * 0.004;
    return level(spec) * (1 + wobble);
  }

  function mark(spec: Market): number {
    return last(spec) * (1 + ((hash(`mark:${spec.symbol}`) % 41) - 20) / 100_000);
  }

  /** Funding in percent per eight hours, to four decimals. */
  function funding(spec: Market): number {
    return ((hash(`funding:${spec.symbol}`) % 250) - 60) / 10_000;
  }

  function nextFunding(): number {
    return (Math.floor(Date.now() / FUNDING_MS) + 1) * FUNDING_MS;
  }

  /** Closes of one series, oldest first: history is fixed, and the newest one follows the live price. */
  function closesOf(spec: Market, timeframe: Timeframe): number[] {
    const closes = walk(`${network}:${spec.symbol}:${timeframe}`, BARS + 1, TIMEFRAME_SWING[timeframe], level(spec));
    closes[BARS] = last(spec);
    return closes;
  }

  function barsOf(spec: Market, timeframe: Timeframe): Bar[] {
    const swing = TIMEFRAME_SWING[timeframe];
    const closes = closesOf(spec, timeframe);
    const next = random(hash(`ohlc:${spec.symbol}:${timeframe}`));
    const span = TIMEFRAME_MS[timeframe];
    const end = Math.floor(Date.now() / span) * span;
    const baseVolume = 60_000_000 / spec.anchor / (86_400_000 / span);
    const bars: Bar[] = [];
    for (let index = 1; index <= BARS; index += 1) {
      const open = closes[index - 1]!;
      const close = closes[index]!;
      bars.push({
        time: end - (BARS - index) * span,
        open,
        high: Math.max(open, close) * (1 + next() * swing * 0.7),
        low: Math.min(open, close) * (1 - next() * swing * 0.7),
        close,
        volume: baseVolume * (0.4 + next() * 1.6),
      });
    }
    return bars;
  }

  function candleRows(spec: Market, timeframe: Timeframe): CandleRow[] {
    return barsOf(spec, timeframe).map((bar) => [
      bar.time,
      amount(bar.open),
      amount(bar.high),
      amount(bar.low),
      amount(bar.close),
      bar.volume.toFixed(4),
    ]);
  }

  function quote(spec: Market): QuoteView {
    const price = last(spec);
    const closes = closesOf(spec, "1d").slice(-91, -1);
    const previous = closes[closes.length - 1]!;
    const volume = (900_000_000 / spec.anchor) * (0.4 + (hash(spec.symbol) % 100) / 60);
    return {
      symbol: spec.symbol,
      price: amount(price),
      markPrice: amount(mark(spec)),
      indexPrice: amount(price * 0.9998),
      fundingRatePct: funding(spec),
      nextFunding: new Date(nextFunding()).toISOString(),
      changePct: Number(((price / previous - 1) * 100).toFixed(2)),
      high24h: amount(Math.max(price, previous) * 1.011),
      low24h: amount(Math.min(price, previous) * 0.989),
      volume24h: volume.toFixed(2),
      quoteVolume24h: (volume * price).toFixed(2),
      closes: closes.map(amount),
      asOf: new Date().toISOString(),
      source: SOURCES[network],
    };
  }

  function marketRow(spec: Market): MarketRow {
    const view = quote(spec);
    return {
      symbol: spec.symbol,
      base: spec.base,
      quote: spec.quote,
      price: view.price,
      markPrice: view.markPrice,
      changePct: view.changePct,
      quoteVolume24h: view.quoteVolume24h,
      fundingRatePct: view.fundingRatePct,
      nextFunding: view.nextFunding,
    };
  }

  /** Twenty levels a side. Sizes move a little every few seconds, the way a live book does. */
  function bookView(spec: Market): OrderBookView {
    const mid = last(spec);
    const places = decimals(mid);
    const unit = 10 ** -places;
    const next = random(hash(`book:${network}:${spec.symbol}:${tick}:${Math.floor(Date.now() / 4000)}`));
    const half = Math.max(1, Math.round((mid * 0.00004) / unit));
    const typical = 40_000 / mid;
    const sizePlaces = Math.max(stepDecimals(spec), mid >= 1000 ? 3 : mid >= 10 ? 2 : 0);
    // Each market leans one way, so the bid share is not always a coin toss.
    const lean = 0.8 + (hash(`lean:${spec.symbol}`) % 45) / 100;

    const side = (direction: 1 | -1, weight: number): BookLevel[] => {
      const levels: BookLevel[] = [];
      let offset = half;
      let total = 0;
      for (let index = 0; index < BOOK_LEVELS; index += 1) {
        const size = Number((typical * weight * (0.25 + next() * 1.6) * (1 + index * 0.07)).toFixed(sizePlaces)) || 10 ** -sizePlaces;
        total += size;
        levels.push({
          price: (mid + direction * offset * unit).toFixed(places),
          size: trimUnits(size),
          total: trimUnits(total),
        });
        offset += 1 + Math.floor(next() * 3);
      }
      return levels;
    };

    const bids = side(-1, lean);
    const asks = side(1, 1);
    const bidTotal = Number(bids[bids.length - 1]!.total);
    const askTotal = Number(asks[asks.length - 1]!.total);
    const bestBid = Number(bids[0]!.price);
    const bestAsk = Number(asks[0]!.price);
    return {
      symbol: spec.symbol,
      bids,
      asks,
      mid: ((bestBid + bestAsk) / 2).toFixed(places),
      spreadBps: Number((((bestAsk - bestBid) / mid) * 10_000).toFixed(2)),
      bidSharePct: Number(((bidTotal / (bidTotal + askTotal)) * 100).toFixed(1)),
      asOf: new Date().toISOString(),
    };
  }

  function tradesView(spec: Market): TradeView[] {
    const mid = last(spec);
    const places = decimals(mid);
    const next = random(hash(`tape:${network}:${spec.symbol}:${tick}:${Math.floor(Date.now() / 4000)}`));
    const typical = 40_000 / mid;
    const sizePlaces = Math.max(stepDecimals(spec), mid >= 1000 ? 3 : mid >= 10 ? 2 : 0);
    const trades: TradeView[] = [];
    let at = Date.now();
    for (let index = 0; index < 30; index += 1) {
      at -= 300 + Math.floor(next() * 2600);
      const size = Number((typical * (0.02 + next() * 0.5)).toFixed(sizePlaces)) || 10 ** -sizePlaces;
      trades.push({
        time: new Date(at).toISOString(),
        price: (mid * (1 + (next() - 0.5) * 0.0006)).toFixed(places),
        size: trimUnits(size),
        side: next() > 0.48 ? "buy" : "sell",
      });
    }
    return trades;
  }

  function fundingView(spec: Market): FundingView {
    const rate = funding(spec);
    const next = random(hash(`funding-history:${network}:${spec.symbol}`));
    const upcoming = nextFunding();
    const history: FundingPoint[] = [];
    for (let index = 42; index >= 1; index -= 1) {
      const settled = rate + (next() - 0.5) * 0.014 + 0.004 * Math.sin(index / 5);
      history.push([new Date(upcoming - index * FUNDING_MS).toISOString(), Number(settled.toFixed(4))]);
    }
    const view = quote(spec);
    const interest = (Number(view.volume24h) * (0.18 + (hash(`oi:${spec.symbol}`) % 40) / 100)) / 3;
    return {
      symbol: spec.symbol,
      ratePct: rate,
      annualPct: Number((rate * (24 / FUNDING_HOURS) * 365).toFixed(2)),
      nextFunding: new Date(upcoming).toISOString(),
      intervalHours: FUNDING_HOURS,
      history,
      openInterest: interest.toFixed(stepDecimals(spec)),
      openInterestValue: (interest * mark(spec)).toFixed(2),
    };
  }

  function frame(spec: Market, timeframe: Timeframe): TechnicalFrame {
    const bars = barsOf(spec, timeframe);
    const closes = bars.map((bar) => bar.close);
    const price = closes[closes.length - 1]!;
    const ema20 = lastOf(ema(closes, 20));
    const ema50 = lastOf(ema(closes, 50));
    const ema200 = lastOf(ema(closes, 200));
    const atr = atrOf(bars);
    const fiveAgo = closes[closes.length - 6];
    let trend: Trend = "unknown";
    if (ema20 !== null && ema50 !== null) {
      if (price > ema20 && ema20 > ema50) trend = "uptrend";
      else if (price < ema20 && ema20 < ema50) trend = "downtrend";
      else trend = "mixed";
    }
    const rsi = rsiOf(closes);
    const macd = macdOf(closes);
    const round = (value: number | null): number | null => (value === null ? null : Number(amount(value)));
    const levels = swingLevels(bars.slice(-120), price);
    return {
      timeframe,
      trend,
      changePct: fiveAgo === undefined ? null : Number(((price / fiveAgo - 1) * 100).toFixed(2)),
      rsi14: rsi === null ? null : Number(rsi.toFixed(1)),
      macd: macd === null ? null : Number(macd.toPrecision(4)),
      atrPct: atr === null ? null : Number(((atr / price) * 100).toFixed(2)),
      ema20: round(ema20),
      ema50: round(ema50),
      ema200: round(ema200),
      support: levels.support.map((value) => Number(amount(value))),
      resistance: levels.resistance.map((value) => Number(amount(value))),
    };
  }

  function technicalsView(spec: Market): TechnicalsView {
    return {
      symbol: spec.symbol,
      price: amount(last(spec)),
      frames: TIMEFRAMES.map((timeframe) => frame(spec, timeframe)),
      asOf: new Date().toISOString(),
    };
  }

  /* -------------------------------------------------------------- account */

  const usable = (wallet: Wallet): boolean => wallet.connected && !wallet.needsDeposit && !wallet.failing;

  function requireWallet(): void {
    const wallet = wallets[network];
    if (!wallet.connected) {
      throw new Error(`Connect a wallet on ${networkName(network)} to trade. Open Settings to approve one.`);
    }
    if (wallet.needsDeposit) {
      throw new Error(
        "Trading and account data start after this wallet's first deposit. Make a deposit, then try again.",
      );
    }
    if (wallet.failing) throw new Error(ACCOUNT_ERROR);
  }

  function positionView(symbol: string, held: Holding): PositionView {
    const spec = market(symbol);
    const at = mark(spec);
    const size = Math.abs(held.qty);
    const notional = size * at;
    const margin = held.isolated ? (size * held.entry) / held.leverage : notional / held.leverage;
    const pnl = held.qty * (at - held.entry);
    const liquidated = liquidation(held.entry, held.leverage, held.qty > 0);
    return {
      symbol,
      side: held.qty > 0 ? "long" : "short",
      qty: trimUnits(size),
      entryPrice: amount(held.entry),
      markPrice: amount(at),
      liquidationPrice: liquidated === null ? null : amount(liquidated),
      leverage: held.leverage,
      isolated: held.isolated,
      notional: notional.toFixed(2),
      margin: margin.toFixed(2),
      unrealizedPnl: pnl.toFixed(2),
      roePct: margin > 0 ? Number(((pnl / margin) * 100).toFixed(2)) : null,
    };
  }

  function orderView(order: Resting): OpenOrderView {
    return {
      id: order.id,
      clientId: order.clientId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price === null ? null : amount(order.price),
      stopPrice: order.stopPrice === null ? null : amount(order.stopPrice),
      qty: trimUnits(order.qty),
      filled: "0",
      reduceOnly: order.reduceOnly,
      status: "NEW",
      time: order.time,
    };
  }

  /** The active network's account, as numbers and as the view the UI gets. */
  function figures(): { equity: number; available: number; view: AccountView } {
    const book = books[network];
    const positions = [...book.positions.entries()].map(([symbol, held]) => positionView(symbol, held));
    let pnl = 0;
    let used = 0;
    for (const position of positions) {
      pnl += Number(position.unrealizedPnl);
      used += Number(position.margin);
    }
    for (const order of book.orders) {
      if (order.reduceOnly || order.price === null) continue;
      used += (order.qty * order.price) / (book.positions.get(order.symbol)?.leverage ?? Math.min(risk.maxLeverage, 3));
    }
    const equity = book.balance + pnl;
    const available = Math.max(0, equity - used);
    return {
      equity,
      available,
      view: {
        equity: equity.toFixed(2),
        walletBalance: book.balance.toFixed(2),
        available: available.toFixed(2),
        unrealizedPnl: pnl.toFixed(2),
        marginUsed: used.toFixed(2),
        balances: [{ asset: "USDT", balance: book.balance.toFixed(2), available: available.toFixed(2) }],
        positions,
        orders: book.orders.map(orderView),
        multiAssets: crossOnly,
        asOf: new Date().toISOString(),
      },
    };
  }

  /** Applies a market fill to a one-way position. */
  function fill(book: Book, spec: Market, side: Side, qty: number, at: number, leverage: number): void {
    const direction = side === "buy" ? 1 : -1;
    const held = book.positions.get(spec.symbol);
    if (!held || Math.sign(held.qty) === direction) {
      const before = held ? Math.abs(held.qty) : 0;
      book.positions.set(spec.symbol, {
        qty: direction * (before + qty),
        entry: held ? (before * held.entry + qty * at) / (before + qty) : at,
        leverage,
        isolated: held?.isolated ?? isolatedNow(),
      });
      return;
    }
    const size = Math.abs(held.qty);
    const closing = Math.min(qty, size);
    book.balance += closing * (at - held.entry) * Math.sign(held.qty);
    if (size - closing > EPSILON) {
      book.positions.set(spec.symbol, { ...held, qty: Math.sign(held.qty) * (size - closing) });
      return;
    }
    // The position is gone, and the exchange drops the reduce-only orders that protected it.
    book.positions.delete(spec.symbol);
    book.orders = book.orders.filter((order) => !(order.symbol === spec.symbol && order.reduceOnly));
    if (qty - closing > EPSILON) {
      book.positions.set(spec.symbol, { qty: direction * (qty - closing), entry: at, leverage, isolated: isolatedNow() });
    }
  }

  function rest(book: Book, order: Omit<Resting, "id" | "time"> & { time?: string }): void {
    orderSeq += 7;
    book.orders.push({ ...order, id: String(orderSeq), time: order.time ?? new Date().toISOString() });
  }

  /* ------------------------------------------------------------- snapshot */

  function instruments(): InstrumentView[] {
    return watchlists[network].map(({ market: spec, custom }) => ({
      symbol: spec.symbol,
      base: spec.base,
      quote: spec.quote,
      custom,
    }));
  }

  function walletView(target: Network): WalletView {
    const { connected, user, agent, expires, needsDeposit } = wallets[target];
    return { network: target, connected, user, agent, expires, needsDeposit };
  }

  /** Conversations that have at least one turn, latest first. */
  function threadViews(): ThreadView[] {
    return threads
      .filter((thread) => thread.runs.length > 0)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        time: thread.runs[thread.runs.length - 1]!.time,
        network: thread.network,
        turns: thread.runs.length,
      }))
      .sort((left, right) => right.time.localeCompare(left.time));
  }

  function snapshot(): Snapshot {
    const quotes: Record<string, QuoteView> = {};
    for (const { market: spec } of watchlists[network]) quotes[spec.symbol] = quote(spec);
    const focused = findMarket(focus[network], network);
    if (focused && !quotes[focused.symbol]) quotes[focused.symbol] = quote(focused);
    const wallet = wallets[network];
    return {
      version: "0.5.0",
      network,
      focus: focus[network],
      feedError: "",
      instruments: instruments(),
      quotes,
      wallets: NETWORKS.map(walletView),
      account: usable(wallet) ? figures().view : null,
      accountError: wallet.connected && wallet.failing ? ACCOUNT_ERROR : "",
      connectError: "",
      assistant: assistantView(),
      risk: { ...risk },
      theme,
      thread: open,
      threads: threadViews(),
      turns: (threads.find((thread) => thread.id === open)?.runs ?? []).map(cloneRun),
      activity: activity.map(cloneRun),
      draft: draft ? { ...draft } : null,
      receipts: { ...receipts },
      failures: { ...failures },
      servers: [...servers.values()].map((server) => ({ ...server })),
      pendingConnect: pendingConnect ? { ...pendingConnect } : null,
      busy,
    };
  }

  function push(): void {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  }

  /** Resolves after a scripted delay; rejects if the user stopped the turn. */
  async function pause(ms: number): Promise<void> {
    if (speed > 0) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, ms * speed);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      wake = null;
    } else {
      await Promise.resolve();
    }
    if (stopRequested) throw new Stopped();
  }

  /* -------------------------------------------------------------- tickets */

  function buildTicket(request: TicketRequest, rationale: string, drafter: "trader" | "assistant" = "trader"): TicketView {
    const spec = market(request.symbol);
    requireWallet();
    if (drafter === "assistant" && network === "mainnet" && !liveTickets) {
      throw new Error(
        "Mainnet tickets from the assistant are turned off. The trader can allow them in Settings, or switch to testnet to practise.",
      );
    }

    const reference = last(spec);
    const held = books[network].positions.get(spec.symbol);
    const heldSize = held ? Math.abs(held.qty) : 0;
    const heldSide = held && held.qty < 0 ? "short" : "long";
    const buying = request.side === "buy";
    const side = buying ? "long" : "short";
    const reduceOnly = request.reduceOnly ?? false;
    const opposing = held !== undefined && (held.qty > 0) !== buying;

    const places = stepDecimals(spec);
    const typed = positive(request.qty, "the quantity");
    const value = typed === null ? positive(request.notional, `the order value in ${spec.quote}`) : null;
    if (typed === null && value === null) throw new Error(`Enter a quantity or an order value in ${spec.quote}.`);
    let qty = Math.floor((typed ?? value! / reference) * 10 ** places + EPSILON) / 10 ** places;

    if (reduceOnly) {
      if (!held) throw new Error(`There is no ${spec.base} position to reduce.`);
      if (!opposing) {
        throw new Error(`A reduce-only ${request.side} cannot shrink a ${heldSide}. Use the other side.`);
      }
      qty = Math.min(qty, heldSize);
    }
    if (!(qty > 0)) {
      throw new Error(`The smallest ${spec.base} order is ${(10 ** -places).toFixed(places)}. Enter a larger amount.`);
    }
    const notional = qty * reference;
    if (!reduceOnly && notional < MIN_NOTIONAL) {
      throw new Error(`Orders on ${spec.symbol} must be worth at least ${MIN_NOTIONAL} ${spec.quote}.`);
    }

    const closing = opposing ? Math.min(qty, heldSize) : 0;
    const opening = qty - closing;
    const opens = opening > EPSILON;
    if (opposing && opens) {
      // Like the core: one order does not close a position and open the opposite one.
      throw new Error(
        `This order is larger than the ${trimUnits(heldSize)} ${spec.base} ${heldSide} it runs against. Close the position first, then open the ${side}.`,
      );
    }
    // A position keeps the leverage it has; only a new one takes the ticket's.
    let leverage = held?.leverage ?? Math.min(risk.maxLeverage, 3);
    let margin = 0;
    if (opens) {
      if (!held) leverage = request.leverage ?? Math.min(risk.maxLeverage, 3);
      if (!Number.isInteger(leverage) || leverage < 1) throw new Error("Leverage must be a whole number of at least 1.");
      if (leverage > risk.maxLeverage) {
        throw new Error(`Leverage ${leverage}x is above the limit of ${risk.maxLeverage}x set in Settings.`);
      }
      margin = (opening * reference) / leverage;
      const { available } = figures();
      if (margin > available) {
        throw new Error(
          `This order needs about ${cash(margin)} ${spec.quote} of margin and ${cash(available)} ${spec.quote} is available.`,
        );
      }
    }

    // The same sentences the core writes, so the interface is developed against the real wording.
    let effect: string;
    let result: { entry: number; long: boolean } | null;
    if (!held) {
      effect = `Opens a ${trimUnits(qty)} ${spec.base} ${side} at ${leverage}x with ${isolatedNow() ? "isolated" : "cross"} margin`;
      result = { entry: reference, long: buying };
    } else if (!opposing) {
      const total = heldSize + qty;
      effect = `Adds ${trimUnits(qty)} ${spec.base} to the ${side}, making it ${trimUnits(total)} ${spec.base} at ${leverage}x`;
      result = { entry: (heldSize * held.entry + qty * reference) / total, long: buying };
    } else if (heldSize - closing > EPSILON) {
      effect = `Reduces the ${heldSide} from ${trimUnits(heldSize)} to ${trimUnits(heldSize - closing)} ${spec.base}`;
      result = null;
    } else {
      const guards = books[network].orders.filter((order) => order.symbol === spec.symbol && order.reduceOnly).length;
      effect = `Closes the ${trimUnits(heldSize)} ${spec.base} ${heldSide}`;
      if (guards > 0) effect += ` and cancels the ${guards} reduce-only order${guards === 1 ? "" : "s"} left on it`;
      result = null;
    }

    const stopLoss = positive(request.stopLoss, "the stop-loss price");
    const takeProfit = positive(request.takeProfit, "the take-profit price");
    if (stopLoss !== null || takeProfit !== null) {
      if (reduceOnly || !opens) {
        throw new Error("A stop-loss or take-profit needs an order that opens or adds to a position.");
      }
      if (stopLoss !== null && (buying ? stopLoss >= reference : stopLoss <= reference)) {
        throw new Error(
          `The stop-loss of a ${side} must be ${buying ? "below" : "above"} the current price of ${pretty(reference)}.`,
        );
      }
      if (takeProfit !== null && (buying ? takeProfit <= reference : takeProfit >= reference)) {
        throw new Error(
          `The take-profit of a ${side} must be ${buying ? "above" : "below"} the current price of ${pretty(reference)}.`,
        );
      }
    }
    if (drafter === "assistant" && opens && stopLoss === null) {
      throw new Error("A ticket from the assistant that opens or adds to a position needs a stop-loss.");
    }

    const liquidated = result ? liquidation(result.entry, leverage, result.long) : null;
    if (stopLoss !== null && liquidated !== null && (buying ? stopLoss <= liquidated : stopLoss >= liquidated)) {
      throw new Error(
        `At ${leverage}x the estimated liquidation price (${pretty(liquidated)}) comes before the stop-loss (${pretty(stopLoss)}), so the stop would not protect the position. Lower the leverage or move the stop closer.`,
      );
    }
    return {
      id: id(),
      network,
      symbol: spec.symbol,
      side: request.side,
      qty: trimUnits(qty),
      price: amount(reference),
      notional: notional.toFixed(2),
      leverage,
      margin: margin.toFixed(2),
      // An order that runs against a position can only shrink it, flagged or not.
      reduceOnly: reduceOnly || opposing,
      stopLoss: stopLoss === null ? null : amount(stopLoss),
      takeProfit: takeProfit === null ? null : amount(takeProfit),
      estLiquidation: liquidated === null ? null : amount(liquidated),
      effect,
      rationale,
    };
  }

  function closeRequest(spec: Market): TicketRequest {
    requireWallet();
    const held = books[network].positions.get(spec.symbol);
    if (!held) throw new Error(`There is no open ${spec.base} position to close.`);
    return { symbol: spec.symbol, side: held.qty > 0 ? "sell" : "buy", qty: trimUnits(Math.abs(held.qty)), reduceOnly: true };
  }

  function startRun(agent: string, title: string, model: string, thread: string, at: number): RunView {
    return {
      id: id().slice(0, 10),
      thread,
      agent,
      title,
      network,
      time: new Date(at).toISOString(),
      status: "running",
      steps: [],
      output: "",
      reasoning: "",
      ms: 0,
      ticket: null,
      cards: [],
      usage: null,
      model,
    };
  }

  /** Something the app did on the exchange for the trader, recorded outside any conversation. */
  function execution(title: string, steps: StepView[], output: string): void {
    const run = startRun("Execution", title, "", "", Date.now());
    run.status = "complete";
    run.steps = steps;
    run.output = output;
    run.ms = steps.reduce((total, entry) => total + entry.ms, 0);
    activity.unshift(run);
  }

  function submit(ticketId: string): void {
    if (!draft || draft.id !== ticketId || draft.network !== network) {
      throw new Error("This ticket has expired. Draft a new one.");
    }
    requireWallet();
    const ticket = draft;
    const spec = market(ticket.symbol);
    const book = books[network];
    const at = last(spec);
    let qty = Number(ticket.qty);
    if (ticket.reduceOnly) {
      const held = book.positions.get(spec.symbol);
      if (!held || (held.qty > 0) === (ticket.side === "buy")) {
        throw new Error(`The ${spec.symbol} position changed after this ticket was drafted. Nothing was sent; draft it again.`);
      }
      qty = Math.min(qty, Math.abs(held.qty));
    }

    const guards = book.orders.filter((order) => order.symbol === spec.symbol && order.reduceOnly).length;
    fill(book, spec, ticket.side, qty, at, ticket.leverage);
    orderSeq += 7;
    const orderId = orderSeq;
    const exit: Side = ticket.side === "buy" ? "sell" : "buy";
    const steps: StepView[] = [
      {
        name: "exchange.order",
        detail: `${spec.symbol} market ${ticket.side} ${trimUnits(qty)}`,
        status: "ok",
        ms: 212,
        preview: `FILLED at ${pretty(at)}, order ${orderId}`,
      },
    ];
    const protection: string[] = [];
    const protect = (type: string, trigger: string | null, tag: "sl" | "tp", words: string) => {
      if (!trigger) return;
      rest(book, {
        clientId: `${ticket.id.slice(0, 30)}-${tag}`,
        symbol: spec.symbol,
        side: exit,
        type,
        price: null,
        stopPrice: Number(trigger),
        qty,
        reduceOnly: true,
      });
      steps.push({
        name: tag === "sl" ? "exchange.stop_loss" : "exchange.take_profit",
        detail: `${spec.symbol} ${type.toLowerCase()} ${exit} ${trimUnits(qty)}`,
        status: "ok",
        ms: 148,
        preview: `NEW, trigger ${pretty(Number(trigger))}`,
      });
      protection.push(`The ${words} is set at ${pretty(Number(trigger))}.`);
    };
    protect("STOP_MARKET", ticket.stopLoss, "sl", "stop-loss");
    protect("TAKE_PROFIT_MARKET", ticket.takeProfit, "tp", "take-profit");

    let note = `Sent on ${network}: ${ticket.side} ${trimUnits(qty)} ${spec.symbol}, order ${orderId}, filled at ${pretty(at)}.`;
    for (const line of protection) note += ` ${line}`;
    if (ticket.reduceOnly && guards > 0 && !book.positions.has(spec.symbol)) {
      note += ` Cancelled ${guards} reduce-only order${guards === 1 ? "" : "s"} left on the position.`;
    }
    receipts[ticket.id] = note;
    draft = null;
    execution(`Confirm ${ticket.side} ${trimUnits(qty)} ${spec.symbol}`, steps, note);
  }

  function cancellation(title: string): void {
    execution(title, [{ name: "exchange.cancel", detail: title, status: "ok", ms: 164, preview: "done" }], `${title}: done.`);
  }

  /* ---------------------------------------------------------------- turns */

  function mentioned(prompt: string): Market[] {
    const found: Market[] = [];
    const watched = new Set(watchlists[network].map((entry) => entry.market));
    for (const word of prompt.match(/[\p{L}\p{N}]+/gu) ?? []) {
      const spec = findMarket(word, network);
      // Off the watchlist, only an exact upper-case ticker counts, so "near" or "op" in a sentence is not a market.
      if (!spec || found.includes(spec) || (!watched.has(spec) && word !== word.toUpperCase())) continue;
      found.push(spec);
    }
    return found.slice(0, 4);
  }

  function practiceNote(): string {
    return network === "testnet" ? " This is testnet: prices can differ from mainnet." : "";
  }

  function trendWords(trend: Trend): string {
    if (trend === "uptrend") return "in an uptrend";
    if (trend === "downtrend") return "in a downtrend";
    return "without a clear trend";
  }

  function rsiWords(rsi: number): string {
    if (rsi >= 70) return "stretched";
    if (rsi >= 55) return "firm, not stretched";
    if (rsi <= 30) return "washed out";
    if (rsi <= 45) return "soft";
    return "neutral";
  }

  function outlookAnswer(spec: Market): string {
    const reading = frame(spec, "4h");
    const price = last(spec);
    const rate = funding(spec);
    const book = bookView(spec);
    const support = reading.support[0];
    const resistance = reading.resistance[0];
    const lines = [
      `**${spec.base} is ${trendWords(reading.trend)} on the 4h chart**, last at ${pretty(price)} ${spec.quote}.`,
      "",
    ];
    if (reading.ema20 !== null && reading.ema50 !== null) {
      const where =
        price > Math.max(reading.ema20, reading.ema50)
          ? "above"
          : price < Math.min(reading.ema20, reading.ema50)
            ? "below"
            : "between";
      lines.push(`- Price is ${where} the 20 and 50 EMAs.`);
    }
    if (reading.rsi14 !== null) lines.push(`- RSI 14 reads ${reading.rsi14.toFixed(1)}: ${rsiWords(reading.rsi14)}.`);
    if (support !== undefined && resistance !== undefined) {
      lines.push(`- Nearest support is ${pretty(support)}; resistance is ${pretty(resistance)}.`);
    } else if (support !== undefined) {
      lines.push(`- Nearest support is ${pretty(support)}. There is no swing high above the price.`);
    } else if (resistance !== undefined) {
      lines.push(`- Nearest resistance is ${pretty(resistance)}. There is no swing low below the price.`);
    }
    lines.push(`- Funding is ${signed(rate, 4)} per 8 hours, so ${rate >= 0 ? "longs pay shorts" : "shorts pay longs"}.`);
    lines.push(`- Bids hold ${Math.round(book.bidSharePct ?? 50)}% of the depth shown.`);
    lines.push("");
    lines.push(
      `${support !== undefined ? `A 4h close below ${pretty(support)} would break the setup.` : "There is no nearby level to lean on."}${practiceNote()}`,
    );
    return lines.join("\n");
  }

  function compareAnswer(specs: Market[]): string {
    const rows = specs.map((spec) => ({ spec, reading: frame(spec, "4h"), price: last(spec), rate: funding(spec) }));
    const ranked = [...rows].sort((left, right) => (right.reading.changePct ?? 0) - (left.reading.changePct ?? 0));
    const wildest = [...rows].sort((left, right) => (right.reading.atrPct ?? 0) - (left.reading.atrPct ?? 0))[0]!;
    return [
      `**${ranked[0]!.spec.base} has the stronger tape** over the last five 4h bars; ${ranked[ranked.length - 1]!.spec.base} is lagging.`,
      "",
      "| Market | Price | 5 bars | RSI 14 | ATR | Funding, 8h |",
      "|:--|--:|--:|--:|--:|--:|",
      ...rows.map(
        ({ spec, reading, price, rate }) =>
          `| ${spec.base} | ${pretty(price)} | ${signed(reading.changePct ?? 0)} | ${(reading.rsi14 ?? 50).toFixed(1)} | ${(reading.atrPct ?? 0).toFixed(2)}% | ${signed(rate, 4)} |`,
      ),
      "",
      `- ${ranked[0]!.spec.base} leads on momentum at ${signed(ranked[0]!.reading.changePct ?? 0)}.`,
      `- Volatility is highest in ${wildest.spec.base}, so size it smaller for the same risk.${practiceNote()}`,
    ].join("\n");
  }

  function fundingAnswer(spec: Market): string {
    const view = fundingView(spec);
    const rate = view.ratePct ?? 0;
    const settled = view.history.map(([, value]) => value);
    const average = settled.reduce((sum, value) => sum + value, 0) / Math.max(1, settled.length);
    const minutes = Math.max(0, Math.round((nextFunding() - Date.now()) / 60_000));
    return [
      `**${spec.base} funding is ${signed(rate, 4)} per 8 hours**, about ${signed(view.annualPct ?? 0)} a year if it held.`,
      "",
      `- ${rate >= 0 ? "Longs pay shorts" : "Shorts pay longs"}. The next payment is in ${Math.floor(minutes / 60)}h ${minutes % 60}m.`,
      `- Over the last two weeks it averaged ${signed(average, 4)} and peaked at ${signed(Math.max(...settled), 4)}.`,
      `- On a 1,000 ${spec.quote} position that is ${cash(Math.abs(rate) * 10)} ${spec.quote} per payment.${practiceNote()}`,
    ].join("\n");
  }

  function movers(): MarketRow[] {
    return marketsOf(network)
      .map(marketRow)
      .sort((left, right) => Math.abs(right.changePct ?? 0) - Math.abs(left.changePct ?? 0))
      .slice(0, 6);
  }

  function moversAnswer(rows: MarketRow[]): string {
    const top = rows[0]!;
    const gain = [...rows].sort((left, right) => (right.changePct ?? 0) - (left.changePct ?? 0))[0]!;
    const drop = [...rows].sort((left, right) => (left.changePct ?? 0) - (right.changePct ?? 0))[0]!;
    const paying = [...rows].sort((left, right) => (right.fundingRatePct ?? 0) - (left.fundingRatePct ?? 0))[0]!;
    return [
      `**${top.base} is moving the most**, ${signed(top.changePct ?? 0)} in 24 hours.`,
      "",
      `- Biggest gain: ${gain.base} at ${signed(gain.changePct ?? 0)}. Biggest drop: ${drop.base} at ${signed(drop.changePct ?? 0)}.`,
      `- Funding is highest on ${paying.base}, ${signed(paying.fundingRatePct ?? 0, 4)} per 8 hours.${practiceNote()}`,
    ].join("\n");
  }

  /** Invented headlines about the markets asked for, from invented newsrooms. The mock reads nothing. */
  function headlines(specs: Market[], at: number): NewsView[] {
    const rooms = ["Tidewire", "Kelp Desk", "The Brine Report"];
    const stories: NewsView[] = [];
    for (const [index, spec] of specs.entries()) {
      const change = quote(spec).changePct ?? 0;
      const rate = funding(spec);
      const name = spec.base;
      const lines = [
        `${name} ${change >= 0 ? "climbs" : "slides"} ${Math.abs(change).toFixed(1)}% in a day as traders ${change >= 0 ? "add to longs" : "cut leverage"}`,
        `Funding on ${name} perpetuals ${rate >= 0 ? "stays positive" : "turns negative"} after the move`,
        `What ${name} holders are watching this week`,
      ];
      for (const [row, title] of lines.entries()) {
        const minutes = 25 + (hash(`${spec.symbol}${row}`) % 9) * 47 + index * 13;
        const room = rooms[(row + index) % rooms.length]!;
        stories.push({
          title,
          source: room,
          url: `https://${room.toLowerCase().replace(/[^a-z]+/g, "")}.example/markets/${name.toLowerCase()}-${row + 1}`,
          published: new Date(at - minutes * 60_000).toISOString(),
        });
      }
    }
    return stories.sort((left, right) => (right.published ?? "").localeCompare(left.published ?? "")).slice(0, 6);
  }

  function newsAnswer(specs: Market[], stories: NewsView[], at: number): string {
    const first = stories[0]!;
    const about = specs.map((spec) => spec.base).join(" and ");
    return [
      `**${first.source} has the newest report on ${about}:** ${first.title.charAt(0).toLowerCase()}${first.title.slice(1)}.`,
      "",
      `- ${stories.length} headlines from the last day, the oldest ${ago(stories[stories.length - 1]!.published, at)} ago.`,
      `- News explains a move. It does not say what comes next, so the stop stays where the chart puts it.${practiceNote()}`,
    ].join("\n");
  }

  function accountAnswer(): string {
    const wallet = wallets[network];
    if (!wallet.connected) return `No wallet is connected on ${networkName(network)}, so there is no account to read.`;
    if (!usable(wallet)) return `The ${networkName(network)} account cannot be read yet.`;
    const { view } = figures();
    const lines = [
      `Equity is **${cash(Number(view.equity))} USDT** on ${network}, with ${cash(Number(view.available))} USDT free.`,
    ];
    if (view.positions.length === 0) {
      lines.push("", "There are no open positions.");
      return lines.join("\n");
    }
    const largest = [...view.positions].sort((left, right) => Number(right.notional) - Number(left.notional))[0]!;
    const pnl = Number(view.unrealizedPnl);
    lines.push(
      "",
      `- ${view.positions.length} open position${view.positions.length === 1 ? "" : "s"}; the largest is the ${market(largest.symbol).base} ${largest.side} at ${cash(Number(largest.notional))} USDT.`,
      `- Unrealized P/L is ${pnl >= 0 ? "+" : "−"}${cash(Math.abs(pnl))} USDT.`,
      `- ${view.orders.length} order${view.orders.length === 1 ? " is" : "s are"} resting.`,
    );
    return lines.join("\n");
  }

  /** Position sizing for a risk the trader accepts, with the stop at the nearest swing level. */
  function planFor(spec: Market, direction: "long" | "short", sizing: Sizing): PlanView {
    const long = direction === "long";
    const entry = last(spec);
    const reading = frame(spec, "4h");
    let stop: number;
    if (sizing.stopDistance !== undefined) {
      stop = entry * (long ? 1 - sizing.stopDistance : 1 + sizing.stopDistance);
    } else if (long) {
      // Keep the stop a sensible distance away, whatever the generated swings look like.
      stop = Math.max(entry * 0.94, Math.min(reading.support[0] ?? entry * 0.975, entry * 0.992));
    } else {
      stop = Math.min(entry * 1.06, Math.max(reading.resistance[0] ?? entry * 1.025, entry * 1.008));
    }
    const distance = Math.abs(entry - stop);
    const swing = long ? reading.resistance[0] : reading.support[0];
    const target = swing !== undefined && Math.abs(swing - entry) > distance ? swing : long ? entry + 2 * distance : entry - 2 * distance;
    const { equity } = figures();
    const places = stepDecimals(spec);
    const qty = Math.floor(((equity * sizing.riskPct) / 100 / distance) * 10 ** places) / 10 ** places;
    // A position that is already open keeps its leverage, whatever the plan asks for.
    const leverage =
      books[network].positions.get(spec.symbol)?.leverage ?? sizing.leverage ?? Math.min(risk.maxLeverage, 3);
    const notional = qty * entry;
    const liquidated = liquidation(entry, leverage, long);
    const loss = qty * distance;
    return {
      symbol: spec.symbol,
      direction,
      entry: amount(entry),
      stop: amount(stop),
      target: amount(target),
      qty: trimUnits(qty),
      leverage,
      notional: notional.toFixed(2),
      margin: (notional / leverage).toFixed(2),
      lossAtStop: loss.toFixed(2),
      riskPct: equity > 0 ? Number(((loss / equity) * 100).toFixed(2)) : null,
      liquidation: liquidated === null ? null : amount(liquidated),
      stopSafe: liquidated === null || (long ? stop > liquidated : stop < liquidated),
      rewardToRisk: Number((Math.abs(target - entry) / distance).toFixed(2)),
    };
  }

  const ORDER = /^(?:please\s+)?(long|short|buy|sell)\s+(\d+(?:\.\d+)?|\.\d+)\s+(\S+?)(?:\s+(?:at\s+)?(\d{1,3})x)?[.!]?$/iu;
  const CLOSE = /^(?:please\s+)?close\s+(?:my\s+)?(\S+?)(?:\s+(?:position|long|short))?[.!]?$/iu;
  const SIZING = /\b(?:risk|risking|size|sizing|plan|enter|entry)\b/i;
  const NEWS = /\b(?:news|headlines?|why)\b/i;
  const ACCOUNT = /\b(?:account|portfolio|holdings|positions?|balance|exposure|equity)\b/i;
  const MOVERS = /\b(?:moving|movers?|gainers?|losers?)\b/i;

  /**
   * One scripted turn of the model. Every message goes to it, as in the app:
   * it reads the message, calls tools round by round, the tools put cards on
   * the answer, and it finishes with text and perhaps a ticket. The patterns
   * above only pick which script stands in for the model's own judgement. The
   * result is not recorded here.
   */
  async function turn(prompt: string, thread: string, driver: Driver): Promise<RunView> {
    const provider = active === "none" ? "openrouter" : active;
    const model = stored[provider].model || "lantern/lantern-2-large";
    const info = modelInfo(provider, model);
    const label = info?.name ?? model.slice(model.lastIndexOf("/") + 1);
    const thinks = Boolean(info?.reasoning);
    const run = startRun("Assistant", prompt, model, thread, driver.at);
    const began = performance.now();
    let round = 0;
    driver.emit({ type: "started", run: cloneRun(run) });

    async function step(name: string, detail: string, ms: number, preview: string, fails = false): Promise<void> {
      const index = run.steps.length;
      const entry: StepView = { name, detail, status: "running", ms: 0, preview: "" };
      run.steps.push(entry);
      driver.emit({ type: "step", index, step: { ...entry } });
      try {
        await driver.pause(ms);
      } catch (error) {
        entry.status = "error";
        entry.preview = "Stopped.";
        driver.emit({ type: "step", index, step: { ...entry } });
        throw error;
      }
      entry.status = fails ? "error" : "ok";
      entry.ms = driver.live ? Math.round(ms * (0.8 + Math.random() * 0.4)) : ms;
      entry.preview = preview;
      driver.emit({ type: "step", index, step: { ...entry } });
    }

    function show(card: CardView): void {
      run.cards.push(card);
      driver.emit({ type: "card", card });
    }

    /**
     * One round of the model deciding which tools to call. What it says while deciding is interim text:
     * the next round replaces it.
     */
    async function decide(interim = "", thoughts: string[] = []): Promise<void> {
      round += 1;
      const index = run.steps.length;
      const entry: StepView = { name: "model", detail: `${label}, round ${round}`, status: "running", ms: 0, preview: "" };
      run.steps.push(entry);
      driver.emit({ type: "step", index, step: { ...entry } });
      const since = performance.now();
      try {
        if (interim && driver.live) driver.emit({ type: "text", delta: interim });
        if (thinks) {
          for (const piece of thoughts) {
            run.reasoning += piece;
            driver.emit({ type: "reasoning", delta: piece });
            await driver.pause(110);
          }
        }
        await driver.pause(260);
      } catch (error) {
        entry.status = "error";
        entry.preview = "Stopped.";
        driver.emit({ type: "step", index, step: { ...entry } });
        throw error;
      }
      entry.status = "ok";
      entry.ms = driver.live ? Math.round(performance.now() - since) : 380;
      driver.emit({ type: "step", index, step: { ...entry } });
    }

    /** The last round: the model writes its answer, and the text streams while that step runs. */
    async function answer(text: string): Promise<void> {
      round += 1;
      const index = run.steps.length;
      const entry: StepView = { name: "model", detail: `${label}, round ${round}`, status: "running", ms: 0, preview: "" };
      run.steps.push(entry);
      driver.emit({ type: "step", index, step: { ...entry } });
      driver.emit({ type: "round" });
      const written = performance.now();
      try {
        if (driver.live) {
          const pieces = text.match(/[\s\S]{1,14}/g) ?? [];
          for (const [at, piece] of pieces.entries()) {
            if (hold && at === Math.ceil(pieces.length / 2)) {
              hold = false;
              await driver.pause(86_400_000);
            }
            run.output += piece;
            driver.emit({ type: "text", delta: piece });
            await driver.pause(22);
          }
        } else {
          run.output = text;
        }
      } catch (error) {
        entry.status = "error";
        entry.preview = "Stopped.";
        driver.emit({ type: "step", index, step: { ...entry } });
        throw error;
      }
      entry.status = "ok";
      entry.ms = driver.live ? Math.round(performance.now() - written) : 1500;
      driver.emit({ type: "step", index, step: { ...entry } });
    }

    /** Drafts a ticket the way `propose_order` does; a refusal comes back as text. */
    async function propose(request: TicketRequest, rationale: string, action: string): Promise<string> {
      const detail = [action, request.qty ?? "", request.symbol].filter(Boolean).join(" ");
      let ticket: TicketView;
      try {
        ticket = buildTicket(request, rationale, "assistant");
      } catch (error) {
        const refusal = messageOf(error);
        await step("propose_order", detail, 160, JSON.stringify({ error: refusal }), true);
        return refusal;
      }
      await step("propose_order", detail, 160, JSON.stringify({ drafted: true, effect: ticket.effect }));
      draft = ticket;
      run.ticket = ticket;
      driver.emit({ type: "ticket", ticket: { ...ticket } });
      return "";
    }

    async function quotes(specs: Market[]): Promise<void> {
      const views = specs.map(quote);
      await step(
        "get_quote",
        specs.map((spec) => spec.symbol).join(", "),
        420,
        JSON.stringify({
          quotes: views.map((view) => ({
            symbol: view.symbol,
            last_price: Number(view.price),
            change_24h_pct: view.changePct,
            funding_rate_pct: view.fundingRatePct,
          })),
        }),
      );
      show({ kind: "quotes", quotes: views });
    }

    async function chart(spec: Market): Promise<TechnicalFrame> {
      const reading = frame(spec, "4h");
      await step(
        "analyze_market",
        `${spec.symbol} 4h`,
        520,
        JSON.stringify({
          symbol: spec.symbol,
          timeframe: "4h",
          trend: reading.trend,
          rsi_14: reading.rsi14,
          atr_pct: reading.atrPct,
          support: reading.support,
          resistance: reading.resistance,
        }),
      );
      show({ kind: "technicals", symbol: spec.symbol, frame: reading });
      return reading;
    }

    async function account(): Promise<boolean> {
      const ok = usable(wallets[network]);
      let preview = JSON.stringify({ error: `No wallet is connected on ${networkName(network)}.` });
      if (ok) {
        const { view } = figures();
        preview = `equity ${view.equity} USDT, ${view.positions.length} open position(s), ${view.orders.length} open order(s)`;
      }
      await step("get_account", "", 180, preview, !ok);
      if (ok) show({ kind: "account" });
      return ok;
    }

    const ticketLine = (ticket: TicketView): string => {
      const spec = market(ticket.symbol);
      const stop = ticket.stopLoss ? `, with the stop-loss at ${pretty(Number(ticket.stopLoss))}` : "";
      return `The ticket is ready: ${lowerFirst(ticket.effect)}, about ${cash(Number(ticket.notional))} ${spec.quote}${stop}. Nothing is sent until you place it.${network === "testnet" ? " This is testnet: practice funds." : ""}`;
    };

    const usage = (): void => {
      if (provider === "ollama" || provider === "lmstudio") return;
      run.usage = {
        promptTokens: 2380 + run.steps.length * 410,
        completionTokens: Math.max(40, Math.round(run.output.length / 3.6)),
        cost: provider === "openrouter" ? 0.0094 + run.steps.length * 0.0021 : null,
      };
    };

    try {
      const order = ORDER.exec(prompt);
      const close = order ? null : CLOSE.exec(prompt);
      if (provider === "lmstudio") await step("load_model", label, 900, "");
      if (/\bfail/i.test(prompt)) {
        round += 1;
        await step("model", `${label}, round ${round}`, 700, "402", true);
        throw new Error("Your OpenRouter balance is too low for this request. Add credit, or pick another model.");
      } else if (order) {
        const spec = market(order[3]!);
        const word = order[1]!.toLowerCase();
        const long = word === "long" || word === "buy";
        await decide();
        await quotes([spec]);
        const reading = await chart(spec);
        const entry = last(spec);
        const stop = long
          ? Math.max(entry * 0.94, Math.min(reading.support[0] ?? entry * 0.975, entry * 0.992))
          : Math.min(entry * 1.06, Math.max(reading.resistance[0] ?? entry * 1.025, entry * 1.008));
        const request: TicketRequest = { symbol: spec.symbol, side: long ? "buy" : "sell", qty: order[2]!, stopLoss: amount(stop) };
        if (order[4]) request.leverage = Number(order[4]);
        const adds = books[network].positions.get(spec.symbol);
        if (adds && (adds.qty > 0) !== long) delete request.stopLoss;
        const refusal = await propose(
          request,
          request.stopLoss ? `The stop sits at the nearest 4h swing ${long ? "low" : "high"}.` : "",
          adds && (adds.qty > 0) !== long ? "reduce" : long ? "open_long" : "open_short",
        );
        await answer(run.ticket ? ticketLine(run.ticket) : `I could not draft the ticket. ${refusal}`);
      } else if (close) {
        const spec = market(close[1]!);
        await decide();
        const read = await account();
        let refusal = read ? "" : `No wallet is connected on ${networkName(network)}.`;
        if (read) {
          try {
            refusal = await propose(closeRequest(spec), "", "close");
          } catch (error) {
            refusal = messageOf(error);
          }
        }
        await answer(run.ticket ? ticketLine(run.ticket) : refusal);
      } else if (SIZING.test(prompt)) {
        const spec = mentioned(prompt)[0] ?? market(focus[network]);
        const direction = /\b(?:short|sell)\b/i.test(prompt) ? "short" : "long";
        const sizing: Sizing = { riskPct: Math.min(5, Math.max(0.1, Number(/(\d+(?:\.\d+)?)\s*%/.exec(prompt)?.[1] ?? 1))) };
        const wanted = /(\d{1,3})\s*x\b/i.exec(prompt)?.[1];
        if (wanted) sizing.leverage = Number(wanted);
        if (/\bwide stop\b/i.test(prompt)) sizing.stopDistance = 0.12;
        await decide("Let me check the market first.", [
          `The trader wants a ${direction} in ${spec.base} sized by risk. `,
          "Read the price and the 4h structure, then size from the stop. ",
        ]);
        await quotes([spec]);
        await chart(spec);
        if (!(await account())) {
          await answer(
            `**${spec.base} is ${trendWords(frame(spec, "4h").trend)} on the 4h chart.** Connect a wallet on ${networkName(network)} and I can size the ${direction} and draft the ticket.`,
          );
        } else {
          const plan = planFor(spec, direction, sizing);
          await step(
            "plan_position",
            spec.symbol,
            140,
            JSON.stringify({
              quantity: Number(plan.qty),
              margin_usdt: Number(plan.margin),
              loss_at_stop_usdt: Number(plan.lossAtStop),
              stop_is_inside_liquidation: plan.stopSafe,
            }),
          );
          show({ kind: "plan", plan });
          const request: TicketRequest = {
            symbol: spec.symbol,
            side: direction === "long" ? "buy" : "sell",
            qty: plan.qty,
            leverage: plan.leverage,
            stopLoss: plan.stop,
          };
          if (plan.target) request.takeProfit = plan.target;
          const refusal = await propose(
            request,
            `Risks about ${plan.riskPct ?? sizing.riskPct}% of equity, ${cash(Number(plan.lossAtStop))} ${spec.quote}, if the stop at ${pretty(Number(plan.stop))} is hit.`,
            direction === "long" ? "open_long" : "open_short",
          );
          const lines = [
            `**A ${plan.qty} ${spec.base} ${direction} risks about ${plan.riskPct ?? sizing.riskPct}% of equity.**`,
            "",
            `- Entry near ${pretty(Number(plan.entry))}, stop at ${pretty(Number(plan.stop))}, target ${pretty(Number(plan.target))}.`,
            `- That is ${cash(Number(plan.notional))} ${spec.quote} of ${spec.base} on ${cash(Number(plan.margin))} ${spec.quote} of margin at ${plan.leverage}x.`,
          ];
          if (plan.liquidation) {
            lines.push(
              plan.stopSafe
                ? `- The stop triggers well before the estimated liquidation at ${pretty(Number(plan.liquidation))}.`
                : `- The estimated liquidation at ${pretty(Number(plan.liquidation))} comes before the stop.`,
            );
          }
          lines.push("");
          lines.push(
            run.ticket
              ? `The ticket is ready. Nothing is sent until you place it.${network === "testnet" ? " This is testnet: practice funds." : ""}`
              : `I did not draft a ticket. ${refusal}`,
          );
          await answer(lines.join("\n"));
        }
      } else if (NEWS.test(prompt)) {
        await decide();
        if (webSearch) {
          const found = mentioned(prompt);
          const specs = found.length > 0 ? found.slice(0, 2) : [market(focus[network])];
          const query = found.length > 0 ? specs.map((spec) => spec.base).join(" ") : "";
          const stories = headlines(specs, driver.at);
          await step(
            "search_news",
            query,
            520,
            JSON.stringify({ query, results: stories.map((story) => [story.source, story.title]) }),
          );
          show({ kind: "news", query, articles: stories });
          await answer(newsAnswer(specs, stories, driver.at));
        } else {
          await answer("Web search is off, so I cannot read the news. You can turn it on in Settings, under Tools.");
        }
      } else if (ACCOUNT.test(prompt)) {
        await decide();
        await account();
        await answer(accountAnswer());
      } else if (MOVERS.test(prompt)) {
        const rows = movers();
        await decide();
        await step(
          "get_movers",
          "",
          380,
          JSON.stringify({ markets: marketsOf(network).length, movers: rows.map((row) => [row.symbol, row.changePct]) }),
        );
        show({ kind: "movers", rows });
        await answer(moversAnswer(rows));
      } else {
        const found = mentioned(prompt);
        const specs = found.length > 0 ? found : [market(focus[network])];
        await decide("Pulling fresh quotes first.", [
          `The trader wants a read on ${specs.map((spec) => spec.base).join(" and ")}. `,
          "Fetch quotes and funding, then the 4h chart, before judging the trend. ",
        ]);
        await quotes(specs);
        if (/\bfunding\b/i.test(prompt)) {
          await answer(fundingAnswer(specs[0]!));
        } else {
          for (const spec of specs.slice(0, 2)) await chart(spec);
          if (specs.length === 1) {
            const book = bookView(specs[0]!);
            await step(
              "get_order_book",
              specs[0]!.symbol,
              310,
              JSON.stringify({ symbol: book.symbol, spread_bps: book.spreadBps, bid_share_pct: book.bidSharePct }),
            );
            show({ kind: "book", book });
          }
          await answer(specs.length === 1 ? outlookAnswer(specs[0]!) : compareAnswer(specs));
        }
      }
      usage();
      run.status = "complete";
    } catch (error) {
      if (error instanceof Stopped) {
        run.status = "stopped";
      } else {
        run.status = "failed";
        run.output = messageOf(error);
      }
    }
    run.ms = driver.live
      ? Math.round(performance.now() - began)
      : run.steps.reduce((total, entry) => total + entry.ms, 0);
    return run;
  }

  /** Files a finished turn under its conversation, starting the conversation if this is its first turn. */
  function record(threadId: string, run: RunView): void {
    let thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      thread = { id: threadId, title: shorten(run.title, 48), network: run.network, runs: [] };
      threads.push(thread);
    }
    thread.runs.push(run);
  }

  async function ask(prompt: string, onEvent: (event: TurnEvent) => void): Promise<Snapshot> {
    await ready;
    const text = prompt.trim();
    if (!text) throw new Error("Type a message first.");
    if (text.length > 2500) throw new Error("Keep the message under 2,500 characters.");
    if (active === "none") throw new Error("Connect a model first.");
    if (busy) throw new Error("The assistant is still working. Stop it or wait for it to finish.");

    busy = true;
    stopRequested = false;
    const thread = open;
    const run = await turn(text, thread, { emit: onEvent, pause, at: Date.now(), live: true });
    record(thread, run);
    busy = false;
    stopRequested = false;
    onEvent({ type: "finished", run: cloneRun(run) });
    return snapshot();
  }

  /* ---------------------------------------------------------------- seeds */

  /** Three positions and four resting orders, as if the wallet had been trading for a few days. */
  function seedBook(): void {
    const book = books[network];
    const size = network === "mainnet" ? 0.25 : 1;
    const day = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
    const eth = market("ETH");
    const sol = market("SOL");
    const doge = market("DOGE");
    const btc = market("BTC");
    book.positions.set(eth.symbol, { qty: 1.2 * size, entry: mark(eth) * 0.962, leverage: 5, isolated: true });
    book.positions.set(sol.symbol, { qty: -40 * size, entry: mark(sol) * 0.985, leverage: 3, isolated: false });
    book.positions.set(doge.symbol, { qty: 12_000 * size, entry: mark(doge) * 1.021, leverage: 2, isolated: true });
    const protect = (spec: Market, side: Side, type: string, trigger: number, qty: number, days: number) =>
      rest(book, {
        clientId: `${id().slice(0, 30)}-${type === "STOP_MARKET" ? "sl" : "tp"}`,
        symbol: spec.symbol,
        side,
        type,
        price: null,
        stopPrice: trigger,
        qty,
        reduceOnly: true,
        time: ago(days),
      });
    protect(eth, "sell", "STOP_MARKET", mark(eth) * 0.93, 1.2 * size, 3);
    protect(eth, "sell", "TAKE_PROFIT_MARKET", mark(eth) * 1.08, 1.2 * size, 3);
    protect(sol, "buy", "STOP_MARKET", mark(sol) * 1.04, 40 * size, 2);
    rest(book, {
      clientId: `web_${id().slice(0, 18)}`,
      symbol: btc.symbol,
      side: "buy",
      type: "LIMIT",
      price: Math.round(mark(btc) * 0.95),
      stopPrice: null,
      qty: 0.01,
      reduceOnly: false,
      time: ago(1),
    });
  }

  /** Writes a finished turn into a conversation without anybody watching it happen. */
  async function seedTurn(thread: string, prompt: string, minutesAgo: number): Promise<RunView> {
    const run = await turn(prompt, thread, {
      emit: () => {},
      pause: () => Promise.resolve(),
      at: Date.now() - minutesAgo * 60_000,
      live: false,
    });
    record(thread, run);
    return run;
  }

  const HISTORY: [prompts: string[], minutesAgo: number][] = [
    [["ETH funding this week"], 95],
    [["Compare SOL and SUI"], 26 * 60],
    [["Top movers"], 31 * 60],
    [["Short SUI 10x, 1% risk, wide stop"], 3 * 1440],
    [["DOGE outlook", "Long 4000 DOGE"], 5 * 1440],
    [["My positions"], 12 * 1440],
    [["BTC outlook"], 20 * 1440],
  ];

  async function seedAll(): Promise<void> {
    if ((options.positions ?? seed !== "empty") && usable(wallets[network])) seedBook();

    if (options.history ?? true) {
      for (const [prompts, minutesAgo] of HISTORY) {
        const thread = id().slice(0, 12);
        for (const [index, prompt] of prompts.entries()) await seedTurn(thread, prompt, minutesAgo - index * 3);
      }
      // A ticket drafted in an old conversation is long gone.
      draft = null;
    }

    if (seed === "empty" || seed === "live") return;
    await seedTurn(open, "BTC outlook", 9);
    const follow: Record<MockTicket, string> = {
      long: "Long BTC, 1% risk",
      short: "Short BTC, 1% risk",
      close: "Close ETH",
    };
    await seedTurn(open, follow[options.ticket ?? "long"], 2);
    const ticket = draft as TicketView | null;
    if (!ticket) return;
    if (seed === "filled") {
      submit(ticket.id);
    } else if (seed === "unconfirmed") {
      failures[ticket.id] =
        `The exchange did not answer in time. The order may or may not have reached the exchange. Check your open orders and positions for client ID ${ticket.id} before sending it again.`;
      draft = null;
    } else if (seed === "expired") {
      draft = null;
    }
  }

  if (options.pending) {
    pendingConnect = { network, url: `http://127.0.0.1:53127/connect/${id().slice(0, 16)}` };
  }

  /** Seeding runs the same scripts a live turn does, so it finishes a few microtasks after the backend is made. */
  const ready = seedAll();

  /* ------------------------------------------------------------- backend */

  /** Simulated latency for ordinary commands. */
  async function settle<T>(work: () => T): Promise<T> {
    await ready;
    if (speed > 0) await new Promise((done) => setTimeout(done, 90 * speed));
    return work();
  }

  const guardIdle = (action: string): void => {
    if (busy) throw new Error(`Stop the assistant or wait for it to finish before ${action}.`);
  };

  const knownNetwork = (target: Network): void => {
    if (!NETWORKS.includes(target)) throw new Error("Unknown network.");
  };

  return {
    boot: () => settle(snapshot),
    snapshot: () => settle(snapshot),

    setNetwork: (next) =>
      settle(() => {
        guardIdle("switching network");
        knownNetwork(next);
        network = next;
        draft = null;
        return snapshot();
      }),

    selectSymbol: (symbol) =>
      settle(() => {
        focus[network] = market(symbol).symbol;
        return snapshot();
      }),

    refreshQuotes: () =>
      settle(() => {
        tick += 1;
        return snapshot();
      }),

    refreshAccount: () => settle(snapshot),

    candles: (symbol, timeframe) =>
      settle((): CandleSeries => {
        const spec = market(symbol);
        return { symbol: spec.symbol, timeframe, rows: candleRows(spec, timeframe), source: SOURCES[network] };
      }),

    marketOverview: () => settle(() => marketsOf(network).map(marketRow)),
    orderBook: (symbol) => settle(() => bookView(market(symbol))),
    recentTrades: (symbol) => settle(() => tradesView(market(symbol))),
    marketFunding: (symbol) => settle(() => fundingView(market(symbol))),
    marketTechnicals: (symbol) => settle(() => technicalsView(market(symbol))),

    watchAdd: (symbol) =>
      settle(() => {
        const spec = market(symbol);
        const watched = watchlists[network];
        if (watched.some((entry) => entry.market === spec)) throw new Error(`${spec.base} is already on your watchlist.`);
        watched.push({ market: spec, custom: true });
        focus[network] = spec.symbol;
        return snapshot();
      }),

    watchRemove: (symbol) =>
      settle(() => {
        const watched = watchlists[network];
        const index = watched.findIndex((entry) => entry.market.symbol === symbol && entry.custom);
        if (index === -1) throw new Error("Only markets you added can be removed from the watchlist.");
        watched.splice(index, 1);
        return snapshot();
      }),

    ask,

    stopTurn: async () => {
      if (!busy) return;
      stopRequested = true;
      wake?.();
    },

    newThread: () =>
      settle(() => {
        guardIdle("starting a new chat");
        open = id().slice(0, 12);
        return snapshot();
      }),

    openThread: (threadId) =>
      settle(() => {
        guardIdle("opening another chat");
        if (!threads.some((thread) => thread.id === threadId)) throw new Error("That chat is no longer saved.");
        open = threadId;
        return snapshot();
      }),

    deleteThread: (threadId) =>
      settle(() => {
        guardIdle("deleting a chat");
        threads = threads.filter((thread) => thread.id !== threadId);
        if (open === threadId) open = id().slice(0, 12);
        return snapshot();
      }),

    prepareTicket: (request) =>
      settle(() => {
        draft = buildTicket(request, "");
        return snapshot();
      }),

    submitTicket: (ticketId) =>
      settle(() => {
        submit(ticketId);
        return snapshot();
      }),

    dismissTicket: () =>
      settle(() => {
        draft = null;
        return snapshot();
      }),

    closePosition: (symbol) =>
      settle(() => {
        draft = buildTicket(closeRequest(market(symbol)), "");
        return snapshot();
      }),

    cancelOrder: (symbol, orderId) =>
      settle(() => {
        requireWallet();
        const book = books[network];
        const index = book.orders.findIndex((order) => order.symbol === symbol && order.id === orderId);
        if (index === -1) throw new Error("That order is no longer open.");
        book.orders.splice(index, 1);
        cancellation(`Cancel order ${orderId} on ${symbol}`);
        return snapshot();
      }),

    cancelAllOrders: (symbol) =>
      settle(() => {
        requireWallet();
        const book = books[network];
        const kept = book.orders.filter((order) => order.symbol !== symbol);
        if (kept.length === book.orders.length) throw new Error(`There are no open ${symbol} orders.`);
        book.orders = kept;
        cancellation(`Cancel all open orders on ${symbol}`);
        return snapshot();
      }),

    connectWalletKey: (request: WalletKeyRequest) =>
      settle(() => {
        guardIdle("changing wallets");
        knownNetwork(request.network);
        const user = request.user.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(user)) {
          throw new Error("Enter the main wallet address: 0x followed by 40 hexadecimal characters.");
        }
        const key = request.agentKey.trim();
        if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(key)) {
          throw new Error("The API wallet private key is 64 hexadecimal characters, with or without 0x in front.");
        }
        // The real core derives the address from the key; here it is only made to look like one.
        const digest = [0, 1, 2, 3, 4].map((salt) => hash(`${salt}:${key}`).toString(16).padStart(8, "0")).join("");
        wallets[request.network] = {
          connected: true,
          user,
          agent: `0x${digest}`,
          expires: null,
          needsDeposit: false,
          failing: false,
        };
        if (pendingConnect?.network === request.network) pendingConnect = null;
        return snapshot();
      }),

    connectWalletBrowser: (request: WalletBrowserRequest) =>
      settle(() => {
        guardIdle("changing wallets");
        knownNetwork(request.network);
        if (!Number.isInteger(request.days) || request.days < 1 || request.days > 365) {
          throw new Error("Choose how long the approval lasts, from 1 to 365 days.");
        }
        if (pendingConnect) throw new Error("Another wallet approval is already waiting. Cancel it first.");
        const url = `http://127.0.0.1:53127/connect/${id().slice(0, 16)}`;
        pendingConnect = { network: request.network, url };
        if (!options.pending) {
          // Stand in for the trader approving in their browser wallet.
          setTimeout(() => {
            if (pendingConnect?.url !== url) return;
            wallets[request.network] = { ...walletIn("connected", request.network), expires: daysFromNow(request.days) };
            pendingConnect = null;
            push();
          }, 2600 * speed);
        }
        return snapshot();
      }),

    cancelWalletConnect: () =>
      settle(() => {
        pendingConnect = null;
        return snapshot();
      }),

    disconnectWallet: (target) =>
      settle(() => {
        guardIdle("changing wallets");
        knownNetwork(target);
        wallets[target] = noWallet();
        if (draft?.network === target) draft = null;
        return snapshot();
      }),

    saveRisk: (request: RiskRequest) =>
      settle(() => {
        guardIdle("changing the risk limits");
        if (!Number.isInteger(request.maxLeverage) || request.maxLeverage < 1 || request.maxLeverage > 50) {
          throw new Error("Maximum leverage is a whole number from 1 to 50.");
        }
        risk = { maxLeverage: request.maxLeverage, isolated: Boolean(request.isolated) };
        if (draft && !draft.reduceOnly && draft.leverage > risk.maxLeverage) draft = null;
        return snapshot();
      }),

    mcpConnect: (request: McpConnectRequest) =>
      settle(() => {
        guardIdle("changing tool servers");
        const serverId = request.id.trim();
        if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(serverId)) {
          throw new Error("Give the server a short id: lowercase letters, digits, dashes or underscores.");
        }
        if (servers.has(serverId)) throw new Error(`A server called ${serverId} is already attached.`);
        if (request.transport === "stdio") {
          if (!request.command.trim()) throw new Error("Enter the program that starts the server.");
          servers.set(serverId, {
            id: serverId,
            name: request.command.trim().split(/[\\/]/).pop() ?? "local server",
            version: "1.0.0",
            transport: "stdio",
            tools: MCP_TOOLS.length,
          });
        } else {
          let url: URL;
          try {
            url = new URL(request.url);
          } catch {
            throw new Error("Enter a full server URL, starting with https://.");
          }
          const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
            throw new Error("Use an https:// URL. Plain http only works for servers on this computer.");
          }
          servers.set(serverId, { id: serverId, name: url.hostname, version: "1.0.0", transport: "http", tools: MCP_TOOLS.length });
        }
        return snapshot();
      }),

    mcpDisconnect: (serverId) =>
      settle(() => {
        guardIdle("changing tool servers");
        servers.delete(serverId);
        return snapshot();
      }),

    mcpTools: (serverId) =>
      settle(() => {
        if (!servers.has(serverId)) throw new Error("Attach the server first.");
        return MCP_TOOLS.map((tool) => ({ ...tool }));
      }),

    mcpCall: (serverId, name, args) =>
      settle(() => {
        if (!servers.has(serverId)) throw new Error("Attach the server first.");
        if (!MCP_TOOLS.some((tool) => tool.name === name)) throw new Error(`${name} is not a tool on this server.`);
        const output = JSON.stringify({ tool: name, arguments: args, result: { items: [], note: "Mock response" } }, null, 2);
        const run = startRun("Tool inspector", `${serverId} ${name}`, "", "", Date.now());
        run.status = "complete";
        run.steps = [{ name: `${serverId}.${name}`, detail: "tool inspector", status: "ok", ms: 96, preview: "" }];
        run.output = output;
        run.ms = 96;
        activity.unshift(run);
        return output;
      }),

    listModels: async (request) => {
      await ready;
      if (speed > 0) await new Promise((done) => setTimeout(done, 350 * speed));
      return listModels(request);
    },

    saveAssistant: (request: AssistantRequest) =>
      settle(() => {
        guardIdle("changing the model");
        saveAssistant(request);
        return snapshot();
      }),

    forgetProvider: (provider) =>
      settle(() => {
        guardIdle("changing the model");
        const known = PROVIDERS.find((entry) => entry.id === provider);
        if (!known) throw new Error("Choose a provider first.");
        stored[known.id] = { hasKey: false, model: "", account: "", gateway: "default", url: known.url };
        if (active === provider) active = "none";
        return snapshot();
      }),

    setTheme: (next) =>
      settle(() => {
        theme = next;
        return snapshot();
      }),

    setWebSearch: (on) =>
      settle(() => {
        webSearch = on;
        return snapshot();
      }),

    openExternal: async (url) => {
      if (!/^https:\/\//.test(url)) throw new Error("Only https links can be opened in the browser.");
      globalThis.open?.(url, "_blank", "noopener");
    },

    onSnapshot(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function flag(value: string | null): boolean | undefined {
  if (value === "1") return true;
  return value === "0" ? false : undefined;
}

function numberOf(value: string | null): number | undefined {
  const parsed = value === null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Reads the forced starting state from the page URL. */
export function mockOptionsFromUrl(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const markets = numberOf(params.get("markets"));
  return {
    seed: oneOf(params.get("seed"), ["empty", "conversation", "filled", "unconfirmed", "expired", "live", "liveticket"] as const),
    network: oneOf(params.get("network"), ["mainnet", "testnet"] as const),
    wallet: oneOf(params.get("wallet"), ["connected", "deposit", "none", "error"] as const),
    positions: flag(params.get("positions")),
    ticket: oneOf(params.get("ticket"), ["long", "short", "close"] as const),
    pending: flag(params.get("pending")),
    multi: flag(params.get("multi")),
    provider: oneOf(params.get("provider"), ["none", "openrouter", "cloudflare", "ollama", "lmstudio"] as const),
    local: oneOf(params.get("local"), ["up", "down", "retry"] as const),
    history: flag(params.get("history")),
    markets: markets === undefined ? undefined : Math.min(2000, Math.floor(markets)),
    theme: oneOf(params.get("theme"), ["system", "light", "dark"] as const),
    mcp: flag(params.get("mcp")),
    web: flag(params.get("web")),
    speed: numberOf(params.get("speed")),
  };
}
