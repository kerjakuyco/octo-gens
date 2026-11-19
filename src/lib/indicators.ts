import type { CandleRow, TechnicalFrame, Timeframe, TradeView } from "../api/types";

/**
 * Display-only technical calculations derived from live candles, quotes and tape.
 * Every reading the assistant quotes is still computed deterministically by the Rust core.
 */

const BARS_PER_YEAR: Record<Timeframe, number> = {
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
};

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values. Entries before the first full window are null.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  let sum = 0;
  for (let index = 0; index < period; index += 1) sum += values[index]!;
  let level = sum / period;
  out[period - 1] = level;
  const weight = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    level += (values[index]! - level) * weight;
    out[index] = level;
  }
  return out;
}

export interface BollingerSeries {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/** Rolling Bollinger bands `(period, width)` across `values`. */
export function bollinger(values: number[], period = 20, width = 2): BollingerSeries {
  const middle: (number | null)[] = new Array<number | null>(values.length).fill(null);
  const upper: (number | null)[] = new Array<number | null>(values.length).fill(null);
  const lower: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (!Number.isInteger(period) || period < 2 || values.length < period) return { middle, upper, lower };

  for (let end = period - 1; end < values.length; end += 1) {
    let sum = 0;
    for (let i = end - period + 1; i <= end; i += 1) sum += values[i]!;
    const avg = sum / period;
    let sq = 0;
    for (let i = end - period + 1; i <= end; i += 1) {
      const diff = values[i]! - avg;
      sq += diff * diff;
    }
    const band = width * Math.sqrt(sq / period);
    middle[end] = avg;
    upper[end] = avg + band;
    lower[end] = avg - band;
  }
  return { middle, upper, lower };
}

export interface CandleAnalytics {
  /** Last completed candle volume divided by the preceding 20-bar mean. */
  rvol: number | null;
  /** Where the latest price sits inside Bollinger(20, 2): 0 = lower, 50 = mid, 100 = upper. */
  bbPositionPct: number | null;
  /** Bollinger(20, 2) full band width as a percent of the middle line. */
  bbWidthPct: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  /** Annualised realized volatility of log returns over the last 30 bars, in percent. */
  volatilityPct: number | null;
  /** Low and high across the last 20 candles, and where price sits inside that range. */
  range20Low: number | null;
  range20High: number | null;
  range20Pct: number | null;
}

/** Volatility, relative volume, Bollinger position, and 20-bar range from a candle series. */
export function candleAnalytics(rows: CandleRow[], timeframe: Timeframe, spot?: number): CandleAnalytics {
  const empty: CandleAnalytics = {
    rvol: null,
    bbPositionPct: null,
    bbWidthPct: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
    volatilityPct: null,
    range20Low: null,
    range20High: null,
    range20Pct: null,
  };
  if (rows.length === 0) return empty;

  const closes = rows.map((row) => Number(row[4]));
  const volumes = rows.map((row) => Number(row[5]));
  const lastPrice = spot !== undefined && Number.isFinite(spot) && spot > 0 ? spot : closes[closes.length - 1]!;

  // Relative volume compares the last completed candle against the 20 prior bars.
  let rvol: number | null = null;
  if (volumes.length > 21) {
    const window = volumes.slice(volumes.length - 22, volumes.length - 2);
    const avg = window.reduce((acc, value) => acc + value, 0) / window.length;
    if (avg > 0) rvol = volumes[volumes.length - 2]! / avg;
  }

  // Bollinger(20, 2) on the latest bar.
  const bands = bollinger(closes, 20, 2);
  const last = closes.length - 1;
  const bbMiddle = bands.middle[last] ?? null;
  const bbUpper = bands.upper[last] ?? null;
  const bbLower = bands.lower[last] ?? null;
  let bbPositionPct: number | null = null;
  let bbWidthPct: number | null = null;
  if (bbMiddle !== null && bbUpper !== null && bbLower !== null && bbMiddle > 0) {
    const span = bbUpper - bbLower;
    bbWidthPct = (span / bbMiddle) * 100;
    if (span > 0) bbPositionPct = ((lastPrice - bbLower) / span) * 100;
  }

  // Annualised realized volatility over 30 bars (matches `indicators::realized_volatility` in core).
  let volatilityPct: number | null = null;
  if (closes.length > 30) {
    const slice = closes.slice(closes.length - 31);
    const returns: number[] = [];
    for (let i = 1; i < slice.length; i += 1) {
      if (slice[i - 1]! > 0 && slice[i]! > 0) returns.push(Math.log(slice[i]! / slice[i - 1]!));
    }
    if (returns.length >= 2) {
      const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
      const variance = returns.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (returns.length - 1);
      volatilityPct = Math.sqrt(variance) * Math.sqrt(BARS_PER_YEAR[timeframe]) * 100;
    }
  }

  // 20-bar range.
  let range20Low: number | null = null;
  let range20High: number | null = null;
  let range20Pct: number | null = null;
  if (rows.length >= 20) {
    const recent = rows.slice(rows.length - 20);
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const row of recent) {
      const h = Number(row[2]);
      const l = Number(row[3]);
      if (h > high) high = h;
      if (l < low) low = l;
    }
    if (Number.isFinite(low) && Number.isFinite(high)) {
      range20Low = low;
      range20High = high;
      range20Pct = rangePositionPct(lastPrice, low, high);
    }
  }

