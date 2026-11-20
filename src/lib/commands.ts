/**
 * Commands for the message box.
 *
 * A command is a shortcut for a message, never an action of its own. Picking `/long` with ETH and
 * 1% risk writes "Long ETH, 1% risk, technical stop-loss.", and the model answers that the way it
 * answers anything typed: it reads the market and the account, sizes the trade with its tools and
 * drafts a ticket the trader confirms. Every safeguard of a typed message holds for a command,
 * because a command is one.
 *
 * The words are plain on purpose. They show in the conversation as the trader's own message, they
 * title the chat in the sidebar, and Retry sends them again. They never ask the model to do
 * arithmetic: sizes come from its planning tool, and the share of a position to close is worked out
 * here, exactly, from the position's own quantity.
 */

import type { CardView, GridDirection, Network, PositionView, RunView, Snapshot, Timeframe } from "../api/types";
import type { IconName } from "../components/Icon";
import { activeWallet } from "./market";

export type CommandGroup = "trade" | "research" | "analysis" | "account";

export const COMMAND_GROUPS: readonly { id: CommandGroup; label: string }[] = [
  { id: "trade", label: "Trade" },
  { id: "research", label: "Research" },
  { id: "analysis", label: "Analysis" },
  { id: "account", label: "Account" },
];

/** A setting a command takes, shown as a chip beside it. */
export type ParamKey =
  | "side"
  | "market"
  | "other"
  | "risk"
  | "leverage"
  | "target"
  | "timeframe"
  | "share"
  | "mode"
  | "grids"
  | "margin";

export interface CommandValues {
  side: "long" | "short";
  /** Exchange symbol, e.g. `BTCUSDT`. */
  market: string;
  /** A second market, to compare with. */
  other: string;
  /** Percent of equity lost if the stop is hit. */
  risk: number;
  /** Leverage; 0 leaves it to the default, the smaller of 3x and the trader's limit. */
  leverage: number;
  /** Where a take-profit goes: none, or the next level the technical reading finds. */
  target: "none" | "level";
  timeframe: Timeframe;
  /** Share of a position to close, in percent. */
  share: number;
  /** Which way a grid bot leans: neutral starts flat, long starts with a long, short with a short. */
  mode: GridDirection;
  /** How many grids a grid bot splits its range into. */
  grids: number;
  /** Margin a grid bot trades with, in USDT. */
  margin: number;
}

/** What a command needs that may be missing. */
export type Need = "account" | "position" | "web" | "journal";

/** What the app knows that decides whether a command can run and what it writes. */
export interface CommandContext {
  network: Network;
  /** Whether the account can be read: a wallet is connected and has made its first deposit. */
  account: "ready" | "connect" | "deposit";
  positions: readonly PositionView[];
  webSearch: boolean;
  /** The assistant may draft mainnet tickets. */
  liveTickets: boolean;
  maxLeverage: number;
  /** The message that asks for a review of the trading journal, or empty when it holds nothing to review. */
  journalReview: string;
}

export interface Command {
  /** Typed after the slash. */
  id: string;
  title: string;
  /** One line on what it does. */
  hint: string;
  group: CommandGroup;
  icon: IconName;
  /** Other words that find it. */
  aliases: readonly string[];
  params: readonly ParamKey[];
  needs: readonly Need[];
  /** Writes the message. */
  write: (values: CommandValues, context: CommandContext) => string;
}

/** Where the trader can fix what stands in a command's way. */
export type FixTarget = "wallet" | "tools" | "trading" | "activity";

/** Why a command cannot be sent yet, or something to know before sending it. */
export interface CommandNote {
  text: string;
  fix: { label: string; target: FixTarget } | null;
}

/** Quote assets the exchange margins perpetuals in, longest first so `USD1` wins over a bare `USD`. */
const QUOTES = ["USDT", "USD1", "USDC"];

/** The coin a market trades, e.g. `BTC` for `BTCUSDT`. */
export function baseOf(symbol: string): string {
  const quote = QUOTES.find((candidate) => symbol.length > candidate.length && symbol.endsWith(candidate));
  return quote ? symbol.slice(0, -quote.length) : symbol;
}

