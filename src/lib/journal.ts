/**
 * Persistent client-side Trading Journal & Setup Edge Analytics store for
 * decentralized perpetual futures. Entries persist to `localStorage` under
 * `octoneo.journal.v1` and sync reactively across Account and Activity views.
 *
 * The journal holds only what the trader logged. The sample entries below are
 * for the browser demo and the tests: the desktop app starts empty, and drops
 * them if an earlier version saved them beside the trader's own entries.
 */

import { useSyncExternalStore } from "react";
import { isDesktop } from "../api";
import type { Network } from "../api/types";
import { signedMoney } from "./format";
import type { EnrichedPosition, ExecutionRecord } from "./portfolio";

const STORAGE_KEY = "octoneo.journal.v1";

export type JournalOutcome = "open" | "win" | "loss" | "breakeven" | "note";

export const JOURNAL_SETUPS = [
  "Trend Follow",
  "Breakout",
  "Mean Reversion",
  "Funding Carry",
  "Support / Resistance",
  "Liquidity Sweep",
  "Macro / News",
] as const;

export type JournalSetup = (typeof JOURNAL_SETUPS)[number];

export interface JournalChecklist {
  stopRespected: boolean;
  sizedWithinRisk: boolean;
  followedPlan: boolean;
}

export interface JournalEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  network: Network;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  outcome: JournalOutcome;
  setup: JournalSetup;
  entryPrice: string;
  exitPrice: string;
  qty: string;
  /** Signed realized (or current mark) P&L in quote currency, e.g. `"342.50"` or `"-74.20"`. */
  pnlUsd: string;
  /** Planned reward-to-risk ratio, e.g. `"2.4"`. */
  rrPlanned: string;
  checklist: JournalChecklist;
  thesis: string;
  lesson: string;
}

export interface JournalDraft {
  id?: string;
  network: Network;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  outcome: JournalOutcome;
  setup: JournalSetup;
  entryPrice: string;
  exitPrice: string;
  qty: string;
  pnlUsd: string;
  rrPlanned: string;
  checklist: JournalChecklist;
  thesis: string;
  lesson: string;
}

export interface SetupPerformance {
  setup: JournalSetup;
  total: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnlUsd: number;
  avgPnlUsd: number | null;
  disciplinePct: number;
}

export interface JournalMetrics {
  totalCount: number;
  openCount: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRatePct: number | null;
  netPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  profitFactor: number | null;
  expectancyUsd: number | null;
  avgRr: number | null;
  disciplinePct: number;
  bestSetup: SetupPerformance | null;
  bySetup: SetupPerformance[];
}

export interface JournalState {
  entries: JournalEntry[];
  composerOpen: boolean;
  editingId: string | null;
  draft: JournalDraft;
}

function defaultDraft(network: Network = "testnet"): JournalDraft {
  return {
    network,
    symbol: "BTCUSDT",
    side: "long",
    leverage: 3,
    outcome: "open",
    setup: "Trend Follow",
    entryPrice: "",
    exitPrice: "",
    qty: "",
    pnlUsd: "",
    rrPlanned: "2.0",
    checklist: {
      stopRespected: true,
      sizedWithinRisk: true,
      followedPlan: true,
    },
    thesis: "",
    lesson: "",
  };
}

