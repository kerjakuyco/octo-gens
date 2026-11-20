import { describe, expect, it } from "vitest";
import { createMockBackend } from "../api/mock";
import type { GridBotView, RunView, Snapshot } from "../api/types";
import {
  buildActivity,
  countActivity,
  dayLabel,
  filterActivity,
  gridEventOf,
  groupByDay,
} from "./history";

function run(title: string, patch: Partial<RunView> = {}): RunView {
  return {
    id: title.replace(/\W+/g, "-").toLowerCase(),
    thread: "",
    agent: "Execution",
    title,
    network: "testnet",
    time: "2026-11-20T12:00:00Z",
    status: "complete",
    steps: [],
    output: "",
    reasoning: "",
    ms: 120,
    ticket: null,
    grid: null,
    cards: [],
    usage: null,
    model: "",
    ...patch,
  };
}

const BOT = {
  id: "bot-1",
  network: "testnet",
  symbol: "BTCUSDT",
  base: "BTC",
  status: "running",
  createdAt: "2026-11-20T11:00:00Z",
} as GridBotView;

async function snapshotWith(activity: RunView[], grids: GridBotView[] = [BOT]): Promise<Snapshot> {
  const base = await createMockBackend({ speed: 0, history: false, positions: false }).boot();
  return { ...base, activity, turns: [], grids };
}

describe("reading a grid bot's runs", () => {
  it("finds the coin and what the bot did, whatever the title says first", () => {
    expect(gridEventOf("Start a BTC grid bot")).toEqual({ base: "BTC", action: "started" });
    expect(gridEventOf("Start the ETH grid bot at 1,800.00")).toEqual({ base: "ETH", action: "started" });
    expect(gridEventOf("BTC grid bot: placed 2 orders")).toEqual({ base: "BTC", action: "placed" });
    expect(gridEventOf("BTC grid bot: placed 1 order (+0.42 USDT)")).toEqual({ base: "BTC", action: "placed" });
    expect(gridEventOf("SOL grid bot: 3 fills")).toEqual({ base: "SOL", action: "filled" });
    expect(gridEventOf("BTC grid bot: orders ended without filling")).toEqual({ base: "BTC", action: "ended" });
    expect(gridEventOf("BTC grid bot stopped at its stop price")).toEqual({ base: "BTC", action: "stopped" });
    expect(gridEventOf("BTC grid bot stopped: its orders were cancelled")).toEqual({ base: "BTC", action: "stopped" });
    expect(gridEventOf("Stop the BTC grid bot")).toEqual({ base: "BTC", action: "stopped" });
  });

  it("leaves every other run alone", () => {
    expect(gridEventOf("Confirm buy 0.01 BTCUSDT")).toBeNull();
    expect(gridEventOf("Cancel order 123 on BTCUSDT")).toBeNull();
    expect(gridEventOf("Deposit 250 USDT from BNB Smart Chain")).toBeNull();
  });
});

describe("the timeline", () => {
  it("marks a grid bot's runs and gives them the bot and its market", async () => {
    const snapshot = await snapshotWith([run("Start a BTC grid bot"), run("Confirm buy 0.01 BTCUSDT")]);
    const items = buildActivity(snapshot);
    const grid = items.find((item) => item.kind === "grid");
    expect(grid?.grid).toMatchObject({ base: "BTC", symbol: "BTCUSDT", action: "started" });
    expect(grid?.grid?.bot?.id).toBe("bot-1");
    expect(grid?.record.symbol).toBe("BTCUSDT");
    expect(items.find((item) => item.kind === "order")?.record.title).toBe("Confirm buy 0.01 BTCUSDT");
  });

  it("finds a coin's market from the watchlist when its bot is gone", async () => {
    const snapshot = await snapshotWith([run("Stop the ETH grid bot")], []);
    const [item] = buildActivity(snapshot);
    expect(item?.grid).toMatchObject({ symbol: "ETHUSDT", bot: null, action: "stopped" });
  });

  it("filters and counts orders, grid bots and money in and out", async () => {
    const snapshot = await snapshotWith([
      run("Start a BTC grid bot"),
      run("Confirm buy 0.01 BTCUSDT"),
      run("Cancel order 1 on BTCUSDT", { steps: [{ name: "exchange.cancel", detail: "", status: "ok", ms: 1, preview: "" }] }),
      run("Deposit 250 USDT from BNB Smart Chain", { network: "mainnet" }),
    ]);
    const items = buildActivity(snapshot);
    expect(countActivity(items)).toEqual({ all: 4, orders: 2, grid: 1, account: 1 });
    expect(filterActivity(items, "orders").map((item) => item.kind).sort()).toEqual(["cancel", "order"]);
    expect(filterActivity(items, "all", "mainnet").map((item) => item.kind)).toEqual(["wallet"]);
    expect(filterActivity(items, "grid", "mainnet")).toEqual([]);
  });

  it("groups by day, newest first, with plain day names", async () => {
    const now = Date.parse("2026-11-20T15:00:00");
    const snapshot = await snapshotWith([
      run("Start a BTC grid bot", { time: new Date(now - 60_000).toISOString() }),
      run("Confirm buy 0.01 BTCUSDT", { time: new Date(now - 26 * 3_600_000).toISOString() }),
      run("Confirm sell 0.01 BTCUSDT", { time: new Date(now - 5 * 86_400_000).toISOString() }),
    ]);
    const days = groupByDay(buildActivity(snapshot), now);
    expect(days.map((day) => day.label)).toEqual(["Today", "Yesterday", dayLabel(new Date(now - 5 * 86_400_000).toISOString(), now)]);
    expect(days[2]?.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  });
});
