import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

async function loadTrade() {
  vi.resetModules();
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
  const { TradeDialog } = await import("./TradeDialog");
  return { state, TradeDialog };
}

describe("TradeDialog order ticket", () => {
  let state: Awaited<ReturnType<typeof loadTrade>>["state"];
  let TradeDialog: Awaited<ReturnType<typeof loadTrade>>["TradeDialog"];

  beforeAll(async () => {
    ({ state, TradeDialog } = await loadTrade());
  });

  it("renders trading-native order form with mark context, side radios, leverage slider, TP/SL fieldset, and summary", () => {
    state.openTrade(null, { symbol: "ETHUSDT", side: "buy", stopLoss: "1700", takeProfit: "1940" });
    const html = renderToStaticMarkup(<TradeDialog />);

    expect(html).toContain("Place Order");
    expect(html).toContain("ETH-USDT Perp");
    expect(html).toContain("Buy / Long");
    expect(html).toContain("Sell / Short");
    expect(html).toContain("Avail. margin:");
    expect(html).toContain('type="range"');
    expect(html).toContain("TP / SL protection");
    expect(html).toContain("R:R 1 :");
    expect(html).toContain("Reduce-only");
    expect(html).toContain("Est. entry (mark)");
    expect(html).toContain("Est. initial margin");
    expect(html).toContain("Est. liq. price");
    expect(html).toContain("Review Long ETH");
    // ETH has a seeded Long position in the mock when positions=1, so the open position strip appears.
    expect(html).toContain("trade-pos-strip");
  });

  it("renders Confirm Order step with exact confirmation button copy", async () => {
    const ok = await state.prepareTicket({ symbol: "BTCUSDT", side: "buy", notional: "500", leverage: 3 });
    expect(ok).toBe(true);
    const draft = state.app.get().snapshot?.draft ?? null;
    expect(draft).not.toBeNull();
    state.openTrade(draft);

    const html = renderToStaticMarkup(<TradeDialog />);
    expect(html).toContain("Confirm Order");
    expect(html).toContain("Order size");
    expect(html).toContain("Notional");
    expect(html).toContain("Initial margin");
    expect(html).toContain("Place order");
    expect(html).toContain("Discard");
  });
});
