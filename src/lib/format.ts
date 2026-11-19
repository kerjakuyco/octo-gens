/**
 * Display formatting. Amounts arrive from the core as decimal strings; they are
 * converted to numbers here for presentation only, never for money math.
 */

const LOCALE = "en-US";
const MINUS = "−";
const DASH = "—";

type Numeric = string | number | null | undefined;

function toNumber(value: Numeric): number {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return typeof value === "number" ? value : Number(value);
}

function fixed(value: number, min: number, max: number): string {
  return value.toLocaleString(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max });
}

/** A USDT amount: always two decimals, grouped. */
export function money(value: Numeric): string {
  const n = toNumber(value);
  return Number.isFinite(n) ? fixed(n, 2, 2).replace("-", MINUS) : DASH;
}

/** A USDT amount with an explicit sign, for profit and loss. */
export function signedMoney(value: Numeric): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  const body = fixed(Math.abs(n), 2, 2);
  if (n > 0) return `+${body}`;
  return n < 0 ? `${MINUS}${body}` : body;
}

/**
 * A market price. Large prices get two decimals; smaller ones keep the extra
 * digits their tick size carries, so 1.9312 and 0.12843 are not rounded away.
 */
export function price(value: Numeric): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  let text: string;
  if (abs >= 1000) text = fixed(n, 2, 2);
  else if (abs >= 1) text = fixed(n, 2, 4);
  else if (abs >= 0.01) text = fixed(n, 4, 5);
  else if (abs === 0) text = "0.00";
  else text = n.toLocaleString(LOCALE, { maximumSignificantDigits: 4 });
  return text.replace("-", MINUS);
}

/** Number of decimals a chart axis needs for prices around `value`. */
export function pricePrecision(value: Numeric): number {
  const abs = Math.abs(toNumber(value));
  if (!Number.isFinite(abs) || abs >= 10 || abs === 0) return 2;
  if (abs >= 0.1) return 4;
  return Math.min(10, Math.ceil(-Math.log10(abs)) + 3);
}

/** A price with a fixed number of decimals, for chart axes where labels must line up. */
export function axisPrice(value: number, decimals: number): string {
  return Number.isFinite(value) ? fixed(value, decimals, decimals).replace("-", MINUS) : DASH;
}

/** A token quantity: up to eight decimals, trailing zeros dropped. */
export function units(value: Numeric): string {
  const n = toNumber(value);
  return Number.isFinite(n) ? fixed(n, 0, 8).replace("-", MINUS) : DASH;
}

/**
 * An asset balance: two decimals for amounts in the hundreds and up, more for
 * smaller ones, where the extra digits are worth something (0.00412 BTC).
 */
export function balance(value: Numeric): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  const size = Math.abs(n);
  return fixed(n, 2, size >= 100 ? 2 : size >= 1 ? 4 : 8).replace("-", MINUS);
}

/** A percent change with an explicit sign. */
export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const body = `${fixed(Math.abs(value), 2, 2)}%`;
  if (value > 0) return `+${body}`;
  return value < 0 ? `${MINUS}${body}` : body;
}

/** A funding rate in percent per interval, signed, to four decimals: `+0.0100%`. */
export function fundingRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const body = `${fixed(Math.abs(value), 4, 4)}%`;
  if (value > 0) return `+${body}`;
  return value < 0 ? `${MINUS}${body}` : body;
}

/** Leverage as traders write it: `3x`. */
export function leverage(value: number): string {
  return Number.isFinite(value) ? `${fixed(value, 0, 2)}x` : DASH;
}

/** Large figures such as traded volume: 1.2M, 3.4B. */
export function compact(value: Numeric): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  return new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** A whole number, grouped. */
export function count(value: number): string {
  return value.toLocaleString(LOCALE, { maximumFractionDigits: 0 });
}

/** Provider cost in US dollars. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value === 0) return "$0";
  const digits = value < 1 ? 4 : 2;
  return `$${fixed(value, digits, digits)}`;
}

/** USD per million tokens, for the model list. */
export function tokenPrice(value: number | null): string {
  if (value === null) return "varies";
  if (value === 0) return "free";
  return `$${value.toLocaleString(LOCALE, { maximumSignificantDigits: 3 })}`;
}

/** Context window: 200k, 1M. */
export function contextSize(tokens: number): string {
  if (!tokens) return DASH;
  if (tokens >= 1_000_000) return `${fixed(tokens / 1_000_000, 0, 1)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

export type Direction = "up" | "down" | "flat";

export function direction(value: Numeric): Direction {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/** How long a run or step took. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${fixed(seconds, 1, 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

function parseTime(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local wall-clock time, 24h. */
export function clock(iso: string): string {
  const date = parseTime(iso);
  if (!date) return DASH;
  return date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Local wall-clock time with seconds, for a trade tape. */
export function clockSeconds(iso: string): string {
  const date = parseTime(iso);
  if (!date) return DASH;
  return date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** A resting or traded size: exact while it is small, shortened once it runs to six figures. */
export function size(value: Numeric): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  return Math.abs(n) >= 100_000 ? compact(n) : fixed(n, 0, 4).replace("-", MINUS);
}

/** Local day and time, e.g. `18 Nov, 09:12`. */
export function dayTime(iso: string): string {
  const date = parseTime(iso);
  if (!date) return DASH;
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${day}, ${clock(iso)}`;
}

/** A local calendar day, e.g. `18 Feb 2027`. */
export function dayDate(iso: string): string {
  const date = parseTime(iso);
  if (!date) return DASH;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Time left until `iso` as `HH:MM:SS`, never negative. */
export function countdown(iso: string | null | undefined, now: number = Date.now()): string {
  const date = iso ? parseTime(iso) : null;
  if (!date) return DASH;
  const seconds = Math.max(0, Math.floor((date.getTime() - now) / 1000));
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** How long ago `iso` was, shortened: `now`, `12m`, `3h`, `2d`. Empty when the time is unknown. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  const date = iso ? parseTime(iso) : null;
  if (!date) return "";
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 2) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** Singular or plural noun with its count. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** A wallet address shortened for display: `0x12ab…9f3c`. */
export function shortAddress(address: string | null | undefined): string {
  if (!address) return DASH;
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const ORDER_TYPES: Record<string, string> = {
  LIMIT: "Limit",
  MARKET: "Market",
  STOP: "Stop limit",
  STOP_MARKET: "Stop market",
  TAKE_PROFIT: "Take-profit limit",
  TAKE_PROFIT_MARKET: "Take-profit market",
  TRAILING_STOP_MARKET: "Trailing stop",
};

/** An exchange order type in plain words: `STOP_MARKET` to `Stop market`. */
export function orderType(type: string): string {
  const known = ORDER_TYPES[type];
  if (known) return known;
  const words = type.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
