import { describe, expect, it } from "vitest";
import { ema } from "../lib/indicators";
import { createMockBackend, mockOptionsFromUrl } from "./mock";
import type { CardView, McpConnectRequest, RunView, Snapshot, TurnEvent } from "./types";

/** A backend that answers at once and starts without earlier conversations. */
function instant(options: Parameters<typeof createMockBackend>[0] = {}) {
  return createMockBackend({ speed: 0, history: false, ...options });
}

function lastTurn(snapshot: Snapshot): RunView {
  return snapshot.turns[snapshot.turns.length - 1]!;
}

function kinds(run: RunView): CardView["kind"][] {
  return run.cards.map((card) => card.kind);
}

describe("mock backend: markets", () => {
  it("boots on testnet with quotes, a funded wallet, a connected model and an empty conversation", async () => {
    const snapshot = await instant().boot();
    expect(snapshot.version).toBe("0.7.0");
    expect(snapshot.network).toBe("testnet");
    expect(snapshot.focus).toBe("BTCUSDT");
    expect(snapshot.instruments).toHaveLength(10);
    expect(snapshot.instruments[0]).toEqual({ symbol: "BTCUSDT", base: "BTC", quote: "USDT", custom: false });

    const quote = snapshot.quotes.BTCUSDT!;
    expect(quote.source).toBe("Testnet");
    expect(quote.closes).toHaveLength(90);
    expect(Number(quote.markPrice)).toBeGreaterThan(0);
    expect(Number(quote.high24h)).toBeGreaterThanOrEqual(Number(quote.price));
    expect(typeof quote.fundingRatePct).toBe("number");
    const untilFunding = Date.parse(quote.nextFunding!) - Date.now();
    expect(untilFunding).toBeGreaterThan(0);
    expect(untilFunding).toBeLessThanOrEqual(8 * 3_600_000);

    expect(snapshot.wallets.map((wallet) => [wallet.network, wallet.connected])).toEqual([
      ["mainnet", false],
      ["testnet", true],
    ]);
    expect(snapshot.account).toMatchObject({ equity: "10000.00", available: "10000.00", positions: [], orders: [] });
    expect(snapshot.assistant).toMatchObject({ provider: "openrouter", ready: true, label: "Lantern 2 Large" });
    expect(snapshot).toMatchObject({ turns: [], threads: [], activity: [], draft: null, pendingWallet: null, walletNotice: null, busy: false });
  });

  it("lists every market of the network, including symbols that are not ASCII", async () => {
    const backend = instant();
    const testnet = await backend.marketOverview();
    expect(testnet).toHaveLength(20);
    expect(testnet.some((row) => row.base === "BNB")).toBe(false);
    expect(testnet[0]).toMatchObject({ symbol: "BTCUSDT", base: "BTC", quote: "USDT" });
    expect(Number(testnet[0]!.quoteVolume24h)).toBeGreaterThan(0);

    await backend.setNetwork("mainnet");
    const mainnet = await backend.marketOverview();
    expect(mainnet).toHaveLength(40);
    expect(mainnet.find((row) => row.base === "XAU")).toMatchObject({ symbol: "XAUUSD1", quote: "USD1" });
    expect(mainnet.some((row) => row.symbol === "币安人生USDT")).toBe(true);

    const added = await backend.watchAdd("币安人生USDT");
    expect(added.focus).toBe("币安人生USDT");
    expect(added.instruments.at(-1)).toEqual({ symbol: "币安人生USDT", base: "币安人生", quote: "USDT", custom: true });
    expect(added.quotes["币安人生USDT"]?.source).toBe("Mainnet");
  });

  it("pads the mainnet list on request, to try the screener at the size of the real one", async () => {
    const backend = instant({ markets: 595, network: "mainnet" });
    const rows = await backend.marketOverview();
    expect(rows).toHaveLength(595);
    expect(new Set(rows.map((row) => row.symbol)).size).toBe(595);
    expect((await backend.setNetwork("testnet")).network).toBe("testnet");
    expect(await backend.marketOverview()).toHaveLength(20);
  });

  it("generates the same tape on every start", async () => {
    const first = await instant().candles("ETHUSDT", "4h");
    const second = await instant().candles("ETHUSDT", "4h");
    expect(first).toMatchObject({ symbol: "ETHUSDT", timeframe: "4h", source: "Testnet" });
    expect(first.rows).toHaveLength(240);
    expect(first.rows.map((row) => row.slice(1))).toEqual(second.rows.map((row) => row.slice(1)));
    for (const [, open, high, low, close] of first.rows) {
      expect(Number(high)).toBeGreaterThanOrEqual(Math.max(Number(open), Number(close)));
      expect(Number(low)).toBeLessThanOrEqual(Math.min(Number(open), Number(close)));
    }
  });

  it("serves an order book and a trade tape around the price", async () => {
    const backend = instant();
    const book = await backend.orderBook("BTCUSDT");
    expect(book.bids).toHaveLength(20);
    expect(book.asks).toHaveLength(20);
    const bids = book.bids.map((level) => Number(level.price));
    const asks = book.asks.map((level) => Number(level.price));
    expect(bids[0]).toBeLessThan(asks[0]!);
    expect(bids).toEqual([...bids].sort((left, right) => right - left));
    expect(asks).toEqual([...asks].sort((left, right) => left - right));
    expect(Number(book.mid)).toBeGreaterThan(bids[0]!);
    expect(Number(book.mid)).toBeLessThan(asks[0]!);
    let running = 0;
    for (const level of book.bids) {
      running += Number(level.size);
      expect(Number(level.total)).toBeCloseTo(running, 6);
    }
    expect(book.spreadBps).toBeGreaterThan(0);
    expect(book.bidSharePct).toBeGreaterThan(0);
    expect(book.bidSharePct).toBeLessThan(100);

    const trades = await backend.recentTrades("BTCUSDT");
    expect(trades).toHaveLength(30);
    const times = trades.map((trade) => Date.parse(trade.time));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    expect(trades.every((trade) => trade.side === "buy" || trade.side === "sell")).toBe(true);
    await expect(backend.orderBook("NOPE")).rejects.toThrow("no perpetual market");
  });

  it("serves funding with its history and open interest", async () => {
    const funding = await instant().marketFunding("ETHUSDT");
    expect(funding.symbol).toBe("ETHUSDT");
    expect(funding.intervalHours).toBe(8);
    expect(funding.annualPct).toBeCloseTo(funding.ratePct! * 3 * 365, 1);
    expect(Date.parse(funding.nextFunding!)).toBeGreaterThan(Date.now());
    expect(funding.history).toHaveLength(42);
    const times = funding.history.map(([time]) => Date.parse(time));
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(times.at(-1)).toBeLessThan(Date.parse(funding.nextFunding!));
    expect(Number(funding.openInterest)).toBeGreaterThan(0);
    expect(Number(funding.openInterestValue)).toBeGreaterThan(Number(funding.openInterest));
  });

  it("reads technicals that agree with the candles it serves", async () => {
    const backend = instant();
    const technicals = await backend.marketTechnicals("BTCUSDT");
    expect(technicals.frames.map((frame) => frame.timeframe)).toEqual(["15m", "1h", "4h", "1d"]);
    const price = Number(technicals.price);
    for (const frame of technicals.frames) {
      expect(["uptrend", "downtrend", "mixed"]).toContain(frame.trend);
      expect(frame.rsi14).toBeGreaterThan(0);
      expect(frame.rsi14).toBeLessThan(100);
      expect(frame.atrPct).toBeGreaterThan(0);
      expect(frame.ema200).not.toBeNull();
      expect(frame.support.every((level) => level < price)).toBe(true);
      expect(frame.resistance.every((level) => level > price)).toBe(true);
      // Nearest first on both sides.
      expect(frame.support).toEqual([...frame.support].sort((left, right) => right - left));
      expect(frame.resistance).toEqual([...frame.resistance].sort((left, right) => left - right));
    }

    // The chart draws its own moving averages from the candles; they land where the reading says.
    const candles = await backend.candles("BTCUSDT", "4h");
    const closes = candles.rows.map((row) => Number(row[4]));
    const frame = technicals.frames[2]!;
    expect(ema(closes, 20).at(-1)! / frame.ema20!).toBeCloseTo(1, 3);
    expect(ema(closes, 50).at(-1)! / frame.ema50!).toBeCloseTo(1, 3);
  });

  it("guards the watchlist and keeps the market in view when it leaves the list", async () => {
    const backend = instant();
    await expect(backend.watchAdd("BTC")).rejects.toThrow("already");
    await expect(backend.watchAdd("NOPE")).rejects.toThrow("no perpetual market");
    await expect(backend.selectSymbol("BNB")).rejects.toThrow("Switch to Mainnet");

    const added = await backend.watchAdd("arb");
    expect(added.focus).toBe("ARBUSDT");
    expect(added.instruments.at(-1)).toMatchObject({ symbol: "ARBUSDT", custom: true });
    await expect(backend.watchRemove("BTCUSDT")).rejects.toThrow("Only markets you added");
    const removed = await backend.watchRemove("ARBUSDT");
    expect(removed.instruments).toHaveLength(10);
    expect(removed.focus).toBe("ARBUSDT");
    expect(removed.quotes.ARBUSDT).toBeDefined();

    // Any market can be in view, on the watchlist or not.
    const focused = await backend.selectSymbol("TON");
    expect(focused.focus).toBe("TONUSDT");
    expect(focused.quotes.TONUSDT?.symbol).toBe("TONUSDT");
  });

  it("expires the draft and follows the network when it changes", async () => {
    const backend = instant();
    const drafted = await backend.prepareTicket({ symbol: "ETHUSDT", side: "buy", notional: "500" });
    expect(drafted.draft).not.toBeNull();

    const mainnet = await backend.setNetwork("mainnet");
    expect(mainnet.network).toBe("mainnet");
    expect(mainnet.draft).toBeNull();
    expect(mainnet.instruments).toHaveLength(12);
    expect(mainnet.quotes.ETHUSDT).toMatchObject({ source: "Mainnet" });
    expect(mainnet.account).toBeNull();
    await expect(backend.submitTicket(drafted.draft!.id)).rejects.toThrow("expired");

    const back = await backend.setNetwork("testnet");
    expect(back.account).not.toBeNull();
  });
});

