import { describe, expect, it } from "vitest";
import { ema } from "./indicators";

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
