// Starts the built desktop app with an empty data folder against a stand-in for
// The exchange served on this computer, and waits for proof that the real web view
// loaded the bundled interface and reached the core: the interface calls `boot`
// on start, and the core then asks the stand-in for its markets and prices.
//
//   node scripts/smoke.mjs [path-to-binary] [--e2e]
//
// With --e2e (debug builds only) the app also connects a throwaway wallet and a
// stand-in model served on this computer, and drives one order through its own
// window: it types a message, the model drafts a ticket with a stop, and the
// ticket is confirmed. The test then waits for the stand-in exchange to receive
// that market order and its stop, signed by the wallet, and for the app to
// journal the fill.
//
// Nothing here touches the real exchange, a real model provider, a real wallet or
// the system keychain.
// Exits 0 on success, 1 if the app exits early or 60 seconds pass.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.platform === "win32" ? "octoneo.exe" : "octoneo";
const e2e = process.argv.includes("--e2e");
const given = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const binary = given ?? (e2e ? ["debug"] : ["release", "debug"]).map((profile) => join("target", profile, executable)).find(existsSync);
if (!binary || !existsSync(binary)) {
  console.error("No built app found. Run `pnpm tauri build` first, or pass the binary path.");
  process.exit(1);
}

/* ------------------------------------------------------- the stand-in exchange */

// The API wallet the app's self-test connects: the example from the exchange's API documentation.
const AGENT = "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";
const MARKETS = [
  { symbol: "BTCUSDT", base: "BTC", price: 62000, tick: "0.1", step: "0.001" },
  { symbol: "ETHUSDT", base: "ETH", price: 1800, tick: "0.01", step: "0.001" },
  { symbol: "SOLUSDT", base: "SOL", price: 70, tick: "0.01", step: "0.01" },
];
const SPANS = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** What the app asked for, as "METHOD /path". */
const seen = [];
/** Signed requests that changed something, as { method, path, params }. */
const changes = [];
/** Signed requests that were not signed the way the exchange requires. */
const malformed = [];
const book = { position: 0, entry: 0, leverage: 20, isolated: false, orders: [], nextId: 1000 };

const market = (symbol) => MARKETS.find((item) => item.symbol === symbol);
const ticker = (item) => ({
  symbol: item.symbol,
  lastPrice: String(item.price),
  priceChangePercent: "1.50",
  highPrice: String(item.price * 1.02),
  lowPrice: String(item.price * 0.98),
  volume: "1000",
  quoteVolume: "5000000",
  closeTime: Date.now(),
});
const premium = (item) => ({
  symbol: item.symbol,
  markPrice: String(item.price),
  indexPrice: String(item.price),
  lastFundingRate: "0.0001",
  nextFundingTime: Date.now() + 3_600_000,
});

function klines(item, interval, limit) {
  const span = SPANS[interval] ?? SPANS["1d"];
  const open = Math.floor(Date.now() / span) * span;
  const at = (age) => item.price * (1 - age / 1000);
  return Array.from({ length: limit }, (_, index) => {
    const age = limit - 1 - index;
    const [o, c] = [at(age + 1), at(age)];
    return [open - age * span, o.toFixed(4), (c * 1.001).toFixed(4), (o * 0.999).toFixed(4), c.toFixed(4), "100", open - age * span + span - 1];
  });
}

const PANEL = new Set(["/fapi/v3/depth", "/fapi/v3/trades", "/fapi/v3/fundingRate", "/fapi/v3/fundingInfo", "/fapi/v3/openInterest"]);

