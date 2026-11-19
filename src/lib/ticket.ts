import type { Snapshot, TicketView } from "../api/types";

export type TicketStatus =
  | { state: "pending" }
  /** Submitted. `note` is what the exchange answered. */
  | { state: "done"; note: string }
  /** Confirmed by the trader but not confirmed by the exchange. `note` says why, and whether the order must be checked there. */
  | { state: "failed"; note: string }
  /** Replaced, dismissed, or invalidated by a network change. */
  | { state: "expired" };

/** Where a ticket stands, derived from the latest snapshot. */
export function ticketStatus(ticket: TicketView, snapshot: Snapshot): TicketStatus {
  const receipt = snapshot.receipts[ticket.id];
  if (receipt) return { state: "done", note: receipt };
  const failure = snapshot.failures[ticket.id];
  if (failure) return { state: "failed", note: failure };
  if (snapshot.draft?.id === ticket.id) return { state: "pending" };
  return { state: "expired" };
}

export type TicketAction = "Long" | "Short" | "Reduce" | "Close";

/**
 * What the order does, in one word. A reduce-only order closes or trims a
 * position; the core's `effect` sentence says which.
 */
export function ticketAction(ticket: TicketView): TicketAction {
  if (!ticket.reduceOnly) return ticket.side === "buy" ? "Long" : "Short";
  return /^clos/i.test(ticket.effect.trim()) ? "Close" : "Reduce";
}

/** The confirm button. The end-to-end test clicks these exact words. */
export function confirmLabel(ticket: TicketView): string {
  return ticket.network === "mainnet" ? "Place live order" : "Place order";
}
