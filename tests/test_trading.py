from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal as D
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from octogens.broker import Alpaca
from octogens.desk import Desk
from octogens.domain import DeskError, Ticket, Workspace
from octogens.market import Market, sample_quote
from octogens.paper import PaperBook


class PaperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "paper.sqlite3"
        self.book = PaperBook(self.path, Workspace.DEMO)
        self.quote = sample_quote("AAPL")

    def test_partial_sale_persists_cash_basis_and_mark_without_double_fill(self):
        def fill(side, qty, price):
            t = Ticket.parse("AAPL", side, qty)
            q = replace(self.quote, price=D(price))
            return t, q, self.book.submit(t, q)

        fill("buy", "2", "100")
        fill("buy", "1", "160")
        ticket, quote, receipt = fill("sell", "1", "150")
        reopened = PaperBook(self.path, Workspace.DEMO)
        self.assertEqual(reopened.submit(ticket, quote), receipt)
        account = reopened.snapshot()
        self.assertEqual((account.cash, account.equity), (D("99790"), D("100090")))
        self.assertEqual((account.holdings[0].qty, account.holdings[0].cost), (D(2), D(240)))
        self.assertEqual(len(account.orders), 3)
        fill("sell", "2", "140")
        self.assertEqual(reopened.snapshot().equity, D("100070"))
        self.assertFalse(reopened.snapshot().holdings)

    def test_rejected_orders_do_not_mutate_account(self):
        before = self.book.snapshot()
        for side, qty in (("sell", "0.1"), ("buy", "500"), ("buy", ".00000001")):
            with self.subTest(side=side, qty=qty), self.assertRaises(DeskError):
                self.book.submit(Ticket.parse("AAPL", side, qty), self.quote)
        self.assertEqual(self.book.snapshot(), before)

    def test_concurrent_orders_cannot_both_spend_the_same_cash(self):
        q = sample_quote("BTC/USD")
        def buy(_):
            try:
                self.book.submit(Ticket.parse("BTC", "buy", "1"), q)
                return True
            except DeskError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(buy, range(2))), 1)
        self.assertEqual(self.book.snapshot().cash, D("15784.50"))

    def test_separate_books_and_stale_market_price(self):
        ticket = Ticket.parse("BTC", "buy", ".001")
        q = sample_quote("BTC/USD")
        self.book.submit(ticket, q)
        market = PaperBook(self.path, Workspace.MARKET)
        for wrong in (q, replace(q, sample=False, as_of=datetime.now(UTC) - timedelta(hours=1))):
            with self.assertRaises(DeskError):
                market.submit(ticket, wrong)
        self.assertEqual(market.snapshot().cash, D(100000))
        self.assertFalse(market.snapshot().orders)
        self.assertEqual(self.book.snapshot().cash, D("99915.78"))

    def test_market_outage_never_generates_a_sample_fill(self):
        def down(url):
            raise DeskError("Feed down")
        desk = Desk(Workspace.MARKET, self.path.parent, Market(down))
        with self.assertRaisesRegex(DeskError, "Feed down"):
            desk.submit(Ticket.parse("AAPL", "buy", "1"))
        self.assertFalse(desk.account().orders)

    def test_quantities_are_finite_positive_units(self):
        for qty in ("NaN", "Infinity", "-1", "0", "1e4", ".000000001", "1,500"):
            with self.subTest(qty=qty), self.assertRaises(DeskError):
                Ticket.parse("BTC", "buy", qty)


class BrokerTests(unittest.TestCase):
    def test_routes_orders_by_account_and_instrument_and_preserves_pending_status(self):
        for mode, host, asset, tif in [
            (Workspace.BROKER_PAPER, "paper-api.alpaca.markets", "ETH/USD", "gtc"),
            (Workspace.BROKER_LIVE, "api.alpaca.markets", "AAPL", "day"),
        ]:
            with self.subTest(mode=mode):
                calls = []
                def transport(url, *, headers, body):
                    calls.append((url, headers, body))
                    return {**body, "id": "broker-id", "filled_qty": "0", "filled_avg_price": None,
                            "status": "accepted", "submitted_at": "2026-01-01T00:00:00Z"}
                broker = Alpaca(mode, "mock-id", "mock-secret", transport)
                ticket = Ticket.parse(asset, "buy", ".25")
                order = broker.submit(ticket)
                url, headers, body = calls[0]
                self.assertEqual(url, f"https://{host}/v2/orders")
                self.assertEqual(headers["APCA-API-SECRET-KEY"], "mock-secret")
                self.assertEqual((body["symbol"], body["qty"], body["time_in_force"],
                                  body["client_order_id"]), (asset, "0.25", tif, ticket.client_id))
                self.assertEqual((order.status, order.filled, order.price), ("accepted", "0", None))

    def test_live_connection_cannot_be_used_in_paper_workspace(self):
        broker = Alpaca(Workspace.BROKER_LIVE, "mock", "mock", lambda *_: self.fail("Network access"))
        with self.assertRaises(DeskError):
            Desk(Workspace.BROKER_PAPER, Path("."), broker=broker)
