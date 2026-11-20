import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GridBotView, RunView } from "../../api/types";
import { buildActivity } from "../../lib/history";
import { closeJournalComposer, openJournalComposer, resetJournalToSeeds } from "../../lib/journal";

async function loadActivity() {
  vi.stubGlobal("window", {
    location: { search: "?speed=0&history=0&positions=1" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { ActivityPage } = await import("./ActivityPage");
  const { Timeline } = await import("./Timeline");
  return { state, ActivityPage, Timeline };
}

function run(title: string, patch: Partial<RunView> = {}): RunView {
  return {
    id: title.replace(/\W+/g, "-").toLowerCase(),
    thread: "",
    agent: "Execution",
    title,
    network: "testnet",
    time: new Date().toISOString(),
    status: "complete",
    steps: [{ name: "exchange.order", detail: "BTCUSDT", status: "ok", ms: 80, preview: "FILLED at 62000" }],
    output: "Running: 10 orders placed.",
    reasoning: "",
    ms: 420,
    ticket: null,
    grid: null,
    cards: [],
    usage: null,
    model: "",
    ...patch,
  };
}

const JARGON = [
  "Logged Realized",
  "Win Rate &amp; Sample",
  "Risk Discipline",
  "Rule audit",
  "plan adherence",
  "Top Setup Edge",
  "Execution &amp; Ledger",
  "Setup Edge Matrix",
  "AI Coach",
  "Export MD",
  "Log Trade",
  "Expectancy",
  "theses",
  "All Networks",
  "Vault Funding",
  "On-Book",
];

describe("ActivityPage", () => {
  let loaded: Awaited<ReturnType<typeof loadActivity>>;

  beforeAll(async () => {
    loaded = await loadActivity();
  });

  it("leads with four plain figures and opens on the journal when only the journal has anything", () => {
    resetJournalToSeeds();
    const html = renderToStaticMarkup(<loaded.ActivityPage />);

    expect(html).toContain("Profit and loss");
    expect(html).toContain("Win rate");
    expect(html).toContain("Kept to the plan");
    expect(html).toContain("Best setup");
    expect(html).toContain("Liquidity sweep");
    expect(html).toContain("Both networks");
    expect(html).toContain("Copy as Markdown");
    expect(html).toContain("Log a trade");
    expect(html).toContain("What the app did");
    expect(html).toMatch(/aria-selected="true"[^>]*>.*Journal/);

    // The journal: entries with plain outcomes and checklist, and how each setup did.
    expect(html).toContain("ETH-USDT");
    expect(html).toContain("Still open");
    expect(html).toContain("Plan kept 3/3");
    expect(html).toContain("What I learned");
    expect(html).toContain("How each setup did");
    expect(html).toContain('aria-label="Journal pages"');
  });

  it("uses plain words: none of the old labels, and never the exchange's name", () => {
    resetJournalToSeeds();
    const html = renderToStaticMarkup(<loaded.ActivityPage />);
    for (const word of JARGON) expect(html, word).not.toContain(word);
    expect(html.toLowerCase()).not.toContain("aster");
  });

  it("opens the journal form with open positions and grid bots to fill it in from", () => {
    const snapshot = loaded.state.app.get().snapshot!;
    const bot = { id: "b1", base: "BTC", symbol: "BTCUSDT", status: "stopped" } as GridBotView;
    loaded.state.app.set({ snapshot: { ...snapshot, grids: [bot] } });
    openJournalComposer({ network: "testnet", symbol: "ETHUSDT", side: "long", leverage: 5 });
    const html = renderToStaticMarkup(<loaded.ActivityPage />);
    loaded.state.app.set({ snapshot });
    closeJournalComposer();

    expect(html).toContain("Fill in from");
    expect(html).toContain("ETH long 5x");
    expect(html).toContain("BTC grid bot, stopped");
    expect(html).toContain("Did you keep to your plan?");
    expect(html).toContain("I set a stop-loss and kept to it");
    expect(html).toContain("Why you took it");
    expect(html).toContain("Save to journal");
  });

  it("shows what the app did by day, with grid bot events beside orders", () => {
    const snapshot = loaded.state.app.get().snapshot!;
    const items = buildActivity({
      ...snapshot,
      turns: [],
      grids: [],
      activity: [
        run("Start a BTC grid bot"),
        run("Confirm buy 0.01 BTCUSDT", { output: "Bought 0.01 BTC at 62,000.00." }),
        run("Stop the BTC grid bot", { status: "failed", output: "Could not cancel 1 order." }),
      ],
    });
    const html = renderToStaticMarkup(
      <loaded.Timeline items={items} showNetwork aiReady onLog={() => {}} />,
    );

    expect(html).toContain("Today");
    expect(html).toContain("All 3");
    expect(html).toContain("Orders 1");
    expect(html).toContain("Grid bots 2");
    expect(html).toContain("Start a BTC grid bot");
    expect(html).toContain("Bought 0.01 BTC");
    expect(html).toContain("Started");
    expect(html).toContain("Failed");
    expect(html).toContain("Testnet");
  });

  it("explains an empty timeline", () => {
    const html = renderToStaticMarkup(<loaded.Timeline items={[]} showNetwork={false} aiReady={false} onLog={() => {}} />);
    expect(html).toContain("Nothing yet.");
  });
});