describe("mock backend: tickets", () => {
  it("drafts a long and fills it only on confirmation", async () => {
    const backend = instant();
    const drafted = await backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01" });
    const ticket = drafted.draft!;
    expect(ticket).toMatchObject({
      network: "testnet",
      symbol: "BTCUSDT",
      side: "buy",
      qty: "0.01",
      leverage: 3,
      reduceOnly: false,
      stopLoss: null,
      takeProfit: null,
      effect: "Opens a 0.01 BTC long at 3x with isolated margin",
      rationale: "",
    });
    expect(Number(ticket.margin)).toBeCloseTo(Number(ticket.notional) / 3, 1);
    expect(Number(ticket.estLiquidation)).toBeLessThan(Number(ticket.price));
    expect(drafted.account?.positions).toHaveLength(0);
    expect(drafted.activity).toHaveLength(0);

    const filled = await backend.submitTicket(ticket.id);
    expect(filled.draft).toBeNull();
    expect(filled.receipts[ticket.id]).toContain("Sent on testnet: buy 0.01 BTCUSDT, order ");
    expect(filled.account?.positions).toEqual([
      expect.objectContaining({ symbol: "BTCUSDT", side: "long", qty: "0.01", leverage: 3, isolated: true }),
    ]);
    expect(Number(filled.account?.marginUsed)).toBeGreaterThan(0);
    // An order is something the app did on the exchange, not a turn of the conversation.
    expect(filled.turns).toHaveLength(0);
    expect(filled.activity[0]).toMatchObject({
      agent: "Execution",
      thread: "",
      status: "complete",
      title: "Confirm buy 0.01 BTCUSDT",
      output: filled.receipts[ticket.id],
    });
    expect(filled.activity[0]?.steps.map((step) => step.name)).toEqual(["exchange.order"]);

    await expect(backend.submitTicket(ticket.id)).rejects.toThrow("expired");
  });

  it("drafts a short with its own leverage, then closes it with a reduce-only ticket", async () => {
    const backend = instant();
    const opened = await backend.prepareTicket({ symbol: "BTCUSDT", side: "sell", qty: "0.01", leverage: 5 });
    expect(opened.draft).toMatchObject({ side: "sell", leverage: 5, effect: "Opens a 0.01 BTC short at 5x with isolated margin" });
    expect(Number(opened.draft!.estLiquidation)).toBeGreaterThan(Number(opened.draft!.price));
    await backend.submitTicket(opened.draft!.id);

    const closing = await backend.closePosition("BTCUSDT");
    expect(closing.draft).toMatchObject({
      side: "buy",
      qty: "0.01",
      reduceOnly: true,
      margin: "0.00",
      estLiquidation: null,
      effect: "Closes the 0.01 BTC short",
    });
    const closed = await backend.submitTicket(closing.draft!.id);
    expect(closed.account?.positions).toHaveLength(0);
    await expect(backend.closePosition("BTCUSDT")).rejects.toThrow("no open BTC position");
  });

  it("holds every ticket to the risk limits", async () => {
    const backend = instant();
    await expect(backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01", leverage: 25 })).rejects.toThrow(
      "above the limit of 10x",
    );

    const raised = await backend.saveRisk({ maxLeverage: 25, isolated: false });
    expect(raised.risk).toEqual({ maxLeverage: 25, isolated: false });
    const drafted = await backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01", leverage: 25 });
    expect(drafted.draft?.leverage).toBe(25);

    // Lowering the limit drops a draft that no longer fits under it.
    expect((await backend.saveRisk({ maxLeverage: 5, isolated: false })).draft).toBeNull();
    await expect(backend.saveRisk({ maxLeverage: 51, isolated: true })).rejects.toThrow("1 to 50");
    await expect(backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01", leverage: 1.5 })).rejects.toThrow(
      "whole number",
    );
    await expect(backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", notional: "2" })).rejects.toThrow("smallest BTC order");
    await expect(backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "40" })).rejects.toThrow("of margin");

    const cross = await backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01" });
    const sent = await backend.submitTicket(cross.draft!.id);
    expect(sent.account?.positions[0]).toMatchObject({ isolated: false, leverage: 3 });
  });

  it("places the stop-loss and take-profit with the order, and drops them when the position closes", async () => {
    const backend = instant();
    const last = Number((await backend.snapshot()).quotes.ETHUSDT!.price);
    const at = (factor: number) => String(Math.round(last * factor));
    await expect(
      backend.prepareTicket({ symbol: "ETHUSDT", side: "buy", notional: "500", stopLoss: at(1.1) }),
    ).rejects.toThrow("stop-loss of a long must be below");
    await expect(
      backend.prepareTicket({ symbol: "ETHUSDT", side: "sell", notional: "500", takeProfit: at(1.1) }),
    ).rejects.toThrow("take-profit of a short must be below");
    // A stop the position would be liquidated before reaching protects nothing.
    await expect(
      backend.prepareTicket({ symbol: "ETHUSDT", side: "buy", notional: "500", leverage: 10, stopLoss: at(0.85) }),
    ).rejects.toThrow("comes before the stop-loss");

    const drafted = await backend.prepareTicket({
      symbol: "ETHUSDT",
      side: "buy",
      notional: "500",
      leverage: 2,
      stopLoss: at(0.9),
      takeProfit: at(1.2),
    });
    const ticket = drafted.draft!;
    expect(Number(ticket.notional)).toBeLessThanOrEqual(500);
    expect(Number(ticket.stopLoss)).toBeLessThan(last);
    expect(Number(ticket.takeProfit)).toBeGreaterThan(last);

    const sent = await backend.submitTicket(ticket.id);
    const orders = sent.account!.orders;
    expect(orders.map((order) => [order.type, order.side, order.reduceOnly, order.qty])).toEqual([
      ["STOP_MARKET", "sell", true, ticket.qty],
      ["TAKE_PROFIT_MARKET", "sell", true, ticket.qty],
    ]);
    expect(orders[0]?.clientId).toBe(`${ticket.id.slice(0, 30)}-sl`);
    expect(orders[1]?.clientId).toBe(`${ticket.id.slice(0, 30)}-tp`);
    expect(orders[0]?.stopPrice).toBe(ticket.stopLoss);
    expect(sent.receipts[ticket.id]).toMatch(/The stop-loss is set at .+\. The take-profit is set at .+\.$/);
    expect(sent.activity[0]?.steps.map((step) => step.name)).toEqual(["exchange.order", "exchange.stop_loss", "exchange.take_profit"]);

    const one = await backend.cancelOrder("ETHUSDT", orders[0]!.id);
    expect(one.account?.orders).toHaveLength(1);
    expect(one.activity[0]).toMatchObject({
      agent: "Execution",
      title: `Cancel order ${orders[0]!.id} on ETHUSDT`,
      output: `Cancel order ${orders[0]!.id} on ETHUSDT: done.`,
    });
    await expect(backend.cancelOrder("ETHUSDT", orders[0]!.id)).rejects.toThrow("no longer open");

    const closing = await backend.closePosition("ETHUSDT");
    expect(closing.draft).toMatchObject({ side: "sell", reduceOnly: true, qty: ticket.qty });
    const flat = await backend.submitTicket(closing.draft!.id);
    expect(flat.account).toMatchObject({ positions: [], orders: [] });
  });

  it("describes what an order does to an existing position", async () => {
    const backend = instant({ positions: true });
    const start = await backend.boot();
    expect(start.account?.positions.map((position) => [position.symbol, position.side, position.qty])).toEqual([
      ["ETHUSDT", "long", "1.2"],
      ["SOLUSDT", "short", "40"],
      ["DOGEUSDT", "long", "12000"],
    ]);
    expect(start.account?.orders).toHaveLength(4);
    expect(Number(start.account?.unrealizedPnl)).not.toBe(0);
    expect(Number(start.account?.equity)).toBeCloseTo(10_000 + Number(start.account?.unrealizedPnl), 1);

    const effect = async (request: Parameters<typeof backend.prepareTicket>[0]) =>
      (await backend.prepareTicket(request)).draft?.effect;
    expect(await effect({ symbol: "ETHUSDT", side: "sell", qty: "0.5", reduceOnly: true })).toBe(
      "Reduces the long from 1.2 to 0.7 ETH",
    );
    expect(await effect({ symbol: "ETHUSDT", side: "sell", qty: "5", reduceOnly: true })).toBe(
      "Closes the 1.2 ETH long and cancels the 2 reduce-only orders left on it",
    );
    // Adding keeps the leverage the position already has, whatever the ticket asks for.
    expect(await effect({ symbol: "ETHUSDT", side: "buy", qty: "0.3", leverage: 2 })).toBe(
      "Adds 0.3 ETH to the long, making it 1.5 ETH at 5x",
    );
    // One order does not close a position and open the opposite one.
    await expect(backend.prepareTicket({ symbol: "ETHUSDT", side: "sell", qty: "2" })).rejects.toThrow(
      "larger than the 1.2 ETH long it runs against",
    );
    expect((await backend.prepareTicket({ symbol: "ETHUSDT", side: "sell", qty: "0.2" })).draft).toMatchObject({
      reduceOnly: true,
      effect: "Reduces the long from 1.2 to 1 ETH",
    });
    await expect(backend.prepareTicket({ symbol: "ETHUSDT", side: "buy", qty: "0.5", reduceOnly: true })).rejects.toThrow(
      "cannot shrink a long",
    );
    await expect(backend.prepareTicket({ symbol: "BTCUSDT", side: "sell", qty: "0.01", reduceOnly: true })).rejects.toThrow(
      "no BTC position",
    );

    const cleared = await backend.cancelAllOrders("ETHUSDT");
    expect(cleared.account?.orders.map((order) => order.symbol)).toEqual(["SOLUSDT", "BTCUSDT"]);
    expect(cleared.activity[0]?.title).toBe("Cancel all open orders on ETHUSDT");
    await expect(backend.cancelAllOrders("ETHUSDT")).rejects.toThrow("no open");
  });
});