function panel(path, item) {
  const now = Date.now();
  if (path === "/fapi/v3/depth") {
    const level = (factor, size) => [(item.price * factor).toFixed(2), size];
    return { E: now, bids: [level(0.9995, "2"), level(0.999, "4"), level(0.99, "9")], asks: [level(1.0005, "2"), level(1.001, "3"), level(1.01, "8")] };
  }
  if (path === "/fapi/v3/trades") {
    return Array.from({ length: 12 }, (_, age) => ({ id: 500 - age, price: String(item.price), qty: "0.25", quoteQty: "1", time: now - age * 1500, isBuyerMaker: age % 3 === 0 }));
  }
  if (path === "/fapi/v3/fundingRate") {
    const span = 8 * 3_600_000;
    const last = Math.floor(now / span) * span;
    return Array.from({ length: 42 }, (_, index) => ({ symbol: item.symbol, fundingTime: last - (41 - index) * span, fundingRate: index % 5 === 0 ? "-0.00003000" : "0.00010000" }));
  }
  if (path === "/fapi/v3/fundingInfo") return [{ symbol: item.symbol, fundingIntervalHours: 8, interestRate: "0.0001" }];
  return { symbol: item.symbol, openInterest: "1250.5", time: now };
}

function positionRow() {
  const margin = book.isolated ? (Math.abs(book.position) * book.entry) / book.leverage : 0;
  return {
    symbol: "BTCUSDT",
    positionAmt: String(book.position),
    entryPrice: String(book.entry),
    markPrice: "62000",
    liquidationPrice: "0",
    leverage: String(book.leverage),
    marginType: book.isolated ? "isolated" : "cross",
    unRealizedProfit: "0",
    notional: String(book.position * 62000),
    isolatedMargin: margin.toFixed(8),
    positionSide: "BOTH",
  };
}

/** The exchange's signing rules that can be checked without its keys: who signed, when, and that a signature is attached. */
function signedCorrectly(query) {
  const nonce = Number(query.get("nonce"));
  const fresh = Math.abs(Date.now() * 1000 - nonce) < 60_000_000;
  return query.get("signer") === AGENT && fresh && /^0x[0-9a-f]{130}$/.test(query.get("signature") ?? "");
}

function account(method, path, query) {
  const symbol = query.get("symbol");
  if (method === "GET" && path === "/fapi/v3/balance") return [{ asset: "USDT", balance: "1000" }];
  if (method === "GET" && path === "/fapi/v3/account") {
    const used = (Math.abs(book.position) * book.entry) / book.leverage;
    const available = (1000 - used).toFixed(8);
    return {
      totalWalletBalance: "1000",
      totalUnrealizedProfit: "0",
      totalMarginBalance: "1000",
      availableBalance: available,
      totalInitialMargin: used.toFixed(8),
      assets: [{ asset: "USDT", walletBalance: "1000", availableBalance: available }],
    };
  }
  if (method === "GET" && path === "/fapi/v3/multiAssetsMargin") return { multiAssetsMargin: false };
  if (method === "GET" && path === "/fapi/v3/positionRisk") return symbol || book.position !== 0 ? [positionRow()] : [];
  if (method === "GET" && path === "/fapi/v3/openOrders") return book.orders;
  if (method === "POST" && path === "/fapi/v3/leverage") {
    book.leverage = Number(query.get("leverage"));
    return { symbol, leverage: book.leverage };
  }
  if (method === "POST" && path === "/fapi/v3/marginType") {
    book.isolated = query.get("marginType") === "ISOLATED";
    return { code: 200, msg: "success" };
  }
  if (method === "POST" && path === "/fapi/v3/order") {
    const id = book.nextId++;
    const quantity = Number(query.get("quantity"));
    if (query.get("type") !== "MARKET") {
      book.orders.push({ orderId: id, clientOrderId: query.get("newClientOrderId"), symbol, side: query.get("side"), type: query.get("type") });
      return { orderId: id, status: "NEW", executedQty: "0", avgPrice: "0" };
    }
    book.position += query.get("side") === "BUY" ? quantity : -quantity;
    book.entry = 62000;
    return { orderId: id, clientOrderId: query.get("newClientOrderId"), status: "FILLED", executedQty: query.get("quantity"), avgPrice: "62000", symbol };
  }
  return null;
}

