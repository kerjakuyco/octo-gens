/**
 * An in-browser stand-in for the Rust core.
 *
 * It lets `pnpm dev` run in a plain browser, drives screenshots, and backs the
 * unit tests. Prices, fills, models and answers are generated here and are
 * entirely fictional. Nothing in this file talks to a network.
 *
 * URL parameters (browser only) force a starting state:
 *   seed=empty|conversation|filled|live|liveticket   conversation to start with
 *   feed=sample|binance|bybit|okx                    active price feed
 *   provider=builtin|openrouter|ollama               assistant provider
 *   theme=system|light|dark                          colour theme
 *   keys=binance,okx                                 venues with API keys loaded
 *   mcp=bybit                                        venues with an MCP server attached
 *   speed=0.25                                       multiplier for scripted delays
 */

import type {
  AccountView,
  AssistantRequest,
  AssistantView,
  Backend,
  BalanceRow,
  CandleRow,
  CandleSeries,
  CredentialsRequest,
  Feed,
  FillView,
  InstrumentView,
  McpConnectRequest,
  McpView,
  ModelInfo,
  Provider,
  QuoteView,
  RunView,
  Side,
  Snapshot,
  StepView,
  Theme,
  TicketRequest,
  TicketView,
  Timeframe,
  ToolInfo,
  TurnEvent,
  UsageView,
  VenueId,
  VenueView,
  WatchView,
} from "./types";

export type MockSeed = "empty" | "conversation" | "filled" | "live" | "liveticket";

export interface MockOptions {
  seed?: MockSeed;
  feed?: Feed;
  provider?: Provider;
  theme?: Theme;
  /** Venues that start with API keys loaded. */
  keys?: VenueId[];
  /** Venues that start with an MCP server attached. */
  mcp?: VenueId[];
  /** Multiplier for scripted delays. `0` makes every turn finish immediately. */
  speed?: number;
  /** Pause the next streamed answer half-way until `stopTurn` is called. */
  hold?: boolean;
}

/* ------------------------------------------------------------- generators */

const SAMPLE_CLOCK = "2025-03-07T21:00:00.000Z";
const VENUES: VenueId[] = ["binance", "bybit", "okx"];
const VENUE_NAMES: Record<VenueId, string> = { binance: "Binance", bybit: "Bybit", okx: "OKX" };
const OFFICIAL: Record<VenueId, string | null> = {
  binance: null,
  bybit: "bybit-official-trading-server@2.1.28",
  okx: "@okx_ai/okx-trade-mcp@1.5.1",
};
const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};
const TIMEFRAME_SWING: Record<Timeframe, number> = { "15m": 0.0022, "1h": 0.0045, "4h": 0.009, "1d": 0.02 };

interface Spec {
  ticker: string;
  name: string;
  anchor: number;
  underlying: string | null;
  custom: boolean;
}

const UNIVERSE_ROWS: [ticker: string, name: string, anchor: number, underlying?: string][] = [
  ["BTC", "Bitcoin", 84215.5],
  ["ETH", "Ethereum", 2145.72],
  ["SOL", "Solana", 142.08],
  ["BNB", "BNB", 612.4],
  ["XRP", "XRP", 2.31],
  ["DOGE", "Dogecoin", 0.1834],
  ["ADA", "Cardano", 0.7421],
  ["AVAX", "Avalanche", 23.87],
  ["LINK", "Chainlink", 15.62],
  ["SUI", "Sui", 2.94],
  ["TSLAx", "Tesla xStock", 324.7, "TSLA"],
  ["AAPLx", "Apple xStock", 219.38, "AAPL"],
  ["NVDAx", "NVIDIA xStock", 144.58, "NVDA"],
  ["SPYx", "SPDR S&P 500 ETF xStock", 587.16, "SPY"],
];

const UNIVERSE: Spec[] = UNIVERSE_ROWS.map(([ticker, name, anchor, underlying]) => ({
  ticker,
  name,
  anchor,
  underlying: underlying ?? null,
  custom: false,
}));

function pairOf(spec: Spec): string {
  return `${spec.ticker.toUpperCase()}/USDT`;
}

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

function decimals(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 8;
}

function amount(value: number): string {
  return value.toFixed(decimals(value));
}

function trimUnits(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "");
}

function pretty(value: number): string {
  const digits = decimals(value);
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function id(): string {
  const next = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return next() + next() + next() + next();
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

/** Fictional models, so nobody mistakes the mock list for a real catalog. */
const MODEL_ROWS: ModelRow[] = [
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
  ["harbor/auto", "Harbor Auto Router", 2_000_000, null, null, true, false, 1775000000],
];

const MODELS: ModelInfo[] = MODEL_ROWS.map(
  ([modelId, name, context, promptPrice, completionPrice, tools, reasoning, created]) => ({
    id: modelId,
    name,
    context,
    promptPrice,
    completionPrice,
    tools,
    reasoning,
    free: promptPrice === 0,
    created,
  }),
);

const MCP_TOOLS: ToolInfo[] = [
  {
    name: "get_tickers",
    description: "Latest price, 24h range and volume for one spot symbol.",
    schema: {
      type: "object",
      properties: { category: { type: "string", enum: ["spot"] }, symbol: { type: "string" } },
      required: ["category", "symbol"],
    },
    readOnly: true,
  },
  {
    name: "get_orderbook",
    description: "Order book depth for a spot symbol.",
    schema: {
      type: "object",
      properties: { symbol: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } },
      required: ["symbol"],
    },
    readOnly: true,
  },
  {
    name: "get_kline",
    description: "Candles for a symbol and interval.",
    schema: {
      type: "object",
      properties: { symbol: { type: "string" }, interval: { type: "string" }, limit: { type: "integer" } },
      required: ["symbol", "interval"],
    },
    readOnly: true,
  },
  {
    name: "get_wallet_balance",
    description: "Balances of the unified trading account. Needs API keys.",
    schema: { type: "object", properties: { accountType: { type: "string" } }, required: ["accountType"] },
    readOnly: true,
  },
  {
    name: "place_order",
    description: "Submit an order. Not marked read-only, so the assistant cannot call it.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["Buy", "Sell"] },
        orderType: { type: "string" },
        qty: { type: "string" },
      },
      required: ["symbol", "side", "orderType", "qty"],
    },
    readOnly: false,
  },
];