/**
 * How a market is named in a message: by its coin for a USDT market, which is how traders say it,
 * otherwise by its symbol, so `BTCUSDC` is never read as `BTCUSDT`.
 */
export function marketName(symbol: string): string {
  return symbol.length > 4 && symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function leverageWords(values: CommandValues): string {
  return values.leverage > 0 ? ` at ${values.leverage}x` : "";
}

function openWords(side: "long" | "short", values: CommandValues): string {
  const verb = side === "long" ? "Long" : "Short";
  const target =
    values.target === "level" ? `, take-profit at the next ${side === "long" ? "resistance" : "support"}` : "";
  return `${verb} ${marketName(values.market)}${leverageWords(values)}, ${values.risk}% risk, technical stop-loss${target}.`;
}

function gridWords(values: CommandValues): string {
  return `Grid ${marketName(values.market)}, ${values.mode}, ${values.grids} grids between support and resistance on the ${values.timeframe}, ${values.margin} USDT margin${leverageWords(values)}. Draft it for me to start.`;
}

function reduceWords(values: CommandValues, context: CommandContext): string {
  const name = marketName(values.market);
  const position = context.positions.find((item) => item.symbol === values.market);
  if (!position) return `Reduce my ${name} position by ${values.share}%.`;
  const qty = shareOf(position.qty, values.share);
  const words = `Reduce my ${name} ${position.side} by ${values.share}%`;
  return qty ? `${words}: ${qty} of ${position.qty} ${baseOf(values.market)}.` : `${words}.`;
}

export const COMMANDS: readonly Command[] = [
  {
    id: "long",
    title: "Open a long",
    hint: "Sized from your risk, with a stop-loss",
    group: "trade",
    icon: "trendUp",
    aliases: ["buy", "open long"],
    params: ["market", "risk", "leverage", "target"],
    needs: ["account"],
    write: (values) => openWords("long", values),
  },
  {
    id: "short",
    title: "Open a short",
    hint: "Sized from your risk, with a stop-loss",
    group: "trade",
    icon: "trendDown",
    aliases: ["sell", "open short"],
    params: ["market", "risk", "leverage", "target"],
    needs: ["account"],
    write: (values) => openWords("short", values),
  },
  {
    id: "plan",
    title: "Plan a trade",
    hint: "Size, margin and liquidation, without a ticket",
    group: "trade",
    icon: "target",
    aliases: ["size", "position size", "risk"],
    params: ["side", "market", "risk", "leverage"],
    needs: ["account"],
    write: (values) =>
      `Plan a ${values.side} on ${marketName(values.market)}${leverageWords(values)}, ${values.risk}% risk, technical stop-loss. Size it, but don't draft a ticket yet.`,
  },
  {
    id: "close",
    title: "Close a position",
    hint: "The whole position, and its stop orders",
    group: "trade",
    icon: "exit",
    aliases: ["exit", "flatten"],
    params: ["market"],
    needs: ["position"],
    write: (values) => `Close my ${marketName(values.market)} position.`,
  },
  {
    id: "reduce",
    title: "Reduce a position",
    hint: "Take part of a position off",
    group: "trade",
    icon: "minus",
    aliases: ["trim", "take profit", "partial"],
    params: ["market", "share"],
    needs: ["position"],
    write: reduceWords,
  },
  {
    id: "grid",
    title: "Grid bot",
    hint: "Buys low and sells high inside a range",
    group: "trade",
    icon: "grid",
    aliases: ["range", "grid bot", "sideways"],
    params: ["market", "mode", "timeframe", "grids", "margin", "leverage"],
    needs: ["account"],
    write: gridWords,
  },
  {
    id: "outlook",
    title: "Market outlook",
    hint: "Price, trend, funding and the levels that matter",
    group: "research",
    icon: "chart",
    aliases: ["analysis", "view", "bias"],
    params: ["market"],
    needs: [],
    write: (values) => `${marketName(values.market)} outlook`,
  },
  {
    id: "why",
    title: "Why is it moving?",
    hint: "Recent headlines and catalysts",
    group: "research",
    icon: "news",
    aliases: ["catalyst", "move", "pump", "dump"],
    params: ["market"],
    needs: ["web"],
    write: (values) => `Why is ${marketName(values.market)} moving? Check recent news.`,
  },
  {
    id: "news",
    title: "Market news",
    hint: "The latest from crypto newsrooms and the economy",
    group: "research",
    icon: "magazine",
    aliases: ["headlines", "macro"],
    params: [],
    needs: ["web"],
    write: () => "Market news",
  },
  {
    id: "movers",
    title: "Top movers",
    hint: "Biggest gainers, losers and most traded",
    group: "research",
    icon: "bolt",
    aliases: ["gainers", "losers", "trending"],
    params: [],
    needs: [],
    write: () => "Top movers",
  },
  {
    id: "watchlist",
    title: "Scan my watchlist",
    hint: "Strongest to weakest, with funding",
    group: "research",
    icon: "star",
    aliases: ["scan", "watch"],
    params: [],
    needs: [],
    write: () => "Scan my watchlist: strongest and weakest, and any funding that stands out.",
  },
  {
    id: "funding",
    title: "Funding",
    hint: "The rate now, the next payment, and who pays",
    group: "research",
    icon: "percent",
    aliases: ["rate", "carry"],
    params: ["market"],
    needs: [],
    write: (values) =>
      `${marketName(values.market)} funding: the rate now, the next payment, and what it costs a long or a short to hold.`,
  },
  {
    id: "technicals",
    title: "Technical analysis",
    hint: "Trend, RSI, MACD, volatility and levels",
    group: "analysis",
    icon: "activity",
    aliases: ["ta", "indicators", "rsi", "macd"],
    params: ["market", "timeframe"],
    needs: [],
    write: (values) => `${marketName(values.market)} technicals on the ${values.timeframe}.`,
  },
  {
    id: "levels",
    title: "Support and resistance",
    hint: "The levels to trade around",
    group: "analysis",
    icon: "levels",
    aliases: ["support", "resistance", "sr", "key levels"],
    params: ["market", "timeframe"],
    needs: [],
    write: (values) => `${marketName(values.market)} support and resistance on the ${values.timeframe}.`,
  },
  {
    id: "book",
    title: "Order book",
    hint: "Spread, depth and which side is heavier",
    group: "analysis",
    icon: "book",
    aliases: ["depth", "liquidity", "orderbook"],
    params: ["market"],
    needs: [],
    write: (values) => `${marketName(values.market)} order book: spread, depth and which side is heavier.`,
  },
  {
    id: "compare",
    title: "Compare two markets",
    hint: "Trend, momentum and funding side by side",
    group: "analysis",
    icon: "compare",
    aliases: ["versus", "vs"],
    params: ["market", "other"],
    needs: [],
    write: (values) =>
      `Compare ${marketName(values.market)} and ${marketName(values.other)}: trend, momentum and funding.`,
  },
  {
    id: "portfolio",
    title: "Review my positions",
    hint: "Margin use, liquidation risk, what needs attention",
    group: "account",
    icon: "account",
    aliases: ["positions", "risk check", "audit"],
    params: [],
    needs: ["account"],
    write: () => "Review my positions, margin use and liquidation risk.",
  },
  {
    id: "journal",
    title: "Review my journal",
    hint: "Your edge, and where discipline leaks",
    group: "account",
    icon: "journal",
    aliases: ["coach", "performance", "review"],
    params: [],
    needs: ["journal"],
    write: (_values, context) => context.journalReview,
  },
  {
    id: "bots",
    title: "My grid bots",
    hint: "How each grid bot is doing",
    group: "account",
    icon: "grid",
    aliases: ["grids", "bot status"],
    params: [],
    needs: ["account"],
    write: () => "How are my grid bots doing?",
  },
];

export function commandById(id: string): Command | undefined {
  return COMMANDS.find((command) => command.id === id);
}

/** The command named exactly by `word`: its id or one of its one-word aliases. */
export function findCommand(word: string): Command | undefined {
  const text = word.trim().toLowerCase();
  if (!text) return undefined;
  return commandById(text) ?? COMMANDS.find((command) => command.aliases.includes(text));
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
}

/**
 * How well a command matches, lower is better, or null when it does not. Words match from their start,
 * so a short query finds what it names and not every word that happens to contain it; anywhere inside
 * a name counts only once three letters are typed.
 */
function rank(command: Command, query: string): number | null {
  if (command.id === query) return 0;
  if (command.aliases.includes(query)) return 1;
  if (command.id.startsWith(query)) return 2;
  if (command.aliases.some((alias) => words(alias).some((word) => word.startsWith(query)))) return 3;
  if (words(command.title).some((word) => word.startsWith(query))) return 4;
  if (words(command.hint).some((word) => word.startsWith(query))) return 5;
  if (query.length >= 3 && (command.id.includes(query) || command.title.toLowerCase().includes(query))) return 6;
  return null;
}

/** Commands that match what was typed after the slash, best first. Everything, in order, for an empty query. */
export function searchCommands(query: string): Command[] {
  const text = query.trim().toLowerCase();
  if (!text) return [...COMMANDS];
  const scored: { command: Command; score: number; order: number }[] = [];
  COMMANDS.forEach((command, order) => {
    const score = rank(command, text);
    if (score !== null) scored.push({ command, score, order });
  });
  return scored.sort((left, right) => left.score - right.score || left.order - right.order).map((item) => item.command);
}

/** What follows a leading slash while a command's name is still being typed, or null when the text is not that. */
export function slashQuery(text: string): string | null {
  return /^\/([^\s/]*)$/.exec(text)?.[1] ?? null;
}

/** A market being named with `$` just before the caret: `$et` in "compare $et". */
export interface Mention {
  /** Where the `$` is. */
  start: number;
  /** The caret. */
  end: number;
  /** What follows the `$`. */
  query: string;
}

export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const query = /(?:^|\s)\$([\p{L}\p{N}]*)$/u.exec(before)?.[1];
  if (query === undefined) return null;
  return { start: caret - query.length - 1, end: caret, query };
}

