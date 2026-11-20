import { beforeEach, describe, expect, it } from "vitest";
import {
  computeJournalMetrics,
  deleteJournalEntry,
  formatJournalMarkdown,
  getJournalState,
  openJournalComposer,
  resetJournalToSeeds,
  saveJournalEntry,
} from "./journal";

describe("trading journal store & edge analytics", () => {
  beforeEach(() => {
    resetJournalToSeeds();
  });

  it("loads starter perpetual futures journal entries and computes win rate, profit factor, and setup edge", () => {
    const { entries } = getJournalState();
    expect(entries).toHaveLength(5);

    const metrics = computeJournalMetrics(entries, "testnet");
    expect(metrics.totalCount).toBe(5);
    expect(metrics.openCount).toBe(2);
    expect(metrics.closedCount).toBe(3);
    expect(metrics.winCount).toBe(2);
    expect(metrics.lossCount).toBe(1);
    expect(metrics.winRatePct).toBeCloseTo(66.67, 1);
    expect(metrics.netPnlUsd).toBeCloseTo(466.1, 1);
    expect(metrics.profitFactor).toBeGreaterThan(7);
    expect(metrics.bestSetup?.setup).toBe("Liquidity Sweep");
  });

  it("creates, edits, deletes, and exports journal entries to markdown", () => {
    openJournalComposer({
      network: "testnet",
      symbol: "ARBUSDT",
      side: "long",
      leverage: 4,
      outcome: "win",
      setup: "Funding Carry",
      entryPrice: "0.3100",
      exitPrice: "0.3410",
      qty: "2000",
      pnlUsd: "62.00",
      rrPlanned: "2.5",
      thesis: "Negative funding squeeze at 4h support.",
      lesson: "Held for full target.",
    });

    const created = saveJournalEntry(getJournalState().draft);
    expect(created.symbol).toBe("ARBUSDT");
    expect(getJournalState().entries).toHaveLength(6);

    const updated = saveJournalEntry({ ...created, pnlUsd: "80.00" }, created.id);
    expect(updated.id).toBe(created.id);
    expect(updated.pnlUsd).toBe("80.00");

    const md = formatJournalMarkdown(getJournalState().entries, computeJournalMetrics(getJournalState().entries));
    expect(md).toContain("# OctoNeo Perpetual Futures Trading Journal");
    expect(md).toContain("ARBUSDT · LONG 4x (WIN) — Funding Carry");

    deleteJournalEntry(created.id);
    expect(getJournalState().entries).toHaveLength(5);
  });
});
