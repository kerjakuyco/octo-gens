/**
 * Grid bot math for the interface: the price levels a range makes, the profit each step is worth,
 * which levels start as buys and which as sells, suggested ranges, and summaries of the bots.
 *
 * These figures are previews. The core sizes the orders, rounds them to the market's steps and signs
 * them (`crates/octoneo-core/src/grid.rs` and `studio/grid.rs`); the preview it returns is the one a
 * bot starts from.
 */

import type { GridBotView, GridDirection, GridSpacing, Side, TechnicalsView } from "../api/types";

export const GRID_MIN_COUNT = 2;
export const GRID_MAX_COUNT = 50;
/** Assumed round-trip maker fee in percent (0.02% entry + 0.02% exit = 0.04%). */
export const MAKER_FEE_ROUNDTRIP_PCT = 0.04;

export function priceDecimalsFor(value: number): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return 2;
  if (abs >= 50) return 2;
  if (abs >= 5) return 3;
  if (abs >= 0.5) return 4;
  if (abs >= 0.05) return 5;
  if (abs >= 0.005) return 6;
  return 7;
}

export function roundGridPrice(value: number, refPrice?: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const digits = priceDecimalsFor(refPrice ?? value);
  return Number(value.toFixed(digits)).toString();
}

/** The `grids + 1` price levels between `lower` and `upper`, lowest first. */
export function computeGridPrices(
  lower: number,
  upper: number,
  grids: number,
  spacing: GridSpacing,
): number[] {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) return [];
  const count = Math.floor(grids);
  if (count < GRID_MIN_COUNT || count > GRID_MAX_COUNT) return [];

  const prices: number[] = [];
  if (spacing === "arithmetic") {
    const step = (upper - lower) / count;
    for (let i = 0; i <= count; i += 1) {
      prices.push(i === count ? upper : lower + step * i);
    }
  } else {
    const ratio = (upper / lower) ** (1 / count);
    for (let i = 0; i <= count; i += 1) {
      prices.push(i === count ? upper : lower * ratio ** i);
    }
  }
  return prices;
}

/** Profit of one completed trade between neighbouring levels, in percent, after maker fees both ways. */
export function computeProfitPerGridPct(prices: number[]): { min: number; max: number } {
  if (prices.length < 2) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < prices.length - 1; i += 1) {
    const lo = prices[i]!;
    const hi = prices[i + 1]!;
    if (lo <= 0) continue;
    const net = ((hi - lo) / lo) * 100 - MAKER_FEE_ROUNDTRIP_PCT;
    if (net < min) min = net;
    if (net > max) max = net;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return {
    min: Number(Math.max(min, -99.99).toFixed(2)),
    max: Number(Math.max(max, -99.99).toFixed(2)),
  };
}

export interface LadderPlan {
  sides: (Side | null)[];
  buyCount: number;
  sellCount: number;
  initialSide: Side | null;
  initialLegs: number;
  anchorIndex: number;
}

/**
 * Which levels start as buy orders (below the price) and which as sells (above it). The level nearest
 * the price is left without an order. A long grid first buys what its sells will sell; a short grid
 * first sells what its buys will buy back.
 */
export function planLadderSides(
  direction: GridDirection,
  prices: number[],
  mark: number,
): LadderPlan {
  if (prices.length < 2 || !Number.isFinite(mark) || mark <= 0) {
    return { sides: [], buyCount: 0, sellCount: 0, initialSide: null, initialLegs: 0, anchorIndex: -1 };
  }

  let anchorIndex = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < prices.length; i += 1) {
    const d = Math.abs(prices[i]! - mark);
    if (d < bestDist) {
      bestDist = d;
      anchorIndex = i;
    }
  }

  const sides: (Side | null)[] = prices.map((lvl, idx) => {
    if (idx === anchorIndex) return null;
    return lvl < mark ? "buy" : "sell";
  });

  const buyCount = sides.filter((s) => s === "buy").length;
  const sellCount = sides.filter((s) => s === "sell").length;
  let initialSide: Side | null = null;
  let initialLegs = 0;

  if (direction === "long" && sellCount > 0) {
    initialSide = "buy";
    initialLegs = sellCount;
  } else if (direction === "short" && buyCount > 0) {
    initialSide = "sell";
    initialLegs = buyCount;
  }

  return { sides, buyCount, sellCount, initialSide, initialLegs, anchorIndex };
}

export interface GridSuggestion {
  id: "tight" | "levels" | "wide";
  /** What the range is, in a few words. */
  label: string;
  /** What it is for. */
  detail: string;
  /** What the range was worked out from. */
  basis: string;
  direction: GridDirection;
  spacing: GridSpacing;
  lowerPrice: string;
  upperPrice: string;
  grids: number;
  leverage: number;
  stopLower: string;
  stopUpper: string;
  profitMinPct: number;
  profitMaxPct: number;
}

