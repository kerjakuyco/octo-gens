import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridBotView } from "../api/types";
import {
  computeJournalMetrics,
  draftFromGridBot,
  journalReviewPrompt,
  setupLabel,
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
    expect(md).toContain("# OctoNeo trading journal");
    expect(md).toContain("ARBUSDT · Long 4x · Won · Funding carry");
    expect(md).toContain("**Why**: Negative funding squeeze at 4h support.");

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

describe("logging a grid bot", () => {
  const bot = (patch: Partial<GridBotView>): GridBotView =>
    ({
      id: "bot1",
      network: "testnet",
      symbol: "BTCUSDT",
      base: "BTC",
      quote: "USDT",
      direction: "neutral",
      spacing: "arithmetic",
      status: "stopped",
      lowerPrice: "60000",
      upperPrice: "64000",
      grids: 10,
      leverage: 3,
      isolated: true,
      margin: "250",
      realizedPnl: "12.40",
      unrealizedPnl: "0",
      totalPnl: "12.40",
      matchedTrades: 4,
      stopLower: null,
      stopUpper: "66000",
      createdAt: "2026-11-20T10:00:00Z",
      stoppedAt: "2026-11-20T12:30:00Z",
      lastNote: "Stopped by you.",
      ...patch,
    }) as GridBotView;

  it("drafts a stopped bot as a closed grid trade with what it made", () => {
    const draft = draftFromGridBot(bot({}));
    expect(draft).toMatchObject({
      network: "testnet",
      symbol: "BTCUSDT",
      side: "long",
      leverage: 3,
      outcome: "win",
      setup: "Grid Bot",
      entryPrice: "60000",
      exitPrice: "64000",
      pnlUsd: "12.40",
    });
    expect(draft.checklist.stopRespected).toBe(true);
    expect(draft.thesis).toBe("Neutral grid on BTC from 60000 to 64000: 10 grids, 250 USDT of margin at 3x.");
    expect(draft.lesson).toContain("4 completed trades");
    expect(draft.lesson).toContain("Stopped by you.");
  });

  it("keeps a running bot open, a short one short, and a loss a loss", () => {
    expect(draftFromGridBot(bot({ status: "running", stoppedAt: null })).outcome).toBe("open");
    expect(draftFromGridBot(bot({ direction: "short" })).side).toBe("short");
    expect(draftFromGridBot(bot({ realizedPnl: "-3.10", totalPnl: "-3.10" })).outcome).toBe("loss");
    expect(draftFromGridBot(bot({ realizedPnl: "0", totalPnl: "0" })).outcome).toBe("breakeven");
  });

  it("names setups in plain words without changing what is stored", () => {
    expect(setupLabel("Support / Resistance")).toBe("Support and resistance");
    expect(setupLabel("Grid Bot")).toBe("Grid bot");
    expect(setupLabel("Something old")).toBe("Something old");
  });

  it("asks for a review with the figures in plain words", () => {
    resetJournalToSeeds();
    const prompt = journalReviewPrompt(computeJournalMetrics(getJournalState().entries, "testnet"));
    expect(prompt).toContain("Review my trading journal (3 closed trades, 2 still open):");
    expect(prompt).toContain("Best setup: Liquidity sweep");
  });
});
