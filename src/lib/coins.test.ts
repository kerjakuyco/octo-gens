import { describe, expect, it } from "vitest";
import { coinIcon, coinTicker } from "./coins";

describe("coin icons", () => {
  it("finds a well-known coin by its market's base asset", () => {
    for (const base of ["BTC", "ETH", "SOL", "XRP", "DOGE", "SUI", "btc"]) {
      expect(coinIcon(base), base).toBeTruthy();
    }
    // A market quoted per thousand coins is still that coin, and a renamed ticker is still its coin.
    expect(coinTicker("1000PEPE")).toBe("PEPE");
    expect(coinIcon("1000PEPE")).toBe(coinIcon("PEPE"));
    expect(coinIcon("1000SHIB")).toBeTruthy();
    expect(coinIcon("RENDER")).toBe(coinIcon("RNDR"));
    expect(coinIcon("1INCH")).toBeTruthy();
  });

  it("has no icon where a ticker could mean something else", () => {
    // Stocks, commodities and tickers shared by unrelated tokens keep their letters: a wrong logo misleads.
    for (const base of ["ANT", "META", "EWT", "MET", "LIT", "XAU", "NVDA", "TSLA", "CL", "", "牛来"]) {
      expect(coinIcon(base), base).toBeUndefined();
    }
  });
});
