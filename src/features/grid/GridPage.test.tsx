import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadGridPage(search: string) {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { search },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { GridPage } = await import("./GridPage");
  return renderToStaticMarkup(<GridPage />);
}

/** Text the page shows, without its markup. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

describe("GridPage", () => {
  it("shows the bots at work, then the form for a new one beside its price levels", async () => {
    const html = await loadGridPage("?speed=0&grids=1");
    const words = text(html);

    // A summary across the bots, then the bots themselves.
    expect(words).toContain("Margin in use");
    expect(words).toContain("Completed trades");
    expect(words).toContain("Your bots");
    expect(words).toContain("Running 2");
    expect(words).toContain("Stopped 1");
    expect(html).toContain('aria-label="More for the BTC bot"');
    expect(words).toContain("Ask AI");

    // The form, in plain words.
    expect(words).toContain("New grid bot");
    expect(words).toContain("Plan with AI");
    for (const word of ["Neutral", "Long", "Short", "Even price steps", "Even percentage steps", "Margin", "Leverage"]) {
      expect(words).toContain(word);
    }
    expect(words).toContain("More settings");
    expect(words).toContain("Start when the price reaches");
    expect(words).toContain("Stop below");
    expect(words).toContain("Maker orders only");
    expect(words).toContain("Review grid bot");
    expect(html).toContain('role="radiogroup"');

    // The price levels beside it, described for assistive technology.
    expect(words).toContain("Price levels");
    expect(html).toMatch(/role="img" aria-label="\d+ buy orders below the price and \d+ sell orders above it/);
  });

  it("explains what a grid bot does when there is none yet", async () => {
    const html = await loadGridPage("?speed=0");
    const words = text(html);
    expect(words).toContain("A grid bot places buy orders below the price and sell orders above it.");
    expect(words).not.toContain("Your bots");
    expect(words).toContain("New grid bot");
  });

  it("uses the app's words, not trading-desk jargon or the exchange's name", async () => {
    // A bot's last note is written by the core, in its own words; everything else is this page's.
    const html = (await loadGridPage("?speed=0&grids=1")).replace(/<p class="gb-bot-note">.*?<\/p>/g, "");
    const words = text(html).toLowerCase();
    for (const jargon of ["rung", "ladder", "matched cycle", "auto (technical)", "aster", "non-custodial", "gtx"]) {
      expect(words).not.toContain(jargon);
    }
  });
});
