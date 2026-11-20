import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { openJournalComposer, resetJournalToSeeds } from "../../lib/journal";

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
  return { state, ActivityPage };
}

describe("ActivityPage trading journal & execution history", () => {
  let ActivityPage: Awaited<ReturnType<typeof loadActivity>>["ActivityPage"];

  beforeAll(async () => {
    ({ ActivityPage } = await loadActivity());
  });

  it("renders journal performance KPIs, setup edge summary, and structured trade journal cards", () => {
    resetJournalToSeeds();
    const html = renderToStaticMarkup(<ActivityPage />);

    // Top actions and KPI strip
    expect(html).toContain("Logged Realized P&amp;L");
    expect(html).toContain("Win Rate &amp; Sample");
    expect(html).toContain("Risk Discipline");
    expect(html).toContain("Top Setup Edge");
    expect(html).toContain("Liquidity Sweep");
    expect(html).toContain("Export MD");
    expect(html).toContain("Log Trade");

    // Starter journal cards with thesis, lesson, and discipline tags
    expect(html).toContain("ETH-USDT");
    expect(html).toContain("BTC-USDT");
    expect(html).toContain("Thesis &amp; Setup");
    expect(html).toContain("Execution &amp; Review");
    expect(html).toContain("3/3 rules");
    expect(html).toContain('aria-label="Trading journal pagination"');
    expect(html).toContain("10 / page");
  });

  it("renders the inline trade journal composer with active position snapshot buttons when opened", () => {
    openJournalComposer({ network: "testnet", symbol: "ETHUSDT", side: "long", leverage: 5 });
    const html = renderToStaticMarkup(<ActivityPage />);

    expect(html).toContain("Log Perpetual Trade &amp; Thesis");
    expect(html).toContain("Snapshot active position:");
    expect(html).toContain("ETH Long 5x");
    expect(html).toContain("Risk &amp; Execution Discipline");
    expect(html).toContain("Save Journal Entry");
  });
});
