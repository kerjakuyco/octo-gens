from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal as D
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from octogens.desk import Desk
from octogens.domain import DeskError, Workspace
from octogens.market import sample_quote
from octogens.strategy import run_pattern


class PatternAgentTests(unittest.TestCase):
    def test_bounded_buy_then_restart_then_sell_on_new_signal(self):
        with TemporaryDirectory() as folder:
            directory = Path(folder)
            market = Mock()
            desk = Desk(Workspace.MARKET, directory, market)
            q = replace(sample_quote("AAPL"), price=D(100), sample=False, as_of=datetime.now(UTC) - timedelta(days=1),
                        closes=tuple(D(i) for i in range(100, 164)))
            market.quote.return_value = q
            bought = run_pattern(desk, "AAPL", "250")
            self.assertEqual((bought.order.side, bought.order.quantity), ("buy", "2.5"))
            self.assertEqual(desk.account().cash, D(99750))
            restarted = Desk(Workspace.MARKET, directory, market)
            again = run_pattern(restarted, "AAPL", "500")
            self.assertEqual(again.order.id, bought.order.id)
            self.assertEqual(len(restarted.account().orders), 1)
            market.quote.return_value = replace(q, price=D(110), as_of=q.as_of + timedelta(days=1),
                                                closes=tuple(reversed(q.closes)))
            sold = run_pattern(restarted, "AAPL", "1000")
            self.assertEqual((sold.order.side, sold.order.quantity), ("sell", "2.5"))
            self.assertEqual(restarted.account().cash, D(100025))
            self.assertFalse(restarted.account().holdings)

    def test_flat_history_holds_and_broker_modes_never_call_any_tools(self):
        with TemporaryDirectory() as folder:
            market = Mock()
            market.quote.return_value = replace(sample_quote("AAPL"), closes=(D(100),) * 30)
            desk = Desk(Workspace.DEMO, Path(folder), market)
            decision = run_pattern(desk, "AAPL", "100")
            self.assertIn("Hold", decision.text)
            self.assertIsNone(decision.order)
            self.assertFalse(desk.account().orders)
        for mode in (Workspace.BROKER_PAPER, Workspace.BROKER_LIVE):
            broker_desk = Mock(mode=mode)
            with self.assertRaises(DeskError):
                run_pattern(broker_desk, "AAPL", "100")
            self.assertFalse(broker_desk.method_calls)
