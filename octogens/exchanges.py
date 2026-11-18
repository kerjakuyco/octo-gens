"""Spot-only implementations for the bundled MCP servers. All sizes are base units."""

import base64
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

from .domain import DeskError, Ticket, decimal_text
from .instruments import VENUES, instrument
from .network import request_json


HOST = {"binance": "https://api.binance.com", "okx": "https://www.okx.com", "bybit": "https://api.bybit.com"}


class Venue:
    def __init__(self, venue, key="", secret="", passphrase="", fetch=request_json):
        if venue not in VENUES:
            raise DeskError("Unknown exchange.")
        self.id, self.key, self.secret, self.passphrase, self.fetch = venue, key, secret, passphrase, fetch
        if any((key, secret, passphrase)) and not (key and secret and (venue != "okx" or passphrase)):
            raise DeskError("Supply the key and secret together; OKX also requires its API passphrase.")

    def _request(self, path, params, *, private=False, post=False):
        params = dict(params)
        method = "POST" if post else "GET"
        query, body, headers = urlencode(params), None, {}
        if private:
            if not self.key:
                raise DeskError("Reconnect with exchange credentials to use account tools.")
            ms = str(time.time_ns() // 1_000_000)
            def digest(payload):
                return hmac.new(self.secret.encode(), payload.encode(), hashlib.sha256).digest()
            if self.id == "binance":
                query = urlencode({**params, "timestamp": ms, "recvWindow": "5000"})
                query += "&signature=" + digest(query).hex()
                headers = {"X-MBX-APIKEY": self.key}
            else:
                if post:
                    body = json.dumps(params, separators=(",", ":"))
                    query = ""
                if self.id == "okx":
                    ts = datetime.fromtimestamp(int(ms) / 1000, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    target = path + ("?" + query if query else "")
                    sig = base64.b64encode(digest(ts + method + target + (body or ""))).decode()
                    headers = {"OK-ACCESS-KEY": self.key, "OK-ACCESS-SIGN": sig, "OK-ACCESS-TIMESTAMP": ts,
                               "OK-ACCESS-PASSPHRASE": self.passphrase}
                else:
                    sig = digest(ms + self.key + "5000" + (body if post else query)).hex()
                    headers = {"X-BAPI-API-KEY": self.key, "X-BAPI-SIGN": sig, "X-BAPI-TIMESTAMP": ms,
                               "X-BAPI-RECV-WINDOW": "5000"}
        url = HOST[self.id] + path + ("?" + query if query else "")
        data = self.fetch(url, method=method, headers=headers, wire=body.encode() if body is not None else None)
        if self.id == "okx" and str(data.get("code")) != "0":
            details = data.get("data") or [{}]
            raise DeskError(f"OKX {data.get('code')}: {details[0].get('sMsg') or data.get('msg')}")
        if self.id == "bybit" and data.get("retCode") != 0:
            raise DeskError(f"Bybit {data.get('retCode')}: {data.get('retMsg')}")
        return data

    def listing(self, pair):
        i = instrument(pair)
        base = i.ticker.upper()
        code = i.pair.replace("/", "-" if self.id == "okx" else "")
        try:
            if self.id == "binance":
                rows = self._request("/api/v3/exchangeInfo", {"symbol": code})["symbols"]
                valid = any(r["symbol"] == code and r["baseAsset"] == base and r["quoteAsset"] == "USDT"
                            and r["status"] == "TRADING" and r.get("isSpotTradingAllowed") for r in rows)
            elif self.id == "okx":
                rows = self._request("/api/v5/public/instruments", {"instType": "SPOT", "instId": code})["data"]
                valid = any(r["instId"] == code and r["baseCcy"] == base and r["quoteCcy"] == "USDT"
                            and r["instType"] == "SPOT" and r["state"] == "live" for r in rows)
            else:
                data = self._request("/v5/market/instruments-info", {"category": "spot", "symbol": code})["result"]
                valid = data["category"] == "spot" and any(
                    r["symbol"] == code and r["baseCoin"] == base and r["quoteCoin"] == "USDT"
                    and r["status"] == "Trading" and (not i.underlying or r.get("symbolType", "").lower() == "xstocks")
                    for r in data["list"])
        except DeskError as exc:
            if "invalid symbol" in str(exc).lower() or "51001:" in str(exc):
                valid = False
            else:
                raise
        return {**i.view(), "venue": self.id, "market": "spot", "code": code, "listed": bool(valid)}

    def _listed(self, pair):
        listing = self.listing(pair)
        if not listing["listed"]:
            raise DeskError(f"No active spot listing for {listing['pair']} on {VENUES[self.id]}.")
        return listing

    def quote(self, pair):
        meta = self._listed(pair)
        code = meta["code"]
        if self.id == "bybit":
            params = {"category": "spot", "symbol": code}
            data = self._request("/v5/market/tickers", params)
            tick = next(r for r in data["result"]["list"] if r["symbol"] == code)
            price, stamp = tick["lastPrice"], data["time"]
            bars = self._request("/v5/market/kline", {**params, "interval": "D", "limit": 91})["result"]["list"]
        elif self.id == "binance":
            tick = self._request("/api/v3/ticker/24hr", {"symbol": code})
            if tick["symbol"] != code:
                raise DeskError("Ticker does not match the requested spot pair.")
            price, stamp = tick["lastPrice"], tick["closeTime"]
            bars = self._request("/api/v3/klines", {"symbol": code, "interval": "1d", "limit": 91})
        else:
            tick = self._request("/api/v5/market/ticker", {"instId": code})["data"][0]
            if tick["instId"] != code or tick["instType"] != "SPOT":
                raise DeskError("Ticker does not match the requested spot pair.")
            price, stamp = tick["last"], tick["ts"]
            bars = self._request("/api/v5/market/candles", {"instId": code, "bar": "1Dutc", "limit": 91})["data"]
        stamp = int(stamp)
        day = stamp // 86_400_000
        def positive(value):
            try:
                n = Decimal(str(value))
                if n.is_finite() and 0 < n < 10**12:
                    return str(n)
            except InvalidOperation:
                pass
            raise DeskError("The venue returned an invalid price.")
        closes = {int(b[0]): positive(b[4]) for b in bars if int(b[0]) // 86_400_000 < day}
        return {**meta, "price": positive(price), "as_of": datetime.fromtimestamp(stamp / 1000, UTC).isoformat(),
                "closes": [closes[t] for t in sorted(closes)[-90:]]}

    def balances(self):
        if self.id == "binance":
            rows = self._request("/api/v3/account", {"omitZeroBalances": "true"}, private=True)["balances"]
            return [{"asset": r["asset"], "total": str(Decimal(r["free"]) + Decimal(r["locked"]))} for r in rows]
        if self.id == "okx":
            rows = self._request("/api/v5/account/balance", {}, private=True)["data"][0]["details"]
            return [{"asset": r["ccy"], "total": r["cashBal"]} for r in rows]
        rows = self._request("/v5/account/wallet-balance", {"accountType": "UNIFIED"}, private=True)["result"]["list"]
        return [{"asset": r["coin"], "total": r["walletBalance"]} for account in rows for r in account["coin"]]

    def order(self, pair, side, quantity, client_id):
        import re
        ticket = Ticket.parse(instrument(pair).pair, side, quantity)
        if not re.fullmatch(r"[0-9a-f]{32}", client_id):
            raise DeskError("Invalid client order ID.")
        code = self._listed(ticket.symbol)["code"]
        qty = decimal_text(ticket.qty)
        if self.id == "binance":
            r = self._request("/api/v3/order", {"symbol": code, "side": ticket.side.upper(), "type": "MARKET",
                              "quantity": qty, "newClientOrderId": client_id}, private=True, post=True)
            oid, status = r["orderId"], r.get("status", "acknowledged")
        elif self.id == "okx":
            r = self._request("/api/v5/trade/order", {"instId": code, "tdMode": "cash", "side": ticket.side,
                              "ordType": "market", "tgtCcy": "base_ccy", "sz": qty,
                              "clOrdId": client_id}, private=True, post=True)["data"][0]
            if r["sCode"] != "0":
                raise DeskError(r.get("sMsg") or "Order rejected by OKX.")
            oid, status = r["ordId"], "acknowledged"
        else:
            r = self._request("/v5/order/create", {"category": "spot", "symbol": code, "side": ticket.side.title(),
                              "orderType": "Market", "marketUnit": "baseCoin", "isLeverage": 0, "qty": qty,
                              "orderLinkId": client_id}, private=True, post=True)["result"]
            oid, status = r["orderId"], "acknowledged"
        return {"venue": self.id, "pair": ticket.symbol, "side": side, "quantity": qty, "id": str(oid),
                "status": status, "client_id": client_id}
