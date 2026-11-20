import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("the desktop app's journal", () => {
  afterEach(() => {
    vi.doUnmock("../api");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Loads the journal module as the desktop app does, over a storage holding `saved`. */
  async function desktopJournal(saved: unknown) {
    const store = new Map<string, string>();
    if (saved !== undefined) store.set("octoneo.journal.v1", JSON.stringify(saved));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    vi.resetModules();
    vi.doMock("../api", () => ({ isDesktop: () => true }));
    return import("./journal");
  }

  it("starts empty: the sample trades are never shown as the trader's own", async () => {
    const journal = await desktopJournal(undefined);
    expect(journal.getJournalState().entries).toEqual([]);
  });

  it("drops the sample trades an earlier version saved, and keeps the trader's", async () => {
    const own = { id: "jnl-mine-1", symbol: "BTCUSDT", outcome: "open", setup: "Breakout" };
    const sample = { id: "jnl-btc-sweep", symbol: "BTCUSDT", outcome: "win", setup: "Liquidity Sweep" };
    const journal = await desktopJournal([sample, own]);
    expect(journal.getJournalState().entries.map((entry) => entry.id)).toEqual(["jnl-mine-1"]);
  });
});