describe("mock backend: wallets", () => {
  it("refuses tickets until a wallet can trade", async () => {
    const none = instant({ wallet: "none" });
    expect((await none.boot()).account).toBeNull();
    await expect(none.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01" })).rejects.toThrow(
      "Connect a wallet on Testnet",
    );
    // The assistant says so instead of drafting.
    const asked = await none.ask("Long BTC, 1% risk", () => {});
    expect(lastTurn(asked)).toMatchObject({ status: "complete", ticket: null });
    expect(lastTurn(asked).output).toContain("Connect a wallet on Testnet");
    expect(asked.draft).toBeNull();

    const deposit = instant({ wallet: "deposit" });
    const waiting = await deposit.boot();
    expect(waiting.wallets[1]).toMatchObject({ connected: true, needsDeposit: true });
    expect(waiting.account).toBeNull();
    expect(waiting.accountError).toBe("");
    await expect(deposit.closePosition("BTCUSDT")).rejects.toThrow("first deposit");

    const failing = await instant({ wallet: "error" }).boot();
    expect(failing.account).toBeNull();
    expect(failing.accountError).not.toBe("");
  });

  it("connects a pasted API wallet key after checking its shape, and never echoes it", async () => {
    const backend = instant({ network: "mainnet" });
    const user = `0x${"ab".repeat(20)}`;
    const agentKey = "cd".repeat(32);
    await expect(backend.connectWalletKey({ network: "mainnet", user: "0x123", agentKey })).rejects.toThrow(
      "main wallet address",
    );
    await expect(backend.connectWalletKey({ network: "mainnet", user, agentKey: "nope" })).rejects.toThrow(
      "64 hexadecimal",
    );

    const connected = await backend.connectWalletKey({ network: "mainnet", user, agentKey: `0x${agentKey}` });
    const wallet = connected.wallets[0]!;
    expect(wallet).toMatchObject({ network: "mainnet", connected: true, user, expires: null, needsDeposit: false });
    expect(wallet.agent).toMatch(/^0x[0-9a-f]{40}$/);
    expect(connected.account).toMatchObject({ walletBalance: "2480.12" });
    expect(JSON.stringify(connected)).not.toContain(agentKey);

    const gone = await backend.disconnectWallet("mainnet");
    expect(gone.wallets[0]).toEqual({
      network: "mainnet",
      connected: false,
      user: null,
      agent: null,
      expires: null,
      needsDeposit: false,
    });
    expect(gone.account).toBeNull();
  });

  it("resolves a browser approval through a pushed snapshot", async () => {
    const backend = instant({ wallet: "none" });
    const pushed = new Promise<Snapshot>((resolve) => {
      const stop = backend.onSnapshot((snapshot) => {
        stop();
        resolve(snapshot);
      });
    });
    await expect(backend.connectWalletBrowser({ network: "testnet", days: 0 })).rejects.toThrow("1 to 365");

    const waiting = await backend.connectWalletBrowser({ network: "testnet", days: 30 });
    expect(waiting.pendingWallet).toMatchObject({ network: "testnet", task: "connect" });
    expect(waiting.pendingWallet?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16}$/);
    expect(waiting.wallets[1]?.connected).toBe(false);

    const approved = await pushed;
    expect(approved.pendingWallet).toBeNull();
    expect(approved.walletNotice).toEqual({ network: "testnet", task: "connect", ok: true, text: "Wallet connected on Testnet." });
    const wallet = approved.wallets[1]!;
    expect(wallet).toMatchObject({ connected: true, needsDeposit: false });
    expect(wallet.user).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const days = (Date.parse(wallet.expires!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(approved.account).not.toBeNull();
  });

  it("keeps an approval waiting until it is cancelled or replaced", async () => {
    const backend = instant({ pending: true });
    const start = await backend.boot();
    expect(start.pendingWallet).toMatchObject({ network: "testnet", task: "connect" });
    expect(start.wallets[1]?.connected).toBe(false);
    // One wallet page at a time: starting another takes the place of the one that was waiting.
    const replaced = await backend.connectWalletBrowser({ network: "mainnet", days: 7 });
    expect(replaced.pendingWallet?.network).toBe("mainnet");
    expect(replaced.pendingWallet?.url).not.toBe(start.pendingWallet?.url);
    const cancelled = await backend.cancelWalletPage();
    expect(cancelled.pendingWallet).toBeNull();
    expect(cancelled.walletNotice).toBeNull();
  });

  it("moves funds through a wallet page and says how it ended", async () => {
    const backend = instant();
    const before = Number((await backend.boot()).account!.walletBalance);
    const next = () =>
      new Promise<Snapshot>((resolve) => {
        const stop = backend.onSnapshot((snapshot) => {
          stop();
          resolve(snapshot);
        });
      });
    await expect(backend.fundWallet({ network: "mainnet", task: "deposit" })).rejects.toThrow("Connect a wallet on Mainnet first.");
    await expect(backend.fundWallet({ network: "testnet", task: "connect" })).rejects.toThrow("a deposit or a withdrawal");

    let pushed = next();
    const depositing = await backend.fundWallet({ network: "testnet", task: "deposit" });
    expect(depositing.pendingWallet).toMatchObject({ network: "testnet", task: "deposit" });
    const deposited = await pushed;
    expect(deposited.pendingWallet).toBeNull();
    expect(deposited.walletNotice).toMatchObject({ task: "deposit", ok: true });
    expect(deposited.walletNotice?.text).toContain("Deposit of 250 USDT confirmed on BNB Smart Chain Testnet");
    expect(Number(deposited.account!.walletBalance)).toBe(before + 250);
    expect(deposited.activity[0]).toMatchObject({ agent: "Execution", title: "Deposit 250 USDT from BNB Smart Chain Testnet" });
    expect(deposited.activity[0]?.steps[0]?.name).toBe("wallet.deposit");

    pushed = next();
    const withdrawing = await backend.fundWallet({ network: "testnet", task: "withdraw" });
    expect(withdrawing.pendingWallet?.task).toBe("withdraw");
    expect(withdrawing.walletNotice).toBeNull();
    const withdrawn = await pushed;
    expect(withdrawn.walletNotice?.text).toContain("Withdrawal of 40 USDT to BNB Smart Chain Testnet requested");
    expect(Number(withdrawn.account!.walletBalance)).toBe(before + 210);
    expect(withdrawn.activity[0]?.steps[0]?.name).toBe("wallet.withdraw");
  });

  it("has nothing to withdraw before the first deposit, and a deposit opens the account", async () => {
    const backend = instant({ wallet: "deposit" });
    const start = await backend.boot();
    expect(start.wallets[1]).toMatchObject({ connected: true, needsDeposit: true });
    expect(start.account).toBeNull();
    await expect(backend.fundWallet({ network: "testnet", task: "withdraw" })).rejects.toThrow("nothing to withdraw yet");
    const pushed = new Promise<Snapshot>((resolve) => {
      const stop = backend.onSnapshot((snapshot) => {
        stop();
        resolve(snapshot);
      });
    });
    await backend.fundWallet({ network: "testnet", task: "deposit" });
    const opened = await pushed;
    expect(opened.wallets[1]?.needsDeposit).toBe(false);
    expect(opened.account).not.toBeNull();
  });
});

describe("mock backend: assistant", () => {
  it("answers nothing until a model is connected, while markets keep working", async () => {
    const backend = instant({ provider: "none" });
    const snapshot = await backend.boot();
    expect(snapshot.assistant).toMatchObject({ provider: "none", model: "", label: "", ready: false });
    expect(snapshot.assistant.providers.map((provider) => [provider.id, provider.local, provider.hasKey, provider.model])).toEqual([
      ["openrouter", false, false, ""],
      ["cloudflare", false, false, ""],
      ["ollama", true, false, ""],
      ["lmstudio", true, false, ""],
    ]);
    await expect(backend.ask("BTC outlook", () => {})).rejects.toThrow(/^Connect a model first\.$/);
    expect((await backend.snapshot()).turns).toHaveLength(0);
    expect(await backend.marketOverview()).toHaveLength(20);
    expect((await backend.orderBook("BTCUSDT")).bids).toHaveLength(20);
  });

  it("streams a research answer with steps, cards, a round marker and usage", async () => {
    const backend = instant();
    const events: TurnEvent[] = [];
    const snapshot = await backend.ask("BTC outlook", (event) => events.push(event));
    const run = lastTurn(snapshot);

    expect(events[0]?.type).toBe("started");
    expect(events.at(-1)).toMatchObject({ type: "finished", run: { id: run.id, status: "complete" } });
    expect(run).toMatchObject({ status: "complete", agent: "Assistant", model: "lantern/lantern-2-large", network: "testnet" });
    expect(run.steps.map((step) => step.name)).toEqual(["model", "get_quote", "analyze_market", "get_order_book", "model"]);
    expect(run.steps.every((step) => step.status === "ok")).toBe(true);
    expect(run.steps[0]?.detail).toBe("Lantern 2 Large, round 1");
    expect(run.output).toContain("**BTC is ");
    expect(run.usage?.promptTokens).toBeGreaterThan(0);

    // Cards arrive as events, in the order the tools answered, and stay on the run.
    const streamedCards = events.flatMap((event) => (event.type === "card" ? [event.card] : []));
    expect(streamedCards.map((card) => card.kind)).toEqual(["quotes", "technicals", "book"]);
    expect(run.cards).toEqual(streamedCards);
    const [quotes, technicals, book] = run.cards;
    expect(quotes).toMatchObject({ kind: "quotes", quotes: [{ symbol: "BTCUSDT" }] });
    expect(technicals).toMatchObject({ kind: "technicals", symbol: "BTCUSDT", frame: { timeframe: "4h" } });
    expect(book).toMatchObject({ kind: "book", book: { symbol: "BTCUSDT" } });

    // Text before the last round marker is interim; what follows it is the answer.
    const round = events.map((event) => event.type).lastIndexOf("round");
    const streamed = events
      .slice(round + 1)
      .map((event) => (event.type === "text" ? event.delta : ""))
      .join("");
    expect(round).toBeGreaterThan(0);
    expect(streamed).toBe(run.output);
    expect(events.some((event) => event.type === "reasoning")).toBe(true);

    // The conversation now exists, named after its first message.
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.threads).toEqual([
      { id: snapshot.thread, title: "BTC outlook", time: run.time, network: "testnet", turns: 1 },
    ]);
    expect(snapshot.activity).toHaveLength(0);
  });

  it("compares markets, ranks movers and reads the account", async () => {
    const backend = instant({ positions: true });
    const compared = lastTurn(await backend.ask("Compare SOL and SUI", () => {}));
    expect(kinds(compared)).toEqual(["quotes", "technicals", "technicals"]);
    expect(compared.cards[0]).toMatchObject({ quotes: [{ symbol: "SOLUSDT" }, { symbol: "SUIUSDT" }] });
    expect(compared.output).toContain("| Market | Price |");

    const movers = lastTurn(await backend.ask("Top movers", () => {}));
    expect(movers.steps.map((step) => step.name)).toEqual(["model", "get_movers", "model"]);
    const card = movers.cards[0]!;
    expect(card.kind).toBe("movers");
    if (card.kind === "movers") {
      expect(card.rows).toHaveLength(6);
      const moves = card.rows.map((row) => Math.abs(row.changePct ?? 0));
      expect(moves).toEqual([...moves].sort((left, right) => right - left));
    }

    const account = lastTurn(await backend.ask("My positions", () => {}));
    expect(kinds(account)).toEqual(["account"]);
    expect(account.output).toContain("3 open positions");

    const funding = lastTurn(await backend.ask("ETH funding this week", () => {}));
    expect(kinds(funding)).toEqual(["quotes"]);
    expect(funding.output).toContain("**ETH funding is ");
  });

  it("reads the news when asked, unless web search is off", async () => {
    const backend = instant();
    expect((await backend.boot()).assistant.webSearch).toBe(true);
    const events: TurnEvent[] = [];
    const news = lastTurn(await backend.ask("Any news on SOL?", (event) => events.push(event)));
    expect(news.steps.map((step) => [step.name, step.detail])).toEqual([
      ["model", "Lantern 2 Large, round 1"],
      ["search_news", "SOL"],
      ["model", "Lantern 2 Large, round 2"],
    ]);
    expect(kinds(news)).toEqual(["news"]);
    const card = news.cards[0]!;
    if (card.kind !== "news") throw new Error("expected a news card");
    expect(card.query).toBe("SOL");
    expect(card.articles).toHaveLength(3);
    expect(events.some((event) => event.type === "card" && event.card.kind === "news")).toBe(true);
    for (const article of card.articles) {
      expect(article.title).toContain("SOL");
      expect(article.url).toMatch(/^https:\/\/[a-z]+\.example\/markets\/sol-\d$/);
      expect(Date.parse(article.published ?? "")).toBeLessThan(Date.now());
    }
    const times = card.articles.map((article) => article.published ?? "");
    expect(times).toEqual([...times].sort().reverse());
    expect(news.output).toContain(card.articles[0]!.source);

    // No market named: the newest headlines about the market in focus, with an empty query.
    const market = lastTurn(await backend.ask("Market news", () => {}));
    expect(market.cards[0]).toMatchObject({ kind: "news", query: "" });

    const off = await backend.setWebSearch(false);
    expect(off.assistant.webSearch).toBe(false);
    const refused = lastTurn(await backend.ask("Why is BTC moving?", () => {}));
    expect(refused.cards).toEqual([]);
    expect(refused.steps.map((step) => step.name)).toEqual(["model", "model"]);
    expect(refused.output).toBe(
      "Web search is off, so I cannot read the news. You can turn it on in Settings, under Tools.",
    );
    expect((await instant(mockOptionsFromUrl("?web=0")).boot()).assistant.webSearch).toBe(false);
  });

  it("sizes a position from the risk and drafts a ticket with its stop", async () => {
    const backend = instant();
    const events: TurnEvent[] = [];
    const snapshot = await backend.ask("Long ETH, 1% risk", (event) => events.push(event));
    const run = lastTurn(snapshot);
    expect(kinds(run)).toEqual(["quotes", "technicals", "account", "plan"]);
    expect(run.steps.map((step) => step.name)).toEqual([
      "model",
      "get_quote",
      "analyze_market",
      "get_account",
      "plan_position",
      "propose_order",
      "model",
    ]);

    const card = run.cards[3]!;
    if (card.kind !== "plan") throw new Error("the fourth card is the plan");
    const { plan } = card;
    expect(plan).toMatchObject({ symbol: "ETHUSDT", direction: "long", leverage: 3, stopSafe: true });
    expect(plan.riskPct).toBeGreaterThan(0.5);
    expect(plan.riskPct).toBeLessThanOrEqual(1);
    expect(Number(plan.stop)).toBeLessThan(Number(plan.entry));
    expect(Number(plan.target)).toBeGreaterThan(Number(plan.entry));
    expect(Number(plan.margin)).toBeCloseTo(Number(plan.notional) / 3, 1);

    const ticket = snapshot.draft!;
    expect(events.some((event) => event.type === "ticket" && event.ticket.id === ticket.id)).toBe(true);
    expect(run.ticket?.id).toBe(ticket.id);
    expect(ticket).toMatchObject({ symbol: "ETHUSDT", side: "buy", qty: plan.qty, stopLoss: plan.stop, takeProfit: plan.target });
    expect(ticket.rationale).toContain("of equity");
    expect(run.output).toContain("The ticket is ready");
  });

  it("shows a plan whose stop sits beyond liquidation, and drafts nothing for it", async () => {
    const snapshot = await instant().ask("Short SOL 10x, 1% risk, wide stop", () => {});
    const run = lastTurn(snapshot);
    const card = run.cards.find((item) => item.kind === "plan");
    if (card?.kind !== "plan") throw new Error("the turn has a plan card");
    expect(card.plan).toMatchObject({ direction: "short", leverage: 10, stopSafe: false });
    expect(run.steps.find((step) => step.name === "propose_order")).toMatchObject({ status: "error" });
    expect(run.output).toContain("I did not draft a ticket");
    expect(run.output).toContain("comes before the stop-loss");
    expect(run).toMatchObject({ status: "complete", ticket: null });
    expect(snapshot.draft).toBeNull();
  });

  it("sends an order worded as a command to the model like any other message", async () => {
    const backend = instant();
    const opened = await backend.ask("Long 0.01 BTC", () => {});
    expect(lastTurn(opened)).toMatchObject({ agent: "Assistant", model: "lantern/lantern-2-large", status: "complete" });
    expect(lastTurn(opened).steps.at(-2)).toMatchObject({ name: "propose_order", detail: "open_long 0.01 BTCUSDT", status: "ok" });
    // A ticket from the assistant always carries a stop-loss.
    expect(opened.draft).toMatchObject({ side: "buy", qty: "0.01", effect: "Opens a 0.01 BTC long at 3x with isolated margin" });
    expect(opened.draft?.stopLoss).not.toBeNull();
    await backend.submitTicket(opened.draft!.id);

    const closing = await backend.ask("Close BTC", () => {});
    expect(closing.draft?.effect).toMatch(/^Closes the 0\.01 BTC long and cancels the 1 reduce-only order/);
    await backend.submitTicket(closing.draft!.id);
    const nothing = await backend.ask("Close BTC", () => {});
    expect(lastTurn(nothing)).toMatchObject({ status: "complete", ticket: null });
    expect(lastTurn(nothing).output).toContain("no open BTC position");
  });

  it("lets the assistant draft mainnet tickets only when the trader allows it", async () => {
    const backend = instant({ network: "mainnet", wallet: "connected" });
    const refused = await backend.ask("Long BTC, 1% risk", () => {});
    expect(lastTurn(refused)).toMatchObject({ status: "complete", ticket: null });
    expect(lastTurn(refused).output).toContain("Mainnet tickets from the assistant are turned off");
    expect(refused.draft).toBeNull();

    // A ticket the trader writes is theirs, so it is drafted either way.
    expect((await backend.prepareTicket({ symbol: "BTCUSDT", side: "buy", qty: "0.01" })).draft).toMatchObject({
      network: "mainnet",
    });

    const saved = await backend.saveAssistant({
      provider: "openrouter",
      model: "lantern/lantern-2-large",
      effort: "auto",
      liveTickets: true,
    });
    expect(saved.assistant.liveTickets).toBe(true);
    const allowed = await backend.ask("Long BTC, 1% risk", () => {});
    expect(allowed.draft).toMatchObject({ network: "mainnet", side: "buy", reduceOnly: false });
    expect(allowed.draft?.stopLoss).not.toBeNull();
    expect(lastTurn(allowed).ticket?.id).toBe(allowed.draft?.id);
  });

  it("resolves a failed run instead of rejecting", async () => {
    const snapshot = await instant().ask("please fail this one", () => {});
    expect(lastTurn(snapshot)).toMatchObject({ status: "failed" });
    expect(lastTurn(snapshot).output).toContain("balance is too low");
    expect(lastTurn(snapshot).steps.at(-1)).toMatchObject({ name: "model", status: "error" });
    expect(snapshot.busy).toBe(false);
  });

  it("rejects an empty message before starting a run", async () => {
    const backend = instant();
    await expect(backend.ask("   ", () => {})).rejects.toThrow("Type a message");
    expect((await backend.snapshot()).turns).toHaveLength(0);
  });

  it("stops a running turn, and refuses to change conversations under it", async () => {
    const backend = createMockBackend({ speed: 0.01, hold: true, history: false });
    const pending = backend.ask("BTC outlook", () => {});
    await new Promise((done) => setTimeout(done, 300));
    const during = await backend.snapshot();
    expect(during.busy).toBe(true);
    const waiting = "Stop the assistant or wait for it to finish before";
    await expect(backend.setNetwork("mainnet")).rejects.toThrow(`${waiting} switching network.`);
    await expect(backend.newThread()).rejects.toThrow(`${waiting} starting a new chat.`);
    await expect(backend.openThread(during.thread)).rejects.toThrow(`${waiting} opening another chat.`);
    await expect(backend.deleteThread(during.thread)).rejects.toThrow(`${waiting} deleting a chat.`);
    await backend.stopTurn();
    const snapshot = await pending;
    expect(lastTurn(snapshot).status).toBe("stopped");
    expect(lastTurn(snapshot).output.length).toBeGreaterThan(0);
    expect(snapshot.busy).toBe(false);
  });
});

