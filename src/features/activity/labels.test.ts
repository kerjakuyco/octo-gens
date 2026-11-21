import { describe, expect, it } from "vitest";
import type { RunView, Snapshot, TicketView } from "../../api/types";
import { buildActivity } from "../../lib/history";
import { eventStatus, eventTitle } from "./labels";

const ticket: TicketView = {
  id: "a3f9c2e17b604d55a3f9c2e17b604d55",
  network: "testnet",
  symbol: "BTCUSDT",
  side: "buy",
  qty: "0.01",
  price: "62000",
  notional: "620",
  leverage: 3,
  margin: "206.67",
  reduceOnly: false,
  stopLoss: null,
  takeProfit: null,
  estLiquidation: "42883.3",
  effect: "Opens a 0.01 BTC long at 3x with isolated margin",
  rationale: "",
};

// The reasons as the core words them.
const lost = `The exchange did not say whether it took the order (HTTP 503). The order may or may not have reached the exchange. Check your open orders and positions for client ID ${ticket.id} before sending it again.`;
const banded =
  "A market buy would be refused right now: the best price to buy at, 65,907.94, is 6.3% above the mark price, 62,000.00, and the exchange takes market orders only within 2% of it. On testnet the order book can drift away from the mark price. Nothing was sent.";
const unfilled = "The exchange took the order but did not fill it (status expired). Nothing was opened or closed.";

function run(title: string, patch: Partial<RunView> = {}): RunView {
  return {
    id: title.replace(/\W+/g, "-").toLowerCase(),
    thread: "",
    agent: "Execution",
    title,
    network: "testnet",
    time: "2026-11-21T10:00:00Z",
    status: "complete",
    steps: [],
    output: "",
    reasoning: "",
    ms: 420,
    ticket: null,
    grid: null,
    cards: [],
    usage: null,
    model: "",
    ...patch,
  };
}

function snapshotWith(patch: Partial<Snapshot>): Snapshot {
  return {
    network: "testnet",
    instruments: [],
    activity: [],
    turns: [],
    grids: [],
    receipts: {},
    failures: {},
    draft: null,
    ...patch,
  } as unknown as Snapshot;
}

/** The one event a confirmed order that failed for `reason` makes. */
function failedOrder(reason: string) {
  const confirm = run("Confirm buy 0.01 BTCUSDT", { status: "failed", output: reason });
  const [item] = buildActivity(snapshotWith({ activity: [confirm] }));
  return item!;
}

/** The one event an assistant's ticket that failed for `reason` makes. */
function failedTicket(reason: string) {
  const turn = run("Long BTC", { agent: "Assistant", ticket });
  const [item] = buildActivity(snapshotWith({ turns: [turn], failures: { [ticket.id]: reason } }));
  return item!;
}

describe("an order that did not go through", () => {
  it("is unconfirmed, not failed, while it may exist", () => {
    const item = failedOrder(lost);
    expect(eventTitle(item)).toBe("Buy 0.01 BTC not confirmed");
    expect(eventStatus(item)).toEqual({ label: "Unconfirmed", tone: "warn" });
  });

  it("did not go through when it was refused or held back", () => {
    const item = failedOrder(banded);
    expect(eventTitle(item)).toBe("Buy 0.01 BTC did not go through");
    expect(eventStatus(item)).toEqual({ label: "Failed", tone: "down" });
  });
});

describe("a ticket that did not go through", () => {
  it("is unconfirmed while the order may exist", () => {
    expect(eventStatus(failedTicket(lost))).toEqual({ label: "Unconfirmed", tone: "warn" });
  });

  it("was not placed when it was refused or held back", () => {
    expect(eventStatus(failedTicket(banded))).toEqual({ label: "Not placed", tone: "down" });
  });

  it("was not filled when the exchange took it and filled none of it", () => {
    expect(eventStatus(failedTicket(unfilled))).toEqual({ label: "Not filled", tone: "down" });
  });
});
