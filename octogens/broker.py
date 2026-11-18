"""Adapter for Alpaca Trading API v2. Credentials are scoped to one connection."""

from decimal import Decimal

from .domain import Account, DeskError, Holding, Order, Ticket, Workspace, decimal_text
from .network import request_json


class Alpaca:
    HOSTS = {
        Workspace.BROKER_PAPER: "https://paper-api.alpaca.markets/v2",
        Workspace.BROKER_LIVE: "https://api.alpaca.markets/v2",
    }

    def __init__(self, mode, key, secret, fetch=request_json):
        self.host = self.HOSTS[mode]
        if not key.strip() or not secret.strip():
            raise DeskError("Enter both the Alpaca key ID and secret for this account.")
        self._headers = {"APCA-API-KEY-ID": key.strip(), "APCA-API-SECRET-KEY": secret.strip()}
        self.fetch = fetch

    def _request(self, path, **kwargs):
        return self.fetch(self.host + path, headers=self._headers, **kwargs)

    def account_info(self):
        account = self._request("/account")
        if account.get("currency") != "USD":
            raise DeskError("This desk supports USD brokerage accounts.")
        return account

    @staticmethod
    def _order(row):
        return Order(row["id"], row["symbol"], row["side"],
                     row.get("qty") or f"${row.get('notional', '?')}", row.get("filled_qty") or "0",
                     Decimal(row["filled_avg_price"]) if row.get("filled_avg_price") else None,
                     row["status"], row.get("submitted_at") or row.get("created_at") or "")

    def snapshot(self):
        account = self.account_info()
        holdings = tuple(Holding(p["symbol"], Decimal(p["qty"]), Decimal(p["market_value"]),
                                 Decimal(p["cost_basis"])) for p in self._request("/positions"))
        orders = tuple(self._order(o) for o in self._request("/orders?status=all&limit=50&direction=desc"))
        return Account(Decimal(account["cash"]), Decimal(account["equity"]), holdings, orders)

    def submit(self, ticket: Ticket):
        order = self._request("/orders", body={
            "symbol": ticket.symbol.removeprefix("$"), "side": ticket.side, "qty": decimal_text(ticket.qty),
            "type": "market", "time_in_force": "gtc" if "/" in ticket.symbol else "day",
            "client_order_id": ticket.client_id,
        })
        return self._order(order)
