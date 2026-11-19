import { describe, expect, it } from "vitest";
import type { CandleRow, TechnicalFrame, TradeView } from "../api/types";
import { basisBps, bollinger, candleAnalytics, ema, rangePositionPct, tapePressure, trendConfluence } from "./indicators";

describe("ema", () => {
  it("starts at the simple average of the first window", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(2);
    // weight 0.5: 2 + (4 - 2) / 2, then 3 + (5 - 3) / 2
    expect(out[3]).toBe(3);
    expect(out[4]).toBe(4);
  });

  it("stays on a flat series and has one entry per input", () => {
    const out = ema(new Array<number>(30).fill(7), 20);
    expect(out).toHaveLength(30);
    expect(out[18]).toBeNull();
    expect(out[19]).toBe(7);
    expect(out[29]).toBe(7);
  });

  it("is empty-handed when the series is shorter than the window", () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
    expect(ema([], 20)).toEqual([]);
    expect(ema([1, 2, 3], 0)).toEqual([null, null, null]);
  });
});

describe("bollinger", () => {
  it("computes symmetric upper and lower bands around the rolling mean", () => {
    const out = bollinger([10, 12, 14, 12], 3, 2);
    expect(out.middle[0]).toBeNull();
    expect(out.middle[1]).toBeNull();
    expect(out.middle[2]).toBeCloseTo(12, 6);
    // std dev of [10, 12, 14] is sqrt(8/3)
    const sd = Math.sqrt(8 / 3);
    expect(out.upper[2]).toBeCloseTo(12 + 2 * sd, 6);
    expect(out.lower[2]).toBeCloseTo(12 - 2 * sd, 6);
  });
});

describe("market analytics helpers", () => {
  it("computes basis in bps and clamped range position", () => {
    expect(basisBps("100.1", "100")).toBeCloseTo(10, 5);
    expect(basisBps("99.9", "100")).toBeCloseTo(-10, 5);
    expect(basisBps("100", "0")).toBeNull();

    expect(rangePositionPct(50, 0, 100)).toBe(50);
    expect(rangePositionPct(120, 0, 100)).toBe(100);
    expect(rangePositionPct(-10, 0, 100)).toBe(0);
    expect(rangePositionPct(50, 50, 50)).toBeNull();
  });

  it("computes relative volume, Bollinger metrics, volatility, and 20-bar range from candles", () => {
    const rows: CandleRow[] = Array.from({ length: 35 }, (_, i) => {
      const close = 100 + Math.sin(i / 3) * 4 + i * 0.2;
      const vol = i === 33 ? 200 : 100;
      return [i * 3600_000, String(close - 0.5), String(close + 1), String(close - 1), String(close), String(vol)];
    });
    const out = candleAnalytics(rows, "1h");
    expect(out.rvol).toBeCloseTo(2, 5);
    expect(out.bbMiddle).not.toBeNull();
    expect(out.bbWidthPct).toBeGreaterThan(0);
    expect(out.volatilityPct).toBeGreaterThan(0);
    expect(out.range20Low).not.toBeNull();
    expect(out.range20High).toBeGreaterThan(out.range20Low!);
    expect(out.range20Pct).toBeGreaterThanOrEqual(0);
    expect(out.range20Pct).toBeLessThanOrEqual(100);
  });

  it("summarises taker buy/sell pressure across recent trades", () => {
    const trades: TradeView[] = [
      { time: "2026-11-19T00:00:00Z", price: "100", size: "3", side: "buy" },
      { time: "2026-11-19T00:00:01Z", price: "100", size: "1", side: "sell" },
    ];
    const pressure = tapePressure(trades);
    expect(pressure).toMatchObject({ buyPct: 75, buyNotional: 300, sellNotional: 100, netNotional: 200, count: 2 });
    expect(tapePressure([])).toBeNull();
  });

  it("scores multi-timeframe trend confluence", () => {
    const frame = (timeframe: TechnicalFrame["timeframe"], trend: TechnicalFrame["trend"]): TechnicalFrame => ({
      timeframe,
      trend,
      changePct: 0,
      rsi14: 50,
      macd: 0,
      atrPct: 1,
      ema20: 100,
      ema50: 99,
      ema200: 95,
      support: [],
      resistance: [],
    });
    expect(
      trendConfluence([frame("15m", "uptrend"), frame("1h", "uptrend"), frame("4h", "uptrend"), frame("1d", "mixed")]),
    ).toMatchObject({ tone: "up", label: "3/4 Uptrend" });
    expect(
      trendConfluence([frame("15m", "downtrend"), frame("1h", "downtrend"), frame("4h", "mixed"), frame("1d", "uptrend")]),
    ).toMatchObject({ tone: "down", label: "2/4 Downtrend" });
    expect(
      trendConfluence([frame("15m", "uptrend"), frame("1h", "downtrend"), frame("4h", "mixed"), frame("1d", "mixed")]),
    ).toMatchObject({ tone: undefined, label: "Mixed" });
  });
});
