import type { StepView } from "../api/types";

/**
 * Plain words for what the assistant and the app did. The core reports steps
 * by tool name (`get_quote`, `exchange.order`); nobody should have to read those.
 */

const QUOTE_ASSET = /(?:USDT|USD1|USDC)$/;
const FRAME = /(?:^|[\s,])(15m|1h|4h|1d)(?=$|[\s,])/;
const TIMEFRAME = /^(?:15m|1h|4h|1d)$/;
const DRAFT = "propose_order";

const LABELS: Record<string, string> = {
  model: "Model",
  load_model: "Load model",
  get_quote: "Price",
  analyze_market: "Chart",
  get_candles: "Candles",
  get_order_book: "Order book",
  scan_watchlist: "Watchlist",
  get_movers: "Movers",
  get_account: "Account",
  plan_position: "Position size",
  propose_order: "Ticket",
  search_news: "News",
  read_page: "Article",
  list_server_tools: "Tool list",
  call_server_tool: "Tool",
  "exchange.position": "Position check",
  "exchange.mark_price": "Price check",
  "exchange.margin_mode": "Margin mode",
  "exchange.leverage": "Leverage",
  "exchange.order": "Order",
  "exchange.stop_loss": "Stop-loss",
  "exchange.take_profit": "Take-profit",
  "exchange.cancel": "Cancel",
  "wallet.deposit": "Deposit",
  "wallet.withdraw": "Withdrawal",
};

/** A step's name in plain words. An unknown one keeps its own words, without the underscores. */
export function stepLabel(name: string): string {
  const known = LABELS[name];
  if (known) return known;
  const words = name.replace(/^(?:get|scan|read|list)_/, "").replace(/[_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** `a, b and c`. */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]!}`;
}

/** Base assets named in a step's argument summary: `BTCUSDT, ETHUSDT` gives BTC and ETH. */
function bases(detail: string): string[] {
  const found: string[] = [];
  for (const word of detail.split(/[\s,]+/)) {
    if (!word || TIMEFRAME.test(word)) continue;
    const symbol = word.toUpperCase();
    const base = symbol.length > 4 ? symbol.replace(QUOTE_ASSET, "") : symbol;
    if (!found.includes(base)) found.push(base);
  }
  return found;
}

/** What one step looked at, as a noun phrase; null for steps that are not worth a mention. */
function phrase(step: StepView): string | null {
  const frame = FRAME.exec(step.detail)?.[1];
  switch (step.name) {
    case "model":
    case "load_model":
      return null;
    case "get_quote": {
      const names = bases(step.detail);
      if (names.length === 0) return "prices";
      return `${listWords(names.slice(0, 3))} ${names.length > 1 ? "prices" : "price"}`;
    }
    case "analyze_market":
      return frame ? `${frame} chart` : "chart";
    case "get_candles":
      return frame ? `${frame} candles` : "candles";
    case "search_news":
      return "the news";
    case "read_page":
      return "an article";
    case "list_server_tools":
    case "call_server_tool":
      return "tools";
    default:
      return stepLabel(step.name).toLowerCase() || null;
  }
}

/** Finished work in one line, or empty when there is nothing to say. */
export function activitySummary(steps: StepView[]): string {
  const seen: string[] = [];
  let drafted = false;
  for (const step of steps) {
    if (step.name === DRAFT) {
      drafted ||= step.status !== "error";
      continue;
    }
    const text = phrase(step);
    if (text && !seen.includes(text)) seen.push(text);
  }
  const shown = seen.slice(0, 3);
  const more = seen.length - shown.length;
  let text = "";
  if (shown.length > 0) {
    text = more > 0 ? `Checked ${shown.join(", ")} and ${more} more` : `Checked ${listWords(shown)}`;
  }
  if (drafted) return text ? `${text}, drafted a ticket` : "Drafted a ticket";
  return text;
}

/** What is happening right now, while a turn runs. */
export function activityNow(steps: StepView[]): string {
  let running: StepView | undefined;
  for (const step of steps) {
    if (step.status === "running") running = step;
  }
  if (!running) return "Thinking";
  if (running.name === DRAFT) return "Drafting a ticket";
  if (running.name === "load_model") return "Loading the model";
  if (running.name === "search_news") return "Reading the news";
  if (running.name === "read_page") return "Reading an article";
  const text = phrase(running);
  return text ? `Checking ${text}` : "Thinking";
}
