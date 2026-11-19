import { describe, expect, it } from "vitest";
import {
  ago,
  axisPrice,
  balance,
  compact,
  contextSize,
  countdown,
  dayDate,
  direction,
  duration,
  fundingRate,
  leverage,
  money,
  orderType,
  percent,
  plural,
  price,
  pricePrecision,
  shortAddress,
  signedMoney,
  size,
  tokenPrice,
  units,
  usd,
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

  it("keeps the precision a market's tick size carries", () => {
    expect(price("84215.5")).toBe("84,215.50");
    expect(price("96.42")).toBe("96.42");
    expect(price("11.943")).toBe("11.943");
    expect(price("1.9312")).toBe("1.9312");
    expect(price("0.1834")).toBe("0.1834");
    expect(price("0.12843")).toBe("0.12843");
    expect(price("0.00001234")).toBe("0.00001234");
    expect(price("-3.5")).toBe("−3.50");
    expect(price(null)).toBe("—");
    expect(pricePrecision("84215.5")).toBe(2);
    expect(pricePrecision("96.42")).toBe(2);
    expect(pricePrecision("1.9312")).toBe(4);
    expect(pricePrecision("0.1834")).toBe(4);
    expect(pricePrecision("0.011286")).toBe(5);
    expect(pricePrecision("0.00001234")).toBe(8);
    expect(axisPrice(1.93, 4)).toBe("1.9300");
    expect(axisPrice(62786.4, 2)).toBe("62,786.40");
  });

  it("formats funding rates to four decimals, and leverage as traders write it", () => {
    expect(fundingRate(0.01)).toBe("+0.0100%");
    expect(fundingRate(-0.0042)).toBe("−0.0042%");
    expect(fundingRate(0)).toBe("0.0000%");
    expect(fundingRate(null)).toBe("—");
    expect(leverage(3)).toBe("3x");
    expect(leverage(2.5)).toBe("2.5x");
  });

  it("trims trailing zeros from quantities", () => {
    expect(units("0.50000000")).toBe("0.5");
    expect(units("1250")).toBe("1,250");
    expect(units("0.00000001")).toBe("0.00000001");
  });

  it("keeps cents on balances without losing small holdings", () => {
    expect(balance("10000")).toBe("10,000.00");
    expect(balance("0.04120000")).toBe("0.0412");
    expect(balance("4496.52754216")).toBe("4,496.53");
    expect(balance("1.23456789")).toBe("1.2346");
    expect(balance("")).toBe("—");
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

  it("shortens a size once it runs to six figures, and keeps a small one exact", () => {
    expect(size("0.4521")).toBe("0.4521");
    expect(size("12000")).toBe("12,000");
    expect(size("312500")).toBe("312.5K");
    expect(size("nope")).toBe("—");
  });

  it("counts down to the next funding payment and never below zero", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(countdown("2026-11-19T16:00:00Z", now)).toBe("04:00:00");
    expect(countdown("2026-11-19T12:01:05Z", now)).toBe("00:01:05");
    expect(countdown("2026-11-19T11:00:00Z", now)).toBe("00:00:00");
    expect(countdown(null, now)).toBe("—");
    expect(countdown("nope", now)).toBe("—");
  });

  it("writes calendar days", () => {
    // Local time, so the day can fall on either side of midnight UTC.
    expect(dayDate("2027-02-17T12:00:00Z")).toMatch(/^1[78] Feb 2027$/);
    expect(dayDate("nope")).toBe("—");
  });

  it("says how long ago something was published", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const before = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect([0, 1, 2, 59, 60, 119, 47 * 60 + 59, 48 * 60, 5 * 1440].map((minutes) => ago(before(minutes), now))).toEqual([
      "now",
      "now",
      "2m",
      "59m",
      "1h",
      "1h",
      "47h",
      "2d",
      "5d",
    ]);
    // A time in the future is a clock that disagrees, not a negative age.
    expect(ago(before(-30), now)).toBe("now");
    expect([ago(null, now), ago("", now), ago("yesterday", now)]).toEqual(["", "", ""]);
  });

  it("pluralises", () => {
    expect(plural(1, "step")).toBe("1 step");
    expect(plural(5, "step")).toBe("5 steps");
    expect(plural(2, "position")).toBe("2 positions");
  });

  it("names order types and shortens wallet addresses", () => {
    expect(orderType("STOP_MARKET")).toBe("Stop market");
    expect(orderType("TAKE_PROFIT_MARKET")).toBe("Take-profit market");
    expect(orderType("LIMIT")).toBe("Limit");
    expect(orderType("SOME_NEW_TYPE")).toBe("Some new type");
    expect(shortAddress("0x51c0A6f2B9e84D73a1F5c2E86b0d94A7f3E21b8C")).toBe("0x51c0…1b8C");
    expect(shortAddress("0x1234")).toBe("0x1234");
    expect(shortAddress(null)).toBe("—");
  });
});
