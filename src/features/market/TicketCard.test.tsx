import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../../api/types";

async function loadCard() {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { search: "?speed=0&seed=unconfirmed" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { TicketCard } = await import("./TicketCard");
  return { state, TicketCard };
}

describe("TicketCard after the order did not go through", () => {
  let loaded: Awaited<ReturnType<typeof loadCard>>;
  let lost: TicketView;

  beforeAll(async () => {
    loaded = await loadCard();
    const snapshot = loaded.state.app.get().snapshot!;
    lost = snapshot.turns.map((turn) => turn.ticket).find((ticket) => ticket && snapshot.failures[ticket.id])!;
  });

  it("calls an order whose answer was lost unconfirmed", () => {
    const html = renderToStaticMarkup(<loaded.TicketCard ticket={lost} />);
    expect(html).toContain("<strong>Order unconfirmed.</strong> The exchange did not answer in time.");
    expect(html).toContain('data-tone="warn" role="alert"');
  });

  it("says a refused order was not placed, with the reason, in the same calm tone", () => {
    const snapshot = loaded.state.app.get().snapshot!;
    const reason =
      "A market buy would be refused right now: the best price to buy at, 61,651.90, is 6.3% above the mark price, 58,008.70, and the exchange takes market orders only within 2% of it. On testnet the order book can drift away from the mark price. Nothing was sent.";
    loaded.state.app.set({ snapshot: { ...snapshot, failures: { ...snapshot.failures, [lost.id]: reason } } });
    const html = renderToStaticMarkup(<loaded.TicketCard ticket={lost} />);
    loaded.state.app.set({ snapshot });

    expect(html).toContain(`<strong>Order not placed.</strong> ${reason}`);
    expect(html).not.toContain("unconfirmed");
    expect(html).toContain('data-tone="warn" role="alert"');
  });
});
