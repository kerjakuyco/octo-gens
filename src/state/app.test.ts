import { beforeAll, describe, expect, it, vi } from "vitest";

/** The store starts the way the browser build does: on the mock backend, read from the page address. */
async function started() {
  vi.stubGlobal("window", {
    location: { search: "?speed=0&history=0" },
    matchMedia: () => ({ matches: true }),
  });
  const state = await import("./app");
  await state.start();
  return state;
}

describe("trading limits", () => {
  let state: Awaited<ReturnType<typeof started>>;

  beforeAll(async () => {
    state = await started();
    expect(state.app.get().phase).toBe("ready");
  });

  it("saves a changed limit and shows it at once, with no notice", async () => {
    expect(state.app.get().snapshot?.risk).toEqual({ maxLeverage: 10, isolated: true });
    expect(await state.saveRisk({ maxLeverage: 20, isolated: true })).toBe("");
    expect(state.app.get().snapshot?.risk).toEqual({ maxLeverage: 20, isolated: true });
    expect(await state.saveRisk({ maxLeverage: 20, isolated: false })).toBe("");
    expect(state.app.get().snapshot?.risk).toEqual({ maxLeverage: 20, isolated: false });
    expect(state.app.get().notice).toBeNull();
    expect(state.app.get().working).toBe("");
  });

  it("hands a refusal to the setting to show, keeps the saved limits, and raises no notice", async () => {
    const reason = await state.saveRisk({ maxLeverage: 51, isolated: false });
    expect(reason).toBe("Maximum leverage is a whole number from 1 to 50.");
    expect(state.app.get().snapshot?.risk).toEqual({ maxLeverage: 20, isolated: false });
    expect(state.app.get().notice).toBeNull();
    expect(state.app.get().working).toBe("");
  });

  it("does not send a change while another one is being applied, and says so", async () => {
    const first = state.saveRisk({ maxLeverage: 5, isolated: false });
    const second = await state.saveRisk({ maxLeverage: 7, isolated: false });
    expect(second).toBe("Another change is still being applied. Try again.");
    expect(await first).toBe("");
    expect(state.app.get().snapshot?.risk).toEqual({ maxLeverage: 5, isolated: false });
  });

  it("still reports other failed commands as a notice", async () => {
    expect(await state.watchAdd("NOPE")).toBe(false);
    expect(state.app.get().notice).toMatchObject({ tone: "error" });
  });
});

describe("wallet pages", () => {
  let state: Awaited<ReturnType<typeof started>>;

  beforeAll(async () => {
    state = await started();
  });

  it("says once how a deposit ended, and shows the new balance", async () => {
    const before = Number(state.app.get().snapshot?.account?.walletBalance);
    state.dismissNotice();
    expect(await state.fundWallet({ network: "testnet", task: "deposit" })).toBe(true);
    expect(state.app.get().snapshot?.pendingWallet).toMatchObject({ network: "testnet", task: "deposit" });
    // The mock stands in for the wallet in the browser and reports back through a pushed snapshot.
    await vi.waitFor(() => expect(state.app.get().snapshot?.pendingWallet).toBeNull());
    const notice = state.app.get().notice;
    expect(notice).toMatchObject({ tone: "info" });
    expect(notice?.text).toContain("Deposit of 250 USDT confirmed");
    expect(Number(state.app.get().snapshot?.account?.walletBalance)).toBe(before + 250);
  });

  it("starts nothing without a wallet, and says why", async () => {
    state.dismissNotice();
    expect(await state.fundWallet({ network: "mainnet", task: "withdraw" })).toBe(false);
    expect(state.app.get().notice).toMatchObject({ tone: "error", text: "Connect a wallet on Mainnet first." });
    expect(state.app.get().snapshot?.pendingWallet).toBeNull();
  });
});
