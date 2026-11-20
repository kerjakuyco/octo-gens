import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { marketName } from "../../lib/commands";

async function loadComposer() {
  vi.stubGlobal("window", {
    location: { search: "?speed=0" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { Composer } = await import("./Composer");
  return { state, Composer };
}

const DISABLED_SEND = /<button type="submit" class="send"[^>]*disabled/;

describe("Composer", () => {
  let state: Awaited<ReturnType<typeof loadComposer>>["state"];
  let Composer: Awaited<ReturnType<typeof loadComposer>>["Composer"];

  beforeAll(async () => {
    ({ state, Composer } = await loadComposer());
  });

  it("is a combobox with buttons for commands and markets, and sends nothing while empty", () => {
    const html = renderToStaticMarkup(<Composer />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Commands"');
    expect(html).toContain('aria-label="Market"');
    expect(html).toContain('placeholder="Ask anything, or type / for commands"');
    expect(html).toMatch(DISABLED_SEND);
    // No list is open, and no command is in the box.
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("cmd-pill");
  });

  it("takes a command from elsewhere in the app, with its settings as chips at their defaults", () => {
    const focus = state.app.get().snapshot?.focus ?? "";
    const name = marketName(focus);
    state.prefillComposer("long");
    const html = renderToStaticMarkup(<Composer />);

    expect(html).toContain("Open a long");
    expect(html).toContain('aria-label="Remove Open a long"');
    expect(html).toContain(`aria-label="Market: ${name}"`);
    expect(html).toContain('aria-label="Risk: 1%"');
    expect(html).toContain('aria-label="Leverage: Auto"');
    expect(html).toContain('aria-label="Take-profit: No take-profit"');
    // The message it will send, word for word, and the side it trades tints the box.
    expect(html).toContain(`Long ${name}, 1% risk, technical stop-loss.`);
    expect(html).toMatch(/<form class="composer" data-tone="up"/);
    // A trade command shows which network it is for, and goes as it is: the details are optional.
    expect(html).toContain("composer-network");
    expect(html).toContain('placeholder="Add details, like a stop level (optional)"');
    expect(html).not.toMatch(DISABLED_SEND);
  });

  it("applies the settings a request carries", () => {
    state.prefillComposer("compare", { market: "ETHUSDT", other: "SOLUSDT" });
    const html = renderToStaticMarkup(<Composer />);
    expect(html).toContain('aria-label="Market: ETH"');
    expect(html).toContain('aria-label="Compare with: SOL"');
    expect(html).toContain("Compare ETH and SOL: trend, momentum and funding.");
    // Not a trade: no network, no tint.
    expect(html).not.toContain("composer-network");
    expect(html).not.toContain('class="composer" data-tone');
  });

  it("opens the list of commands under their groups, with the first one ready to pick", () => {
    state.prefillComposer(null);
    const html = renderToStaticMarkup(<Composer />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/role="listbox" aria-label="Commands"/);
    for (const id of ["/long", "/short", "/outlook", "/technicals", "/journal"]) expect(html).toContain(id);
    for (const group of ["Trade", "Research", "Analysis", "Account"]) expect(html).toContain(`>${group}</div>`);
    expect(html).toMatch(/aria-activedescendant="[^"]+-0"/);
    expect(html).toMatch(/role="option" aria-selected="true"[^>]*data-index="0"/);
    // A command name being typed is not a message.
    expect(html).toMatch(DISABLED_SEND);
  });
});
