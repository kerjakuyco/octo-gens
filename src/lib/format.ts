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
 * Adds two-decimal amounts for a headline total. The sum is done in whole
 * cents, so it is exact for the values the core sends.
 */
export function sumAmounts(values: string[]): string {
  let cents = 0;
  for (const value of values) {
    const n = toNumber(value);
    if (Number.isFinite(n)) cents += Math.round(n * 100);
  }
  return (cents / 100).toFixed(2);
}

/** A market price: two decimals for large prices, more precision for small ones. */
export function price(value: Numeric): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  let text: string;
  if (abs >= 1) text = fixed(n, 2, 2);
  else if (abs >= 0.01) text = fixed(n, 4, 4);
  else if (abs === 0) text = "0.00";
  else text = n.toLocaleString(LOCALE, { maximumSignificantDigits: 4 });
  return text.replace("-", MINUS);
}

/** Number of decimals a chart axis needs for prices around `value`. */
export function pricePrecision(value: Numeric): number {
  const abs = Math.abs(toNumber(value));
  if (!Number.isFinite(abs) || abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  if (abs === 0) return 2;
  return Math.min(10, Math.ceil(-Math.log10(abs)) + 3);
}

/** A token quantity: up to eight decimals, trailing zeros dropped. */
export function units(value: Numeric): string {
  const n = toNumber(value);
  return Number.isFinite(n) ? fixed(n, 0, 8).replace("-", MINUS) : DASH;
}

/** A percent change with an explicit sign. */
export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const body = `${fixed(Math.abs(value), 2, 2)}%`;
  if (value > 0) return `+${body}`;
  return value < 0 ? `${MINUS}${body}` : body;
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

/** Local day and time, e.g. `18 Nov, 09:12`. */
export function dayTime(iso: string): string {
  const date = parseTime(iso);
  if (!date) return DASH;
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${day}, ${clock(iso)}`;
}

/** An unambiguous UTC stamp for market data, e.g. `2026-11-18 09:12 UTC`. */
export function utcStamp(iso: string): string {
  const date = parseTime(iso);
  if (!date) return DASH;
  const text = date.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

/** `BTC/USDT` to `BTC`. */
export function baseOf(pair: string): string {
  return pair.split("/")[0] ?? pair;
}

/** Singular or plural noun with its count. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
