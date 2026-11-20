import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** Boots the app against the mock with `search` and renders the Account page to markup. */
async function render(search: string): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { search: `?speed=0&history=0&${search}` },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { AccountPage } = await import("./AccountPage");
  return renderToStaticMarkup(<AccountPage />);
}

describe("Account page", () => {
  it("says whose account it is and how it stands, in plain words", async () => {
    const html = await render("positions=1&grids=1");

    expect(html).toContain("Wallet");
    expect(html).toContain("Testnet · test funds");
    expect(html).toContain("Trade-only key approved");
    expect(html).toContain("New order");

    expect(html).toContain("Equity");
    expect(html).toContain("Free margin");
    expect(html).toContain("Exposure");
    expect(html).toContain("Funding, next 8 hours");
    expect(html).toContain("2 of 3 positions with a stop-loss");
    expect(html).toContain('role="meter"');

    // None of the old jargon, and never the exchange's name.
    for (const word of ["Net Account Equity", "Vault", "Delta Neutral", "SL armed", "Place Order", "AI Risk Check", "Limit Entry", "Dist. to Mark", "Collateral &amp; Vault"]) {
      expect(html).not.toContain(word);
    }
    expect(html.toLowerCase()).not.toMatch(/\baster/);
  });

  it("shows positions with what protects them, and a grid bot that shares one", async () => {
    const html = await render("positions=1&grids=1");

    expect(html).toContain("Positions");
    for (const market of ["ETH", "SOL", "DOGE"]) expect(html).toContain(`<span class="symbol-name">${market}</span>`);
    expect(html).toContain("No stop-loss");
    expect(html).toContain("Reward to risk");
    expect(html).toContain("Close half");
    expect(html).toContain('aria-label="Close ETH long"');
    expect(html).toContain("Your ETH grid bot trades this market");
    expect(html).toContain("Open the bot");
  });

  it("marks the orders a grid bot placed and lets them be told apart from the trader's own", async () => {
    const html = await render("positions=1&grids=1");

    expect(html).toContain("Open orders");
    expect(html).toMatch(/Yours \d+/);
    expect(html).toMatch(/Grid bots \d+/);
    expect(html).toContain('data-owner="bot"');
    expect(html).not.toMatch(/Yours 0/);
    expect(html).toContain("placed by the grid bot");
    expect(html).toContain("2 grid bots at work");
    expect(html).toContain("Open grid bots");
  });

  it("lists the balances beside the wallet and the app's trade-only key", async () => {
    const html = await render("positions=1");

    expect(html).toContain("Balances");
    expect(html).toContain("Your wallet on Testnet");
    expect(html).toContain("The app&#x27;s trade-only key");
    expect(html).toContain("Manage wallets");
    expect(html).toContain("No grid bot yet.");
    expect(html).toContain("Set one up");
  });

  it("asks for a wallet when there is none, and for a first deposit when the wallet has made none", async () => {
    const none = await render("wallet=none");
    expect(none).toContain("No wallet on Testnet");
    expect(none).toContain("Connect a wallet");

    const deposit = await render("wallet=deposit");
    expect(deposit).toContain("Your account opens with a first deposit");
    expect(deposit).toContain("Deposit");
  });
});
