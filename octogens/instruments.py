"""The trading universe is spot tokens, denominated in USDT. No equity fallback."""

from dataclasses import dataclass
import re

from .domain import DeskError


@dataclass(frozen=True)
class Instrument:
    ticker: str
    name: str
    sample: str
    underlying: str = ""

    @property
    def pair(self):
        return self.ticker.upper() + "/USDT"

    @property
    def kind(self):
        return "Tokenized stock" if self.underlying else "Crypto"

    def view(self):
        return {"pair": self.pair, "ticker": self.ticker, "name": self.name, "kind": self.kind,
                "underlying": self.underlying, "family": "xStocks" if self.underlying else "Native asset"}


UNIVERSE = {i.pair: i for i in (
    Instrument("TSLAx", "Tesla xStock", "324.70", "TSLA"),
    Instrument("AAPLx", "Apple xStock", "219.38", "AAPL"),
    Instrument("NVDAx", "NVIDIA xStock", "144.58", "NVDA"),
    Instrument("SPYx", "SPDR S&P 500 ETF xStock", "587.16", "SPY"),
    Instrument("BTC", "Bitcoin", "84215.50"),
    Instrument("ETH", "Ethereum", "2145.72"),
    Instrument("SOL", "Solana", "142.08"),
)}
VENUES = {"bybit": "Bybit", "binance": "Binance", "okx": "OKX"}
DEFAULT_PAIR = "TSLAX/USDT"


def instrument(raw):
    text = str(raw).strip().upper().removeprefix("$").replace("-", "/")
    for data in UNIVERSE.values():
        if text in (data.pair, data.ticker.upper(), data.pair.replace("/", ""), data.name.upper()):
            return data
        if data.underlying and text in (data.underlying, data.underlying + "/USDT"):
            raise DeskError(f"{data.underlying} is the underlying. Select {data.ticker}/USDT for its xStock token.")
    raise DeskError(f"Unknown spot instrument: {raw}. Choose a listed token/USDT pair.")


def in_prompt(text):
    result = []
    for word in re.findall(r"\$?[A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)?", text):
        base = word.upper().lstrip("$").split("/")[0].split("-")[0]
        if any(base in (i.ticker.upper(), i.underlying, i.pair.replace("/", "")) for i in UNIVERSE.values()):
            pair = instrument(word).pair
            if pair not in result:
                result.append(pair)
    return result