describe("mock backend: conversations", () => {
  it("starts, reopens and deletes conversations", async () => {
    const backend = instant();
    const first = await backend.ask("BTC outlook", () => {});
    const firstId = first.thread;

    // A new conversation is not listed until it has a turn.
    const fresh = await backend.newThread();
    expect(fresh.thread).not.toBe(firstId);
    expect(fresh.turns).toHaveLength(0);
    expect(fresh.threads.map((thread) => thread.id)).toEqual([firstId]);

    const second = await backend.ask("Top movers", () => {});
    expect(second.turns.map((run) => run.title)).toEqual(["Top movers"]);
    expect(second.threads.map((thread) => thread.title)).toEqual(["Top movers", "BTC outlook"]);

    const reopened = await backend.openThread(firstId);
    expect(reopened.thread).toBe(firstId);
    expect(reopened.turns.map((run) => run.title)).toEqual(["BTC outlook"]);
    const more = await backend.ask("ETH funding this week", () => {});
    expect(more.turns.map((run) => run.title)).toEqual(["BTC outlook", "ETH funding this week"]);
    expect(more.threads[0]).toMatchObject({ id: firstId, title: "BTC outlook", turns: 2 });
    await expect(backend.openThread("gone")).rejects.toThrow("That chat is no longer saved.");

    // Deleting the open conversation leaves a new, empty one open.
    const deleted = await backend.deleteThread(firstId);
    expect(deleted.thread).not.toBe(firstId);
    expect(deleted.turns).toHaveLength(0);
    expect(deleted.threads.map((thread) => thread.title)).toEqual(["Top movers"]);
  });

  it("starts with earlier conversations in the list and none of them open", async () => {
    const backend = createMockBackend({ speed: 0 });
    const snapshot = await backend.boot();
    expect(snapshot.turns).toHaveLength(0);
    expect(snapshot.threads).toHaveLength(7);
    expect(snapshot.threads.some((thread) => thread.id === snapshot.thread)).toBe(false);
    const times = snapshot.threads.map((thread) => Date.parse(thread.time));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    // Tickets drafted in those conversations are long expired.
    expect(snapshot.draft).toBeNull();

    const wide = snapshot.threads.find((thread) => thread.title.startsWith("Short SUI"))!;
    const opened = await backend.openThread(wide.id);
    expect(opened.turns).toHaveLength(1);
    expect(opened.turns[0]?.cards.some((card) => card.kind === "plan" && !card.plan.stopSafe)).toBe(true);
    const two = snapshot.threads.find((thread) => thread.turns === 2)!;
    expect((await backend.openThread(two.id)).turns.map((run) => run.title)).toEqual(["DOGE outlook", "Long 4000 DOGE"]);
  });
});