/**
 * Three ranges to start from, worked out from the market's recent movement: a tight one for small
 * moves, one between the nearest 4h support and resistance, and a wide one for bigger swings. Each
 * keeps leverage within `maxLeverage` and puts its stops a little outside its range.
 */
export function suggestGridRanges(
  mark: number,
  technicals: TechnicalsView | null,
  maxLeverage: number,
): GridSuggestion[] {
  if (!Number.isFinite(mark) || mark <= 0) return [];

  const h4 = technicals?.frames.find((f) => f.timeframe === "4h") ?? technicals?.frames[0] ?? null;
  const d1 = technicals?.frames.find((f) => f.timeframe === "1d") ?? h4;
  const atr4hPct = h4?.atrPct ?? 1.6;
  const atrDailyPct = d1?.atrPct ?? Math.max(atr4hPct * 2.1, 3.2);
  const trend = h4?.trend ?? "mixed";

  const capLev = (desired: number) => Math.max(1, Math.min(maxLeverage, desired));
  const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

  // A market already trending leans the middle range its way; a ranging one stays neutral.
  const levelsDirection: GridDirection = trend === "uptrend" ? "long" : trend === "downtrend" ? "short" : "neutral";

  const tightHalf = clamp(atr4hPct * 1.6, 2.5, 5.5) / 100;
  const nearSupport = h4?.support.find((lvl) => lvl < mark * 0.975 && lvl > mark * 0.85);
  const nearResistance = h4?.resistance.find((lvl) => lvl > mark * 1.025 && lvl < mark * 1.15);
  const levelsHalf = clamp(atrDailyPct * 1.9, 5.5, 12.0) / 100;
  const wideHalf = clamp(atrDailyPct * 3.4, 11.0, 22.0) / 100;
  const fromLevels = nearSupport !== undefined || nearResistance !== undefined;

  const specs: {
    id: GridSuggestion["id"];
    label: string;
    detail: string;
    basis: string;
    direction: GridDirection;
    spacing: GridSpacing;
    low: number;
    high: number;
    grids: number;
    leverage: number;
    stopPad: number;
  }[] = [
    {
      id: "tight",
      label: "Tight",
      detail: "Close to the price, for small moves",
      basis: h4 ? `About 1.6 times the 4h average range of ${atr4hPct.toFixed(2)}%` : "About 3.5% each way",
      direction: "neutral",
      spacing: "geometric",
      low: mark * (1 - tightHalf),
      high: mark * (1 + tightHalf),
      grids: 12,
      leverage: capLev(3),
      stopPad: 0.025,
    },
    {
      id: "levels",
      label: fromLevels ? "Around the 4h levels" : "Balanced",
      detail:
        levelsDirection === "neutral"
          ? "Between the nearest support and resistance"
          : `Between support and resistance, leaning ${levelsDirection} with the trend`,
      basis: fromLevels ? "From the nearest 4h support and resistance" : `From the 1d average range of ${atrDailyPct.toFixed(2)}%`,
      direction: levelsDirection,
      spacing: "arithmetic",
      low: nearSupport ?? mark * (1 - levelsHalf),
      high: nearResistance ?? mark * (1 + levelsHalf),
      grids: 14,
      leverage: capLev(3),
      stopPad: 0.04,
    },
    {
      id: "wide",
      label: "Wide",
      detail: "Room for bigger swings, fewer fills",
      basis: d1 ? `About 3.4 times the 1d average range of ${atrDailyPct.toFixed(2)}%` : "About 14% each way",
      direction: "neutral",
      spacing: "geometric",
      low: mark * (1 - wideHalf),
      high: mark * (1 + wideHalf),
      grids: 18,
      leverage: capLev(2),
      stopPad: 0.06,
    },
  ];

  return specs.map((spec) => {
    const prices = computeGridPrices(spec.low, spec.high, spec.grids, spec.spacing);
    const { min, max } = computeProfitPerGridPct(prices);
    return {
      id: spec.id,
      label: spec.label,
      detail: spec.detail,
      basis: spec.basis,
      direction: spec.direction,
      spacing: spec.spacing,
      lowerPrice: roundGridPrice(spec.low, mark),
      upperPrice: roundGridPrice(spec.high, mark),
      grids: spec.grids,
      leverage: spec.leverage,
      stopLower: roundGridPrice(spec.low * (1 - spec.stopPad), mark),
      stopUpper: roundGridPrice(spec.high * (1 + spec.stopPad), mark),
      profitMinPct: min,
      profitMaxPct: max,
    };
  });
}

