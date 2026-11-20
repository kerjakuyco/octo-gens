import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

async function loadChat() {
  vi.stubGlobal("window", {
    // An empty conversation with no positions; every scripted turn finishes at once.
    location: { search: "?speed=0&seed=empty" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { ChatPage } = await import("./ChatPage");
  return { state, ChatPage };
}

/** The labels of the chips in the row named `label`, in order. */
function chips(html: string, label: string): string[] {
  const row = new RegExp(`<div class="suggestions"[^>]*aria-label="${label}">(.*?)</div>`).exec(html)?.[1] ?? "";
  return [...row.matchAll(/<span class="suggestion-label">([^<]+)<\/span>/g)].map((match) => match[1] ?? "");
}

describe("ChatPage", () => {
  let state: Awaited<ReturnType<typeof loadChat>>["state"];
  let ChatPage: Awaited<ReturnType<typeof loadChat>>["ChatPage"];

  beforeAll(async () => {
    ({ state, ChatPage } = await loadChat());
  });

  it("starts an empty conversation with starting points and a hint at what the box understands", () => {
    const html = renderToStaticMarkup(<ChatPage />);
    expect(html).toContain("Ask about any market");
    expect(chips(html, "Suggestions")).toEqual(["BTC outlook", "Market news", "Top movers", "Long ETH, 1% risk"]);
    // A trade goes into the box as its command, and the chip says which one; questions are asked at once.
    expect(html).toMatch(/data-kind="command"[^>]*aria-label="Long ETH, 1% risk, fills in \/long"/);
    expect(html).toContain('<span class="suggestion-command">/long</span>');
    expect(html.match(/data-kind="ask"/g)).toHaveLength(3);
    expect(html).toContain("<kbd>/</kbd> for commands");
    expect(html).toContain("<kbd>$</kbd> to name a market");
    // Nothing to scroll back to yet, and no answer to follow up on.
    expect(html).not.toContain("to-latest");
    expect(html).not.toContain('aria-label="Follow-ups"');
  });

  it("offers what to do next under a finished answer that read one market", async () => {
    expect(await state.ask("BTC outlook")).toBe(true);
    const html = renderToStaticMarkup(<ChatPage />);
    // The outlook read the price, the 4h chart and the book: trade it, or read the news it did not. The mock's
    // BTC moves sideways on the 4h, which adds a grid bot to the trades on offer.
    expect(chips(html, "Follow-ups")).toEqual(["Long BTC", "Short BTC", "Grid BTC", "Why is BTC moving?"]);
    expect(html).toMatch(/data-kind="command"[^>]*aria-label="Grid BTC, fills in \/grid"/);
    expect(html).toMatch(/data-kind="command" data-tone="up"[^>]*aria-label="Long BTC, fills in \/long"/);
    expect(html).toMatch(/data-kind="command" data-tone="down"[^>]*aria-label="Short BTC, fills in \/short"/);
    // The starting points and the hint belong to an empty conversation only.
    expect(html).not.toContain('aria-label="Suggestions"');
    expect(html).not.toContain("chat-hint");
    // A turn already filed by the core is not one being sent, so it does not animate in.
    expect(html).toContain('<article class="turn" data-live="false" data-latest="true">');
  });

  it("hides follow-ups while an answer is being written, and marks the message being sent", () => {
    const filed = state.app.get().snapshot?.turns.at(-1);
    expect(filed).toBeDefined();
    if (!filed) return;
    state.app.set({ live: { run: { ...filed, id: "", status: "running", cards: [] }, text: "", reasoning: "" } });
    try {
      const html = renderToStaticMarkup(<ChatPage />);
      expect(html).not.toContain('aria-label="Follow-ups"');
      expect(html).toContain('<article class="turn" data-live="true" data-latest="true">');
      expect(html).toContain('<article class="turn" data-live="false" data-latest="false">');
    } finally {
      state.app.set({ live: null });
    }
  });

  it("offers nothing after an answer that drafted a ticket: the ticket is the next step", async () => {
    expect(await state.ask("Long BTC, 1% risk")).toBe(true);
    expect(state.app.get().snapshot?.turns.at(-1)?.ticket).not.toBeNull();
    const html = renderToStaticMarkup(<ChatPage />);
    expect(html).not.toContain('aria-label="Follow-ups"');
  });
});
