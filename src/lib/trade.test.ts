import { describe, expect, it } from "vitest";
import type { PositionView } from "../api/types";
import { estimateOrder, leverageTicks, offsetPrice, sizeFromPercent, validateOrderFields } from "./trade";

const LONG_ETH: PositionView = {
  symbol: "ETHUSDT",
  side: "long",
  qty: "1.2",
  entryPrice: "3100",
  markPrice: "3200",
  notional: "3840",
  margin: "768",
  unrealizedPnl: "120",
  roePct: 15.6,
  liquidationPrice: "2500",
  leverage: 5,
  isolated: true,
};

describe("trade helpers", () => {
  it("estimates notional, margin, liquidation, and risk/reward for long and short orders", () => {
    const longEst = estimateOrder({
      side: "buy",
      markPrice: 60_000,
      amount: "1200",
      mode: "value",
      leverage: 5,
      stopLoss: "58800",
      takeProfit: "63600",
      reduceOnly: false,
    });
    expect(longEst.qty).toBeCloseTo(0.02, 6);
    expect(longEst.notional).toBeCloseTo(1200, 6);
    expect(longEst.margin).toBeCloseTo(240, 6);
    expect(longEst.estLiqPrice).toBeCloseTo(49_200, 2);
    expect(longEst.slPct).toBeCloseTo(-2, 4);
    expect(longEst.slPnl).toBeCloseTo(-24, 4);
    expect(longEst.tpPct).toBeCloseTo(6, 4);
    expect(longEst.tpPnl).toBeCloseTo(72, 4);
    expect(longEst.rrRatio).toBeCloseTo(3, 4);

    const shortEst = estimateOrder({
      side: "sell",
      markPrice: 3000,
      amount: "0.5",
      mode: "units",
      leverage: 3,
      stopLoss: "3090",
      takeProfit: "2820",
      reduceOnly: false,
    });
    expect(shortEst.notional).toBeCloseTo(1500, 6);
    expect(shortEst.margin).toBeCloseTo(500, 6);
    expect(shortEst.slPnl).toBeCloseTo(-45, 4);
    expect(shortEst.tpPnl).toBeCloseTo(90, 4);
    expect(shortEst.rrRatio).toBeCloseTo(2, 4);
  });

  it("computes side-aware TP/SL offset prices", () => {
    expect(offsetPrice(60_000, "buy", "sl", 2)).toBe("58800");
    expect(offsetPrice(60_000, "buy", "tp", 4)).toBe("62400");
    expect(offsetPrice(60_000, "sell", "sl", 2)).toBe("61200");
    expect(offsetPrice(60_000, "sell", "tp", 4)).toBe("57600");
  });

  it("sizes orders from available margin or open position quantity", () => {
    expect(
      sizeFromPercent({
        pct: 50,
        mode: "value",
        markPrice: 60_000,
        available: 1000,
        leverage: 5,
        reduceOnly: false,
        position: null,
      }),
    ).toBe("2500");

    // 100% leaves a 5% buffer for fees/slippage.
    expect(
      sizeFromPercent({
        pct: 100,
        mode: "value",
        markPrice: 60_000,
        available: 1000,
        leverage: 2,
        reduceOnly: false,
        position: null,
      }),
    ).toBe("1900");

    // Reduce-only uses exact open position quantity.
    expect(
      sizeFromPercent({
        pct: 50,
        mode: "units",
        markPrice: 3200,
        available: 1000,
        leverage: 5,
        reduceOnly: true,
        position: LONG_ETH,
      }),
    ).toBe("0.6");
  });

  it("validates amount, leverage, SL/TP direction, and reduce-only side", () => {
    expect(
      validateOrderFields({
        side: "buy",
        markPrice: 60_000,
        amount: "500",
        mode: "value",
        leverage: 5,
        maxLeverage: 10,
        stopLoss: "61000",
        takeProfit: "59000",
        reduceOnly: false,
        position: null,
      }),
    ).toEqual({
      stopLoss: "Stop-loss must be below mark price for a Long.",
      takeProfit: "Take-profit must be above mark price for a Long.",
    });

    expect(
      validateOrderFields({
        side: "buy",
        markPrice: 3200,
        amount: "0.5",
        mode: "units",
        leverage: 5,
        maxLeverage: 10,
        stopLoss: "",
        takeProfit: "",
        reduceOnly: true,
        position: LONG_ETH,
      }),
    ).toEqual({
      reduceOnly: "Select Sell to reduce your open Long position.",
    });
  });

  it("builds concise leverage tick presets within the configured cap", () => {
    expect(leverageTicks(3)).toEqual([1, 2, 3]);
    expect(leverageTicks(10)).toEqual([1, 2, 3, 5, 10]);
    expect(leverageTicks(15)).toEqual([1, 2, 3, 5, 10, 15]);
    expect(leverageTicks(50)).toEqual([1, 3, 5, 10, 20, 50]);
  });
});
