/** The Activity page's words in one place, so they stay plain and the same everywhere on it. */

import type { IconName } from "../../components/Icon";
import { units } from "../../lib/format";
import type { ActivityFilter, ActivityItem, ActivityKind, GridAction } from "../../lib/history";
import type { JournalOutcome } from "../../lib/journal";
import { ticketFailure } from "../../lib/ticket";

export type Tone = "up" | "down" | "warn" | undefined;

/** An outcome as a chip: still open, won, lost, broke even, or a note. */
export const OUTCOMES: Record<JournalOutcome, { label: string; tone: Tone }> = {
  open: { label: "Still open", tone: "warn" },
  win: { label: "Won", tone: "up" },
  loss: { label: "Lost", tone: "down" },
  breakeven: { label: "Broke even", tone: undefined },
  note: { label: "Note", tone: undefined },
};

/** The outcome choices in the journal form, in the order a trade goes. */
export const OUTCOME_CHOICES: { value: JournalOutcome; label: string }[] = [
  { value: "open", label: "Still open" },
  { value: "win", label: "Won" },
  { value: "loss", label: "Lost" },
  { value: "breakeven", label: "Broke even" },
  { value: "note", label: "Just a note" },
];

export const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "All",
  orders: "Orders",
  grid: "Grid bots",
  account: "Funds",
};

const KIND_ICONS: Record<ActivityKind, IconName> = {
  order: "trade",
  ticket: "assistant",
  cancel: "close",
  grid: "grid",
  wallet: "wallet",
  tool: "plug",
};

const KIND_NAMES: Record<ActivityKind, string> = {
  order: "Order",
  ticket: "Ticket",
  cancel: "Cancelled",
  grid: "Grid bot",
  wallet: "Funds",
  tool: "Tool",
};

const GRID_ACTIONS: Record<GridAction, string> = {
  started: "Started",
  placed: "Placed orders",
  filled: "Filled",
  ended: "Orders ended",
  stopped: "Stopped",
};

export function kindIcon(item: ActivityItem): IconName {
  return KIND_ICONS[item.kind];
}

/** A short name for what kind of event this is, shown beside its title. */
export function kindName(item: ActivityItem): string {
  if (item.grid) return GRID_ACTIONS[item.grid.action];
  return KIND_NAMES[item.kind];
}

/**
 * What happened, in plain words. An order that went through says what was bought or sold; a ticket
 * says what it would do; everything else keeps the title the app gave it, which is already plain.
 */
export function eventTitle(item: ActivityItem): string {
  const { record } = item;
  const amount = record.qty && record.base ? `${units(record.qty)} ${record.base}` : null;
  if (item.kind === "order" && record.side && amount) {
    if (record.status === "complete") return `${record.side === "buy" ? "Bought" : "Sold"} ${amount}`;
    if (record.status === "failed") {
      // An order whose answer was lost may have gone through after all.
      const outcome = ticketFailure(record.summary) === "unconfirmed" ? "not confirmed" : "did not go through";
      return `${record.side === "buy" ? "Buy" : "Sell"} ${amount} ${outcome}`;
    }
  }
  if (item.kind === "ticket" && amount) {
    const what = record.reduceOnly ? "Reduce" : record.side === "buy" ? "Long" : "Short";
    return `Ticket: ${what} ${amount}${record.leverage ? ` at ${record.leverage}x` : ""}`;
  }
  return record.title;
}

/** Where an event stands, as a chip. */
export function eventStatus(item: ActivityItem): { label: string; tone: Tone } {
  const { status, summary } = item.record;
  const orderLike = item.kind === "ticket" || item.kind === "order";
  // An order whose answer was lost may exist, so it is neither placed nor failed.
  if (status === "failed" && orderLike && ticketFailure(summary) === "unconfirmed") {
    return { label: "Unconfirmed", tone: "warn" };
  }
  if (item.kind === "ticket") {
    if (status === "pending") return { label: "Waiting for you", tone: "warn" };
    if (status === "complete") return { label: "Placed", tone: "up" };
    if (status === "failed") {
      return ticketFailure(summary) === "unfilled"
        ? { label: "Not filled", tone: "down" }
        : { label: "Not placed", tone: "down" };
    }
    if (status === "expired") return { label: "Expired", tone: undefined };
  }
  if (status === "failed") return { label: "Failed", tone: "down" };
  if (status === "stopped") return { label: "Stopped", tone: "warn" };
  if (status === "running") return { label: "Running", tone: undefined };
  if (status === "pending") return { label: "Waiting", tone: "warn" };
  if (status === "expired") return { label: "Expired", tone: undefined };
  return { label: item.kind === "order" ? "Filled" : "Done", tone: item.kind === "order" ? "up" : undefined };
}

/** How the checklist went, as a short chip. */
export function planKept(passed: number): { label: string; tone: Tone } {
  return {
    label: `Plan kept ${passed}/3`,
    tone: passed === 3 ? "up" : passed === 2 ? "warn" : "down",
  };
}
