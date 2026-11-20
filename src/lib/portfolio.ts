/**
 * Pure portfolio analytics, perpetual position risk enrichment, resting order
 * enrichment, and execution history aggregation for decentralized futures.
 */

import type {
  Network,
  OpenOrderView,
  PositionView,
  RunView,
  Side,
  Snapshot,
  StepView,
  TicketView,
} from "../api/types";
import { pricePrecision } from "./format";
import { instrumentFor } from "./market";
import { type TicketStatus, ticketStatus } from "./ticket";
import { trimDecimal } from "./trade";

export type HealthTier = "healthy" | "moderate" | "elevated";
export type ExposureBias = "long" | "short" | "neutral";

export interface AllocationSlice {
  symbol: string;
  base: string;
  quote: string;
  side: "long" | "short";
  notional: number;
  sharePct: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface PortfolioAnalytics {
  equity: number;
  walletBalance: number;
  available: number;
  marginUsed: number;
  unrealizedPnl: number;
  /** Unrealized P&L as a percentage of wallet balance. */
  unrealizedReturnPct: number;
  /** Initial margin used as a percentage of account equity (0–100+). */
  marginRatioPct: number;
  /** Free collateral as a percentage of account equity (0–100). */
  freeCollateralPct: number;
  health: HealthTier;
  longNotional: number;
  shortNotional: number;
  grossNotional: number;
  /** Positive means net long; negative means net short. */
  netDelta: number;
  netBias: ExposureBias;
  /** Share of gross notional on the long side (0–100). */
  longSharePct: number;
  /** Gross notional divided by account equity. */
  effectiveLeverage: number;
  /** Net estimated 8h funding carry in USD across open positions (+ earned, - paid). */
  estFunding8hUsd: number;
  /** Net estimated 24h funding carry in USD across open positions (+ earned, - paid). */
  estFunding24hUsd: number;
  protectedCount: number;
  unprotectedCount: number;
  allocations: AllocationSlice[];
}

export interface EnrichedPosition {
  position: PositionView;
  base: string;
  quote: string;
  qtyNum: number;
  notionalNum: number;
  marginNum: number;
  entryNum: number;
  markNum: number;
  liqNum: number | null;
  pnlNum: number;
  roePct: number | null;
  /** Share of gross open notional (0–100). */
  sharePct: number;
  /** Signed price move in % from entry to mark in the direction of the position. */
  markMovePct: number | null;
  /** Percentage distance from current mark price to liquidation price. */
  liqDistancePct: number | null;
  liqTone: "up" | "warn" | "down" | undefined;
  /** Current funding rate in % per interval from the live quote, if available. */
  fundingRatePct: number | null;
  /** Estimated 8h funding carry in USD (+ means position earns funding, - means it pays). */
  estFunding8hUsd: number | null;
  stopLossOrder: OpenOrderView | null;
  takeProfitOrder: OpenOrderView | null;
  slPrice: string | null;
  tpPrice: string | null;
  /** Estimated P&L in quote currency if the resting stop-loss triggers. */
  slPnlUsd: number | null;
  /** Estimated P&L in quote currency if the resting take-profit triggers. */
  tpPnlUsd: number | null;
  /** Planned reward-to-risk ratio from entry when both SL and TP orders are resting. */
  plannedRr: number | null;
  /** 50% of current position quantity formatted for a 1-click partial trim. */
  trimHalfQty: string;
}

export interface EnrichedOrder {
  order: OpenOrderView;
  base: string;
  quote: string;
  markPrice: number | null;
  effectivePrice: string | null;
  effectivePriceNum: number | null;
  /** Signed percentage distance from current mark price to the order's trigger/limit price. */
  distanceFromMarkPct: number | null;
  estNotional: number | null;
  roleLabel: "Stop-Loss Guard" | "Take-Profit Target" | "Limit Entry" | "Reduce Limit" | "Trigger Order";
  linkedPositionSide: "long" | "short" | null;
}

export type ExecutionCategory = "order" | "cancel" | "wallet" | "ticket" | "tool";

export interface ExecutionRecord {
  id: string;
  category: ExecutionCategory;
  title: string;
  summary: string;
  network: Network;
  time: string;
  status: "complete" | "failed" | "stopped" | "running" | "pending" | "expired";
  tone: "up" | "down" | "warn" | undefined;
  statusLabel: string;
  symbol: string | null;
  base: string | null;
  side: Side | null;
  qty: string | null;
  fillPrice: string | null;
  notional: string | null;
  leverage: number | null;
  orderId: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  reduceOnly: boolean;
  ms: number;
  steps: StepView[];
  ticket: TicketView | null;
}

function num(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveNum(value: string | number | null | undefined): number | null {
  const n = num(value);
  return n > 0 ? n : null;
}

/** Finds the active reduce-only SL and TP orders protecting an open position from pre-indexed symbol orders. */
function findProtectionOrders(
  position: PositionView,
  symbolOrders: readonly OpenOrderView[] | undefined,
): { sl: OpenOrderView | null; tp: OpenOrderView | null } {
  if (!symbolOrders || symbolOrders.length === 0) return { sl: null, tp: null };
  const exitSide: Side = position.side === "long" ? "sell" : "buy";
  let sl: OpenOrderView | null = null;
  let tp: OpenOrderView | null = null;
  for (const order of symbolOrders) {
    if (order.side !== exitSide) continue;
    const kind = order.type.toUpperCase();
    if (!sl && kind.includes("STOP")) sl = order;
    else if (!tp && kind.includes("TAKE_PROFIT")) tp = order;
    if (sl && tp) break;
  }
  return { sl, tp };
}

/**
 * Computes signed 8h funding carry in USD for a position.
 * Positive funding rate means longs pay shorts; negative means shorts pay longs.
 */
export function estimatePositionFunding8h(
  notional: number,
  side: "long" | "short",
  fundingRatePct: number | null,
): number | null {
  if (fundingRatePct === null || !Number.isFinite(fundingRatePct) || notional <= 0) return null;
  const payerSign = side === "long" ? -1 : 1;
  const raw = notional * (fundingRatePct / 100) * payerSign;
  return Object.is(raw, -0) ? 0 : raw;
}

export function enrichPositions(snapshot: Snapshot): EnrichedPosition[] {
  const account = snapshot.account;
  if (!account || account.positions.length === 0) return [];

  const ordersBySymbol = new Map<string, OpenOrderView[]>();
  for (const order of account.orders) {
    const group = ordersBySymbol.get(order.symbol);
    if (group) group.push(order);
    else ordersBySymbol.set(order.symbol, [order]);
  }

  const grossNotional = account.positions.reduce((sum, pos) => sum + Math.abs(num(pos.notional)), 0);

  return account.positions.map((position) => {
    const instrument = instrumentFor(snapshot, position.symbol);
    const quoteView = snapshot.quotes[position.symbol];
    const qtyNum = Math.abs(num(position.qty));
    const notionalNum = Math.abs(num(position.notional));
    const marginNum = Math.abs(num(position.margin));
    const entryNum = num(position.entryPrice);
    const markNum = num(position.markPrice);
    const liqNum = positiveNum(position.liquidationPrice);
    const pnlNum = num(position.unrealizedPnl);
    const sign = position.side === "long" ? 1 : -1;

    const sharePct = grossNotional > 0 ? (notionalNum / grossNotional) * 100 : 0;
    const markMovePct = entryNum > 0 && markNum > 0 ? ((markNum - entryNum) / entryNum) * 100 * sign : null;

    let liqDistancePct: number | null = null;
    let liqTone: "up" | "warn" | "down" | undefined;
    if (liqNum !== null && markNum > 0) {
      liqDistancePct = Math.abs((markNum - liqNum) / markNum) * 100;
      liqTone = liqDistancePct >= 15 ? "up" : liqDistancePct >= 7 ? "warn" : "down";
    }

    const fundingRatePct = quoteView?.fundingRatePct ?? null;
    const estFunding8hUsd = estimatePositionFunding8h(notionalNum, position.side, fundingRatePct);

    const { sl, tp } = findProtectionOrders(position, ordersBySymbol.get(position.symbol));
    const slPrice = sl ? (positiveNum(sl.stopPrice) ? sl.stopPrice : positiveNum(sl.price) ? sl.price : null) : null;
    const tpPrice = tp ? (positiveNum(tp.stopPrice) ? tp.stopPrice : positiveNum(tp.price) ? tp.price : null) : null;
    const slNum = positiveNum(slPrice);
    const tpNum = positiveNum(tpPrice);

    const slPnlUsd = slNum !== null && entryNum > 0 && qtyNum > 0 ? (slNum - entryNum) * qtyNum * sign : null;
    const tpPnlUsd = tpNum !== null && entryNum > 0 && qtyNum > 0 ? (tpNum - entryNum) * qtyNum * sign : null;

    let plannedRr: number | null = null;
    if (slNum !== null && tpNum !== null && entryNum > 0) {
      const risk = (entryNum - slNum) * sign;
      const reward = (tpNum - entryNum) * sign;
      if (risk > 0 && reward > 0) plannedRr = reward / risk;
    }

    const half = qtyNum / 2;
    const trimDecimals = qtyNum >= 100 ? 2 : qtyNum >= 1 ? 4 : 6;
    const trimHalfQty = trimDecimal(half, trimDecimals) || position.qty;

    return {
      position,
      base: instrument.base,
      quote: instrument.quote || "USDT",
      qtyNum,
      notionalNum,
      marginNum,
      entryNum,
      markNum,
      liqNum,
      pnlNum,
      roePct: position.roePct,
      sharePct,
      markMovePct,
      liqDistancePct,
      liqTone,
      fundingRatePct,
      estFunding8hUsd,
      stopLossOrder: sl,
      takeProfitOrder: tp,
      slPrice,
      tpPrice,
      slPnlUsd,
      tpPnlUsd,
      plannedRr,
      trimHalfQty,
    };
  });
}

export function computePortfolioAnalytics(
  snapshot: Snapshot,
  precomputedPositions?: readonly EnrichedPosition[],
): PortfolioAnalytics {
  const account = snapshot.account;
  const equity = num(account?.equity);
  const walletBalance = num(account?.walletBalance);
  const available = num(account?.available);
  const marginUsed = num(account?.marginUsed);
  const unrealizedPnl = num(account?.unrealizedPnl);

  const unrealizedReturnPct = walletBalance > 0 ? (unrealizedPnl / walletBalance) * 100 : 0;
  const marginRatioPct = equity > 0 ? Math.max(0, (marginUsed / equity) * 100) : 0;
  const freeCollateralPct = equity > 0 ? Math.max(0, Math.min(100, (available / equity) * 100)) : 0;

  let health: HealthTier = "healthy";
  if (marginRatioPct >= 75) health = "elevated";
  else if (marginRatioPct >= 50) health = "moderate";

  const enriched = precomputedPositions ?? enrichPositions(snapshot);
  let longNotional = 0;
  let shortNotional = 0;
  let estFunding8hUsd = 0;
  let protectedCount = 0;

  for (const item of enriched) {
    if (item.position.side === "long") longNotional += item.notionalNum;
    else shortNotional += item.notionalNum;
    if (item.estFunding8hUsd !== null) estFunding8hUsd += item.estFunding8hUsd;
    if (item.stopLossOrder !== null) protectedCount += 1;
  }

  const grossNotional = longNotional + shortNotional;
  const netDelta = longNotional - shortNotional;
  let netBias: ExposureBias = "neutral";
  if (Math.abs(netDelta) > 1e-2) {
    netBias = netDelta > 0 ? "long" : "short";
  }

  const longSharePct = grossNotional > 0 ? (longNotional / grossNotional) * 100 : 50;
  const effectiveLeverage = equity > 0 ? grossNotional / equity : 0;

  const allocations: AllocationSlice[] = enriched
    .map((item) => ({
      symbol: item.position.symbol,
      base: item.base,
      quote: item.quote,
      side: item.position.side,
      notional: item.notionalNum,
      sharePct: item.sharePct,
      unrealizedPnl: item.pnlNum,
      leverage: item.position.leverage,
    }))
    .sort((left, right) => right.notional - left.notional);

  return {
    equity,
    walletBalance,
    available,
    marginUsed,
    unrealizedPnl,
    unrealizedReturnPct,
    marginRatioPct,
    freeCollateralPct,
    health,
    longNotional,
    shortNotional,
    grossNotional,
    netDelta,
    netBias,
    longSharePct,
    effectiveLeverage,
    estFunding8hUsd,
    estFunding24hUsd: estFunding8hUsd * 3,
    protectedCount,
    unprotectedCount: Math.max(0, enriched.length - protectedCount),
    allocations,
  };
}

export function enrichOrders(snapshot: Snapshot): EnrichedOrder[] {
  const account = snapshot.account;
  if (!account || account.orders.length === 0) return [];

  const positionSides = new Map<string, "long" | "short">();
  for (const pos of account.positions) {
    positionSides.set(pos.symbol, pos.side);
  }

  return account.orders.map((order) => {
    const instrument = instrumentFor(snapshot, order.symbol);
    const quoteView = snapshot.quotes[order.symbol];
    const markNum = positiveNum(quoteView?.markPrice ?? quoteView?.price);
    const stopNum = positiveNum(order.stopPrice);
    const limitNum = positiveNum(order.price);
    const effectivePriceNum = stopNum ?? limitNum;
    const effectivePrice =
      stopNum !== null ? order.stopPrice : limitNum !== null ? order.price : null;

    const distanceFromMarkPct =
      effectivePriceNum !== null && markNum !== null
        ? ((effectivePriceNum - markNum) / markNum) * 100
        : null;

    const qtyNum = positiveNum(order.qty);
    const estNotional = effectivePriceNum !== null && qtyNum !== null ? effectivePriceNum * qtyNum : null;

    const kind = order.type.toUpperCase();
    let roleLabel: EnrichedOrder["roleLabel"] = "Trigger Order";
    if (kind.includes("STOP")) roleLabel = "Stop-Loss Guard";
    else if (kind.includes("TAKE_PROFIT")) roleLabel = "Take-Profit Target";
    else if (kind === "LIMIT") roleLabel = order.reduceOnly ? "Reduce Limit" : "Limit Entry";

    return {
      order,
      base: instrument.base,
      quote: instrument.quote || "USDT",
      markPrice: markNum,
      effectivePrice,
      effectivePriceNum,
      distanceFromMarkPct,
      estNotional,
      roleLabel,
      linkedPositionSide: positionSides.get(order.symbol) ?? null,
    };
  });
}

function parseActivityRun(run: RunView, snapshot: Snapshot): ExecutionRecord {
  const firstStep = run.steps[0]?.name ?? "";
  let category: ExecutionCategory = "order";
  if (firstStep.startsWith("wallet.") || /^(?:Deposit|Withdraw)\b/i.test(run.title)) {
    category = "wallet";
  } else if (firstStep === "exchange.cancel" || /^Cancel\b/i.test(run.title)) {
    category = "cancel";
  } else if (run.agent === "Tool inspector" || (!firstStep.startsWith("exchange.") && run.agent !== "Execution")) {
    category = "tool";
  }

  let symbol: string | null = null;
  let side: Side | null = null;
  let qty: string | null = null;
  let fillPrice: string | null = null;
  let orderId: string | null = null;
  let stopLoss: string | null = null;
  let takeProfit: string | null = null;

  const confirmMatch = /^Confirm\s+(buy|sell)\s+(\d+(?:\.\d+)?)\s+([A-Z0-9\u4e00-\u9fff]+)/i.exec(run.title);
  if (confirmMatch) {
    side = confirmMatch[1]!.toLowerCase() === "buy" ? "buy" : "sell";
    qty = confirmMatch[2]!;
    symbol = confirmMatch[3]!;
  } else {
    const cancelMatch = /\bon\s+([A-Z0-9\u4e00-\u9fff]+)$/i.exec(run.title);
    if (cancelMatch) symbol = cancelMatch[1]!;
  }

  for (const step of run.steps) {
    if (step.name === "exchange.order") {
      const filledAt = /FILLED at\s+([0-9.,]+)/i.exec(step.preview);
      if (filledAt) fillPrice = filledAt[1]!.replace(/,/g, "");
      const idMatch = /order\s+(\d+)/i.exec(step.preview);
      if (idMatch) orderId = idMatch[1]!;
    } else if (step.name === "exchange.stop_loss") {
      const trig = /trigger\s+([0-9.,]+)/i.exec(step.preview);
      if (trig) stopLoss = trig[1]!.replace(/,/g, "");
    } else if (step.name === "exchange.take_profit") {
      const trig = /trigger\s+([0-9.,]+)/i.exec(step.preview);
      if (trig) takeProfit = trig[1]!.replace(/,/g, "");
    }
  }

  const instrument = symbol ? instrumentFor(snapshot, symbol) : null;
  const notionalNum =
    qty !== null && fillPrice !== null ? num(qty) * num(fillPrice) : null;
  const notional =
    notionalNum !== null && notionalNum > 0
      ? trimDecimal(notionalNum, pricePrecision(notionalNum))
      : null;

  const statusMap: Record<RunView["status"], { label: string; tone?: "up" | "down" | "warn" }> = {
    complete: { label: category === "order" ? "Filled" : "Done", tone: "up" },
    failed: { label: "Failed", tone: "down" },
    stopped: { label: "Stopped", tone: "warn" },
    running: { label: "Running" },
  };
  const badge = statusMap[run.status];

  return {
    id: `act-${run.id}`,
    category,
    title: run.title,
    summary: run.output,
    network: run.network,
    time: run.time,
    status: run.status,
    tone: badge.tone,
    statusLabel: badge.label,
    symbol,
    base: instrument?.base ?? symbol,
    side,
    qty,
    fillPrice,
    notional,
    leverage: null,
    orderId,
    stopLoss,
    takeProfit,
    reduceOnly: false,
    ms: run.ms,
    steps: run.steps,
    ticket: run.ticket,
  };
}

function ticketRecordFromTurn(run: RunView, ticket: TicketView, status: TicketStatus, snapshot: Snapshot): ExecutionRecord {
  const instrument = instrumentFor(snapshot, ticket.symbol);
  let recStatus: ExecutionRecord["status"] = "pending";
  let tone: ExecutionRecord["tone"] = "warn";
  let statusLabel = "Waiting for you";
  let summary = ticket.effect;

  if (status.state === "done") {
    recStatus = "complete";
    tone = "up";
    statusLabel = "Placed";
    summary = status.note;
  } else if (status.state === "failed") {
    recStatus = "failed";
    tone = "down";
    statusLabel = "Not placed";
    summary = status.note;
  } else if (status.state === "expired") {
    recStatus = "expired";
    tone = undefined;
    statusLabel = "Expired";
    summary = `${ticket.effect} (expired before it was confirmed).`;
  }

  return {
    id: `tkt-${ticket.id}`,
    category: "ticket",
    title: `${ticket.reduceOnly ? "Reduce" : ticket.side === "buy" ? "Long" : "Short"} ${ticket.qty} ${instrument.base} @ ${ticket.leverage}x`,
    summary,
    network: ticket.network,
    time: run.time,
    status: recStatus,
    tone,
    statusLabel,
    symbol: ticket.symbol,
    base: instrument.base,
    side: ticket.side,
    qty: ticket.qty,
    fillPrice: ticket.price,
    notional: ticket.notional,
    leverage: ticket.leverage,
    orderId: ticket.id.slice(0, 10),
    stopLoss: ticket.stopLoss,
    takeProfit: ticket.takeProfit,
    reduceOnly: ticket.reduceOnly,
    ms: run.ms,
    steps: run.steps,
    ticket,
  };
}

/**
 * Aggregates exchange execution activity (`snapshot.activity`) and assistant-drafted
 * order tickets (`snapshot.turns`), newest first.
 */
export function buildExecutionHistory(snapshot: Snapshot): ExecutionRecord[] {
  const records: ExecutionRecord[] = [];

  for (const run of snapshot.activity) {
    records.push(parseActivityRun(run, snapshot));
  }

  for (const turn of snapshot.turns) {
    if (!turn.ticket) continue;
    const status = ticketStatus(turn.ticket, snapshot);
    records.push(ticketRecordFromTurn(turn, turn.ticket, status, snapshot));
  }

  return records.sort((left, right) => right.time.localeCompare(left.time));
}
