import { describe, expect, it } from "vitest";
import type { Snapshot, TicketView } from "../api/types";
import { confirmLabel, failureTitle, ticketAction, ticketFailure, ticketStatus } from "./ticket";

const ticket: TicketView = {
  id: "a3f9c2e17b604d55a3f9c2e17b604d55",
  network: "testnet",
  symbol: "BTCUSDT",
  side: "buy",
  qty: "0.01",
  price: "62786.40",
  notional: "627.86",
  leverage: 3,
  margin: "209.29",
  reduceOnly: false,
  stopLoss: null,
  takeProfit: null,
  estLiquidation: "42171.53",
  effect: "Opens a 0.01 BTC long at 3x",
  rationale: "",
};

function snapshotWith(patch: Partial<Snapshot>): Snapshot {
  return { network: "testnet", receipts: {}, failures: {}, draft: null, ...patch } as Snapshot;
}

describe("ticketStatus", () => {
  it("is pending while the ticket is the current draft", () => {
    expect(ticketStatus(ticket, snapshotWith({ draft: ticket }))).toEqual({ state: "pending" });
  });

  it("is done once a receipt exists, even if a stale draft is still attached", () => {
    const note = "Sent on testnet: buy 0.01 BTCUSDT, order 48213777, filled at 62,790.12.";
    const snapshot = snapshotWith({ draft: ticket, receipts: { [ticket.id]: note } });
    expect(ticketStatus(ticket, snapshot)).toEqual({ state: "done", note });
  });

  it("expires when it was replaced or dismissed", () => {
    expect(ticketStatus(ticket, snapshotWith({}))).toEqual({ state: "expired" });
    expect(ticketStatus(ticket, snapshotWith({ draft: { ...ticket, id: "another" } }))).toEqual({ state: "expired" });
  });

  it("expires when the network changes, because the core drops the draft", () => {
    expect(ticketStatus(ticket, snapshotWith({ network: "mainnet", draft: null }))).toEqual({ state: "expired" });
  });

  it("keeps the reason when the exchange did not confirm the order", () => {
    const note = "The exchange did not answer in time. The order may or may not have reached the exchange.";
    const snapshot = snapshotWith({ failures: { [ticket.id]: note } });
    expect(ticketStatus(ticket, snapshot)).toEqual({ state: "failed", note });
    // A newer draft does not hide what happened to this one.
    expect(ticketStatus(ticket, { ...snapshot, draft: { ...ticket, id: "newer" } })).toEqual({ state: "failed", note });
  });

  it("keeps a sent ticket done after a newer draft arrives", () => {
    const snapshot = snapshotWith({ draft: { ...ticket, id: "newer" }, receipts: { [ticket.id]: "Sent." } });
    expect(ticketStatus(ticket, snapshot)).toEqual({ state: "done", note: "Sent." });
  });
});

describe("failureTitle", () => {
  // The reasons as the core words them.
  const id = ticket.id;
  const lost = `The exchange did not say whether it took the order (HTTP 503). The order may or may not have reached the exchange. Check your open orders and positions for client ID ${id} before sending it again.`;
  const absent = `The exchange did not say whether it took the order (HTTP 503). The exchange shows no order with client ID ${id}, so it was most likely not placed. Check your positions before sending it again.`;
  const banded =
    "A market buy would be refused right now: the best price to buy at, 61,651.90, is 6.3% above the mark price, 58,008.70, and the exchange takes market orders only within 2% of it. On testnet the order book can drift away from the mark price. Nothing was sent.";
  const empty =
    "A market sell cannot fill right now: the order book has no buy orders to sell to. On testnet a market's order book can sit empty for a while. Nothing was sent.";
  const refused =
    "The best price on the other side of the book is too far from the mark price, outside the band the exchange allows for market orders, so nothing was placed (code -4131). On testnet the order book can drift away from the mark price.";
  const stale = "The BTCUSDT position changed after this ticket was drafted. Nothing was sent; draft it again.";
  const unfilled = "The exchange took the order but did not fill it (status expired). Nothing was opened or closed.";

  it("calls an order unconfirmed only when it may exist after all", () => {
    expect(ticketFailure(lost)).toBe("unconfirmed");
    expect(failureTitle(lost)).toBe("Order unconfirmed.");
  });

  it("says an order was not placed when it was refused, stopped before it was sent, or left no trace", () => {
    for (const note of [banded, empty, refused, stale, absent, "Exchange: Margin is insufficient (code -2019)"]) {
      expect(ticketFailure(note)).toBe("unplaced");
      expect(failureTitle(note)).toBe("Order not placed.");
    }
  });

  it("says an order the exchange took without filling was not filled", () => {
    expect(ticketFailure(unfilled)).toBe("unfilled");
    expect(failureTitle(unfilled)).toBe("Order not filled.");
  });
});

describe("ticketAction", () => {
  it("names an opening order by its direction", () => {
    expect(ticketAction(ticket)).toBe("Long");
    expect(ticketAction({ ...ticket, side: "sell", effect: "Opens a 0.01 BTC short at 5x" })).toBe("Short");
  });

  it("tells a close from a reduction on reduce-only orders", () => {
    const reduceOnly = { ...ticket, side: "sell", reduceOnly: true, margin: "0.00" } as const;
    expect(ticketAction({ ...reduceOnly, effect: "Closes your 1.2 ETH long" })).toBe("Close");
    expect(ticketAction({ ...reduceOnly, effect: "Reduces your ETH long from 1.2 to 0.7" })).toBe("Reduce");
    expect(ticketAction({ ...reduceOnly, effect: "" })).toBe("Reduce");
  });

  it("keeps the direction for an opposite order that is not reduce-only", () => {
    const flip = { ...ticket, side: "sell", effect: "Closes your 1.2 ETH long and opens a 0.8 ETH short at 3x" } as const;
    expect(ticketAction(flip)).toBe("Short");
  });
});

describe("labels", () => {
  it("words the confirm button by network, exactly as the end-to-end test clicks it", () => {
    expect(confirmLabel(ticket)).toBe("Place order");
    expect(confirmLabel({ ...ticket, network: "mainnet" })).toBe("Place live order");
  });
});
