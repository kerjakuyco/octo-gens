/**
 * What the app did on the exchange, as one timeline, newest first: orders with their stop-loss and
 * take-profit, cancellations, tickets the assistant drafted, deposits and withdrawals, and what the grid
 * bots did.
 *
 * It reads the execution history the portfolio module builds. The grid bots' own runs are recognised by
 * their titles ("Start a BTC grid bot", "BTC grid bot: placed 2 orders", "Stop the BTC grid bot"), which
 * the core and the browser mock both write, so each one can name its market and open its bot.
 */

import type { GridBotView, Network, Snapshot } from "../api/types";
import { type ExecutionRecord, buildExecutionHistory } from "./portfolio";

/** What kind of thing happened. */
export type ActivityKind = "order" | "ticket" | "cancel" | "grid" | "wallet" | "tool";

/** The timeline's filters: everything, orders and tickets, grid bots, money in and out of the account. */
export type ActivityFilter = "all" | "orders" | "grid" | "account";

/** What a grid bot did. */
export type GridAction = "started" | "placed" | "filled" | "ended" | "stopped";

export interface GridEvent {
  /** The coin, e.g. `BTC`. */
  base: string;
  /** The market, e.g. `BTCUSDT`, to open the bot and the market with. */
  symbol: string;
  action: GridAction;
  /** The bot, while it is still listed on the active network. */
  bot: GridBotView | null;
}

export interface ActivityItem {
  record: ExecutionRecord;
  kind: ActivityKind;
  /** Set for what a grid bot did. */
  grid: GridEvent | null;
}

/** The coin before "grid bot", wherever the title puts it. */
const GRID_TITLE = /(?:^|\s)([^\s:]+) grid bot\b/i;

/** What a grid bot run did, read from its title, or null when the run is not a grid bot's. */
export function gridEventOf(title: string): { base: string; action: GridAction } | null {
  const base = GRID_TITLE.exec(title)?.[1];
  if (!base) return null;
  let action: GridAction = "placed";
  if (/^Start (?:a|the)\b/i.test(title)) action = "started";
  else if (/\bstopped\b|^Stop the\b/i.test(title)) action = "stopped";
  else if (/ended without filling/i.test(title)) action = "ended";
  else if (/:\s*\d+\s+fills?\b/i.test(title)) action = "filled";
  return { base, action };
}

/**
 * The bot a grid event belongs to: of the listed bots on that coin, the newest one started before the
 * event (allowing a minute for the clocks), else the newest. Its market comes from the bot, the
 * watchlist, or the coin with USDT.
 */
function gridBotFor(snapshot: Snapshot, base: string, time: string): { symbol: string; bot: GridBotView | null } {
  const at = Date.parse(time);
  const candidates = snapshot.grids
    .filter((bot) => bot.base === base)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const bot =
    candidates.find((item) => !Number.isFinite(at) || Date.parse(item.createdAt) <= at + 60_000) ??
    candidates[0] ??
    null;
  const symbol = bot?.symbol ?? snapshot.instruments.find((item) => item.base === base)?.symbol ?? `${base}USDT`;
  return { symbol, bot };
}

/** Every event, newest first, each with its kind and, for a grid bot's, its market and bot. */
export function buildActivity(snapshot: Snapshot): ActivityItem[] {
  return buildExecutionHistory(snapshot).map((record) => {
    const event = record.category === "wallet" ? null : gridEventOf(record.title);
    if (!event) return { record, kind: record.category, grid: null };
    const { symbol, bot } = gridBotFor(snapshot, event.base, record.time);
    return {
      record: { ...record, symbol: record.symbol ?? symbol, base: record.base ?? event.base },
      kind: "grid",
      grid: { ...event, symbol, bot },
    };
  });
}

/** Whether an event belongs under a filter. */
export function matchesFilter(item: ActivityItem, filter: ActivityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "orders":
      return item.kind === "order" || item.kind === "ticket" || item.kind === "cancel";
    case "grid":
      return item.kind === "grid";
    case "account":
      return item.kind === "wallet";
  }
}

/** The events under a filter, on one network or all of them. */
export function filterActivity(
  items: readonly ActivityItem[],
  filter: ActivityFilter,
  network: Network | "all" = "all",
): ActivityItem[] {
  return items.filter(
    (item) => (network === "all" || item.record.network === network) && matchesFilter(item, filter),
  );
}

/** How many events each filter holds. */
export function countActivity(items: readonly ActivityItem[]): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = { all: 0, orders: 0, grid: 0, account: 0 };
  for (const item of items) {
    counts.all += 1;
    if (matchesFilter(item, "orders")) counts.orders += 1;
    else if (item.kind === "grid") counts.grid += 1;
    else if (item.kind === "wallet") counts.account += 1;
  }
  return counts;
}

/** A local calendar day as `YYYY-MM-DD`, or empty for a time that cannot be read. */
function dayKey(time: number): string {
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Today", "Yesterday", or the date, such as "Mon 18 Nov", with the year when it is not this one. */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  const key = dayKey(time);
  if (!key) return "Earlier";
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export interface ActivityDay {
  key: string;
  label: string;
  items: ActivityItem[];
}

/** Events grouped by the local day they happened on, keeping their order. */
export function groupByDay(items: readonly ActivityItem[], now: number = Date.now()): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const item of items) {
    const key = dayKey(Date.parse(item.record.time)) || "unknown";
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(item);
    else days.push({ key, label: dayLabel(item.record.time, now), items: [item] });
  }
  return days;
}
