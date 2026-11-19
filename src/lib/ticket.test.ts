import { describe, expect, it } from "vitest";
import type { Snapshot, TicketView } from "../api/types";
import { confirmLabel, ticketAction, ticketStatus } from "./ticket";

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
