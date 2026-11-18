"""A local pattern-following agent that trades one symbol in a practice book."""

from dataclasses import dataclass, replace
from decimal import Decimal, ROUND_DOWN
import re
from statistics import mean

from .agents import pattern_outcomes
from .domain import DeskError, Order, Quote, Ticket, decimal_text, price_text
from .market import check_paper_price


def trade_budget(raw, currency="USD"):
    value = raw.strip()
    if not re.fullmatch(r"[0-9]{1,9}(?:\.[0-9]{1,2})?", value) or Decimal(value) <= 0:
        raise DeskError(f"Enter a positive maximum trade value in {currency}, with up to two decimal places.")
    return Decimal(value)


@dataclass(frozen=True)
class Decision:
    text: str
    quote: Quote
    order: Order | None = None


def run_pattern(desk, asset, budget):
    if desk.mode.broker:
        raise DeskError("The pattern agent runs in the two local practice workspaces.")
    currency = getattr(desk, "currency", "USD")
    cap = trade_budget(budget, currency)
    q = desk.quote(asset, refresh=True)
    check_paper_price(q)
    def price(value):
        return price_text(value) if currency == "USD" else f"{value:,.2f} {currency}"
    reading = f"{q.symbol} · {price(q.price)} · {q.source} · {q.stamp}"
    # One simulated fill per symbol/quote date across runs and app restarts.
    key = f"pattern-v1:{q.symbol}:{q.as_of.date()}"
    if prior := desk.book.order_by_id(key):
        return Decision(f"Already traded this quote date: {prior.side} {prior.quantity} {q.symbol}.\n{reading}",
                        q, prior)
    outcomes = pattern_outcomes(q.closes)
    if not outcomes:
        return Decision(f"Hold: too little completed price history to compare patterns.\n{reading}", q)
    up, down = sum(v > 0 for v in outcomes), sum(v < 0 for v in outcomes)
    evidence = f"{up}/5 past matches rose, {down}/5 fell; mean next-session move {mean(outcomes):+.2f}%."
    if up >= 4 and mean(outcomes) > 0:
        side = "buy"
    elif down >= 4 and mean(outcomes) < 0:
        side = "sell"
    else:
        return Decision(f"Hold: the historical matches do not agree strongly enough.\n{evidence}\n{reading}", q)

    account = desk.account()
    available = min(cap, account.cash) if side == "buy" else cap
    qty = (available / q.price).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    if side == "sell":
        held = next((h.qty for h in account.holdings if h.symbol == q.symbol), Decimal(0))
        qty = min(held, qty)
    if qty * q.price < Decimal(".01"):
        reason = "insufficient paper cash" if side == "buy" else "no sellable holding within the trade limit"
        return Decision(f"Hold: {reason}.\n{evidence}\n{reading}", q)
    ticket = replace(Ticket.parse(q.symbol, side, decimal_text(qty)), client_id=key)
    order = desk.book.submit(ticket, q)
    return Decision(f"Paper fill: {order.side} {order.quantity} {order.symbol} at {price(order.price)}."
                    f"\n{evidence}\n{reading}", q, order)
