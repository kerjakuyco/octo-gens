from datetime import UTC, datetime
from decimal import Decimal as D
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from octogens.agents import ollama_explain, pattern_outcomes, respond
from octogens.desk import Desk
from octogens.domain import DeskError, Ticket, Workspace
from octogens.market import Market


class ResearchTests(unittest.TestCase):
    def test_overlapping_equity_and_crypto_tickers_remain_distinct(self):
        calls = []
        def feed(url):
            calls.append(url)
            return {"chart": {"result": [{"meta": {"regularMarketTime": 1770000000, "regularMarketPrice": 51,
                    "instrumentType": "ETF", "symbol": "BTC", "currency": "USD"}, "indicators": {"quote": [{}]}}]}}
        equity = Ticket.parse("$BTC", "buy", "1")
        self.assertEqual(Market(feed).quote(equity.symbol).symbol, "$BTC")
        self.assertIn("/chart/BTC?", calls[0])
        self.assertEqual(Ticket.parse("BTC", "buy", "1").symbol, "BTC/USD")

    def test_market_sources_ignore_in_progress_daily_candle_and_missing_closes(self):
        day = int(datetime(2026, 2, 3, tzinfo=UTC).timestamp())
        def feed(url):
            if "finance.yahoo.com" in url:
                return {"chart": {"result": [{
                    "meta": {"regularMarketTime": day + 100, "regularMarketPrice": 111,
                             "instrumentType": "EQUITY", "symbol": "AAPL", "currency": "USD"},
                    "timestamp": [day - 2*86400, day - 86400, day],
                    "indicators": {"quote": [{"close": [100, None, 110]}]},
                }]}}
            if "/candles" in url:
                return [[day, 0, 0, 0, 204], [day - 86400, 0, 0, 0, 201], [day - 2*86400, 0, 0, 0, 200]]
            return {"time": "2026-02-03T12:00:00Z", "price": "205.002"}
        market = Market(feed)
        stock, coin = market.quote("AAPL"), market.quote("BTC-USD")
        self.assertEqual((stock.price, stock.closes, stock.sample), (111, (100,), False))
        self.assertEqual((coin.price, coin.closes), (D("205.002"), (200, 201)))

    def test_pattern_model_does_not_train_on_the_query_outcome(self):
        closes = [D(100)] * 13 + [D(200), D(400), D(800)]
        self.assertEqual(pattern_outcomes(closes), (0, 0, 0, 0, 0))
        self.assertEqual(pattern_outcomes(closes[:4]), ())

    def test_offline_conversation_can_compare_and_draft_without_changing_account(self):
        with TemporaryDirectory() as folder:
            desk = Desk(Workspace.DEMO, Path(folder), Market(lambda *_: self.fail("Unexpected network call")))
            reply = respond("Compare Bitcoin and ETH", "AAPL", desk)
            self.assertEqual([q.symbol for q in reply.quotes], ["BTC/USD", "ETH/USD"])
            self.assertIn("Sample feed", reply.text)
            self.assertIn("closest historical patterns", reply.text)
            self.assertIn("highest first", reply.text)
            draft = respond("Buy 0.01 BTC", "AAPL", desk).ticket
            self.assertEqual((draft.symbol, draft.qty), ("BTC/USD", D(".01")))
            self.assertFalse(desk.account().orders)
            self.assertIsNone(respond("Don't buy 1 BTC", "AAPL", desk).ticket)
            desk.submit(draft)
            self.assertIn("Largest exposure: BTC/USD", respond("my portfolio", "AAPL", desk).text)

    def test_ollama_gets_grounded_readings_and_has_no_execution_tool(self):
        def local(url, *, body, **kwargs):
            self.assertTrue(url.startswith("http://127.0.0.1:11434/api/"))
            if url.endswith("/show"):
                return {"model_info": {"family": "mock"}}
            self.assertIn("Sample feed: $100", body["messages"][-1]["content"])
            self.assertIn("Compare them", body["messages"][-1]["content"])
            self.assertNotIn("tools", body)
            return {"message": {"content": "Explanation"}}
        self.assertEqual(ollama_explain("test:1b", "Compare them", "Sample feed: $100", (), local), "Explanation")
        with self.assertRaisesRegex(DeskError, "locally installed"):
            ollama_explain("remote", "test", "", (), lambda *a, **kw: {"remote_host": "remote"})