  return { rvol, bbPositionPct, bbWidthPct, bbUpper, bbMiddle, bbLower, volatilityPct, range20Low, range20High, range20Pct };
}

/** Clamped 0–100 position of `value` between `low` and `high`. */
export function rangePositionPct(
  value: number | string | null | undefined,
  low: number | string | null | undefined,
  high: number | string | null | undefined,
): number | null {
  const v = Number(value);
  const lo = Number(low);
  const hi = Number(high);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
}

/** Mark-to-index basis in basis points. Positive means perpetual trades at a premium to spot index. */
export function basisBps(
  mark: number | string | null | undefined,
  index: number | string | null | undefined,
): number | null {
  const m = Number(mark);
  const idx = Number(index);
  if (!Number.isFinite(m) || !Number.isFinite(idx) || idx <= 0) return null;
  return ((m - idx) / idx) * 10_000;
}

export interface TapePressure {
  /** Share of taker notional on the buy side, 0–100. */
  buyPct: number;
  buyNotional: number;
  sellNotional: number;
  netNotional: number;
  count: number;
}

/** Buy vs sell taker volume split across the recent trade tape. */
export function tapePressure(trades: TradeView[]): TapePressure | null {
  if (trades.length === 0) return null;
  let buyNotional = 0;
  let sellNotional = 0;
  for (const trade of trades) {
    const notional = Number(trade.price) * Number(trade.size);
    if (!Number.isFinite(notional) || notional <= 0) continue;
    if (trade.side === "buy") buyNotional += notional;
    else sellNotional += notional;
  }
  const total = buyNotional + sellNotional;
  if (total <= 0) return null;
  return {
    buyPct: (buyNotional / total) * 100,
    buyNotional,
    sellNotional,
    netNotional: buyNotional - sellNotional,
    count: trades.length,
  };
}

export interface TrendConfluence {
  bullish: number;
  bearish: number;
  mixed: number;
  total: number;
  tone: "up" | "down" | undefined;
  label: string;
}

/** Summarises multi-timeframe trend alignment across all available technical frames. */
export function trendConfluence(frames: TechnicalFrame[]): TrendConfluence {
  let bullish = 0;
  let bearish = 0;
  let mixed = 0;
  for (const frame of frames) {
    if (frame.trend === "uptrend") bullish += 1;
    else if (frame.trend === "downtrend") bearish += 1;
    else if (frame.trend === "mixed") mixed += 1;
  }
  const total = bullish + bearish + mixed;
  if (total === 0) return { bullish, bearish, mixed, total, tone: undefined, label: "No trend yet" };
  if (bullish > bearish && bullish >= Math.ceil(total / 2)) {
    return { bullish, bearish, mixed, total, tone: "up", label: `${bullish}/${total} Uptrend` };
  }
  if (bearish > bullish && bearish >= Math.ceil(total / 2)) {
    return { bullish, bearish, mixed, total, tone: "down", label: `${bearish}/${total} Downtrend` };
  }
  return { bullish, bearish, mixed, total, tone: undefined, label: "Mixed" };
}
