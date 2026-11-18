import { describe, expect, it } from "vitest";
import { createMockBackend, mockOptionsFromUrl } from "./mock";
import type { TurnEvent } from "./types";

function instant(options: Parameters<typeof createMockBackend>[0] = {}) {
  return createMockBackend({ speed: 0, ...options });
}

describe("mock backend", () => {
  it("boots on the sample tape with a full watchlist and a funded paper account", async () => {
    const snapshot = await instant().boot();
    expect(snapshot.feed).toBe("sample");
    expect(snapshot.instruments).toHaveLength(14);
    expect(snapshot.quotes["BTC/USDT"]).toMatchObject({ price: "84215.50", sample: true, source: "Sample tape" });
    expect(snapshot.quotes["BTC/USDT"]?.closes).toHaveLength(90);
    expect(snapshot.account).toMatchObject({ cash: "100000.00", equity: "100000.00" });
    expect(snapshot.draft).toBeNull();
  });

  it("generates the same tape on every start", async () => {
    const first = await instant().candles("ETH/USDT", "4h");
    const second = await instant().candles("ETH/USDT", "4h");
    expect(first.rows).toHaveLength(160);
    expect(first.rows.map((row) => row.slice(1))).toEqual(second.rows.map((row) => row.slice(1)));
    for (const [, open, high, low, close] of first.rows) {
      expect(Number(high)).toBeGreaterThanOrEqual(Math.max(Number(open), Number(close)));
      expect(Number(low)).toBeLessThanOrEqual(Math.min(Number(open), Number(close)));
    }
  });

  it("drafts a ticket from an order prompt and fills it only on confirmation", async () => {
    const backend = instant();
    const events: TurnEvent[] = [];
    const asked = await backend.ask("Buy 0.5 BTC", (event) => events.push(event));

    expect(events[0]?.type).toBe("started");
    expect(events[events.length - 1]).toMatchObject({ type: "finished", run: { status: "complete" } });
    expect(events.some((event) => event.type === "ticket")).toBe(true);
    const ticket = asked.draft;
    expect(ticket).toMatchObject({ pair: "BTC/USDT", side: "buy", qty: "0.5", destination: "paper", value: "42107.75" });
    expect(asked.runs[0]?.ticket?.id).toBe(ticket?.id);
    expect(asked.account.cash).toBe("100000.00");

    const filled = await backend.submitTicket(ticket!.id);
    expect(filled.draft).toBeNull();
    expect(filled.account.cash).toBe("57892.25");
    expect(filled.account.holdings[0]).toMatchObject({ pair: "BTC/USDT", qty: "0.5", cost: "42107.75" });
    expect(filled.account.orders[0]?.id).toBe(ticket!.id);
    expect(filled.receipts[ticket!.id]).toContain("Paper fill");

    await expect(backend.submitTicket(ticket!.id)).rejects.toThrow("expired");
  });

  it("streams a research answer with steps, a round marker and usage", async () => {
    const backend = instant({ provider: "openrouter" });
    const events: TurnEvent[] = [];
    const snapshot = await backend.ask("Compare ETH and SOL", (event) => events.push(event));
    const run = snapshot.runs[0]!;

    expect(run).toMatchObject({ status: "complete", agent: "Assistant", model: "lantern/lantern-2-large" });
    expect(run.steps.map((step) => step.name)).toEqual(["get_quote", "analyze_market", "analyze_market"]);
    expect(run.steps.every((step) => step.status === "ok")).toBe(true);
    expect(run.output).toContain("| Token | Price (USDT) |");
    expect(run.usage?.promptTokens).toBeGreaterThan(0);

    const round = events.findIndex((event) => event.type === "round");
    const streamed = events
      .slice(round + 1)
      .map((event) => (event.type === "text" ? event.delta : ""))
      .join("");
    expect(round).toBeGreaterThan(0);
    expect(streamed).toBe(run.output);
    expect(events.some((event) => event.type === "reasoning")).toBe(true);
  });

  it("resolves a failed run instead of rejecting", async () => {
    const snapshot = await instant().ask("please fail this one", () => {});
    expect(snapshot.runs[0]).toMatchObject({ status: "failed" });
    expect(snapshot.runs[0]?.output).toContain("OpenRouter (402)");
    expect(snapshot.busy).toBe(false);
  });

  it("rejects invalid prompts before starting a run", async () => {
    const backend = instant();
    await expect(backend.ask("   ", () => {})).rejects.toThrow("Type a question");
    expect((await backend.snapshot()).runs).toHaveLength(0);
  });

  it("stops a running turn and records it as stopped", async () => {
    const backend = createMockBackend({ speed: 0.01, hold: true });
    const pending = backend.ask("Analyze BTC", () => {});
    await new Promise((done) => setTimeout(done, 120));
    expect((await backend.snapshot()).busy).toBe(true);
    await expect(backend.setFeed("binance")).rejects.toThrow("Stop the assistant");
    await backend.stopTurn();
    const snapshot = await pending;
    expect(snapshot.runs[0]?.status).toBe("stopped");
    expect(snapshot.busy).toBe(false);
  });

  it("expires the draft when the feed changes, and labels live quotes", async () => {
    const backend = instant();
    await backend.prepareTicket({ pair: "ETH/USDT", side: "buy", quoteAmount: "500", destination: "paper" });
    const live = await backend.setFeed("binance");
    expect(live.draft).toBeNull();
    expect(live.quotes["ETH/USDT"]).toMatchObject({ sample: false, source: "Binance spot" });
    expect(live.quotes["ETH/USDT"]?.high24h).not.toBeNull();
  });

  it("requires API keys before a live ticket or balances", async () => {
    const backend = instant({ feed: "okx" });
    const request = { pair: "BTC/USDT", side: "buy", qty: "0.01", destination: "exchange" } as const;
    await expect(backend.prepareTicket(request)).rejects.toThrow("Add OKX API keys");
    await expect(backend.balances("okx")).rejects.toThrow("API keys");
    await expect(backend.setCredentials({ venue: "okx", key: "k", secret: "s", remember: false })).rejects.toThrow("passphrase");

    const keyed = await backend.setCredentials({ venue: "okx", key: "k", secret: "s", passphrase: "p", remember: true });
    expect(keyed.venues.find((venue) => venue.id === "okx")).toMatchObject({ credentials: true, remembered: true });
    const drafted = await backend.prepareTicket(request);
    expect(drafted.draft).toMatchObject({ destination: "exchange", feed: "okx" });
    const sent = await backend.submitTicket(drafted.draft!.id);
    expect(sent.receipts[drafted.draft!.id]).toContain("OKX acknowledged");
    expect(sent.account.orders).toHaveLength(0);
  });

  it("guards the watchlist and tokenized-stock symbols", async () => {
    const backend = instant();
    await expect(backend.watchAdd("PEPE")).rejects.toThrow("no sample data");
    await expect(backend.selectPair("TSLA")).rejects.toThrow("underlying share");
    await backend.setFeed("bybit");
    const added = await backend.watchAdd("pepe");
    expect(added.focus).toBe("PEPE/USDT");
    expect(added.instruments.at(-1)).toMatchObject({ ticker: "PEPE", custom: true });
    await expect(backend.watchAdd("PEPE")).rejects.toThrow("already");
    await expect(backend.watchRemove("BTC/USDT")).rejects.toThrow("Only symbols you added");
    expect((await backend.watchRemove("PEPE/USDT")).instruments).toHaveLength(14);
  });

  it("saves assistant settings only when they are complete", async () => {
    const backend = instant();
    const request = { provider: "openrouter", model: "kelpworks/kelp-4-flash", effort: "high", liveTickets: true } as const;
    await expect(backend.saveAssistant(request)).rejects.toThrow("OpenRouter key");
    const saved = await backend.saveAssistant({ ...request, key: "sk-or-v1-abcdefgh12345678" });
    expect(saved.assistant).toMatchObject({ provider: "openrouter", hasKey: true, tools: true, reasoning: false, effort: "auto", liveTickets: true });
    expect(JSON.stringify(saved)).not.toContain("sk-or-v1-abcdefgh12345678");
    expect((await backend.listModels()).some((model) => !model.tools)).toBe(true);
  });

  it("pushes background snapshots to subscribers", async () => {
    const backend = createMockBackend({ speed: 0.001 });
    const seen: number[] = [];
    const stop = backend.onSnapshot((snapshot) => seen.push(snapshot.runs.length));
    const watching = await backend.startWatch("BTC/USDT", "250");
    expect(watching.watch).toEqual({ pair: "BTC/USDT", budget: "250", feed: "sample" });
    await new Promise((done) => setTimeout(done, 60));
    expect(seen).toEqual([2]);
    stop();
    await expect(backend.runPattern("BTC/USDT", "-5")).rejects.toThrow("positive maximum");
  });

  it("reads forced states from the URL", () => {
    expect(mockOptionsFromUrl("?seed=conversation&feed=binance&provider=openrouter&theme=light&keys=binance,nope&speed=0")).toEqual({
      seed: "conversation",
      feed: "binance",
      provider: "openrouter",
      theme: "light",
      keys: ["binance"],
      mcp: [],
      speed: 0,
    });
    expect(mockOptionsFromUrl("?seed=bogus")).toMatchObject({ seed: undefined, feed: undefined });
  });

  it("seeds a conversation with a pending ticket, or a filled one", async () => {
    const pending = await instant({ seed: "conversation" }).boot();
    expect(pending.runs).toHaveLength(2);
    expect(pending.draft?.id).toBe(pending.runs[0]?.ticket?.id);

    const filled = await instant({ seed: "filled" }).boot();
    expect(filled.draft).toBeNull();
    expect(filled.receipts[filled.runs[0]!.ticket!.id]).toContain("Paper fill");

    const live = await instant({ seed: "liveticket", feed: "binance" }).boot();
    expect(live.draft).toMatchObject({ destination: "exchange", feed: "binance" });
  });
});
