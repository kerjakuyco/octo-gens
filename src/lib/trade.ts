/**
 * Presentation-only order ticket estimates, sizing helpers, and client-side
 * field validation for the manual trade form. Exact exchange validation and
 * sizing still happen in `octoneo-core` when the ticket is drafted.
 */

import type { PositionView, Side } from "../api/types";
import { pricePrecision } from "./format";

export type AmountMode = "units" | "value";

export interface OrderEstimate {
  qty: number | null;
  notional: number | null;
  margin: number | null;
  estLiqPrice: number | null;
  slPct: number | null;
  slPnl: number | null;
  tpPct: number | null;
  tpPnl: number | null;
  rrRatio: number | null;
}

export interface OrderFieldErrors {
  amount?: string;
  leverage?: string;
  stopLoss?: string;
  takeProfit?: string;
  reduceOnly?: string;
}

function positive(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Formats a decimal string without scientific notation or noisy trailing zeros. */
export function trimDecimal(value: number, maxDecimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const fixed = value.toFixed(Math.max(0, Math.min(8, maxDecimals)));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Computes a target price offset by `pct` (e.g. `2` for 2%) from `markPrice`. */
export function offsetPrice(markPrice: number, side: Side, kind: "sl" | "tp", pct: number): string {
  if (!Number.isFinite(markPrice) || markPrice <= 0 || !Number.isFinite(pct) || pct <= 0) return "";
  const moveUp = (side === "buy" && kind === "tp") || (side === "sell" && kind === "sl");
  const target = markPrice * (moveUp ? 1 + pct / 100 : 1 - pct / 100);
  if (target <= 0) return "";
  return trimDecimal(target, pricePrecision(markPrice));
}

/**
 * Computes an order size input string from a percentage of available buying
 * power, or from a percentage of an open position when `reduceOnly` is on.
 */
export function sizeFromPercent(params: {
  pct: number;
  mode: AmountMode;
  markPrice: number;
  available: number;
  leverage: number;
  reduceOnly: boolean;
  position: PositionView | null;
}): string {
  const { pct, mode, markPrice, available, leverage, reduceOnly, position } = params;
  if (!Number.isFinite(pct) || pct <= 0) return "";

  if (reduceOnly) {
    const posQty = position ? Number(position.qty) : Number.NaN;
    if (!Number.isFinite(posQty) || posQty <= 0) return "";
    const qty = posQty * (pct / 100);
    if (mode === "units") return trimDecimal(qty, qty >= 100 ? 2 : qty >= 1 ? 4 : 6);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return "";
    return trimDecimal(qty * markPrice, 2);
  }

  if (!Number.isFinite(available) || available <= 0 || !Number.isFinite(leverage) || leverage < 1) return "";
  // Reserve a small buffer at 100% so fees and mark movement do not trip insufficient margin.
  const effectivePct = pct >= 100 ? 95 : pct;
  const notional = available * leverage * (effectivePct / 100);
  if (mode === "value") return trimDecimal(notional, 2);
  if (!Number.isFinite(markPrice) || markPrice <= 0) return "";
  const qty = notional / markPrice;
  return trimDecimal(qty, qty >= 100 ? 2 : qty >= 1 ? 4 : 6);
}

/** Real-time pre-review estimates for notional, required margin, liq price, and TP/SL payoff. */
export function estimateOrder(params: {
  side: Side;
  markPrice: number;
  amount: string;
  mode: AmountMode;
  leverage: number;
  stopLoss: string;
  takeProfit: string;
  reduceOnly: boolean;
}): OrderEstimate {
  const { side, markPrice, amount, mode, leverage, stopLoss, takeProfit, reduceOnly } = params;
  const parsed = positive(amount);
  const hasMark = Number.isFinite(markPrice) && markPrice > 0;
  const sign = side === "buy" ? 1 : -1;

  let qty: number | null = null;
  let notional: number | null = null;
  if (parsed !== null) {
    if (mode === "units") {
      qty = parsed;
      notional = hasMark ? parsed * markPrice : null;
    } else {
      notional = parsed;
      qty = hasMark ? parsed / markPrice : null;
    }
  }

  const validLev = Number.isFinite(leverage) && leverage >= 1;
  const margin = !reduceOnly && notional !== null && validLev ? notional / leverage : null;

  let estLiqPrice: number | null = null;
  if (!reduceOnly && hasMark && validLev) {
    // Conservative isolated estimate (90% of initial margin before maintenance buffer).
    const move = 0.9 / leverage;
    const candidate = side === "buy" ? markPrice * (1 - move) : markPrice * (1 + move);
    estLiqPrice = candidate > 0 ? candidate : null;
  }

  const sl = !reduceOnly ? positive(stopLoss) : null;
  const tp = !reduceOnly ? positive(takeProfit) : null;

  const slPct = sl !== null && hasMark ? ((sl - markPrice) / markPrice) * 100 * sign : null;
  const tpPct = tp !== null && hasMark ? ((tp - markPrice) / markPrice) * 100 * sign : null;
  const slPnl = sl !== null && hasMark && qty !== null ? (sl - markPrice) * qty * sign : null;
  const tpPnl = tp !== null && hasMark && qty !== null ? (tp - markPrice) * qty * sign : null;

  let rrRatio: number | null = null;
  if (sl !== null && tp !== null && hasMark) {
    const risk = (markPrice - sl) * sign;
    const reward = (tp - markPrice) * sign;
    if (risk > 0 && reward > 0) rrRatio = reward / risk;
  }

  return { qty, notional, margin, estLiqPrice, slPct, slPnl, tpPct, tpPnl, rrRatio };
}

/** Client-side UX checks shown on blur/submit before sending the draft to the core. */
export function validateOrderFields(params: {
  side: Side;
  markPrice: number;
  amount: string;
  mode: AmountMode;
  leverage: number;
  maxLeverage: number;
  stopLoss: string;
  takeProfit: string;
  reduceOnly: boolean;
  position: PositionView | null;
}): OrderFieldErrors {
  const { side, markPrice, amount, mode, leverage, maxLeverage, stopLoss, takeProfit, reduceOnly, position } = params;
  const errors: OrderFieldErrors = {};
  const hasMark = Number.isFinite(markPrice) && markPrice > 0;

  if (!amount.trim()) {
    errors.amount = mode === "units" ? "Enter an order size." : "Enter an order value.";
  } else if (positive(amount) === null) {
    errors.amount = "Enter a number greater than zero.";
  }

  if (reduceOnly) {
    if (!position) {
      errors.reduceOnly = "No open position in this market to reduce.";
    } else if ((position.side === "long" && side === "buy") || (position.side === "short" && side === "sell")) {
      errors.reduceOnly =
        position.side === "long"
          ? "Select Sell to reduce your open Long position."
          : "Select Buy to reduce your open Short position.";
    }
    return errors;
  }

  if (!Number.isInteger(leverage) || leverage < 1 || leverage > maxLeverage) {
    errors.leverage = `Choose whole-number leverage from 1x to ${maxLeverage}x.`;
  }

  if (stopLoss.trim()) {
    const sl = positive(stopLoss);
    if (sl === null) {
      errors.stopLoss = "Enter a valid stop-loss price.";
    } else if (hasMark) {
      if (side === "buy" && sl >= markPrice) errors.stopLoss = "Stop-loss must be below mark price for a Long.";
      if (side === "sell" && sl <= markPrice) errors.stopLoss = "Stop-loss must be above mark price for a Short.";
    }
  }

  if (takeProfit.trim()) {
    const tp = positive(takeProfit);
    if (tp === null) {
      errors.takeProfit = "Enter a valid take-profit price.";
    } else if (hasMark) {
      if (side === "buy" && tp <= markPrice) errors.takeProfit = "Take-profit must be above mark price for a Long.";
      if (side === "sell" && tp >= markPrice) errors.takeProfit = "Take-profit must be below mark price for a Short.";
    }
  }

  return errors;
}

/** Builds leverage preset ticks that fit neatly inside the trader's configured cap. */
export function leverageTicks(maxLeverage: number): number[] {
  const base = [1, 2, 3, 5, 10, 20, 50].filter((x) => x <= maxLeverage);
  if (maxLeverage >= 1 && !base.includes(maxLeverage)) base.push(maxLeverage);
  // Keep at most 6 crisp ticks so the row stays uncluttered.
  if (base.length <= 6) return base;
  return [1, 3, 5, 10, 20, maxLeverage].filter((v, i, arr) => v <= maxLeverage && arr.indexOf(v) === i);
}
