import { describe, expect, it } from "vitest";
import type { Snapshot, TicketView } from "../api/types";
import { feedName, ticketNumber, ticketStatus } from "./ticket";

const ticket: TicketView = {
  id: "a3f9c2e17b604d55a3f9c2e17b604d55",
  pair: "BTC/USDT",
  side: "buy",
  qty: "0.5",
  price: "84215.50",
  value: "42107.75",
  feed: "sample",
  destination: "paper",
  rationale: "",
};

function snapshotWith(patch: Partial<Snapshot>): Snapshot {
  return {
    receipts: {},
    draft: null,
    account: { cash: "100000.00", equity: "100000.00", holdings: [], orders: [] },
    ...patch,
  } as Snapshot;
}

describe("ticketStatus", () => {
  it("is pending while the ticket is the current draft", () => {
    expect(ticketStatus(ticket, snapshotWith({ draft: ticket }))).toEqual({ state: "pending" });
  });

  it("is done once a receipt exists, even if a stale draft is still attached", () => {
    const snapshot = snapshotWith({ draft: ticket, receipts: { [ticket.id]: "Binance acknowledged the order." } });
    expect(ticketStatus(ticket, snapshot)).toEqual({ state: "done", note: "Binance acknowledged the order." });
  });

  it("recognises a paper fill from the account when the receipt is gone", () => {
    const snapshot = snapshotWith({
      account: {
        cash: "57892.25",
        equity: "100000.00",
        holdings: [],
        orders: [
          { id: ticket.id, pair: "BTC/USDT", side: "buy", qty: "0.5", price: "84215.50", status: "filled", submitted: "2026-11-18T09:12:00Z" },
        ],
      },
    });
    expect(ticketStatus(ticket, snapshot)).toEqual({ state: "done", note: "Filled 0.5 at 84,215.50 USDT." });
  });

  it("expires when it was replaced or dismissed", () => {
    expect(ticketStatus(ticket, snapshotWith({}))).toEqual({ state: "expired" });
    expect(ticketStatus(ticket, snapshotWith({ draft: { ...ticket, id: "another" } }))).toEqual({ state: "expired" });
  });
});

describe("labels", () => {
  it("names feeds and shortens ticket ids", () => {
    expect(feedName("sample")).toBe("Sample tape");
    expect(feedName("okx")).toBe("OKX");
    expect(ticketNumber(ticket.id)).toBe("A3F9C2");
  });
});