/** Share of the margin times leverage that orders may use; the rest is kept for fees and price moves. */
const ORDER_BUDGET_SHARE = 0.95;

export interface GridOrderEstimate {
  /** Value of each order in the quote asset. */
  perOrderValue: number;
  /** Size of each order in the coin, at the price now. */
  perOrderQty: number;
  /** Value of every order together. */
  totalValue: number;
}

/**
 * Roughly how big each order of a grid will be: margin times leverage, less a little kept back, shared
 * between the grids. Null until there is enough to work it out. The core works out the real size.
 */
export function estimateGridOrders(
  margin: number,
  leverage: number,
  grids: number,
  mark: number,
): GridOrderEstimate | null {
  if (!(margin > 0) || !(leverage >= 1) || !(grids >= GRID_MIN_COUNT) || !(mark > 0)) return null;
  const totalValue = margin * leverage * ORDER_BUDGET_SHARE;
  const perOrderValue = totalValue / grids;
  return { perOrderValue, perOrderQty: perOrderValue / mark, totalValue };
}

/** Where the price sits in a range: below it, inside it (and how far up), or above it. */
export function gridRangeProgress(
  mark: number | null | undefined,
  lower: number,
  upper: number,
): { pct: number; zone: "below" | "inside" | "above" } | null {
  if (mark === null || mark === undefined || !Number.isFinite(mark) || !Number.isFinite(lower) || !Number.isFinite(upper)) {
    return null;
  }
  if (upper <= lower) return null;
  const raw = ((mark - lower) / (upper - lower)) * 100;
  const zone: "below" | "inside" | "above" = raw < 0 ? "below" : raw > 100 ? "above" : "inside";
  return { pct: Math.max(0, Math.min(100, raw)), zone };
}

/** How long a bot has run, or ran, in short form: `2d 4h`, `3h 12m`, `8m`. */
export function gridDuration(createdAt: string, stoppedAt: string | null, nowMs = Date.now()): string {
  const start = Date.parse(createdAt);
  if (!Number.isFinite(start)) return "—";
  const end = stoppedAt ? Date.parse(stoppedAt) : nowMs;
  const mins = Math.max(1, Math.floor((end - start) / 60_000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

/** Totals across bots, for the summary at the top of the page. Margin counts bots that run or wait to start. */
export function summarizeGrids(grids: GridBotView[]): {
  runningCount: number;
  waitingCount: number;
  stoppedCount: number;
  activeMargin: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalPnl: number;
  totalMatchedTrades: number;
} {
  let runningCount = 0;
  let waitingCount = 0;
  let stoppedCount = 0;
  let activeMargin = 0;
  let totalRealizedPnl = 0;
  let totalUnrealizedPnl = 0;
  let totalMatchedTrades = 0;

  for (const bot of grids) {
    const realized = Number(bot.realizedPnl) || 0;
    const unrealized = Number(bot.unrealizedPnl) || 0;
    totalRealizedPnl += realized;
    totalMatchedTrades += bot.matchedTrades;
    if (bot.status === "running") {
      runningCount += 1;
      activeMargin += Number(bot.margin) || 0;
      totalUnrealizedPnl += unrealized;
    } else if (bot.status === "waiting") {
      waitingCount += 1;
      activeMargin += Number(bot.margin) || 0;
    } else {
      stoppedCount += 1;
    }
  }

  return {
    runningCount,
    waitingCount,
    stoppedCount,
    activeMargin,
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalPnl: totalRealizedPnl + totalUnrealizedPnl,
    totalMatchedTrades,
  };
}

/** The client id prefix the core gives every order of one bot: `ong_`, the first ten characters of its id, `_`. */
function clientPrefix(bot: GridBotView): string {
  return `ong_${bot.id.slice(0, 10)}_`;
}

/**
 * The grid bot that placed an order, so a page can say whose order it is: matched by the order's id on
 * one of the bot's levels, or by the client id the bot gave it.
 */
export function botForOrder(
  bots: readonly GridBotView[],
  order: { id: string; clientId: string; symbol: string },
): GridBotView | null {
  for (const bot of bots) {
    if (bot.symbol !== order.symbol) continue;
    if (bot.levels.some((level) => level.orderId === order.id)) return bot;
    if (order.clientId.startsWith(clientPrefix(bot))) return bot;
  }
  return null;
}

/** The bot at work in a market, running or waiting for its start price, if there is one. */
export function activeBotFor(bots: readonly GridBotView[], symbol: string): GridBotView | null {
  return bots.find((bot) => bot.symbol === symbol && (bot.status === "running" || bot.status === "waiting")) ?? null;
}
