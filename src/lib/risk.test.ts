import { describe, expect, it } from "vitest";
import { LEVERAGE_CAP, LEVERAGE_RULE, parseLeverage } from "./risk";

describe("leverage limit", () => {
  it("reads a whole number from 1 to the cap", () => {
    expect(parseLeverage("1")).toBe(1);
    expect(parseLeverage(" 10 ")).toBe(10);
    expect(parseLeverage("010")).toBe(10);
    expect(parseLeverage(String(LEVERAGE_CAP))).toBe(50);
  });

  it("refuses anything that is not a limit, so that it is never sent", () => {
    // A number field hands over an empty string for text it cannot read.
    for (const typed of ["", "  ", "0", "51", "100", "2.5", "1e1", "-3", "+3", "3x", "three"]) {
      expect(parseLeverage(typed), typed).toBeNull();
    }
    expect(LEVERAGE_RULE).toBe("Enter a whole number from 1 to 50.");
  });
});
