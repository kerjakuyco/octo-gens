import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

async function loadAccount() {
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
  const { AccountPage } = await import("./AccountPage");
  return { state, AccountPage };
}

describe("AccountPage portfolio & perpetual desk", () => {
  let AccountPage: Awaited<ReturnType<typeof loadAccount>>["AccountPage"];

  beforeAll(async () => {
    ({ AccountPage } = await loadAccount());
  });

  it("renders vault & agent identity, 4-card portfolio KPIs, exposure bar, and enriched perp positions", () => {
    const html = renderToStaticMarkup(<AccountPage />);

    // Self-custody vault & trade-only agent identity bar
    expect(html).toContain("Vault");
    expect(html).toContain("Trade-only");
    expect(html).toContain("Place Order");

    // 4-card KPI strip: Net Account Equity, Free Collateral & Margin, Directional Exposure, Est. Funding Carry
    expect(html).toContain("Net Account Equity");
    expect(html).toContain("Free Collateral &amp; Margin");
    expect(html).toContain("Directional Exposure");
    expect(html).toContain("Est. Funding Carry");
    expect(html).toContain("2/3 SL armed");

    // Accessible desk tabs
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Positions");
    expect(html).toContain("Open orders");
    expect(html).toContain("Collateral &amp; Vault");
    expect(html).toContain("Journal &amp; History");

    // Enriched open positions with liquidation buffer, TP/SL protection badges, and 1-click actions
    expect(html).toContain("ETH-USDT");
    expect(html).toContain("SOL-USDT");
    expect(html).toContain("DOGE-USDT");
    expect(html).toContain("R:R 1 :");
    expect(html).toContain("No Stop-Loss");
    expect(html).toContain("Add / TP·SL");
    expect(html).toContain("Trim 50%");
    expect(html).toContain("Journal");
    expect(html).toContain('aria-label="Close ETH long"');
    expect(html).toContain('aria-label="Open positions pagination"');
    expect(html).toContain("10 / page");
  });
});