function answer(method, url) {
  const { pathname: path, searchParams: query } = url;
  const symbol = query.get("symbol");
  if (path === "/fapi/v3/time") return [200, { serverTime: Date.now() }];
  if (path === "/fapi/v3/exchangeInfo") {
    const symbols = MARKETS.map((item) => ({
      symbol: item.symbol,
      baseAsset: item.base,
      quoteAsset: "USDT",
      status: "TRADING",
      contractType: "PERPETUAL",
      maintMarginPercent: "2.5000",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: item.tick },
        { filterType: "MARKET_LOT_SIZE", stepSize: item.step, minQty: item.step, maxQty: "120" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    }));
    return [200, { symbols }];
  }
  const unknown = [400, { code: -1121, msg: "Invalid symbol." }];
  if (path === "/fapi/v3/ticker/24hr") return symbol ? (market(symbol) ? [200, ticker(market(symbol))] : unknown) : [200, MARKETS.map(ticker)];
  if (path === "/fapi/v3/premiumIndex") return symbol ? (market(symbol) ? [200, premium(market(symbol))] : unknown) : [200, MARKETS.map(premium)];
  if (path === "/fapi/v3/klines") return market(symbol) ? [200, klines(market(symbol), query.get("interval"), Number(query.get("limit") ?? 30))] : unknown;
  // What the market panel reads: the book, the tape, funding and open interest.
  if (PANEL.has(path)) return market(symbol) ? [200, panel(path, market(symbol))] : unknown;

  // Everything else belongs to the account and must be signed by the API wallet.
  if (!signedCorrectly(query)) {
    malformed.push(`${method} ${path}`);
    return [400, { code: -1022, msg: "Signature for this request is not valid." }];
  }
  const body = account(method, path, query);
  if (body === null) return [404, { code: -1, msg: "not served by the smoke test" }];
  if (method !== "GET") changes.push({ method, path, params: Object.fromEntries(query) });
  return [200, body];
}

const venue = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  seen.push(`${request.method} ${url.pathname}`);
  const [status, body] = answer(request.method, url);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => venue.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${venue.address().port}`;

/* ------------------------------------------------------- the stand-in model */

// A model server in the shape of LM Studio's, which the self-test connects the way a trader
// would: by its address. It answers a message by drafting a ticket, then by saying so.
const MODEL = "selftest/model";
/** Chat requests the app made, as parsed bodies. */
const chats = [];

function sse(response, chunks) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function chat(response, body) {
  chats.push(body);
  const usage = { prompt_tokens: 1200, completion_tokens: 30 };
  if (body.messages.at(-1)?.role === "tool") {
    sse(response, [
      { choices: [{ delta: { content: "The ticket is ready. This is testnet practice." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage },
    ]);
    return;
  }
  const order = { symbol: "BTC", action: "open_long", quantity: "0.01", stop_loss: "60000", rationale: "As asked; the idea is wrong below 60,000." };
  const call = { index: 0, id: "call_1", type: "function", function: { name: "propose_order", arguments: JSON.stringify(order) } };
  sse(response, [
    { choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
  ]);
}

const model = createServer((request, response) => {
  const { pathname: path } = new URL(request.url, "http://127.0.0.1");
  let raw = "";
  request.on("data", (piece) => (raw += piece));
  request.on("end", () => {
    if (request.method === "POST" && path === "/v1/chat/completions") return chat(response, JSON.parse(raw));
    const loaded = { id: MODEL, config: { context_length: 16384 } };
    const listing = { models: [{ type: "llm", key: MODEL, display_name: "Self-test model", max_context_length: 32768, capabilities: { trained_for_tool_use: true }, loaded_instances: [loaded] }] };
    const known = request.method === "GET" && path === "/api/v1/models";
    response.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(known ? listing : { error: "not served by the smoke test" }));
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

/* ------------------------------------------------------------------ the app */

const dataDir = mkdtempSync(join(tmpdir(), "octoneo-smoke-"));
const env = {
  ...process.env,
  OCTONEO_DATA_DIR: dataDir,
  // Secrets stay in memory: the test must not read a real key, or wait on the system asking whether it may.
  OCTONEO_NO_KEYCHAIN: "1",
  OCTONEO_MAINNET_URL: origin,
  OCTONEO_TESTNET_URL: origin,
  ...(e2e ? { OCTONEO_SELFTEST: "1", OCTONEO_SELFTEST_MODEL_URL: `http://127.0.0.1:${model.address().port}` } : {}),
};
const app = spawn(binary, [], { env, stdio: "inherit" });
let exited = null;
app.on("exit", (code) => (exited = code ?? 1));

