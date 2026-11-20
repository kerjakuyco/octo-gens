import { describe, expect, it } from "vitest";
import { createMockBackend } from "../api/mock";
import {
  buildExecutionHistory,
  computePortfolioAnalytics,
  enrichOrders,
  enrichPositions,
  estimatePositionFunding8h,
} from "./portfolio";

describe("portfolio analytics & position enrichment", () => {
  it("computes signed 8h funding carry for long and short perpetual positions", () => {
    // Positive funding rate (+0.01% per 8h): longs pay (-), shorts earn (+).
    expect(estimatePositionFunding8h(10_000, "long", 0.01)).toBeCloseTo(-1, 6);
    expect(estimatePositionFunding8h(10_000, "short", 0.01)).toBeCloseTo(1, 6);
    // Negative funding rate (-0.02% per 8h): longs earn (+), shorts pay (-).
    expect(estimatePositionFunding8h(5_000, "long", -0.02)).toBeCloseTo(1, 6);
    expect(estimatePositionFunding8h(5_000, "short", -0.02)).toBeCloseTo(-1, 6);
    expect(estimatePositionFunding8h(10_000, "long", null)).toBeNull();
  });

  it("enriches open positions with liquidation buffer, TP/SL protection orders, and portfolio share", async () => {
    const backend = createMockBackend({ speed: 0, positions: true, history: false });
    const snapshot = await backend.boot();

    const positions = enrichPositions(snapshot);
    expect(positions).toHaveLength(3);

    const eth = positions.find((item) => item.position.symbol === "ETHUSDT");
    expect(eth).toBeDefined();
    expect(eth?.base).toBe("ETH");
    expect(eth?.stopLossOrder).not.toBeNull();
    expect(eth?.takeProfitOrder).not.toBeNull();
    expect(eth?.plannedRr).toBeGreaterThan(1);
    expect(eth?.liqDistancePct).toBeGreaterThan(10);
    expect(eth?.trimHalfQty).toBe("0.6");

    const doge = positions.find((item) => item.position.symbol === "DOGEUSDT");
    expect(doge?.stopLossOrder).toBeNull();

    const analytics = computePortfolioAnalytics(snapshot);
    expect(analytics.equity).toBeGreaterThan(9_000);
    expect(analytics.longNotional).toBeGreaterThan(0);
    expect(analytics.shortNotional).toBeGreaterThan(0);
    expect(analytics.grossNotional).toBeCloseTo(analytics.longNotional + analytics.shortNotional, 2);
    expect(analytics.protectedCount).toBe(2);
    expect(analytics.unprotectedCount).toBe(1);
    expect(analytics.allocations).toHaveLength(3);
  });

  it("enriches resting orders with role labels and distance from mark price", async () => {
    const backend = createMockBackend({ speed: 0, positions: true, history: false });
    const snapshot = await backend.boot();

    const orders = enrichOrders(snapshot);
    expect(orders).toHaveLength(4);
    expect(orders.map((item) => item.roleLabel)).toEqual(
      expect.arrayContaining(["Stop-Loss Guard", "Take-Profit Target", "Limit Entry"]),
    );
    for (const item of orders) {
      expect(item.distanceFromMarkPct).not.toBeNull();
    }
  });

  it("aggregates exchange executions and assistant-drafted order tickets into execution history", async () => {
    const backend = createMockBackend({ speed: 0, seed: "filled", positions: true, history: false });
    const snapshot = await backend.boot();

    const records = buildExecutionHistory(snapshot);
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.some((rec) => rec.category === "order" && rec.statusLabel === "Filled")).toBe(true);
    expect(records.some((rec) => rec.category === "ticket")).toBe(true);
  });
});