describe("mock backend: models", () => {
  const key = "sk-or-v1-abcdefgh12345678";
  const account = "0123456789abcdef0123456789abcdef";
  const token = "cf-token-0123456789abcdefghij";

  it("lists what each provider offers", async () => {
    const backend = instant({ provider: "none" });
    await expect(backend.listModels({ provider: "openrouter" })).rejects.toThrow("sk-or-");
    await expect(backend.listModels({ provider: "openrouter", key: "nope" })).rejects.toThrow("sk-or-");
    const catalog = await backend.listModels({ provider: "openrouter", key });
    expect(catalog.some((model) => model.id === "openrouter/auto")).toBe(true);
    expect(catalog.some((model) => !model.tools)).toBe(true);

    await expect(backend.listModels({ provider: "cloudflare", key: token })).rejects.toThrow("Cloudflare account ID");
    await expect(backend.listModels({ provider: "cloudflare", account })).rejects.toThrow("API token");
    const workers = await backend.listModels({ provider: "cloudflare", account, key: token });
    expect(workers.every((model) => model.id.startsWith("@cf/"))).toBe(true);

    const installed = await backend.listModels({ provider: "ollama" });
    expect(installed.map((model) => [model.id, model.tools])).toEqual([
      ["reef:8b", true],
      ["kelp-coder:14b", true],
      ["brine-r1:8b", true],
      ["eel-chat:7b", false],
    ]);
    expect(installed.every((model) => model.promptPrice === null)).toBe(true);
    await expect(backend.listModels({ provider: "lmstudio", url: "not an address" })).rejects.toThrow("server's address");
    expect(await backend.listModels({ provider: "lmstudio", url: "http://127.0.0.1:1234" })).toHaveLength(3);
    await expect(backend.listModels({ provider: "none" })).rejects.toThrow("Choose a provider");
  });

  it("reports a local server that is not running, and one that comes up on a second try", async () => {
    const down = instant({ provider: "none", local: "down" });
    await expect(down.listModels({ provider: "ollama" })).rejects.toThrow("Ollama is not running");
    await expect(down.listModels({ provider: "lmstudio" })).rejects.toThrow("LM Studio is not running");
    await expect(down.saveAssistant({ provider: "ollama", model: "reef:8b", effort: "auto", liveTickets: false })).rejects.toThrow(
      "not running",
    );

    const flaky = instant({ provider: "none", local: "retry" });
    await expect(flaky.listModels({ provider: "ollama" })).rejects.toThrow("not running");
    expect(await flaky.listModels({ provider: "ollama" })).toHaveLength(4);
  });

  it("connects a model from each provider and never echoes a key", async () => {
    const backend = instant({ provider: "none" });
    const base = { effort: "high", liveTickets: false } as const;

    await expect(backend.saveAssistant({ ...base, provider: "openrouter", model: "kelpworks/kelp-4" })).rejects.toThrow("sk-or-");
    await expect(backend.saveAssistant({ ...base, provider: "openrouter", model: "nope/nope", key })).rejects.toThrow(
      "OpenRouter catalog",
    );
    await expect(backend.saveAssistant({ ...base, provider: "openrouter", model: "moray/eel-chat-13b", key })).rejects.toThrow(
      "cannot use tools",
    );
    const cloud = await backend.saveAssistant({ ...base, provider: "openrouter", model: "kelpworks/kelp-4", key });
    expect(cloud.assistant).toMatchObject({
      provider: "openrouter",
      model: "kelpworks/kelp-4",
      label: "Kelp 4",
      ready: true,
      reasoning: true,
      effort: "high",
    });
    expect(cloud.assistant.providers[0]).toMatchObject({ id: "openrouter", hasKey: true, model: "kelpworks/kelp-4" });
    expect(JSON.stringify(cloud)).not.toContain(key);

    await expect(backend.saveAssistant({ ...base, provider: "cloudflare", model: "gpt", account, key: token })).rejects.toThrow(
      "provider/model",
    );
    await expect(
      backend.saveAssistant({ ...base, provider: "cloudflare", model: "lantern/lantern-2-mini", account, key: token, gateway: "no good" }),
    ).rejects.toThrow("gateway ID");
    const gateway = await backend.saveAssistant({ ...base, provider: "cloudflare", model: "lantern/lantern-2-mini", account, key: token });
    expect(gateway.assistant).toMatchObject({ provider: "cloudflare", label: "Lantern 2 Mini", ready: true });
    expect(gateway.assistant.providers[1]).toMatchObject({ hasKey: true, account, gateway: "default", url: "" });
    expect(JSON.stringify(gateway)).not.toContain(token);

    await expect(backend.saveAssistant({ ...base, provider: "ollama", model: "nope:1b" })).rejects.toThrow("did not report nope:1b");
    await expect(backend.saveAssistant({ ...base, provider: "ollama", model: "eel-chat:7b" })).rejects.toThrow("cannot use tools");
    const local = await backend.saveAssistant({ ...base, provider: "ollama", model: "reef:8b" });
    // A model without configurable reasoning has no effort to set.
    expect(local.assistant).toMatchObject({ provider: "ollama", label: "reef:8b", ready: true, reasoning: false, effort: "auto" });
    expect(local.assistant.providers[2]).toMatchObject({ local: true, hasKey: false, url: "http://127.0.0.1:11434" });

    await expect(backend.saveAssistant({ ...base, provider: "lmstudio", model: "nope" })).rejects.toThrow("no model named nope");
    const studio = await backend.saveAssistant({
      ...base,
      provider: "lmstudio",
      model: "tidepool/reef-8b-instruct",
      url: "http://127.0.0.1:4321",
    });
    expect(studio.assistant).toMatchObject({ provider: "lmstudio", label: "Reef 8B Instruct" });
    expect(studio.assistant.providers[3]).toMatchObject({ url: "http://127.0.0.1:4321" });
    // LM Studio loads the model before the first round.
    const run = lastTurn(await backend.ask("Top movers", () => {}));
    expect(run.steps[0]).toMatchObject({ name: "load_model", detail: "Reef 8B Instruct" });
    expect(run.usage).toBeNull();
  });

  it("switches between connected providers with their stored keys, and forgets one", async () => {
    const backend = instant();
    const start = await backend.boot();
    expect(start.assistant.providers.filter((provider) => provider.model !== "").map((provider) => provider.id)).toEqual([
      "openrouter",
      "ollama",
    ]);

    const local = await backend.saveAssistant({ provider: "ollama", model: "reef:8b", effort: "auto", liveTickets: false });
    expect(local.assistant).toMatchObject({ provider: "ollama", model: "reef:8b" });
    // The stored key is kept, so switching back needs nothing typed.
    const back = await backend.saveAssistant({
      provider: "openrouter",
      model: "lantern/lantern-2-large",
      effort: "auto",
      liveTickets: false,
    });
    expect(back.assistant).toMatchObject({ provider: "openrouter", label: "Lantern 2 Large", ready: true });
    expect((await backend.listModels({ provider: "openrouter" })).length).toBeGreaterThan(0);

    const other = await backend.forgetProvider("ollama");
    expect(other.assistant.provider).toBe("openrouter");
    expect(other.assistant.providers[2]).toMatchObject({ model: "" });

    const none = await backend.forgetProvider("openrouter");
    expect(none.assistant).toMatchObject({ provider: "none", ready: false, model: "", label: "" });
    expect(none.assistant.providers[0]).toMatchObject({ hasKey: false, model: "" });
    await expect(backend.ask("BTC outlook", () => {})).rejects.toThrow("Connect a model first.");
    await expect(backend.listModels({ provider: "openrouter" })).rejects.toThrow("sk-or-");
  });
});