/** Invented trades for the browser demo and the tests. Never shown as a trader's own in the desktop app. */
function starterEntries(): JournalEntry[] {
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return [
    {
      id: "jnl-eth-trend",
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(2),
      network: "testnet",
      symbol: "ETHUSDT",
      side: "long",
      leverage: 5,
      outcome: "open",
      setup: "Trend Follow",
      entryPrice: "1711.64",
      exitPrice: "1921.50",
      qty: "1.2",
      pnlUsd: "81.13",
      rrPlanned: "2.2",
      checklist: { stopRespected: true, sizedWithinRisk: true, followedPlan: true },
      thesis:
        "4h higher-low above EMA20/EMA50 confluence with positive spot-perp basis and steady open interest expansion.",
      lesson:
        "Both STOP_MARKET (1,654.70) and TAKE_PROFIT_MARKET (1,921.50) reduce-only guards armed on entry.",
    },
    {
      id: "jnl-sol-resist",
      createdAt: hoursAgo(19),
      updatedAt: hoursAgo(14),
      network: "testnet",
      symbol: "SOLUSDT",
      side: "short",
      leverage: 3,
      outcome: "open",
      setup: "Support / Resistance",
      entryPrice: "95.31",
      exitPrice: "89.40",
      qty: "40",
      pnlUsd: "-58.00",
      rrPlanned: "1.8",
      checklist: { stopRespected: true, sizedWithinRisk: true, followedPlan: true },
      thesis:
        "Short into 4h supply zone after momentum divergence on RSI-14; cross-margined hedge against long ETH beta.",
      lesson:
        "Stop-loss resting above swing high at 100.63; watching 4h close for invalidation.",
    },
    {
      id: "jnl-btc-sweep",
      createdAt: hoursAgo(42),
      updatedAt: hoursAgo(30),
      network: "testnet",
      symbol: "BTCUSDT",
      side: "long",
      leverage: 3,
      outcome: "win",
      setup: "Liquidity Sweep",
      entryPrice: "61420.00",
      exitPrice: "62790.00",
      qty: "0.25",
      pnlUsd: "342.50",
      rrPlanned: "2.5",
      checklist: { stopRespected: true, sizedWithinRisk: true, followedPlan: true },
      thesis:
        "London session wick below 61.5k swept resting long liquidations while funding flipped negative (-0.012%/8h).",
      lesson:
        "Waiting for the 15m reclaim candle before entering saved 380 pts of drawdown and gave a clean 2.5R fill.",
    },
    {
      id: "jnl-sui-breakout",
      createdAt: hoursAgo(76),
      updatedAt: hoursAgo(64),
      network: "testnet",
      symbol: "SUIUSDT",
      side: "short",
      leverage: 5,
      outcome: "win",
      setup: "Breakout",
      entryPrice: "1.964",
      exitPrice: "1.766",
      qty: "1000",
      pnlUsd: "198.00",
      rrPlanned: "2.1",
      checklist: { stopRespected: true, sizedWithinRisk: true, followedPlan: true },
      thesis:
        "Breakdown below 3-day range support with elevated funding (longs crowded at +0.028%/8h).",
      lesson:
        "Trimmed 50% at 1R and trailed stop to breakeven for the runner into daily demand.",
    },
    {
      id: "jnl-doge-meanrev",
      createdAt: hoursAgo(110),
      updatedAt: hoursAgo(96),
      network: "testnet",
      symbol: "DOGEUSDT",
      side: "long",
      leverage: 2,
      outcome: "loss",
      setup: "Mean Reversion",
      entryPrice: "0.1346",
      exitPrice: "0.1284",
      qty: "12000",
      pnlUsd: "-74.40",
      rrPlanned: "1.6",
      checklist: { stopRespected: true, sizedWithinRisk: true, followedPlan: false },
      thesis:
        "Faded first 1h pullback into VWAP without waiting for 4h structure confirmation.",
      lesson:
        "Entered early before BTC stabilized; keep mean-reversion size at 0.5% equity risk when HTF trend is mixed.",
    },
  ];
}

/** What a journal holds before anything is logged: nothing in the desktop app, the samples in the demo. */
function initialEntries(): JournalEntry[] {
  return isDesktop() ? [] : starterEntries();
}

/** The sample entries' ids. Earlier versions showed them in every new journal, and saved them with the first real entry. */
const SAMPLE_IDS = new Set(starterEntries().map((entry) => entry.id));

function readStorage(): JournalEntry[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return initialEntries();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialEntries();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return initialEntries();
    const entries = parsed as JournalEntry[];
    return isDesktop() ? entries.filter((entry) => !SAMPLE_IDS.has(entry.id)) : entries;
  } catch {
    return initialEntries();
  }
}

function writeStorage(entries: JournalEntry[]): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    // Ignore storage quota / sandbox errors.
  }
}

let state: JournalState = {
  entries: readStorage(),
  composerOpen: false,
  editingId: null,
  draft: defaultDraft(),
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: Partial<JournalState>): void {
  state = { ...state, ...next };
  emit();
}

export function getJournalState(): JournalState {
  return state;
}

export function subscribeJournal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useJournal(): JournalState {
  return useSyncExternalStore(subscribeJournal, getJournalState, getJournalState);
}

