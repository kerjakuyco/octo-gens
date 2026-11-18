from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from math import sin
from random import Random
from threading import Lock
from time import monotonic
from urllib.parse import quote as urlquote

from .domain import DeskError, Quote, SAMPLES, cents, symbol
from .network import request_json


def _price(raw):
    value = Decimal(str(raw))
    if not value.is_finite() or value <= 0 or value >= 10**12:
        raise ValueError("Invalid price")
    return value


def sample_quote(asset, anchor=None):
    if anchor is None and asset not in SAMPLES:
        raise DeskError(f"No sample for {asset}. Choose a listed symbol or switch to market prices.")
    anchor = Decimal(SAMPLES[asset][1] if anchor is None else anchor)
    rng = Random(asset)
    # Reproducible, fictional daily prices; never pass them off as market quotes.
    levels = [1.0]
    for i in range(64):
        levels.append(levels[-1] * (1 + rng.uniform(-0.025, 0.026) + 0.004 * sin(i / 3)))
    closes = tuple(cents(anchor * Decimal(str(level / levels[-1]))) for level in levels[:-1])
    return Quote(asset, anchor, datetime(2025, 3, 7, 21, tzinfo=UTC), "Sample feed", closes, True)


class Market:
    def __init__(self, fetch=request_json):
        self.fetch = fetch
        self._cache = {}
        self._lock = Lock()

    def quote(self, raw, *, sample=False, refresh=False):
        asset = symbol(raw)
        if sample:
            return sample_quote(asset)
        with self._lock:
            cached = self._cache.get(asset)
            if cached and not refresh and monotonic() - cached[0] < 60:
                return cached[1]
        try:
            result = self._crypto(asset) if "/" in asset else self._stock(asset)
        except (ValueError, InvalidOperation, KeyError, IndexError, TypeError, OverflowError, OSError):
            raise DeskError(f"No usable USD market data for {asset}. Check the symbol and try again.") from None
        with self._lock:
            self._cache[asset] = (monotonic(), result)
        return result

    def _stock(self, asset):
        provider_symbol = asset.removeprefix("$").replace(".", "-")
        data = self.fetch("https://query1.finance.yahoo.com/v8/finance/chart/"
                          f"{urlquote(provider_symbol)}?range=3mo&interval=1d")
        chart = data["chart"]["result"][0]
        meta = chart["meta"]
        if (meta["symbol"].upper() != provider_symbol or meta["currency"] != "USD"
                or meta["instrumentType"] not in ("EQUITY", "ETF")):
            raise DeskError(f"{asset} is not a supported USD stock or ETF.")
        stamp = datetime.fromtimestamp(meta["regularMarketTime"], UTC)
        bars = zip(chart.get("timestamp", []), chart["indicators"]["quote"][0].get("close", []))
        closes = tuple(_price(v) for t, v in bars if v is not None
                       and datetime.fromtimestamp(t, UTC).date() < stamp.date())
        return Quote(asset, _price(meta["regularMarketPrice"]), stamp, "Yahoo Finance", closes)

    def _crypto(self, asset):
        url = "https://api.exchange.coinbase.com/products/" + asset.replace("/", "-")
        candles = self.fetch(url + "/candles?granularity=86400")
        tick = self.fetch(url + "/ticker")
        stamp = datetime.fromisoformat(tick["time"].replace("Z", "+00:00")).astimezone(UTC)
        bars = {c[0]: _price(c[4]) for c in candles
                if datetime.fromtimestamp(c[0], UTC).date() < stamp.date()}
        return Quote(asset, _price(tick["price"]), stamp, "Coinbase Exchange",
                     tuple(bars[t] for t in sorted(bars)[-90:]))


def check_paper_price(q: Quote, now=None):
    if q.sample:
        return
    age = (now or datetime.now(UTC)) - q.as_of
    # Allow normal stock weekends/holidays. Crypto trades around the clock.
    maximum = timedelta(minutes=15) if "/" in q.symbol else timedelta(days=5)
    if age > maximum or age < -timedelta(minutes=5):
        raise DeskError(f"The {q.symbol} quote is dated {q.stamp}; it cannot fill a paper order.")