describe("mock backend: tool servers", () => {
  it("attaches tool servers under the id the trader gives them", async () => {
    const backend = instant();
    const local = (id: string): McpConnectRequest => ({ id, transport: "stdio", command: "node", args: [], env: {} });
    await expect(backend.mcpConnect(local("Bad Id"))).rejects.toThrow("short id");
    await expect(backend.mcpConnect({ id: "news", transport: "http", url: "http://example.com/mcp" })).rejects.toThrow(
      "https://",
    );

    const attached = await backend.mcpConnect({ id: "news", transport: "http", url: "https://mcp.example.com/mcp" });
    expect(attached.servers).toEqual([
      { id: "news", name: "mcp.example.com", version: "1.0.0", transport: "http", tools: 5 },
    ]);
    await expect(backend.mcpConnect(local("news"))).rejects.toThrow("already attached");

    const tools = await backend.mcpTools("news");
    expect(tools.some((tool) => !tool.readOnly)).toBe(true);
    const output = await backend.mcpCall("news", tools[0]!.name, { query: "BTC" });
    expect(JSON.parse(output)).toMatchObject({ tool: tools[0]!.name, arguments: { query: "BTC" } });
    // A tool the trader ran is recorded for the session.
    expect((await backend.snapshot()).activity[0]).toMatchObject({
      agent: "Tool inspector",
      title: `news ${tools[0]!.name}`,
      output,
    });

    expect((await backend.mcpDisconnect("news")).servers).toHaveLength(0);
    await expect(backend.mcpTools("news")).rejects.toThrow("Attach the server first");
  });
});

