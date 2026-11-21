import type { Snapshot, TicketView } from "../api/types";

export type TicketStatus =
  | { state: "pending" }
  /** Submitted. `note` is what the exchange answered. */
  | { state: "done"; note: string }
  /** Confirmed by the trader but not carried out. `note` says why, and whether the order must be checked on the exchange. */
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

/**
 * What became of a confirmed ticket that did not go through, read from the reason the core gave:
 * `unconfirmed` when the order may exist after all (its answer was lost and the exchange could not
 * say), `unfilled` when the exchange took it but filled none of it, and `unplaced` for everything
 * else: a refusal, a check that stopped it before it was sent, or no trace of it on the exchange.
 */
export type TicketFailure = "unconfirmed" | "unfilled" | "unplaced";

export function ticketFailure(note: string): TicketFailure {
  if (/may or may not have reached the exchange/i.test(note)) return "unconfirmed";
  if (/took the order but did not fill it/i.test(note)) return "unfilled";
  return "unplaced";
}

const FAILURE_TITLES: Record<TicketFailure, string> = {
  unconfirmed: "Order unconfirmed.",
  unfilled: "Order not filled.",
  unplaced: "Order not placed.",
};

/** The words a failed ticket's reason opens with. Only an order that may exist is called unconfirmed. */
export function failureTitle(note: string): string {
  return FAILURE_TITLES[ticketFailure(note)];
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
