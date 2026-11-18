import type { Feed, Snapshot, TicketView } from "../api/types";
import { price, units } from "./format";

export type TicketStatus =
  | { state: "pending" }
  /** Submitted. `note` is the venue or paper-fill outcome. */
  | { state: "done"; note: string }
  /** Replaced, dismissed, or invalidated by a feed change. */
  | { state: "expired" };

/** Where a ticket stands, derived from the latest snapshot. */
export function ticketStatus(ticket: TicketView, snapshot: Snapshot): TicketStatus {
  const receipt = snapshot.receipts[ticket.id];
  if (receipt) return { state: "done", note: receipt };
  const fill = snapshot.account.orders.find((order) => order.id === ticket.id);
  if (fill) {
    return { state: "done", note: `Filled ${units(fill.qty)} at ${price(fill.price)} USDT.` };
  }
  if (snapshot.draft?.id === ticket.id) return { state: "pending" };
  return { state: "expired" };
}

const FEED_NAMES: Record<Feed, string> = {
  sample: "Sample tape",
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
};

export function feedName(feed: Feed): string {
  return FEED_NAMES[feed];
}

/** A short, human-checkable ticket number from the client order id. */
export function ticketNumber(id: string): string {
  return id.slice(0, 6).toUpperCase();
}
