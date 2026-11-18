from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from enum import StrEnum
import re
from uuid import uuid4


class DeskError(Exception):
    """An actionable error that can be displayed in the desktop app."""


class Workspace(StrEnum):
    DEMO = "Practice · sample prices"
    MARKET = "Practice · market prices"
    BROKER_PAPER = "Alpaca · paper account"
    BROKER_LIVE = "Alpaca · live account"

    @property
    def broker(self):
        return self in (Workspace.BROKER_PAPER, Workspace.BROKER_LIVE)


# Familiar crypto names are aliases; an explicit $ticker always denotes equity.
SAMPLES = {
    "AAPL": ("Apple", "216.40"),
    "MSFT": ("Microsoft", "424.56"),
    "NVDA": ("Nvidia", "127.84"),
    "SPY": ("SPDR S&P 500 ETF", "574.62"),
    "BTC/USD": ("Bitcoin", "84215.50"),
    "ETH/USD": ("Ethereum", "2145.72"),
    "SOL/USD": ("Solana", "142.08"),
}
ALIASES = {name.upper(): s for s, (name, _) in SAMPLES.items()}
ALIASES.update({s.split("/")[0]: s for s in SAMPLES if "/" in s})


def symbol(raw: str) -> str:
    value = raw.strip().upper()
    if value.startswith("$"):
        value = value[1:]
        if value in ALIASES and re.fullmatch(r"[A-Z]{1,6}", value):
            return "$" + value  # Keep the equity qualifier across internal lookups.
    else:
        value = ALIASES.get(value, value.replace("-USD", "/USD"))
    if not re.fullmatch(r"[A-Z]{1,6}(?:[.][A-Z]{1,2})?|[A-Z0-9]{1,12}/USDT?", value):
        raise DeskError("Enter a stock ticker such as AAPL or a USD crypto pair such as BTC/USD.")
    return value


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


CENT = Decimal("0.01")


def cents(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def usd(value: Decimal) -> str:
    return f"${value:,.2f}"


def price_text(value: Decimal) -> str:
    return usd(value) if abs(value) >= 1 else f"${decimal_text(value)}"


@dataclass(frozen=True)
class Quote:
    symbol: str
    price: Decimal
    as_of: datetime
    source: str
    # Completed daily observations strictly before the UTC date of the quote.
    closes: tuple[Decimal, ...]
    sample: bool = False

    @property
    def stamp(self):
        return self.as_of.strftime("%Y-%m-%d %H:%M UTC")


@dataclass(frozen=True)
class Ticket:
    symbol: str
    side: str
    qty: Decimal
    client_id: str = field(default_factory=lambda: uuid4().hex)

    def __post_init__(self):
        object.__setattr__(self, "symbol", symbol(self.symbol))
        if self.side not in ("buy", "sell"):
            raise DeskError("Choose Buy or Sell.")
        if (not isinstance(self.qty, Decimal) or not self.qty.is_finite()
                or not 0 < self.qty < 10**9 or self.qty.as_tuple().exponent < -8):
            raise DeskError("Quantity must be positive with up to eight decimal places.")

    @classmethod
    def parse(cls, asset: str, side: str, raw_qty: str):
        raw_qty = raw_qty.strip()
        if not re.fullmatch(r"(?:[0-9]{1,9}(?:\.[0-9]{1,8})?|\.[0-9]{1,8})", raw_qty):
            raise DeskError("Enter a positive quantity with up to eight decimal places.")
        return cls(asset, side.strip().lower(), Decimal(raw_qty))


@dataclass(frozen=True)
class Holding:
    symbol: str
    qty: Decimal
    value: Decimal
    cost: Decimal


@dataclass(frozen=True)
class Order:
    id: str
    symbol: str
    side: str
    quantity: str
    filled: str
    price: Decimal | None
    status: str
    submitted: str


@dataclass(frozen=True)
class Account:
    cash: Decimal
    equity: Decimal
    holdings: tuple[Holding, ...]
    orders: tuple[Order, ...]
