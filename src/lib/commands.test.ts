import { describe, expect, it } from "vitest";
import { createMockBackend } from "../api/mock";
import type { CardView, RunView, Snapshot } from "../api/types";
import {
  COMMANDS,
  blocker,
  caution,
  chipText,
  commandById,
  commandContext,
  commandTone,
  defaultValues,
  findCommand,
  followUps,
  leverageOptions,
  marketName,
  mentionAt,
  replaceMention,
  searchCommands,
  shareOf,
  slashQuery,
  starters,
  valuesFor,
  writeMessage,
} from "./commands";

type Options = Parameters<typeof createMockBackend>[0];

function boot(options: Options = {}): Promise<Snapshot> {
  return createMockBackend({ speed: 0, history: false, ...options }).boot();
}

function command(id: string) {
  const found = commandById(id);
  if (!found) throw new Error(`No command ${id}`);
  return found;
}

function run(cards: CardView[], patch: Partial<RunView> = {}): RunView {
  return {
    id: "run",
    thread: "thread",
    agent: "Assistant",
    title: "ETH outlook",
    network: "testnet",
    time: new Date().toISOString(),
    status: "complete",
    steps: [],
    output: "Fine.",
    reasoning: "",
    ms: 1200,
    ticket: null,
    grid: null,
    cards,
    usage: null,
    model: "model",
    ...patch,
  };
}

const ETH_TECHNICALS: CardView = {
  kind: "technicals",
  symbol: "ETHUSDT",
  frame: {
    timeframe: "4h",
    trend: "uptrend",
    changePct: 1.2,
    rsi14: 58,
    macd: 1.4,
    atrPct: 1.1,
    ema20: 3100,
    ema50: 3050,
    ema200: 2900,
    support: [3050],
    resistance: [3200],
  },
};

describe("the command catalog", () => {
  it("names every command and alias once, in lower case without spaces in the id", () => {
    const ids = COMMANDS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
    const words = COMMANDS.flatMap((item) => [item.id, ...item.aliases]);
    expect(new Set(words).size).toBe(words.length);
  });

  it("covers trading, research, analysis and the account", () => {
    const groups = new Set(COMMANDS.map((item) => item.group));
    expect([...groups]).toEqual(["trade", "research", "analysis", "account"]);
  });

  it("finds a command by its id or a one-word alias", () => {
    expect(findCommand("long")?.id).toBe("long");
    expect(findCommand("SELL")?.id).toBe("short");
    expect(findCommand("ta")?.id).toBe("technicals");
    expect(findCommand("lo")).toBeUndefined();
    expect(findCommand("")).toBeUndefined();
  });

  it("ranks what was typed after the slash: id first, then aliases, then words of the title", () => {
    expect(searchCommands("").map((item) => item.id)).toEqual(COMMANDS.map((item) => item.id));
    expect(searchCommands("lo")[0]?.id).toBe("long");
    expect(searchCommands("sell")[0]?.id).toBe("short");
    expect(searchCommands("ta")[0]?.id).toBe("technicals");
    expect(searchCommands("support").map((item) => item.id)).toContain("levels");
    expect(searchCommands("zzz")).toEqual([]);
  });

  it("matches words from their start, so two letters find what they name and little else", () => {
    expect(searchCommands("re").map((item) => item.id)).toEqual(["reduce", "levels", "journal", "portfolio", "why"]);
    expect(searchCommands("te").map((item) => item.id)).toEqual(["technicals"]);
    expect(searchCommands("ook").map((item) => item.id)).toEqual(["outlook", "book"]);
  });
});

describe("typing in the box", () => {
  it("reads a command name only while it is the whole text after a leading slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/lo")).toBe("lo");
    expect(slashQuery("/long ")).toBeNull();
    expect(slashQuery("long")).toBeNull();
    expect(slashQuery("a/b")).toBeNull();
  });

  it("finds a $ mention just before the caret, at the start or after a space", () => {
    expect(mentionAt("compare $et", 11)).toEqual({ start: 8, end: 11, query: "et" });
    expect(mentionAt("$", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAt("a$b", 3)).toBeNull();
    expect(mentionAt("$eth now", 8)).toBeNull();
  });

  it("puts the market's name in place of the mention, followed by one space", () => {
    expect(replaceMention("compare $et", { start: 8, end: 11, query: "et" }, "ETH")).toEqual({
      text: "compare ETH ",
      caret: 12,
    });
    expect(replaceMention("compare $et and SOL", { start: 8, end: 11, query: "et" }, "ETH")).toEqual({
      text: "compare ETH and SOL",
      caret: 12,
    });
  });
});

