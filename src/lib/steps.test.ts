import { describe, expect, it } from "vitest";
import type { StepView } from "../api/types";
import { activityNow, activitySummary, listWords, stepLabel } from "./steps";

function step(name: string, detail = "", status: StepView["status"] = "ok"): StepView {
  return { name, detail, status, ms: 100, preview: "" };
}

describe("listWords", () => {
  it("joins like a sentence", () => {
    expect(listWords([])).toBe("");
    expect(listWords(["a"])).toBe("a");
    expect(listWords(["a", "b"])).toBe("a and b");
    expect(listWords(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("stepLabel", () => {
  it("puts the core's step names in plain words", () => {
    expect(stepLabel("get_quote")).toBe("Price");
    expect(stepLabel("get_movers")).toBe("Movers");
    expect(stepLabel("load_model")).toBe("Load model");
    expect(stepLabel("exchange.order")).toBe("Order");
    expect(stepLabel("exchange.stop_loss")).toBe("Stop-loss");
    expect(stepLabel("search_news")).toBe("News");
    expect(stepLabel("read_page")).toBe("Article");
  });

  it("keeps the words of a step it does not know", () => {
    expect(stepLabel("get_open_interest")).toBe("Open interest");
    expect(stepLabel("notes.search_headlines")).toBe("Notes search headlines");
    expect(stepLabel("")).toBe("");
  });
});

describe("activitySummary", () => {
  it("names what was checked, once each, and leaves the model rounds out", () => {
    const steps = [
      step("model", "Lantern 2 Large, round 1"),
      step("get_quote", "BTCUSDT"),
      step("analyze_market", "BTCUSDT 4h"),
      step("analyze_market", "ETHUSDT 4h"),
      step("get_order_book", "BTCUSDT"),
      step("model", "Lantern 2 Large, round 2"),
    ];
    expect(activitySummary(steps)).toBe("Checked BTC price, 4h chart and order book");
  });

  it("reads several markets, bare tickers and symbols that are not ASCII", () => {
    expect(activitySummary([step("get_quote", "BTCUSDT, ETHUSDT")])).toBe("Checked BTC and ETH prices");
    expect(activitySummary([step("get_quote", "btc")])).toBe("Checked BTC price");
    expect(activitySummary([step("get_quote", "币安人生USDT")])).toBe("Checked 币安人生 price");
    expect(activitySummary([step("get_quote", "XAUUSD1")])).toBe("Checked XAU price");
    expect(activitySummary([step("get_quote", "")])).toBe("Checked prices");
  });

  it("counts what does not fit and mentions a drafted ticket", () => {
    const steps = [
      step("get_quote", "ETHUSDT"),
      step("analyze_market", "ETHUSDT 4h"),
      step("get_account"),
      step("plan_position", "ETHUSDT"),
      step("propose_order", "open_long 2.1 ETHUSDT"),
    ];
    expect(activitySummary(steps)).toBe("Checked ETH price, 4h chart, account and 1 more, drafted a ticket");
    expect(activitySummary([step("propose_order", "close ETHUSDT")])).toBe("Drafted a ticket");
    expect(activitySummary([step("propose_order", "open_long 1 BTCUSDT", "error")])).toBe("");
  });

  it("has words for the whole-exchange scan and for tools it has not met", () => {
    expect(activitySummary([step("get_movers")])).toBe("Checked movers");
    expect(activitySummary([step("scan_watchlist")])).toBe("Checked watchlist");
    expect(activitySummary([step("get_open_interest", "BTCUSDT")])).toBe("Checked open interest");
    expect(activitySummary([step("call_server_tool", "news search")])).toBe("Checked tools");
    expect(activitySummary([step("load_model", "Reef 8B Instruct"), step("model", "Reef 8B Instruct, round 1")])).toBe("");
    expect(activitySummary([])).toBe("");
  });
});

describe("activityNow", () => {
  it("follows the running step", () => {
    expect(activityNow([])).toBe("Thinking");
    expect(activityNow([step("model", "Lantern 2 Large, round 1", "running")])).toBe("Thinking");
    expect(activityNow([step("load_model", "Reef 8B Instruct", "running")])).toBe("Loading the model");
    expect(activityNow([step("get_quote", "BTCUSDT", "running")])).toBe("Checking BTC price");
    expect(activityNow([step("get_quote", "BTCUSDT"), step("propose_order", "open_long", "running")])).toBe("Drafting a ticket");
    expect(activityNow([step("get_quote", "BTCUSDT")])).toBe("Thinking");
  });
});

describe("news", () => {
  it("says the news was read, and what is being read now", () => {
    const steps = [
      step("model", "Lantern 2 Large, round 1"),
      step("get_quote", "BTCUSDT"),
      step("search_news", "BTC"),
      step("read_page", "tidewire.example"),
      step("read_page", "kelpdesk.example"),
    ];
    expect(activitySummary(steps)).toBe("Checked BTC price, the news and an article");
    expect(activityNow([step("search_news", "BTC", "running")])).toBe("Reading the news");
    expect(activityNow([step("read_page", "tidewire.example", "running")])).toBe("Reading an article");
  });
});