/** Puts `word` where the mention was, followed by a space, and says where the caret goes. */
export function replaceMention(text: string, mention: Mention, word: string): { text: string; caret: number } {
  const after = text.slice(mention.end);
  const joined = `${text.slice(0, mention.start)}${word}${after.startsWith(" ") ? "" : " "}`;
  return { text: joined + after, caret: joined.length + (after.startsWith(" ") ? 1 : 0) };
}

/**
 * `share` percent of a decimal quantity, cut down to the quantity's own decimals, so the result is a
 * size the market accepts. Exact: the digits are counted as whole numbers, never as floating point.
 * Null when that leaves nothing, or the input is not a plain decimal.
 */
export function shareOf(qty: string, share: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(qty.trim());
  if (!match || !Number.isInteger(share) || share <= 0 || share > 100) return null;
  const decimals = match[2] ?? "";
  const scaled = (BigInt(match[1] + decimals) * BigInt(share)) / 100n;
  if (scaled === 0n) return null;
  const digits = scaled.toString().padStart(decimals.length + 1, "0");
  if (!decimals) return digits;
  const whole = digits.slice(0, -decimals.length);
  const fraction = digits.slice(-decimals.length).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function commandContext(snapshot: Snapshot, journalReview = ""): CommandContext {
  const wallet = activeWallet(snapshot);
  return {
    network: snapshot.network,
    account: !wallet.connected ? "connect" : wallet.needsDeposit ? "deposit" : "ready",
    positions: snapshot.account?.positions ?? [],
    webSearch: snapshot.assistant.webSearch,
    liveTickets: snapshot.assistant.liveTickets,
    maxLeverage: snapshot.risk.maxLeverage,
    journalReview,
  };
}

/** The values a command starts from: the market in focus, compared with the next one on the watchlist. */
export function defaultValues(snapshot: Snapshot, timeframe: Timeframe = "4h"): CommandValues {
  const market = snapshot.focus || snapshot.instruments[0]?.symbol || "BTCUSDT";
  const other = snapshot.instruments.find((item) => item.symbol !== market)?.symbol ?? market;
  return {
    side: "long",
    market,
    other,
    risk: 1,
    leverage: 0,
    target: "none",
    timeframe,
    share: 50,
    mode: "neutral",
    // Each order has a minimum size: ten grids on 250 USDT clear it on BTC, the market most often in focus.
    grids: 10,
    margin: 250,
  };
}

/**
 * The values a command opens with. A command about a position starts on a market where there is
 * one, and leverage above the trader's limit falls back to the default.
 */
export function valuesFor(
  command: Command,
  base: CommandValues,
  context: CommandContext,
  preset?: Partial<CommandValues>,
): CommandValues {
  const values: CommandValues = { ...base, ...preset };
  if (command.needs.includes("position") && !context.positions.some((item) => item.symbol === values.market)) {
    const first = context.positions[0];
    if (first) values.market = first.symbol;
  }
  if (values.leverage > context.maxLeverage) values.leverage = 0;
  return values;
}

/** The whole message: the command's words, then anything the trader typed beside it on a line of its own. */
export function writeMessage(command: Command, values: CommandValues, context: CommandContext, note = ""): string {
  const head = command.write(values, context);
  const extra = note.trim();
  return extra ? `${head}\n${extra}` : head;
}

/** Why the command cannot be sent yet, or null when it can. */
export function blocker(command: Command, context: CommandContext, values?: CommandValues): CommandNote | null {
  for (const need of command.needs) {
    if (need === "account" || need === "position") {
      if (context.account === "connect") {
        return { text: "Connect a wallet to use this.", fix: { label: "Connect", target: "wallet" } };
      }
      if (context.account === "deposit") {
        return {
          text: "The account opens after your wallet's first deposit.",
          fix: { label: "Deposit", target: "wallet" },
        };
      }
    }
    if (need === "position") {
      if (context.positions.length === 0) return { text: "You have no open positions.", fix: null };
      if (values && !context.positions.some((item) => item.symbol === values.market)) {
        return { text: `You have no open ${marketName(values.market)} position.`, fix: null };
      }
    }
    if (need === "web" && !context.webSearch) {
      return { text: "Web search is off.", fix: { label: "Turn on", target: "tools" } };
    }
    if (need === "journal" && !context.journalReview) {
      return { text: "Your journal has no trades to review yet.", fix: { label: "Open journal", target: "activity" } };
    }
  }
  return null;
}

/** Something worth knowing before a trade command is sent, or null. */
export function caution(command: Command, context: CommandContext): CommandNote | null {
  const drafts = command.group === "trade" && command.id !== "plan";
  if (drafts && context.network === "mainnet" && !context.liveTickets) {
    return {
      text:
        command.id === "grid"
          ? "Mainnet tickets are off, so the assistant will plan the grid bot without drafting it."
          : "Mainnet tickets are off, so the assistant will plan this without drafting a ticket.",
      fix: { label: "Allow", target: "trading" },
    };
  }
  return null;
}

/** The colour a command gives the message box: green for a long, red for a short, none otherwise. */
export function commandTone(command: Command, values: CommandValues): "up" | "down" | null {
  if (command.id === "long") return "up";
  if (command.id === "short") return "down";
  if (command.id === "plan") return values.side === "long" ? "up" : "down";
  if (command.id === "grid") return values.mode === "long" ? "up" : values.mode === "short" ? "down" : null;
  return null;
}

/* ------------------------------------------------------------- parameters */

export const PARAM_LABELS: Record<ParamKey, string> = {
  side: "Side",
  market: "Market",
  other: "Compare with",
  risk: "Risk",
  leverage: "Leverage",
  target: "Take-profit",
  timeframe: "Timeframe",
  share: "Amount",
  mode: "Direction",
  grids: "Grids",
  margin: "Margin",
};

export interface Option<T> {
  value: T;
  label: string;
  sub?: string;
}

export const SIDE_OPTIONS: readonly Option<CommandValues["side"]>[] = [
  { value: "long", label: "Long" },
  { value: "short", label: "Short" },
];

export const RISK_OPTIONS: readonly Option<number>[] = [
  { value: 0.25, label: "0.25%" },
  { value: 0.5, label: "0.5%" },
  { value: 1, label: "1%", sub: "The assistant's usual ceiling" },
  { value: 2, label: "2%" },
];

export function leverageOptions(maxLeverage: number): Option<number>[] {
  return [0, 2, 3, 5, 10, 20, 50]
    .filter((value) => value === 0 || value <= maxLeverage)
    .map((value) =>
      value === 0
        ? { value, label: "Auto", sub: `The smaller of 3x and your ${maxLeverage}x limit` }
        : { value, label: `${value}x` },
    );
}

export const TARGET_OPTIONS: readonly Option<CommandValues["target"]>[] = [
  { value: "none", label: "No take-profit" },
  { value: "level", label: "At the next level", sub: "Resistance for a long, support for a short" },
];

export const TIMEFRAME_OPTIONS: readonly Option<Timeframe>[] = [
  { value: "15m", label: "15m", sub: "15 minutes" },
  { value: "1h", label: "1h", sub: "1 hour" },
  { value: "4h", label: "4h", sub: "4 hours" },
  { value: "1d", label: "1d", sub: "1 day" },
];

export const MODE_OPTIONS: readonly Option<GridDirection>[] = [
  { value: "neutral", label: "Neutral", sub: "Starts flat: buys below the price, sells above" },
  { value: "long", label: "Long", sub: "Starts with a long and sells into rises" },
  { value: "short", label: "Short", sub: "Starts with a short and buys into dips" },
];

export const GRID_COUNT_OPTIONS: readonly Option<number>[] = [
  { value: 10, label: "10 grids", sub: "Wider gaps, more profit each time" },
  { value: 20, label: "20 grids" },
  { value: 30, label: "30 grids" },
  { value: 50, label: "50 grids", sub: "Narrow gaps, trades more often" },
];

export const MARGIN_OPTIONS: readonly Option<number>[] = [50, 100, 250, 500, 1000].map((value) => ({
  value,
  label: `${value.toLocaleString("en-US")} USDT`,
}));

export const SHARE_OPTIONS: readonly Option<number>[] = [
  { value: 25, label: "25%" },
  { value: 50, label: "50%" },
  { value: 75, label: "75%" },
];

/** What a chip shows for its setting. */
export function chipText(key: ParamKey, values: CommandValues): string {
  switch (key) {
    case "side":
      return values.side === "long" ? "Long" : "Short";
    case "market":
      return marketName(values.market);
    case "other":
      return `vs ${marketName(values.other)}`;
    case "risk":
      return `${values.risk}% risk`;
    case "leverage":
      return values.leverage > 0 ? `${values.leverage}x` : "Auto leverage";
    case "target":
      return values.target === "level" ? "TP at next level" : "No take-profit";
    case "timeframe":
      return values.timeframe;
    case "share":
      return `${values.share}% of it`;
    case "mode":
      return values.mode === "neutral" ? "Neutral" : values.mode === "long" ? "Long" : "Short";
    case "grids":
      return `${values.grids} grids`;
    case "margin":
      return `${values.margin.toLocaleString("en-US")} USDT`;
  }
}

/* ------------------------------------------------------------ suggestions */

/** Something to ask with one click: sent at once, or put in the box as a command to look over first. */
export type Suggestion =
  | { kind: "ask"; label: string; icon: IconName; prompt: string }
  | { kind: "command"; label: string; icon: IconName; command: string; values: Partial<CommandValues> };

function askFor(id: string, label: string, values: CommandValues, context: CommandContext): Suggestion | null {
  const command = commandById(id);
  if (!command || blocker(command, context, values)) return null;
  return { kind: "ask", label, icon: command.icon, prompt: command.write(values, context) };
}

/** Starting points for an empty conversation. Trades go into the box to look over; questions are asked at once. */
export function starters(snapshot: Snapshot): Suggestion[] {
  const context = commandContext(snapshot);
  const values = defaultValues(snapshot);
  const name = marketName(values.market);
  const list: (Suggestion | null)[] = [
    askFor("outlook", `${name} outlook`, values, context),
    askFor("news", "Market news", values, context),
    askFor("movers", "Top movers", values, context),
    context.positions.length > 0
      ? askFor("portfolio", "Review my positions", values, context)
      : {
          kind: "command",
          label: `Long ${marketName(values.other)}, 1% risk`,
          icon: "trendUp",
          command: "long",
          values: { market: values.other },
        },
  ];
  return list.filter((item): item is Suggestion => item !== null);
}

/** The market an answer was about, when it looked closely at one. */
function subjectOf(cards: readonly CardView[]): string | null {
  for (const card of cards) if (card.kind === "plan") return card.plan.symbol;
  for (const card of cards) if (card.kind === "technicals") return card.symbol;
  for (const card of cards) if (card.kind === "book") return card.book.symbol;
  for (const card of cards) {
    if (card.kind === "quotes" && card.quotes.length === 1) return card.quotes[0]?.symbol ?? null;
  }
  return null;
}

/** Whether the reading of a market says it is moving sideways, where a grid bot does best. */
function sideways(cards: readonly CardView[], symbol: string): boolean {
  return cards.some((card) => card.kind === "technicals" && card.symbol === symbol && card.frame.trend === "mixed");
}

/**
 * What to do next after an answer, from what it looked at: trade the market it read, or read what it
 * has not yet. A market moving sideways adds a grid bot to the trades on offer. Nothing after an answer
 * that drafted a ticket or a grid bot: that draft is the next step.
 */
export function followUps(run: RunView, snapshot: Snapshot): Suggestion[] {
  if (run.status !== "complete" || run.ticket || run.grid) return [];
  const context = commandContext(snapshot);
  const base = defaultValues(snapshot);
  const seen = new Set(run.cards.map((card) => card.kind));
  const list: (Suggestion | null)[] = [];
  const subject = subjectOf(run.cards);

  if (subject) {
    const name = marketName(subject);
    const values = { ...base, market: subject };
    if (context.positions.some((item) => item.symbol === subject)) {
      list.push({ kind: "command", label: `Close ${name}`, icon: "exit", command: "close", values: { market: subject } });
    } else {
      list.push({ kind: "command", label: `Long ${name}`, icon: "trendUp", command: "long", values: { market: subject } });
      list.push({ kind: "command", label: `Short ${name}`, icon: "trendDown", command: "short", values: { market: subject } });
      if (sideways(run.cards, subject) && !seen.has("grid")) {
        list.push({ kind: "command", label: `Grid ${name}`, icon: "grid", command: "grid", values: { market: subject } });
      }
    }
    if (!seen.has("technicals")) list.push(askFor("technicals", `${name} technicals`, values, context));
    if (!seen.has("news")) list.push(askFor("why", `Why is ${name} moving?`, values, context));
    if (!seen.has("book")) list.push(askFor("book", `${name} order book`, values, context));
  } else {
    const movers = run.cards.find((card) => card.kind === "movers");
    const top = movers?.kind === "movers" ? movers.rows[0] : undefined;
    if (top) {
      const name = marketName(top.symbol);
      const values = { ...base, market: top.symbol };
      list.push(askFor("outlook", `${name} outlook`, values, context));
      list.push(askFor("why", `Why is ${name} moving?`, values, context));
    }
    if (seen.has("news") && !seen.has("movers")) list.push(askFor("movers", "Top movers", base, context));
    if (seen.has("account") && context.positions.length > 0 && !/positions/i.test(run.title)) {
      list.push(askFor("portfolio", "Review my positions", base, context));
    }
  }

  const unique = new Map<string, Suggestion>();
  for (const item of list) if (item && !unique.has(item.label)) unique.set(item.label, item);
  const offersGrid = [...unique.values()].some((item) => item.kind === "command" && item.command === "grid");
  return [...unique.values()].slice(0, offersGrid ? 4 : 3);
}