describe("shareOf", () => {
  it("takes an exact share of a quantity, cut to its own decimals", () => {
    expect(shareOf("0.198", 50)).toBe("0.099");
    expect(shareOf("12.50", 25)).toBe("3.12");
    expect(shareOf("1.000", 100)).toBe("1");
    expect(shareOf("10", 33)).toBe("3");
    expect(shareOf("3", 50)).toBe("1");
  });

  it("gives nothing for a share that rounds to zero or input it cannot read", () => {
    expect(shareOf("0.001", 50)).toBeNull();
    expect(shareOf("abc", 50)).toBeNull();
    expect(shareOf("-1", 50)).toBeNull();
    expect(shareOf("1", 0)).toBeNull();
    expect(shareOf("1", 101)).toBeNull();
    expect(shareOf("1", 12.5)).toBeNull();
  });
});

describe("writing the message", () => {
  it("names a USDT market by its coin and any other by its symbol", () => {
    expect(marketName("BTCUSDT")).toBe("BTC");
    expect(marketName("BTCUSDC")).toBe("BTCUSDC");
    expect(marketName("USDT")).toBe("USDT");
  });

  it("writes a trade the way a trader would type it, never asking the model for arithmetic", async () => {
    const snapshot = await boot();
    const context = commandContext(snapshot);
    const values = defaultValues(snapshot);
    expect(writeMessage(command("long"), values, context)).toBe("Long BTC, 1% risk, technical stop-loss.");
    expect(writeMessage(command("short"), { ...values, market: "ETHUSDT", risk: 0.5, leverage: 5, target: "level" }, context)).toBe(
      "Short ETH at 5x, 0.5% risk, technical stop-loss, take-profit at the next support.",
    );
    expect(writeMessage(command("long"), { ...values, target: "level" }, context)).toContain("next resistance");
    expect(writeMessage(command("plan"), { ...values, side: "short" }, context)).toBe(
      "Plan a short on BTC, 1% risk, technical stop-loss. Size it, but don't draft a ticket yet.",
    );
    expect(writeMessage(command("compare"), values, context)).toBe("Compare BTC and ETH: trend, momentum and funding.");
    expect(writeMessage(command("technicals"), { ...values, timeframe: "1h" }, context)).toBe("BTC technicals on the 1h.");
    expect(writeMessage(command("outlook"), values, context)).toBe("BTC outlook");
  });

  it("puts what the trader typed beside a command on a line of its own", async () => {
    const snapshot = await boot();
    const message = writeMessage(command("long"), defaultValues(snapshot), commandContext(snapshot), "  stop under 61,800 ");
    expect(message).toBe("Long BTC, 1% risk, technical stop-loss.\nstop under 61,800");
  });

  it("works out the share of a position to close from the position itself", async () => {
    const snapshot = await boot({ positions: true });
    const context = commandContext(snapshot);
    const position = context.positions[0];
    if (!position) throw new Error("The mock has no position.");
    const values = valuesFor(command("reduce"), defaultValues(snapshot), context, { market: position.symbol, share: 50 });
    const half = shareOf(position.qty, 50);
    const message = writeMessage(command("reduce"), values, context);
    expect(message).toContain(`by 50%`);
    if (half) expect(message).toContain(`${half} of ${position.qty}`);
  });

  it("sends the journal review only as the journal wrote it", async () => {
    const snapshot = await boot();
    const context = commandContext(snapshot, "Review my perpetual trading journal performance");
    expect(writeMessage(command("journal"), defaultValues(snapshot), context)).toBe(
      "Review my perpetual trading journal performance",
    );
  });
});