describe("mock backend: forced states", () => {
  it("reads forced states from the URL", () => {
    expect(
      mockOptionsFromUrl(
        "?seed=conversation&network=mainnet&wallet=deposit&positions=1&ticket=close&pending=1&provider=lmstudio&local=retry&history=0&markets=595&theme=light&mcp=1&speed=0",
      ),
    ).toEqual({
      seed: "conversation",
      network: "mainnet",
      wallet: "deposit",
      positions: true,
      ticket: "close",
      pending: true,
      provider: "lmstudio",
      local: "retry",
      history: false,
      markets: 595,
      theme: "light",
      mcp: true,
      speed: 0,
    });
    expect(mockOptionsFromUrl("?seed=bogus&network=devnet&positions=yes&provider=builtin&markets=many")).toMatchObject({
      seed: undefined,
      network: undefined,
      wallet: undefined,
      positions: undefined,
      provider: undefined,
      markets: undefined,
    });
  });

  it("seeds a conversation with each kind of ticket", async () => {
    const pending = await instant({ seed: "conversation" }).boot();
    expect(pending.turns.map((run) => run.title)).toEqual(["BTC outlook", "Long BTC, 1% risk"]);
    expect(kinds(pending.turns[0]!)).toEqual(["quotes", "technicals", "book"]);
    expect(pending.draft?.id).toBe(pending.turns[1]?.ticket?.id);
    expect(pending.draft).toMatchObject({ network: "testnet", symbol: "BTCUSDT", side: "buy" });
    expect(pending.draft?.stopLoss).not.toBeNull();
    expect(pending.draft?.takeProfit).not.toBeNull();
    expect(pending.draft?.rationale).not.toBe("");
    expect(pending.account?.positions).toHaveLength(3);
    expect(pending.threads[0]).toMatchObject({ id: pending.thread, turns: 2 });

    const short = await instant({ seed: "conversation", ticket: "short" }).boot();
    expect(short.draft).toMatchObject({ side: "sell", reduceOnly: false });

    const close = await instant({ seed: "conversation", ticket: "close" }).boot();
    expect(close.draft?.reduceOnly).toBe(true);
    expect(close.draft?.effect).toMatch(/^Closes the 1\.2 ETH long/);
  });

  it("seeds a ticket in each state it can end in", async () => {
    const filled = await instant({ seed: "filled" }).boot();
    expect(filled.draft).toBeNull();
    const sent = filled.turns[1]!.ticket!;
    expect(filled.receipts[sent.id]).toContain("Sent on testnet");
    expect(filled.account?.positions.some((position) => position.symbol === "BTCUSDT")).toBe(true);
    expect(filled.activity[0]).toMatchObject({ agent: "Execution", thread: "" });
    expect(filled.turns).toHaveLength(2);

    const unconfirmed = await instant({ seed: "unconfirmed" }).boot();
    const lost = unconfirmed.turns[1]!.ticket!;
    expect(unconfirmed.draft).toBeNull();
    expect(unconfirmed.failures[lost.id]).toContain("may or may not have reached the exchange");
    expect(unconfirmed.failures[lost.id]).toContain(lost.id);
    expect(unconfirmed.receipts).toEqual({});

    const expired = await instant({ seed: "expired" }).boot();
    expect(expired.turns[1]?.ticket).not.toBeNull();
    expect(expired).toMatchObject({ draft: null, receipts: {}, failures: {} });
  });

  it("seeds a mainnet ticket, a conversation without a wallet, and a tool server", async () => {
    const live = await instant({ seed: "liveticket" }).boot();
    expect(live.network).toBe("mainnet");
    expect(live.wallets[0]?.connected).toBe(true);
    expect(live.assistant.liveTickets).toBe(true);
    expect(live.draft).toMatchObject({ network: "mainnet" });

    const walletless = await instant({ seed: "conversation", wallet: "none" }).boot();
    expect(walletless.turns).toHaveLength(2);
    expect(walletless.turns[1]).toMatchObject({ ticket: null });
    expect(walletless.draft).toBeNull();

    const attached = await instant({ mcp: true }).boot();
    expect(attached.servers).toHaveLength(1);
  });
});

