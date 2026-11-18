import { describe, expect, it } from "vitest";
import {
  baseOf,
  compact,
  contextSize,
  direction,
  duration,
  money,
  percent,
  plural,
  price,
  pricePrecision,
  signedMoney,
  tokenPrice,
  units,
  usd,
  utcStamp,
} from "./format";

describe("amounts", () => {
  it("formats USDT amounts with two decimals", () => {
    expect(money("100000")).toBe("100,000.00");
    expect(money("-12.5")).toBe("−12.50");
    expect(money("")).toBe("—");
    expect(money("abc")).toBe("—");
  });

  it("signs profit and loss", () => {
    expect(signedMoney("1204.1")).toBe("+1,204.10");
    expect(signedMoney("-3")).toBe("−3.00");
    expect(signedMoney("0")).toBe("0.00");
  });

  it("keeps precision for small prices", () => {
    expect(price("84215.5")).toBe("84,215.50");
    expect(price("0.1834")).toBe("0.1834");
    expect(price("0.00001234")).toBe("0.00001234");
    expect(price(null)).toBe("—");
    expect(pricePrecision("84215.5")).toBe(2);
    expect(pricePrecision("0.1834")).toBe(4);
    expect(pricePrecision("0.00001234")).toBe(8);
  });

  it("trims trailing zeros from quantities", () => {
    expect(units("0.50000000")).toBe("0.5");
    expect(units("1250")).toBe("1,250");
    expect(units("0.00000001")).toBe("0.00000001");
  });

  it("formats percent changes and their direction", () => {
    expect(percent(1.236)).toBe("+1.24%");
    expect(percent(-0.8)).toBe("−0.80%");
    expect(percent(null)).toBe("—");
    expect(direction(1.2)).toBe("up");
    expect(direction("-3")).toBe("down");
    expect(direction(null)).toBe("flat");
  });

  it("abbreviates large figures", () => {
    expect(compact("1234567890")).toBe("1.2B");
    expect(contextSize(200000)).toBe("200k");
    expect(contextSize(1048576)).toBe("1M");
    expect(tokenPrice(null)).toBe("varies");
    expect(tokenPrice(0)).toBe("free");
    expect(tokenPrice(2.5)).toBe("$2.5");
    expect(usd(0.0123)).toBe("$0.0123");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(null)).toBe("—");
  });
});

describe("time and text", () => {
  it("formats durations", () => {
    expect(duration(850)).toBe("850 ms");
    expect(duration(4234)).toBe("4.2 s");
    expect(duration(72000)).toBe("1 min 12 s");
  });

  it("writes market timestamps in UTC", () => {
    expect(utcStamp("2025-03-07T21:00:00Z")).toBe("2025-03-07 21:00 UTC");
    expect(utcStamp("nope")).toBe("—");
  });

  it("pluralises and extracts the base asset", () => {
    expect(plural(1, "step")).toBe("1 step");
    expect(plural(5, "step")).toBe("5 steps");
    expect(plural(2, "position")).toBe("2 positions");
    expect(baseOf("TSLAX/USDT")).toBe("TSLAX");
  });
});