describe("what a command needs", () => {
  it("asks for a wallet before anything that reads the account", async () => {
    const snapshot = await boot({ wallet: "none" });
    const context = commandContext(snapshot);
    expect(blocker(command("long"), context)?.fix?.target).toBe("wallet");
    expect(blocker(command("portfolio"), context)?.fix?.target).toBe("wallet");
    expect(blocker(command("outlook"), context)).toBeNull();
  });

  it("needs a deposit when the wallet has made none", async () => {
    const context = commandContext(await boot({ wallet: "deposit" }));
    expect(blocker(command("long"), context)?.fix?.label).toBe("Deposit");
  });

  it("needs web search for the news", async () => {
    const context = commandContext(await boot({ web: false }));
    expect(blocker(command("why"), context)?.fix?.target).toBe("tools");
    expect(blocker(command("news"), context)).not.toBeNull();
    expect(blocker(command("movers"), context)).toBeNull();
  });

  it("needs an open position to close or reduce, in the market chosen", async () => {
    const flat = commandContext(await boot({ positions: false }));
    expect(blocker(command("close"), flat)?.text).toBe("You have no open positions.");

    const snapshot = await boot({ positions: true });
    const context = commandContext(snapshot);
    const held = context.positions[0];
    if (!held) throw new Error("The mock has no position.");
    const values = valuesFor(command("close"), defaultValues(snapshot), context, { market: "NOTHELDUSDT" });
    expect(values.market).toBe(held.symbol);
    expect(blocker(command("close"), context, values)).toBeNull();
    expect(blocker(command("close"), context, { ...values, market: "NOTHELDUSDT" })?.text).toBe(
      "You have no open NOTHELD position.",
    );
  });

  it("needs something in the journal to review it", async () => {
    const snapshot = await boot();
    expect(blocker(command("journal"), commandContext(snapshot))?.fix?.target).toBe("activity");
    expect(blocker(command("journal"), commandContext(snapshot, "Review my journal"))).toBeNull();
  });

  it("says when mainnet tickets are off, without blocking the message", async () => {
    const context = commandContext(await boot({ network: "mainnet" }));
    expect(context.liveTickets).toBe(false);
    expect(caution(command("long"), context)?.fix?.target).toBe("trading");
    expect(caution(command("plan"), context)).toBeNull();
    expect(caution(command("outlook"), context)).toBeNull();
    expect(caution(command("long"), commandContext(await boot()))).toBeNull();
  });
});

describe("settings", () => {
  it("offers leverage only up to the trader's limit, with the default first", () => {
    expect(leverageOptions(3).map((option) => option.label)).toEqual(["Auto", "2x", "3x"]);
    expect(leverageOptions(50).map((option) => option.value)).toContain(50);
  });

  it("drops leverage above the limit back to the default", async () => {
    const snapshot = await boot();
    const context = commandContext(snapshot);
    expect(valuesFor(command("long"), defaultValues(snapshot), context, { leverage: 40 }).leverage).toBe(0);
  });

  it("labels each chip and colours the box by side", async () => {
    const snapshot = await boot();
    const values = defaultValues(snapshot, "1h");
    expect(chipText("risk", values)).toBe("1% risk");
    expect(chipText("leverage", values)).toBe("Auto leverage");
    expect(chipText("leverage", { ...values, leverage: 5 })).toBe("5x");
    expect(chipText("timeframe", values)).toBe("1h");
    expect(chipText("other", values)).toBe("vs ETH");
    expect(commandTone(command("long"), values)).toBe("up");
    expect(commandTone(command("short"), values)).toBe("down");
    expect(commandTone(command("plan"), { ...values, side: "short" })).toBe("down");
    expect(commandTone(command("outlook"), values)).toBeNull();
  });
});

