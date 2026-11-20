import { describe, expect, it } from "vitest";
import type { GridBotView, TechnicalsView } from "../api/types";
import {
  computeGridPrices,
  computeProfitPerGridPct,
  estimateGridOrders,
  gridDuration,
  gridRangeProgress,
  planLadderSides,
  suggestGridRanges,
  summarizeGrids,
} from "./grid";

describe("grid helpers", () => {
  it("computes arithmetic and geometric grid levels monotonically", () => {
    const arith = computeGridPrices(60000, 64000, 4, "arithmetic");
    expect(arith).toEqual([60000, 61000, 62000, 63000, 64000]);

    const geom = computeGridPrices(100, 144, 2, "geometric");
    expect(geom).toHaveLength(3);
    expect(geom[0]).toBe(100);
    expect(geom[1]).toBeCloseTo(120, 6);
    expect(geom[2]).toBe(144);

    expect(computeGridPrices(65000, 60000, 4, "arithmetic")).toEqual([]);
    expect(computeGridPrices(60000, 65000, 1, "arithmetic")).toEqual([]);
  });

  it("calculates net profit per grid after round-trip maker fees", () => {
    const geom = computeGridPrices(100, 121, 2, "geometric");
    const profit = computeProfitPerGridPct(geom);
    // Each step is 10% gross -> 9.96% net after 0.04% round-trip maker fees.
    expect(profit.min).toBeCloseTo(9.96, 2);
    expect(profit.max).toBeCloseTo(9.96, 2);
  });

  it("plans neutral, long, and short ladders around mark price", () => {
    const prices = [60000, 61000, 62000, 63000, 64000];
    const neutral = planLadderSides("neutral", prices, 62050);
    expect(neutral.anchorIndex).toBe(2);
    expect(neutral.buyCount).toBe(2);
    expect(neutral.sellCount).toBe(2);
    expect(neutral.initialSide).toBeNull();
    expect(neutral.initialLegs).toBe(0);

    const longPlan = planLadderSides("long", prices, 62050);
    expect(longPlan.initialSide).toBe("buy");
    expect(longPlan.initialLegs).toBe(2);

    const shortPlan = planLadderSides("short", prices, 62050);
    expect(shortPlan.initialSide).toBe("sell");
    expect(shortPlan.initialLegs).toBe(2);
  });

  it("suggests a tight range, one between the 4h levels and a wide one, within the leverage limit", () => {
    const technicals: TechnicalsView = {
      symbol: "BTCUSDT",
      price: "62000",
      asOf: "2026-11-20T00:00:00Z",
      frames: [
        {
          timeframe: "4h",
          trend: "uptrend",
          changePct: 2.1,
          rsi14: 58,
          macd: 120,
          atrPct: 1.8,
          ema20: 61500,
          ema50: 60800,
          ema200: 59000,
          support: [59200, 57500],
          resistance: [65800, 68000],
        },
        {
          timeframe: "1d",
          trend: "uptrend",
          changePct: 5.4,
          rsi14: 61,
          macd: 420,
          atrPct: 3.6,
          ema20: 60400,
          ema50: 58900,
          ema200: 55200,
          support: [58000],
          resistance: [67000],
        },
      ],
    };

    const presets = suggestGridRanges(62000, technicals, 2);
    expect(presets).toHaveLength(3);
    for (const preset of presets) {
      expect(preset.leverage).toBeLessThanOrEqual(2);
      expect(Number(preset.lowerPrice)).toBeLessThan(62000);
      expect(Number(preset.upperPrice)).toBeGreaterThan(62000);
      expect(Number(preset.stopLower)).toBeLessThan(Number(preset.lowerPrice));
      expect(Number(preset.stopUpper)).toBeGreaterThan(Number(preset.upperPrice));
    }
    const levels = presets.find((p) => p.id === "levels")!;
    expect(levels.label).toBe("Around the 4h levels");
    expect(levels.direction).toBe("long");
    expect(Number(levels.lowerPrice)).toBe(59200);
    expect(Number(levels.upperPrice)).toBe(65800);
    expect(presets.map((p) => p.label)).toEqual(["Tight", "Around the 4h levels", "Wide"]);
  });

  it("names the middle range by its basis when there are no levels to anchor to", () => {
    const presets = suggestGridRanges(100, null, 5);
    expect(presets.find((p) => p.id === "levels")?.label).toBe("Balanced");
    expect(suggestGridRanges(0, null, 5)).toEqual([]);
  });

  it("estimates each order from margin, leverage and grids, keeping a little back", () => {
    const estimate = estimateGridOrders(500, 3, 10, 62500);
    expect(estimate?.totalValue).toBeCloseTo(1425, 6);
    expect(estimate?.perOrderValue).toBeCloseTo(142.5, 6);
    expect(estimate?.perOrderQty).toBeCloseTo(0.00228, 6);
    expect(estimateGridOrders(0, 3, 10, 62500)).toBeNull();
    expect(estimateGridOrders(500, 3, 1, 62500)).toBeNull();
    expect(estimateGridOrders(500, 3, 10, 0)).toBeNull();
  });

  it("computes range progress, duration, and portfolio summaries", () => {
    expect(gridRangeProgress(62000, 60000, 64000)).toEqual({ pct: 50, zone: "inside" });
    expect(gridRangeProgress(59000, 60000, 64000)).toEqual({ pct: 0, zone: "below" });
    expect(gridRangeProgress(65000, 60000, 64000)).toEqual({ pct: 100, zone: "above" });

    const start = "2026-11-18T10:00:00Z";
    const end = "2026-11-20T14:30:00Z";
    expect(gridDuration(start, end)).toBe("2d 4h");

    const bots: GridBotView[] = [
      {
        id: "g1",
        network: "testnet",
        symbol: "BTCUSDT",
        base: "BTC",
        quote: "USDT",
        direction: "neutral",
        spacing: "arithmetic",
        status: "running",
        lowerPrice: "60000",
        upperPrice: "64000",
        grids: 8,
        leverage: 3,
        isolated: true,
        margin: "500",
        qtyPerGrid: "0.004",
        entryPrice: "62000",
        markPrice: "62500",
        triggerPrice: null,
        stopUpper: null,
        stopLower: null,
        closeOnStop: true,
        postOnly: true,
        matchedTrades: 6,
        realizedPnl: "18.5",
        unrealizedPnl: "4.5",
        totalPnl: "23",
        roiPct: 4.6,
        profitPerGridMinPct: 0.72,
        profitPerGridMaxPct: 0.78,
        activeBuyOrders: 4,
        activeSellOrders: 4,
        createdAt: start,
        updatedAt: end,
        stoppedAt: null,
        lastNote: "Running",
        levels: [],
      },
    ];
    const summary = summarizeGrids(bots);
    expect(summary.runningCount).toBe(1);
    expect(summary.activeMargin).toBe(500);
    expect(summary.totalRealizedPnl).toBe(18.5);
    expect(summary.totalUnrealizedPnl).toBe(4.5);
    expect(summary.totalPnl).toBe(23);
    expect(summary.totalMatchedTrades).toBe(6);
  });
});