const journal = join(dataDir, "journal.sqlite3");
// SQLite keeps text as UTF-8, so this is visible without a database driver.
const journaled = (needle) => existsSync(journal) && readFileSync(journal).includes(needle);
const entry = () => changes.find((change) => change.path === "/fapi/v3/order" && change.params.type === "MARKET");

const booted = () => seen.includes("GET /fapi/v3/exchangeInfo") && seen.includes("GET /fapi/v3/ticker/24hr");
const traded = () => {
  const order = entry();
  if (!order) return false;
  const { symbol, side, quantity, reduceOnly, newClientOrderId } = order.params;
  const shaped = symbol === "BTCUSDT" && side === "BUY" && quantity === "0.01" && !reduceOnly && /^[0-9a-f]{32}$/.test(newClientOrderId ?? "");
  if (!shaped) fail(`the order reached the exchange in the wrong shape: ${JSON.stringify(order.params)}`);
  // Isolated margin and 3x are the defaults of a new installation; they must be set before the order goes out.
  const prepared = changes.slice(0, changes.indexOf(order)).map((change) => change.path);
  if (!prepared.includes("/fapi/v3/marginType") || !prepared.includes("/fapi/v3/leverage")) {
    fail("the order went out before the margin mode and leverage were set");
  }
  // The ticket came from the model, which was given the desk and its tools, and may only draft.
  const first = chats[0];
  const offered = (first?.tools ?? []).map((tool) => tool.function?.name);
  if (!first || first.model !== MODEL || !offered.includes("propose_order") || offered.some((name) => /place|cancel|withdraw/.test(name))) {
    fail(`the model was not asked the way the assistant asks: ${JSON.stringify(offered)}`);
  }
  if (!String(first.messages.at(-1)?.content).includes("network: testnet")) fail("the model was not told which network the desk is on");
  // An order the assistant drafts carries a stop, placed right after the entry and unable to do more than close.
  const stop = changes.find((change) => change.path === "/fapi/v3/order" && change.params.type === "STOP_MARKET");
  if (!stop) return false;
  if (stop.params.side !== "SELL" || stop.params.stopPrice !== "60000" || stop.params.reduceOnly !== "true") {
    fail(`the stop reached the exchange in the wrong shape: ${JSON.stringify(stop.params)}`);
  }
  return chats.length >= 2 && journaled("Sent on testnet: buy 0.01 BTCUSDT") && journaled("The ticket is ready.");
};

let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  console.log(message);
  if (exited === null) app.kill();
  venue.close();
  model.close();
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(code);
  }, 500);
}
function fail(reason) {
  finish(1, `Smoke test failed: ${reason}.`);
}

const deadline = Date.now() + 60_000;
const timer = setInterval(() => {
  if (malformed.length > 0) {
    fail(`an account request was not signed the way the exchange requires (${malformed[0]})`);
  } else if (booted() && (!e2e || traded())) {
    const proof = e2e
      ? "connected a wallet and a model, and sent a signed market order with its stop from a ticket the model drafted and its own window confirmed"
      : "started, and its interface reached the core and read the markets";
    finish(0, `Smoke test passed: ${binary} ${proof}.`);
  } else if (exited !== null) {
    fail(`the app exited with code ${exited} before it was done`);
  } else if (Date.now() > deadline) {
    const stage = !booted()
      ? "the interface did not reach the core"
      : e2e && chats.length === 0
        ? "the message never reached the model"
        : !entry()
          ? "no order reached the exchange"
          : "the fill was not journaled";
    fail(`${stage} within 60 seconds`);
  }
}, 200);
