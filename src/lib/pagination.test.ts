import { describe, expect, it } from "vitest";
import { buildPageTokens, paginateList } from "./pagination";

describe("pagination helpers", () => {
  it("slices items, clamps out-of-range pages, and computes range bounds", () => {
    const items = Array.from({ length: 23 }, (_, idx) => idx + 1);

    const first = paginateList(items, 1, 10);
    expect(first.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first.totalPages).toBe(3);
    expect(first.startIndex).toBe(0);
    expect(first.endIndex).toBe(10);
    expect(first.hasPrev).toBe(false);
    expect(first.hasNext).toBe(true);

    // Clamps page 99 down to last page (3) when filter shrinks total items.
    const clamped = paginateList(items, 99, 10);
    expect(clamped.page).toBe(3);
    expect(clamped.items).toEqual([21, 22, 23]);
    expect(clamped.startIndex).toBe(20);
    expect(clamped.endIndex).toBe(23);
    expect(clamped.hasPrev).toBe(true);
    expect(clamped.hasNext).toBe(false);
  });

  it("builds compact page number tokens with ellipses for large page counts", () => {
    expect(buildPageTokens(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPageTokens(1, 12)).toEqual([1, 2, 3, 4, 5, "ellipsis-end", 12]);
    expect(buildPageTokens(6, 12)).toEqual([1, "ellipsis-start", 5, 6, 7, "ellipsis-end", 12]);
    expect(buildPageTokens(12, 12)).toEqual([1, "ellipsis-start", 8, 9, 10, 11, 12]);
  });
});