describe("mock backend: news", () => {
  it("reads two dozen invented stories from the last day, newest first, from both desks", async () => {
    const feed = await instant().newsFeed();
    expect(feed.stories.length).toBeGreaterThanOrEqual(20);
    expect(feed.stories.length).toBeLessThanOrEqual(28);

    const times = feed.stories.map((story) => Date.parse(story.published ?? ""));
    expect([...times].sort((left, right) => right - left)).toEqual(times);
    for (const time of times) {
      expect(Date.now() - time).toBeGreaterThan(0);
      expect(Date.now() - time).toBeLessThan(24 * 3_600_000);
    }
    expect(new Set(feed.stories.map((story) => story.desk))).toEqual(new Set(["crypto", "macro"]));

    // Every newsroom is invented, and so is every address.
    expect(feed.missing).toEqual([]);
    for (const story of feed.stories) {
      expect(feed.publishers).toContain(story.source);
      const url = new URL(story.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname.endsWith(".example")).toBe(true);
      expect(story.title.length).toBeGreaterThan(0);
      expect(story.summary.length).toBeGreaterThan(0);
    }
    expect(feed.publishers).toEqual(expect.arrayContaining(["Tidewire", "Kelp Desk", "The Brine Report"]));
    expect(Number.isNaN(Date.parse(feed.readAt))).toBe(false);
  });

  it("draws an abstract picture for most stories, the same one every time, and leaves a few without", async () => {
    const first = await instant().newsFeed();
    const second = await instant().newsFeed();
    const pictured = first.stories.filter((story) => story.image !== null);
    expect(pictured.length).toBeGreaterThan(first.stories.length / 2);
    expect(first.stories.length - pictured.length).toBeGreaterThanOrEqual(3);
    for (const story of pictured) {
      expect(story.image).toMatch(/^data:image\/svg\+xml/);
      // Shapes and colour only: no words that could pass for a brand.
      expect(decodeURIComponent(story.image!)).not.toMatch(/<text|<image|https?:\/\/(?!www\.w3\.org)/);
    }
    expect(new Set(pictured.map((story) => story.image)).size).toBe(pictured.length);
    expect(second.stories.map((story) => story.image)).toEqual(first.stories.map((story) => story.image));
  });

  it("names only markets listed on the active network", async () => {
    const backend = instant();
    const testnet = await backend.newsFeed();
    const listed = new Set((await backend.marketOverview()).map((row) => row.symbol));
    const about = testnet.stories.flatMap((story) => story.markets);
    expect(about).toEqual(expect.arrayContaining(["BTCUSDT", "ETHUSDT", "SOLUSDT"]));
    for (const symbol of about) expect(listed.has(symbol)).toBe(true);

    // Gold is only listed on mainnet.
    const gold = (stories: typeof testnet.stories) => stories.find((story) => story.title.startsWith("Gold"))?.markets;
    expect(gold(testnet.stories)).toEqual([]);
    await backend.setNetwork("mainnet");
    expect(gold((await backend.newsFeed()).stories)).toEqual(["XAUUSD1"]);
  });

  it("reads nothing while web search is off, and says so", async () => {
    const backend = instant({ web: false });
    await expect(backend.newsFeed()).rejects.toThrow("Web search is off");
    await backend.setWebSearch(true);
    expect((await backend.newsFeed()).stories.length).toBeGreaterThan(0);
  });

  it("can be told that a newsroom did not answer, that none did, or that nobody had a story", async () => {
    const missing = await instant({ feed: "missing" }).newsFeed();
    expect(missing.missing).toEqual(["Kelp Desk"]);
    expect(missing.publishers).toContain("Kelp Desk");
    expect(missing.stories.some((story) => story.source === "Kelp Desk")).toBe(false);

    await expect(instant({ feed: "error" }).newsFeed()).rejects.toThrow("None of the newsrooms answered");
    expect((await instant({ feed: "empty" }).newsFeed()).stories).toEqual([]);

    expect(mockOptionsFromUrl("?feed=missing&web=0")).toMatchObject({ feed: "missing", web: false });
    expect(mockOptionsFromUrl("?feed=nope").feed).toBeUndefined();
  });

  it("passes its own pictures through, and has no article view to open or report on", async () => {
    const backend = instant();
    const feed = await backend.newsFeed();
    const image = feed.stories.find((story) => story.image !== null)!.image!;
    expect(backend.pictureSrc(image)).toBe(image);
    expect(backend.pictureSrc("https://tidewire.example/pictures/lead.jpg")).toBe("");

    const bounds = { x: 260, y: 106, width: 1180, height: 794 };
    await expect(backend.openArticle(feed.stories[0]!.url, bounds)).resolves.toBeUndefined();
    await expect(backend.moveArticle(bounds)).resolves.toBeUndefined();
    await expect(backend.showArticle(false)).resolves.toBeUndefined();
    await expect(backend.reloadArticle()).resolves.toBeUndefined();
    await expect(backend.closeArticle()).resolves.toBeUndefined();
    const stop = backend.onArticle(() => {
      throw new Error("The mock has no article view to report on.");
    });
    expect(stop).toBeTypeOf("function");
    stop();
  });
});