export function openJournalComposer(prefill?: Partial<JournalDraft>, editingId: string | null = null): void {
  const base = defaultDraft(prefill?.network ?? "testnet");
  setState({
    composerOpen: true,
    editingId,
    draft: {
      ...base,
      ...prefill,
      checklist: {
        ...base.checklist,
        ...(prefill?.checklist ?? {}),
      },
    },
  });
}

export function updateJournalDraft(patch: Partial<JournalDraft>): void {
  setState({
    draft: {
      ...state.draft,
      ...patch,
      checklist: {
        ...state.draft.checklist,
        ...(patch.checklist ?? {}),
      },
    },
  });
}

export function closeJournalComposer(): void {
  setState({
    composerOpen: false,
    editingId: null,
  });
}

export function saveJournalEntry(draft: JournalDraft, editingId: string | null = state.editingId): JournalEntry {
  const now = new Date().toISOString();
  const symbol = draft.symbol.trim().toUpperCase() || "BTCUSDT";
  const leverage = Number.isFinite(draft.leverage) && draft.leverage >= 1 ? Math.round(draft.leverage) : 3;

  const existing = editingId ? state.entries.find((item) => item.id === editingId) : undefined;
  const entry: JournalEntry = {
    id: existing?.id ?? `jnl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    network: draft.network,
    symbol,
    side: draft.side,
    leverage,
    outcome: draft.outcome,
    setup: draft.setup,
    entryPrice: draft.entryPrice.trim(),
    exitPrice: draft.exitPrice.trim(),
    qty: draft.qty.trim(),
    pnlUsd: draft.pnlUsd.trim(),
    rrPlanned: draft.rrPlanned.trim(),
    checklist: { ...draft.checklist },
    thesis: draft.thesis.trim(),
    lesson: draft.lesson.trim(),
  };

  const nextEntries = existing
    ? state.entries.map((item) => (item.id === existing.id ? entry : item))
    : [entry, ...state.entries];

  writeStorage(nextEntries);
  setState({
    entries: nextEntries,
    composerOpen: false,
    editingId: null,
    draft: defaultDraft(draft.network),
  });
  return entry;
}

export function deleteJournalEntry(id: string): void {
  const nextEntries = state.entries.filter((item) => item.id !== id);
  writeStorage(nextEntries);
  setState({
    entries: nextEntries,
    ...(state.editingId === id ? { composerOpen: false, editingId: null } : {}),
  });
}

export function resetJournalToSeeds(): void {
  const seeds = starterEntries();
  writeStorage(seeds);
  setState({
    entries: seeds,
    composerOpen: false,
    editingId: null,
  });
}

/** Builds a JournalDraft prefilled from an active open position on the exchange. */
export function draftFromPosition(item: EnrichedPosition, network: Network): JournalDraft {
  const { position, slPrice, tpPrice, plannedRr } = item;
  const guardNotes: string[] = [];
  if (slPrice) guardNotes.push(`SL @ ${slPrice}`);
  if (tpPrice) guardNotes.push(`TP @ ${tpPrice}`);

  return {
    network,
    symbol: position.symbol,
    side: position.side,
    leverage: position.leverage,
    outcome: "open",
    setup: "Trend Follow",
    entryPrice: position.entryPrice,
    exitPrice: tpPrice ?? position.markPrice,
    qty: position.qty,
    pnlUsd: position.unrealizedPnl,
    rrPlanned: plannedRr !== null ? plannedRr.toFixed(2) : "2.0",
    checklist: {
      stopRespected: slPrice !== null,
      sizedWithinRisk: true,
      followedPlan: true,
    },
    thesis: `${position.isolated ? "Isolated" : "Cross"} ${position.leverage}x ${position.side} on ${item.base}-${item.quote} Perp (${item.sharePct.toFixed(1)}% of portfolio notional).`,
    lesson:
      guardNotes.length > 0
        ? `Active protection: ${guardNotes.join(" · ")}.`
        : "No reduce-only SL/TP order attached yet — monitor invalidation level.",
  };
}

/** Builds a JournalDraft prefilled from an execution or assistant ticket record. */
export function draftFromExecution(record: ExecutionRecord): JournalDraft {
  const side: "long" | "short" = record.side === "sell" ? "short" : "long";
  const guards: string[] = [];
  if (record.stopLoss) guards.push(`SL @ ${record.stopLoss}`);
  if (record.takeProfit) guards.push(`TP @ ${record.takeProfit}`);

  return {
    network: record.network,
    symbol: record.symbol ?? "BTCUSDT",
    side,
    leverage: record.leverage ?? 3,
    outcome: "open",
    setup: "Trend Follow",
    entryPrice: record.fillPrice ?? "",
    exitPrice: record.takeProfit ?? "",
    qty: record.qty ?? "",
    pnlUsd: "",
    rrPlanned: "2.0",
    checklist: {
      stopRespected: Boolean(record.stopLoss),
      sizedWithinRisk: true,
      followedPlan: true,
    },
    thesis: record.summary,
    lesson: guards.length > 0 ? `Executed with ${guards.join(" · ")}.` : "",
  };
}

function finiteOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function entryDisciplinePct(entry: JournalEntry): number {
  const { stopRespected, sizedWithinRisk, followedPlan } = entry.checklist;
  const score = (stopRespected ? 1 : 0) + (sizedWithinRisk ? 1 : 0) + (followedPlan ? 1 : 0);
  return (score / 3) * 100;
}

export function computeJournalMetrics(
  entries: JournalEntry[],
  networkFilter: Network | "all" = "all",
): JournalMetrics {
  let totalCount = 0;
  let openCount = 0;
  let winCount = 0;
  let lossCount = 0;
  let breakevenCount = 0;
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let netPnlUsd = 0;
  let rrSum = 0;
  let rrCount = 0;
  let disciplineSum = 0;

  const setupBuckets = new Map<
    JournalSetup,
    { total: number; closed: number; wins: number; losses: number; pnlSum: number; discSum: number }
  >();

  for (const entry of entries) {
    if (networkFilter !== "all" && entry.network !== networkFilter) continue;
    totalCount += 1;

    const isWin = entry.outcome === "win";
    const isLoss = entry.outcome === "loss";
    const isBe = entry.outcome === "breakeven";
    const isClosed = isWin || isLoss || isBe;

    if (entry.outcome === "open") openCount += 1;
    else if (isWin) winCount += 1;
    else if (isLoss) lossCount += 1;
    else if (isBe) breakevenCount += 1;

    const pnl = finiteOrNull(entry.pnlUsd);
    if (pnl !== null && isClosed) {
      netPnlUsd += pnl;
      if (pnl > 0) grossProfitUsd += pnl;
      else if (pnl < 0) grossLossUsd += Math.abs(pnl);
    }

    const rr = finiteOrNull(entry.rrPlanned);
    if (rr !== null && rr > 0) {
      rrSum += rr;
      rrCount += 1;
    }

    const disc = entryDisciplinePct(entry);
    disciplineSum += disc;

    let bucket = setupBuckets.get(entry.setup);
    if (!bucket) {
      bucket = { total: 0, closed: 0, wins: 0, losses: 0, pnlSum: 0, discSum: 0 };
      setupBuckets.set(entry.setup, bucket);
    }
    bucket.total += 1;
    if (isClosed) bucket.closed += 1;
    if (isWin) bucket.wins += 1;
    if (isLoss) bucket.losses += 1;
    if (pnl !== null) bucket.pnlSum += pnl;
    bucket.discSum += disc;
  }

  const closedCount = winCount + lossCount + breakevenCount;
  const decidedCount = winCount + lossCount;
  const winRatePct = decidedCount > 0 ? (winCount / decidedCount) * 100 : null;
  const avgWinUsd = winCount > 0 ? grossProfitUsd / winCount : null;
  const avgLossUsd = lossCount > 0 ? grossLossUsd / lossCount : null;
  const profitFactor =
    grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? Number.POSITIVE_INFINITY : null;
  const expectancyUsd = closedCount > 0 ? netPnlUsd / closedCount : null;
  const avgRr = rrCount > 0 ? rrSum / rrCount : null;
  const disciplinePct = totalCount > 0 ? disciplineSum / totalCount : 100;

  const bySetup: SetupPerformance[] = [];
  for (const setup of JOURNAL_SETUPS) {
    const bucket = setupBuckets.get(setup);
    if (!bucket || bucket.total === 0) continue;
    const decided = bucket.wins + bucket.losses;
    bySetup.push({
      setup,
      total: bucket.total,
      closed: bucket.closed,
      wins: bucket.wins,
      losses: bucket.losses,
      winRatePct: decided > 0 ? (bucket.wins / decided) * 100 : null,
      netPnlUsd: bucket.pnlSum,
      avgPnlUsd: bucket.pnlSum / bucket.total,
      disciplinePct: bucket.discSum / bucket.total,
    });
  }
  bySetup.sort((left, right) => right.netPnlUsd - left.netPnlUsd);

  const bestSetup = bySetup.find((row) => row.netPnlUsd > 0) ?? bySetup[0] ?? null;

  return {
    totalCount,
    openCount,
    closedCount,
    winCount,
    lossCount,
    breakevenCount,
    winRatePct,
    netPnlUsd,
    grossProfitUsd,
    grossLossUsd,
    avgWinUsd,
    avgLossUsd,
    profitFactor,
    expectancyUsd,
    avgRr,
    disciplinePct,
    bestSetup,
    bySetup,
  };
}

/** Exports the journal and edge metrics as clean Markdown for clipboard sharing or AI analysis. */
export function formatJournalMarkdown(entries: JournalEntry[], metrics: JournalMetrics): string {
  const pf =
    metrics.profitFactor === null
      ? "—"
      : Number.isFinite(metrics.profitFactor)
        ? metrics.profitFactor.toFixed(2)
        : "∞";
  const lines = [
    "# OctoNeo Perpetual Futures Trading Journal",
    "",
    `- **Closed Trades**: ${metrics.closedCount} (${metrics.winCount}W / ${metrics.lossCount}L / ${metrics.breakevenCount}BE)`,
    `- **Win Rate**: ${metrics.winRatePct !== null ? `${metrics.winRatePct.toFixed(1)}%` : "—"}`,
    `- **Net Realized P&L**: ${metrics.netPnlUsd >= 0 ? "+" : "−"}${Math.abs(metrics.netPnlUsd).toFixed(2)} USDT`,
    `- **Profit Factor**: ${pf} · **Discipline Score**: ${metrics.disciplinePct.toFixed(0)}%`,
    "",
    "## Entries",
    "",
  ];

  for (const entry of entries) {
    const pnl = finiteOrNull(entry.pnlUsd);
    const pnlText = pnl !== null ? `${pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)} USDT` : "—";
    lines.push(
      `### ${entry.symbol} · ${entry.side.toUpperCase()} ${entry.leverage}x (${entry.outcome.toUpperCase()}) — ${entry.setup}`,
      `- **Entry / Exit**: ${entry.entryPrice || "—"} → ${entry.exitPrice || "—"} · **Qty**: ${entry.qty || "—"} · **P&L**: ${pnlText} · **Planned R:R**: ${entry.rrPlanned || "—"}`,
      `- **Thesis**: ${entry.thesis || "—"}`,
      `- **Review / Lesson**: ${entry.lesson || "—"}`,
      "",
    );
  }

  return lines.join("\n");
}

/**
 * The message that asks the assistant to review the journal's performance: the figures, then what to
 * look for. The journal reaches a model only in this message, when the trader asks for the review.
 */
export function journalReviewPrompt(metrics: JournalMetrics): string {
  const pf =
    metrics.profitFactor !== null && Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "—";
  return [
    `Review my perpetual trading journal performance (${metrics.closedCount} closed trades, ${metrics.openCount} open theses):`,
    `- Win rate: ${metrics.winRatePct !== null ? `${metrics.winRatePct.toFixed(1)}%` : "—"}, Net realized P&L: ${signedMoney(metrics.netPnlUsd.toFixed(2))} USDT, Profit factor: ${pf}, Discipline score: ${metrics.disciplinePct.toFixed(0)}%`,
    metrics.bestSetup
      ? `- Top setup: ${metrics.bestSetup.setup} (${signedMoney(metrics.bestSetup.netPnlUsd.toFixed(2))} USDT)`
      : "",
    "Identify my strongest edge, any risk/discipline leaks, and how I should position my current portfolio.",
  ]
    .filter(Boolean)
    .join("\n");
}