/* -------------------------------------------------------------- the mock */

interface Position {
  qty: number;
  cost: number;
}

interface Book {
  cash: number;
  positions: Map<string, Position>;
  orders: FillView[];
}

interface VenueState {
  credentials: boolean;
  remembered: boolean;
  mcp: McpView | null;
}

class Stopped extends Error {}

function newBook(): Book {
  return { cash: 100_000, positions: new Map(), orders: [] };
}

export function createMockBackend(options: MockOptions = {}): Backend {
  const speed = options.speed ?? 1;
  let hold = options.hold ?? false;

  let feed: Feed = options.feed ?? "sample";
  let focus = "BTC/USDT";
  let tick = 0;
  let theme: Theme = options.theme ?? "system";
  let thread = id().slice(0, 12);
  let runs: RunView[] = [];
  let draft: TicketView | null = null;
  let watch: WatchView | null = null;
  let busy = false;
  let stopRequested = false;
  let wake: (() => void) | null = null;
  const receipts: Record<string, string> = {};
  const watchlist: Spec[] = UNIVERSE.map((spec) => ({ ...spec }));
  const books: Record<Feed, Book> = {
    sample: newBook(),
    binance: newBook(),
    bybit: newBook(),
    okx: newBook(),
  };
  const venues: Record<VenueId, VenueState> = {
    binance: { credentials: false, remembered: false, mcp: null },
    bybit: { credentials: false, remembered: false, mcp: null },
    okx: { credentials: false, remembered: false, mcp: null },
  };
  const listeners = new Set<(snapshot: Snapshot) => void>();

  const provider = options.provider ?? "builtin";
  let assistant: AssistantView = {
    provider,
    model: provider === "openrouter" ? "lantern/lantern-2-large" : provider === "ollama" ? "qwen3:4b" : "",
    label: "",
    hasKey: provider === "openrouter",
    tools: provider === "openrouter",
    reasoning: provider === "openrouter",
    effort: "auto",
    liveTickets: false,
  };

  for (const venue of options.keys ?? []) venues[venue].credentials = true;
  for (const venue of options.mcp ?? []) {
    venues[venue].mcp = {
      name: `${VENUE_NAMES[venue]} trading server`,
      version: "2.1.28",
      transport: OFFICIAL[venue] ? "official" : "stdio",
      tools: MCP_TOOLS.length,
    };
  }

  /* ---------------------------------------------------------- market data */

  const find = (pair: string): Spec | undefined => watchlist.find((spec) => pairOf(spec) === pair);

  function resolve(raw: string): Spec {
    const text = raw.trim().toUpperCase().replace(/^\$/, "").replace("-", "/");
    const spec = watchlist.find((candidate) => {
      const ticker = candidate.ticker.toUpperCase();
      return text === ticker || text === `${ticker}/USDT` || text === `${ticker}USDT`;
    });
    if (spec) return spec;
    const underlying = watchlist.find((candidate) => candidate.underlying === text.replace("/USDT", ""));
    if (underlying) {
      throw new Error(
        `${underlying.underlying} is the underlying share. Use ${underlying.ticker}/USDT for its tokenized stock.`,
      );
    }
    throw new Error(`${raw.trim()} is not on your watchlist. Add it from the market panel first.`);
  }

  function livePrice(spec: Spec, source: Feed = feed): number {
    if (source === "sample") return spec.anchor;
    const bias = ((hash(source + spec.ticker) % 200) - 100) / 100_000;
    const wobble = (random(hash(`${spec.ticker}:${tick}`))() - 0.5) * 0.004;
    return spec.anchor * (1.012 + bias + wobble);
  }

  function asOf(): string {
    return feed === "sample" ? SAMPLE_CLOCK : new Date().toISOString();
  }

  function quote(spec: Spec): QuoteView {
    const last = livePrice(spec);
    const levels = walk(`${feed}:${pairOf(spec)}:1d`, 91, TIMEFRAME_SWING["1d"], last);
    const closes = levels.slice(0, 90);
    const previous = closes[closes.length - 1]!;
    const live = feed !== "sample";
    const high = Math.max(last, previous) * 1.011;
    const low = Math.min(last, previous) * 0.989;
    const volume = (4_000_000_000 / spec.anchor) * (0.4 + (hash(spec.ticker) % 100) / 60);
    return {
      pair: pairOf(spec),
      price: amount(last),
      changePct: Number(((last / previous - 1) * 100).toFixed(2)),
      high24h: live ? amount(high) : null,
      low24h: live ? amount(low) : null,
      volume24h: live ? volume.toFixed(2) : null,
      quoteVolume24h: live ? (volume * last).toFixed(2) : null,
      bid: live ? amount(last * 0.9999) : null,
      ask: live ? amount(last * 1.0001) : null,
      closes: closes.map(amount),
      asOf: asOf(),
      source: live ? `${VENUE_NAMES[feed as VenueId]} spot` : "Sample tape",
      sample: !live,
    };
  }

  function candleRows(spec: Spec, timeframe: Timeframe): CandleRow[] {
    const length = 160;
    const swing = TIMEFRAME_SWING[timeframe];
    const closes = walk(`${feed}:${pairOf(spec)}:${timeframe}`, length + 1, swing, livePrice(spec));
    const next = random(hash(`ohlc:${pairOf(spec)}:${timeframe}`));
    const span = TIMEFRAME_MS[timeframe];
    const end = Math.floor(Date.parse(asOf()) / span) * span;
    const baseVolume = 60_000_000 / spec.anchor / (86_400_000 / span);
    const rows: CandleRow[] = [];
    for (let index = 1; index <= length; index += 1) {
      const open = closes[index - 1]!;
      const close = closes[index]!;
      const high = Math.max(open, close) * (1 + next() * swing * 0.7);
      const low = Math.min(open, close) * (1 - next() * swing * 0.7);
      const volume = baseVolume * (0.4 + next() * 1.6);
      rows.push([end - (length - index) * span, amount(open), amount(high), amount(low), amount(close), volume.toFixed(4)]);
    }
    return rows;
  }

  /* -------------------------------------------------------------- account */

  function account(): AccountView {
    const book = books[feed];
    let equity = book.cash;
    const holdings = [...book.positions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pair, position]) => {
        const spec = find(pair);
        const value = position.qty * (spec ? livePrice(spec) : 0);
        equity += value;
        return {
          pair,
          qty: trimUnits(position.qty),
          value: value.toFixed(2),
          cost: position.cost.toFixed(2),
          pnl: (value - position.cost).toFixed(2),
        };
      });
    return { cash: book.cash.toFixed(2), equity: equity.toFixed(2), holdings, orders: [...book.orders] };
  }

  function fill(book: Book, pair: string, side: Side, qty: number, at: number, orderId: string, when: string): void {
    const value = Math.round(qty * at * 100) / 100;
    const position = book.positions.get(pair) ?? { qty: 0, cost: 0 };
    if (side === "buy") {
      if (value > book.cash) throw new Error("There is not enough paper cash for this order.");
      book.cash -= value;
      book.positions.set(pair, { qty: position.qty + qty, cost: position.cost + value });
    } else {
      if (qty > position.qty + 1e-12) throw new Error("The sell quantity exceeds your paper holding.");
      const released = Math.round(((position.cost * qty) / position.qty) * 100) / 100;
      book.cash += value;
      const left = position.qty - qty;
      if (left > 1e-12) book.positions.set(pair, { qty: left, cost: position.cost - released });
      else book.positions.delete(pair);
    }
    book.orders.unshift({
      id: orderId,
      pair,
      side,
      qty: trimUnits(qty),
      price: amount(at),
      status: "filled",
      submitted: when,
    });
  }

  /* ------------------------------------------------------------- snapshot */

  function assistantLabel(): string {
    if (assistant.provider === "openrouter" && assistant.model) return `OpenRouter · ${assistant.model}`;
    if (assistant.provider === "ollama" && assistant.model) return `Ollama · ${assistant.model}`;
    return "Built-in agents";
  }

  function instruments(): InstrumentView[] {
    return watchlist.map((spec) => ({
      pair: pairOf(spec),
      ticker: spec.ticker,
      name: spec.name,
      kind: spec.underlying ? "xstock" : "crypto",
      underlying: spec.underlying,
      custom: spec.custom,
    }));
  }

  function venueViews(): VenueView[] {
    return VENUES.map((venue) => ({
      id: venue,
      name: VENUE_NAMES[venue],
      credentials: venues[venue].credentials,
      remembered: venues[venue].remembered,
      mcp: venues[venue].mcp,
      officialPackage: OFFICIAL[venue],
    }));
  }

  function snapshot(): Snapshot {
    const quotes: Record<string, QuoteView> = {};
    for (const spec of watchlist) quotes[pairOf(spec)] = quote(spec);
    return {
      version: "0.3.0",
      feed,
      focus,
      feedError: "",
      instruments: instruments(),
      quotes,
      account: account(),
      venues: venueViews(),
      assistant: { ...assistant, label: assistantLabel() },
      theme,
      thread,
      runs: runs.map((run) => ({ ...run, steps: run.steps.map((step) => ({ ...step })) })),
      draft: draft ? { ...draft } : null,
      receipts: { ...receipts },
      watch: watch ? { ...watch } : null,
      nodeRuntime: true,
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

  /** Simulated latency for ordinary commands. */
  async function settle<T>(work: () => T): Promise<T> {
    if (speed > 0) await new Promise((done) => setTimeout(done, 90 * speed));
    return work();
  }

  /* -------------------------------------------------------------- tickets */

  function buildTicket(request: TicketRequest, rationale: string): TicketView {
    const spec = resolve(request.pair);
    const last = livePrice(spec);
    let qty: number;
    if (request.qty !== undefined && request.qty !== "") {
      if (!/^(?:\d{1,9}(?:\.\d{1,8})?|\.\d{1,8})$/.test(request.qty.trim())) {
        throw new Error("Enter a positive quantity with up to eight decimal places.");
      }
      qty = Number(request.qty);
    } else if (request.quoteAmount !== undefined && request.quoteAmount !== "") {
      const quoteAmount = Number(request.quoteAmount);
      if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) throw new Error("Enter a positive USDT amount.");
      qty = Math.floor((quoteAmount / last) * 1e8) / 1e8;
    } else {
      throw new Error("Enter a quantity or a USDT amount.");
    }
    if (!(qty > 0)) throw new Error("That amount is too small to trade.");
    if (request.destination === "exchange") {
      if (feed === "sample") throw new Error("Switch to a live feed to send an exchange order.");
      if (!venues[feed].credentials) {
        throw new Error(`Add ${VENUE_NAMES[feed]} API keys in Connections to send live orders.`);
      }
    }
    return {
      id: id(),
      pair: pairOf(spec),
      side: request.side,
      qty: trimUnits(qty),
      price: amount(last),
      value: (qty * last).toFixed(2),
      feed,
      destination: request.destination,
      rationale,
    };
  }

  function submit(ticketId: string): void {
    if (!draft || draft.id !== ticketId) throw new Error("This ticket expired. Draft a new one.");
    const ticket = draft;
    const spec = resolve(ticket.pair);
    if (ticket.destination === "exchange") {
      const venue = VENUE_NAMES[ticket.feed as VenueId];
      receipts[ticket.id] = `${venue} acknowledged the order. Order id ${hash(ticket.id) % 10_000_000_000}.`;
    } else {
      const last = livePrice(spec);
      fill(books[feed], ticket.pair, ticket.side, Number(ticket.qty), last, ticket.id, new Date().toISOString());
      receipts[ticket.id] =
        `Paper fill: ${ticket.side === "buy" ? "bought" : "sold"} ${ticket.qty} ${spec.ticker} at ${pretty(last)} USDT.`;
    }
    draft = null;
  }

  /* ---------------------------------------------------------------- turns */

  function mentioned(prompt: string): Spec[] {
    const found: Spec[] = [];
    for (const word of prompt.toUpperCase().match(/[A-Z0-9]+/g) ?? []) {
      const spec = watchlist.find(
        (candidate) => candidate.ticker.toUpperCase() === word || candidate.name.toUpperCase() === word,
      );
      if (spec && !found.includes(spec)) found.push(spec);
    }
    return found.slice(0, 4);
  }

  function stats(spec: Spec) {
    const view = quote(spec);
    const closes = view.closes.map(Number);
    const last = Number(view.price);
    const fiveAgo = closes[closes.length - 5] ?? last;
    const next = random(hash(`stats:${spec.ticker}`));
    return {
      spec,
      last,
      five: (last / fiveAgo - 1) * 100,
      rsi: 38 + next() * 34,
      atr: 0.6 + next() * 1.8,
      support: last * (0.972 + next() * 0.01),
      resistance: last * (1.018 + next() * 0.012),
    };
  }

  function sourceNote(): string {
    return feed === "sample"
      ? "Sample tape prices are fictional, so read this as a walkthrough rather than a signal."
      : `Prices are ${VENUE_NAMES[feed as VenueId]} spot as of ${new Date().toISOString().slice(11, 16)} UTC.`;
  }

  function researchAnswer(specs: Spec[]): string {
    const rows = specs.map(stats);
    const lead = rows[0]!;
    if (rows.length > 1) {
      const ranked = [...rows].sort((left, right) => right.five - left.five);
      const table = rows
        .map(
          (row) =>
            `| ${row.spec.ticker} | ${pretty(row.last)} | ${signed(row.five)} | ${row.rsi.toFixed(1)} | ${row.atr.toFixed(2)}% |`,
        )
        .join("\n");
      return [
        `**${ranked[0]!.spec.ticker} has the stronger tape** over the last five sessions; ${ranked[ranked.length - 1]!.spec.ticker} is lagging.`,
        "",
        "| Token | Price (USDT) | 5 sessions | RSI 14 | ATR 14 |",
        "|:--|--:|--:|--:|--:|",
        table,
        "",
        `- ${ranked[0]!.spec.ticker} leads on momentum at ${signed(ranked[0]!.five)}.`,
        `- Volatility is highest in ${[...rows].sort((left, right) => right.atr - left.atr)[0]!.spec.ticker}, so size it smaller for the same risk.`,
        "- None of the readings is stretched: RSI sits between 30 and 70 for all of them.",
        "",
        sourceNote(),
      ].join("\n");
    }
    const trend = lead.five >= 0 ? "a short-term uptrend" : "a short-term pullback";
    return [
      `**${lead.spec.ticker} is in ${trend}**, last at ${pretty(lead.last)} USDT.`,
      "",
      "### What the 4h chart shows",
      `- Five-session change is ${signed(lead.five)}.`,
      `- RSI 14 reads ${lead.rsi.toFixed(1)}: ${lead.rsi > 60 ? "firm, not stretched" : "neutral"}.`,
      `- Nearest support is around ${pretty(lead.support)}; resistance around ${pretty(lead.resistance)}.`,
      "",
      "| Reading | Value |",
      "|:--|--:|",
      `| Last price | ${pretty(lead.last)} USDT |`,
      `| ATR 14 | ${lead.atr.toFixed(2)}% |`,
      `| Distance to support | ${signed((lead.support / lead.last - 1) * 100)} |`,
      "",
      `A close below ${pretty(lead.support)} would invalidate the setup. ${sourceNote()}`,
    ].join("\n");
  }

  function portfolioAnswer(): string {
    const view = account();
    const lines = [
      `Paper equity is **${Number(view.equity).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT**, with ${Number(view.cash).toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT in cash.`,
    ];
    if (view.holdings.length === 0) {
      lines.push("", "There are no open positions on this feed yet.");
    } else {
      lines.push("", "| Position | Units | Value (USDT) | P/L (USDT) |", "|:--|--:|--:|--:|");
      for (const holding of view.holdings) {
        lines.push(`| ${holding.pair} | ${holding.qty} | ${holding.value} | ${holding.pnl} |`);
      }
    }
    return lines.join("\n");
  }

  function startRun(agent: string, title: string, model: string): RunView {
    return {
      id: id().slice(0, 10),
      thread,
      agent,
      title,
      feed,
      time: new Date().toISOString(),
      status: "running",
      steps: [],
      output: "",
      reasoning: "",
      ms: 0,
      ticket: null,
      usage: null,
      model,
    };
  }

  async function ask(prompt: string, onEvent: (event: TurnEvent) => void): Promise<Snapshot> {
    const text = prompt.trim();
    if (!text) throw new Error("Type a question or a command first.");
    if (text.length > 2500) throw new Error("Keep the prompt under 2,500 characters.");
    if (busy) throw new Error("The assistant is still working. Stop it or wait for it to finish.");

    const order = /^(?:please\s+)?(buy|sell)\s+([\d.]+)\s+([\w/$-]+)[.!]?$/i.exec(text);
    const model = assistant.provider === "builtin" ? "" : assistant.model;
    const agent = order ? "Order agent" : assistant.provider === "builtin" ? "Research agent" : "Assistant";
    const run = startRun(agent, text, order ? "" : model);
    const started = performance.now();
    busy = true;
    stopRequested = false;
    onEvent({ type: "started", run: { ...run } });

    async function step(name: string, detail: string, ms: number, preview: string, fails = false): Promise<void> {
      const index = run.steps.length;
      const entry: StepView = { name, detail, status: "running", ms: 0, preview: "" };
      run.steps.push(entry);
      onEvent({ type: "step", index, step: { ...entry } });
      try {
        await pause(ms);
      } catch (error) {
        entry.status = "error";
        entry.preview = "Stopped.";
        onEvent({ type: "step", index, step: { ...entry } });
        throw error;
      }
      entry.status = fails ? "error" : "ok";
      entry.ms = Math.round(ms * (0.8 + Math.random() * 0.4));
      entry.preview = preview;
      onEvent({ type: "step", index, step: { ...entry } });
    }

    async function stream(answer: string): Promise<void> {
      const pieces = answer.match(/[\s\S]{1,14}/g) ?? [];
      for (const [index, piece] of pieces.entries()) {
        if (hold && index === Math.ceil(pieces.length / 2)) {
          hold = false;
          await pause(86_400_000);
        }
        run.output += piece;
        onEvent({ type: "text", delta: piece });
        await pause(22);
      }
    }

    try {
      if (order) {
        const spec = resolve(order[3]!);
        await step("get_quote", pairOf(spec), 260, `${pairOf(spec)} last ${pretty(livePrice(spec))} USDT`);
        const ticket = buildTicket(
          { pair: pairOf(spec), side: order[1]!.toLowerCase() as Side, qty: order[2]!, destination: "paper" },
          "",
        );
        draft = ticket;
        run.ticket = ticket;
        onEvent({ type: "ticket", ticket: { ...ticket } });
        run.output = `Drafted a paper ticket to ${ticket.side} ${ticket.qty} ${spec.ticker}, about ${pretty(Number(ticket.value))} USDT. Nothing is sent until you confirm it.`;
        onEvent({ type: "text", delta: run.output });
      } else if (/\bfail/i.test(text)) {
        await step("get_quote", focus, 240, `${focus} quoted`);
        await step("openrouter.chat", model || "lantern/lantern-2-large", 700, "402 insufficient credits", true);
        throw new Error(
          "OpenRouter (402): this key has no credits left. Add credits at openrouter.ai, then ask again.",
        );
      } else if (/\b(portfolio|holdings|positions|cash|balance|exposure)\b/i.test(text)) {
        await step("get_portfolio", feed === "sample" ? "paper account" : `paper account on ${feed}`, 180, "equity and positions read");
        onEvent({ type: "round" });
        await stream(portfolioAnswer());
      } else {
        const found = mentioned(text);
        const specs = found.length > 0 ? found : [resolve(focus)];
        const wantsTicket = /\b(size|long|risk|position|enter)\b/i.test(text);
        if (assistant.provider !== "builtin") {
          onEvent({ type: "text", delta: "Pulling fresh quotes first." });
          for (const piece of ["The user wants a read on ", specs.map((spec) => spec.ticker).join(" and "), ". Fetch quotes, then indicators on the 4h chart before judging the trend."]) {
            run.reasoning += piece;
            onEvent({ type: "reasoning", delta: piece });
            await pause(120);
          }
        }
        await step("get_quote", specs.map(pairOf).join(", "), 420, specs.map((spec) => `${spec.ticker} ${pretty(livePrice(spec))}`).join(", "));
        for (const spec of specs.slice(0, 2)) {
          const row = stats(spec);
          await step("analyze_market", `${pairOf(spec)} · 4h`, 520, `RSI ${row.rsi.toFixed(1)}, ATR ${row.atr.toFixed(2)}%, trend ${row.five >= 0 ? "up" : "down"}`);
        }
        if (feed !== "sample" && specs.length === 1) {
          await step("get_order_book", pairOf(specs[0]!), 310, "spread 0.8 bps, bids 54% of depth within 0.5%");
        }
        onEvent({ type: "round" });
        if (assistant.provider !== "builtin") {
          const piece = " Momentum and volatility are in hand; write the verdict first, evidence second.";
          run.reasoning += piece;
          onEvent({ type: "reasoning", delta: piece });
        }
        await stream(researchAnswer(specs));
        if (wantsTicket) {
          const spec = specs[0]!;
          const riskUsdt = Number(account().equity) * 0.01;
          const row = stats(spec);
          const stopDistance = row.last - row.support;
          const qty = Math.floor((riskUsdt / stopDistance) * 1e6) / 1e6;
          await step("plan_position", `${pairOf(spec)} · 1% risk`, 140, `size ${trimUnits(qty)} ${spec.ticker}, stop ${pretty(row.support)}`);
          await step("propose_order", `buy ${trimUnits(qty)} ${spec.ticker} · paper`, 160, "ticket drafted");
          const ticket = buildTicket(
            { pair: pairOf(spec), side: "buy", qty: trimUnits(qty), destination: "paper" },
            `Risking 1% of equity with a stop at ${pretty(row.support)} USDT.`,
          );
          draft = ticket;
          run.ticket = ticket;
          onEvent({ type: "ticket", ticket: { ...ticket } });
        }
        if (assistant.provider === "openrouter") {
          const usage: UsageView = {
            promptTokens: 2380 + specs.length * 410,
            completionTokens: Math.round(run.output.length / 3.6),
            cost: 0.0094 + specs.length * 0.0021,
          };
          run.usage = usage;
        }
      }
      run.status = "complete";
    } catch (error) {
      if (error instanceof Stopped) {
        run.status = "stopped";
      } else {
        run.status = "failed";
        run.output = error instanceof Error ? error.message : String(error);
      }
    }

    run.ms = Math.round(performance.now() - started);
    busy = false;
    stopRequested = false;
    runs.unshift(run);
    onEvent({ type: "finished", run: { ...run, steps: run.steps.map((entry) => ({ ...entry })) } });
    return snapshot();
  }

  /* ------------------------------------------------------- pattern agent */

  function patternRun(pair: string, budget: string): void {
    const spec = resolve(pair);
    const row = stats(spec);
    const run = startRun("Pattern agent", `Evaluate ${spec.ticker}`, "");
    const up = Math.round(1 + (hash(spec.ticker) % 4));
    run.steps.push({
      name: "pattern.evaluate",
      detail: `${pairOf(spec)} · max ${budget} USDT`,
      status: "ok",
      ms: 38,
      preview: `${up}/5 past matches rose`,
    });
    run.status = "complete";
    run.ms = 41;
    run.output = [
      "Hold: the historical matches do not agree strongly enough.",
      `${up} of 5 past matches rose, ${5 - up} fell.`,
      `${pairOf(spec)} last ${pretty(row.last)} USDT.`,
    ].join("\n");
    runs.unshift(run);
  }

  function budgetOf(raw: string): string {
    const text = raw.trim();
    if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
      throw new Error("Enter a positive maximum trade value in USDT, with up to two decimals.");
    }
    return text;
  }

  /* ---------------------------------------------------------------- seeds */

  function seedBook(): void {
    const book = books[feed];
    const day = 86_400_000;
    const base = Date.now();
    const btc = resolve("BTC");
    const sol = resolve("SOL");
    const tsla = resolve("TSLAx");
    fill(book, pairOf(btc), "buy", 0.25, livePrice(btc) * 0.962, id(), new Date(base - 3 * day).toISOString());
    fill(book, pairOf(sol), "buy", 60, livePrice(sol) * 1.035, id(), new Date(base - 2 * day).toISOString());
    fill(book, pairOf(tsla), "buy", 12, livePrice(tsla) * 0.981, id(), new Date(base - day).toISOString());
    fill(book, pairOf(sol), "sell", 20, livePrice(sol) * 1.012, id(), new Date(base - day / 2).toISOString());
  }

  function seedRun(title: string, agent: string, output: string, steps: StepView[], minutesAgo: number): RunView {
    const run = startRun(agent, title, agent === "Assistant" ? assistant.model : "");
    run.time = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    run.status = "complete";
    run.steps = steps;
    run.output = output;
    run.ms = steps.reduce((total, entry) => total + entry.ms, 0) + 1900;
    if (assistant.provider === "openrouter" && agent === "Assistant") {
      run.usage = { promptTokens: 3204, completionTokens: 412, cost: 0.0136 };
      run.reasoning = "Compare momentum and volatility for both, then rank them.";
    }
    return run;
  }

  function seedConversation(ticketState: "pending" | "filled" | "live"): void {
    seedBook();
    const eth = resolve("ETH");
    const sol = resolve("SOL");
    const agent = assistant.provider === "builtin" ? "Research agent" : "Assistant";
    const research = seedRun(
      "Compare ETH and SOL",
      agent,
      researchAnswer([eth, sol]),
      [
        { name: "get_quote", detail: "ETH/USDT, SOL/USDT", status: "ok", ms: 412, preview: `ETH ${pretty(livePrice(eth))}, SOL ${pretty(livePrice(sol))}` },
        { name: "analyze_market", detail: "ETH/USDT · 4h", status: "ok", ms: 538, preview: "RSI 58.4, ATR 1.31%, trend up" },
        { name: "analyze_market", detail: "SOL/USDT · 4h", status: "ok", ms: 497, preview: "RSI 47.9, ATR 2.02%, trend down" },
      ],
      9,
    );
    const live = ticketState === "live" && feed !== "sample";
    if (live) venues[feed as VenueId].credentials = true;
    const ticket = buildTicket(
      { pair: pairOf(eth), side: "buy", qty: "1.5", destination: live ? "exchange" : "paper" },
      "ETH leads on momentum and its volatility is the lower of the two.",
    );
    const order = seedRun(
      "Buy 1.5 ETH",
      "Order agent",
      `Drafted a ${live ? "live" : "paper"} ticket to buy 1.5 ETH, about ${pretty(Number(ticket.value))} USDT. Nothing is sent until you confirm it.`,
      [{ name: "get_quote", detail: "ETH/USDT", status: "ok", ms: 244, preview: `ETH/USDT last ${pretty(livePrice(eth))} USDT` }],
      2,
    );
    order.ticket = ticket;
    order.ms = 268;
    runs = [order, research];
    draft = ticket;
    if (ticketState === "filled") submit(ticket.id);
  }

  switch (options.seed) {
    case "conversation":
      seedConversation("pending");
      break;
    case "filled":
      seedConversation("filled");
      break;
    case "liveticket":
      seedConversation("live");
      break;
    case "live": {
      seedBook();
      hold = true;
      break;
    }
    default:
      break;
  }

  /* ------------------------------------------------------------- backend */

  const guardIdle = (action: string): void => {
    if (busy) throw new Error(`Stop the assistant before ${action}.`);
  };

  return {
    boot: () => settle(snapshot),
    snapshot: () => settle(snapshot),

    setFeed: (next) =>
      settle(() => {
        guardIdle("switching feeds");
        if (!["sample", ...VENUES].includes(next)) throw new Error("Unknown price feed.");
        feed = next;
        draft = null;
        return snapshot();
      }),

    selectPair: (pair) =>
      settle(() => {
        focus = pairOf(resolve(pair));
        return snapshot();
      }),

    refreshQuotes: () =>
      settle(() => {
        tick += 1;
        return snapshot();
      }),

    candles: (pair, timeframe) =>
      settle((): CandleSeries => {
        const spec = resolve(pair);
        return {
          pair: pairOf(spec),
          timeframe,
          rows: candleRows(spec, timeframe),
          source: feed === "sample" ? "Sample tape" : `${VENUE_NAMES[feed]} spot`,
          sample: feed === "sample",
        };
      }),

    watchAdd: (symbol) =>
      settle(() => {
        const ticker = symbol.trim().toUpperCase().replace(/^\$/, "").replace(/[/-]?USDT$/, "");
        if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new Error("Enter a token symbol such as PEPE or ARB.");
        if (watchlist.some((spec) => spec.ticker.toUpperCase() === ticker)) {
          throw new Error(`${ticker} is already on your watchlist.`);
        }
        if (feed === "sample") {
          throw new Error(`${ticker} has no sample data. Switch to Binance, Bybit or OKX to add it.`);
        }
        const anchor = Number((0.05 + (hash(ticker) % 9000) / 100).toFixed(4));
        watchlist.push({ ticker, name: ticker, anchor, underlying: null, custom: true });
        focus = `${ticker}/USDT`;
        return snapshot();
      }),

    watchRemove: (pair) =>
      settle(() => {
        const index = watchlist.findIndex((spec) => pairOf(spec) === pair && spec.custom);
        if (index === -1) throw new Error("Only symbols you added can be removed.");
        watchlist.splice(index, 1);
        if (focus === pair) focus = "BTC/USDT";
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
        thread = id().slice(0, 12);
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

    runPattern: (pair, budget) =>
      settle(() => {
        patternRun(pair, budgetOf(budget));
        return snapshot();
      }),

    startWatch: (pair, budget) =>
      settle(() => {
        const limit = budgetOf(budget);
        const spec = resolve(pair);
        patternRun(pair, limit);
        watch = { pair: pairOf(spec), budget: limit, feed };
        if (speed > 0) {
          // Stand in for the 15-minute timer so background snapshots can be seen in development.
          setTimeout(() => {
            if (watch?.pair !== pairOf(spec)) return;
            patternRun(pair, limit);
            push();
          }, 6000 * speed);
        }
        return snapshot();
      }),

    stopWatch: () =>
      settle(() => {
        watch = null;
        return snapshot();
      }),

    setCredentials: (request: CredentialsRequest) =>
      settle(() => {
        guardIdle("changing API keys");
        const name = VENUE_NAMES[request.venue];
        if (!request.key.trim() || !request.secret.trim()) throw new Error(`Enter both the ${name} API key and secret.`);
        if (request.venue === "okx" && !request.passphrase?.trim()) {
          throw new Error("OKX also needs the API passphrase you set when creating the key.");
        }
        venues[request.venue].credentials = true;
        venues[request.venue].remembered = request.remember;
        return snapshot();
      }),

    clearCredentials: (venue) =>
      settle(() => {
        guardIdle("changing API keys");
        venues[venue].credentials = false;
        venues[venue].remembered = false;
        if (draft?.destination === "exchange" && draft.feed === venue) draft = null;
        return snapshot();
      }),

    balances: (venue) =>
      settle((): BalanceRow[] => {
        if (!venues[venue].credentials) throw new Error(`Add ${VENUE_NAMES[venue]} API keys first.`);
        return [
          { asset: "USDT", total: "2480.12" },
          { asset: "BTC", total: "0.0412" },
          { asset: "ETH", total: "0.85" },
          { asset: "SOL", total: "14.2" },
        ];
      }),

    mcpConnect: (request: McpConnectRequest) =>
      settle(() => {
        guardIdle("attaching a server");
        const name = VENUE_NAMES[request.venue];
        if (request.transport === "official") {
          if (!OFFICIAL[request.venue]) throw new Error(`${name} does not publish an MCP server. Attach a custom one instead.`);
          venues[request.venue].mcp = { name: `${name} trading server`, version: "2.1.28", transport: "official", tools: MCP_TOOLS.length };
        } else if (request.transport === "stdio") {
          if (!request.command.trim()) throw new Error("Enter the program that starts the server.");
          venues[request.venue].mcp = { name: request.command.trim().split(/[\\/]/).pop() ?? "custom server", version: "1.0.0", transport: "stdio", tools: MCP_TOOLS.length };
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
          venues[request.venue].mcp = { name: url.hostname, version: "1.0.0", transport: "http", tools: MCP_TOOLS.length };
        }
        return snapshot();
      }),

    mcpDisconnect: (venue) =>
      settle(() => {
        guardIdle("detaching a server");
        venues[venue].mcp = null;
        return snapshot();
      }),

    mcpTools: (venue) =>
      settle(() => {
        if (!venues[venue].mcp) throw new Error("Attach the server first.");
        return MCP_TOOLS.map((tool) => ({ ...tool }));
      }),

    mcpCall: (venue, name, args) =>
      settle(() => {
        if (!venues[venue].mcp) throw new Error("Attach the server first.");
        if (!MCP_TOOLS.some((tool) => tool.name === name)) throw new Error(`${name} is not a tool on this server.`);
        const spec = resolve(focus);
        return JSON.stringify(
          { tool: name, arguments: args, result: { symbol: pairOf(spec).replace("/", ""), lastPrice: amount(livePrice(spec)), note: "Mock response" } },
          null,
          2,
        );
      }),

    listModels: async (key) => {
      if (speed > 0) await new Promise((done) => setTimeout(done, 350 * speed));
      if (key && !/^sk-or-/.test(key.trim())) throw new Error("OpenRouter keys start with sk-or-. Check the key and try again.");
      return MODELS.map((model) => ({ ...model }));
    },

    saveAssistant: (request: AssistantRequest) =>
      settle(() => {
        guardIdle("changing the model");
        let { model } = request;
        let { hasKey } = assistant;
        let tools = false;
        let reasoning = false;
        if (request.provider === "openrouter") {
          const key = request.key?.trim() ?? "";
          if (key && !/^sk-or-[\w-]{8,}$/.test(key)) throw new Error("Paste an OpenRouter key that starts with sk-or-.");
          if (!key && !assistant.hasKey) throw new Error("Paste your OpenRouter key to use OpenRouter models.");
          const info = MODELS.find((candidate) => candidate.id === model);
          if (!info) throw new Error("Choose a model from the list before saving.");
          hasKey = true;
          tools = info.tools;
          reasoning = info.reasoning;
        } else if (request.provider === "ollama") {
          if (!/^[\w.:/-]{1,80}$/.test(model.trim())) throw new Error("Enter the model tag shown by `ollama list`, for example qwen3:4b.");
          model = model.trim();
        } else {
          model = "";
        }
        assistant = {
          provider: request.provider,
          model,
          label: "",
          hasKey,
          tools,
          reasoning,
          effort: reasoning ? request.effort : "auto",
          liveTickets: request.liveTickets,
        };
        return snapshot();
      }),

    setTheme: (next) =>
      settle(() => {
        theme = next;
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

function venueList(value: string | null): VenueId[] {
  return (value ?? "").split(",").filter((item): item is VenueId => VENUES.includes(item as VenueId));
}

function speedOf(value: string | null): number | undefined {
  const speed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(speed) && speed >= 0 ? speed : undefined;
}

/** Reads the forced starting state from the page URL. */
export function mockOptionsFromUrl(search: string): MockOptions {
  const params = new URLSearchParams(search);
  return {
    seed: oneOf(params.get("seed"), ["empty", "conversation", "filled", "live", "liveticket"] as const),
    feed: oneOf(params.get("feed"), ["sample", "binance", "bybit", "okx"] as const),
    provider: oneOf(params.get("provider"), ["builtin", "openrouter", "ollama"] as const),
    theme: oneOf(params.get("theme"), ["system", "light", "dark"] as const),
    keys: venueList(params.get("keys")),
    mcp: venueList(params.get("mcp")),
    speed: speedOf(params.get("speed")),
  };
}