describe("suggestions", () => {
  it("starts an empty chat on the market in focus, the news, the movers and a trade to look over", async () => {
    const list = starters(await boot({ positions: false }));
    expect(list.map((item) => item.label)).toEqual(["BTC outlook", "Market news", "Top movers", "Long ETH, 1% risk"]);
    const trade = list[3];
    expect(trade?.kind).toBe("command");
    if (trade?.kind === "command") expect(trade.values).toEqual({ market: "ETHUSDT" });
  });

  it("leaves the news out while web search is off, and offers a review when positions are open", async () => {
    const list = starters(await boot({ web: false, positions: true }));
    expect(list.map((item) => item.label)).toEqual(["BTC outlook", "Top movers", "Review my positions"]);
  });

  it("follows an answer about a market with trades on it and what it has not read yet", async () => {
    const snapshot = await boot({ positions: false });
    const list = followUps(run([ETH_TECHNICALS]), snapshot);
    expect(list.map((item) => item.label)).toEqual(["Long ETH", "Short ETH", "Why is ETH moving?"]);
    expect(list[0]?.kind).toBe("command");
    expect(list[2]?.kind).toBe("ask");
  });

  it("offers to close a market that is held instead of opening it again", async () => {
    const snapshot = await boot({ positions: true });
    const held = snapshot.account?.positions[0];
    if (!held) throw new Error("The mock has no position.");
    const card: CardView = { ...ETH_TECHNICALS, symbol: held.symbol } as CardView;
    expect(followUps(run([card]), snapshot)[0]?.label).toBe(`Close ${marketName(held.symbol)}`);
  });

  it("offers nothing after a ticket, a failure or while running", async () => {
    const snapshot = await boot();
    const ticket = { id: "t" } as RunView["ticket"];
    expect(followUps(run([ETH_TECHNICALS], { ticket }), snapshot)).toEqual([]);
    expect(followUps(run([ETH_TECHNICALS], { status: "failed" }), snapshot)).toEqual([]);
    expect(followUps(run([ETH_TECHNICALS], { status: "running" }), snapshot)).toEqual([]);
  });

  it("follows the movers with the top mover", async () => {
    const snapshot = await boot();
    const movers: CardView = {
      kind: "movers",
      rows: [
        {
          symbol: "SOLUSDT",
          base: "SOL",
          quote: "USDT",
          price: "150",
          markPrice: null,
          changePct: 9.5,
          quoteVolume24h: null,
          fundingRatePct: null,
          nextFunding: null,
        },
      ],
    };
    expect(followUps(run([movers]), snapshot).map((item) => item.label)).toEqual([
      "SOL outlook",
      "Why is SOL moving?",
    ]);
  });
});

describe("grid bots", () => {
  it("writes a grid bot the way a trader would ask for one", async () => {
    const snapshot = await boot();
    const context = commandContext(snapshot);
    const values = defaultValues(snapshot);
    expect(writeMessage(command("grid"), values, context)).toBe(
      "Grid BTC, neutral, 10 grids between support and resistance on the 4h, 250 USDT margin. Draft it for me to start.",
    );
    expect(
      writeMessage(command("grid"), { ...values, market: "ETHUSDT", mode: "long", grids: 30, margin: 1000, timeframe: "1d", leverage: 3 }, context),
    ).toBe("Grid ETH, long, 30 grids between support and resistance on the 1d, 1000 USDT margin at 3x. Draft it for me to start.");
    expect(writeMessage(command("bots"), values, context)).toBe("How are my grid bots doing?");
  });

  it("needs an account, and says on mainnet that a grid bot is only planned while mainnet tickets are off", async () => {
    expect(blocker(command("grid"), commandContext(await boot({ wallet: "none" })))?.fix?.target).toBe("wallet");
    expect(blocker(command("bots"), commandContext(await boot({ wallet: "none" })))?.fix?.target).toBe("wallet");
    const mainnet = commandContext(await boot({ network: "mainnet", wallet: "connected" }));
    expect(caution(command("grid"), mainnet)?.text).toContain("plan the grid bot without drafting it");
  });

  it("labels the grid settings and colours the box by the way the bot leans", async () => {
    const snapshot = await boot();
    const values = defaultValues(snapshot);
    expect(chipText("mode", values)).toBe("Neutral");
    expect(chipText("grids", values)).toBe("10 grids");
    expect(chipText("margin", { ...values, margin: 1000 })).toBe("1,000 USDT");
    expect(commandTone(command("grid"), values)).toBeNull();
    expect(commandTone(command("grid"), { ...values, mode: "long" })).toBe("up");
    expect(commandTone(command("grid"), { ...values, mode: "short" })).toBe("down");
  });

  it("offers a grid bot after a reading that says the market moves sideways", async () => {
    const snapshot = await boot({ positions: false });
    const sideways: CardView = { ...ETH_TECHNICALS, frame: { ...ETH_TECHNICALS.frame, trend: "mixed" } } as CardView;
    const list = followUps(run([sideways]), snapshot);
    expect(list.map((item) => item.label)).toEqual(["Long ETH", "Short ETH", "Grid ETH", "Why is ETH moving?"]);
    const grid = list[2];
    expect(grid?.kind === "command" && grid.command).toBe("grid");
    // Not after a trending reading, and nothing after an answer that drafted a grid bot.
    expect(followUps(run([ETH_TECHNICALS]), snapshot).map((item) => item.label)).not.toContain("Grid ETH");
    const drafted = { id: "g" } as RunView["grid"];
    expect(followUps(run([sideways], { grid: drafted }), snapshot)).toEqual([]);
  });
});
