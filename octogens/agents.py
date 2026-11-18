"""On-device research, portfolio and order-drafting tools for the assistant."""

from dataclasses import dataclass
import re
from statistics import mean

from .domain import ALIASES, SAMPLES, Account, DeskError, Quote, Ticket, decimal_text, price_text, symbol, usd
from .providers import ollama_explain


HELP = ("Ask “Analyze AAPL”, “Compare BTC and ETH”, or “Review my portfolio”. "
        "To prepare a market order, say “Buy 0.01 BTC” or “Sell 2 AAPL”. "
        "Use $TICKER for other stocks and BASE/USD for crypto.")


def pct(a, b):
    return (a / b - 1) * 100


def pattern_outcomes(closes):
    """Next-day returns of the five nearest earlier three-return patterns.

    The training pattern *and its outcome* must precede the query window.
    """
    if len(closes) < 16:
        return ()
    returns = [float(pct(b, a)) for a, b in zip(closes, closes[1:])]
    query = returns[-3:]
    ranked = []
    for i in range(len(returns) - 6):
        distance = sum((a - b) ** 2 for a, b in zip(returns[i:i + 3], query))
        ranked.append((distance, i, returns[i + 3]))
    return tuple(outcome for _, _, outcome in sorted(ranked)[:5])


def market_report(q: Quote):
    lines = [f"{q.symbol}  ·  {price_text(q.price)}",
             f"{q.source}  |  {q.stamp}"]
    if q.closes:
        lines.append(f"Since the previous close: {pct(q.price, q.closes[-1]):+.2f}%.")
    if len(q.closes) >= 5:
        lines.append(f"Change from five sessions ago: {pct(q.price, q.closes[-5]):+.2f}%.")
    if len(q.closes) >= 20:
        avg = sum(q.closes[-20:]) / 20
        lines.append(f"20-session average: {price_text(avg)} ({pct(q.price, avg):+.2f}% from average).")
    outcomes = pattern_outcomes(q.closes)
    if outcomes:
        lines.append(f"Local pattern model: {sum(v > 0 for v in outcomes)} of the 5 closest "
                     f"historical patterns rose the following session; mean move {mean(outcomes):+.2f}%.")
    else:
        lines.append("Too few completed sessions for a pattern comparison.")
    return "\n".join(lines)


def account_report(a: Account):
    lines = [f"Equity: {usd(a.equity)}   ·   Cash: {usd(a.cash)}"]
    if not a.holdings:
        return "\n".join([*lines, "There are no open positions."])
    ranked = sorted(a.holdings, key=lambda h: abs(h.value), reverse=True)
    lines.append(f"{len(ranked)} open position(s); unrealized P/L: "
                 f"{usd(sum(h.value - h.cost for h in ranked))}.")
    largest = ranked[0]
    if a.equity > 0:
        lines.append(f"Largest exposure: {largest.symbol}, {abs(largest.value) / a.equity:.1%} of equity.")
    for h in ranked[:8]:
        lines.append(f"{h.symbol}: {decimal_text(h.qty)} units · {usd(h.value)} value")
    return "\n".join(lines)


def mentioned_symbols(prompt):
    found = []
    for token in re.findall(r"\$?[A-Za-z0-9]+(?:[./-][A-Za-z0-9]+)?", prompt):
        word = token.upper()
        if (word in SAMPLES or word in ALIASES or word.startswith("$") or word.endswith(("/USD", "-USD"))
                or (token.isupper() and re.fullmatch(r"[A-Z]{1,6}(?:\.[A-Z])?", token)
                    and word not in {"I", "A", "US", "USD", "ETF", "AI", "AND", "VS", "OR", "MY"})):
            try:
                canonical = symbol(token)
            except DeskError:
                continue
            if canonical not in found:
                found.append(canonical)
    if not found and (m := re.fullmatch(r"(?:quote|research|analy[sz]e)\s+([\w./-]+)[?!.]?", prompt, re.I)):
        found.append(symbol(m[1].rstrip(".!?")))
    if len(found) > 4:
        raise DeskError("Compare up to four instruments per question.")
    return found


@dataclass(frozen=True)
class Reply:
    agent: str
    text: str
    quotes: tuple[Quote, ...] = ()
    ticket: Ticket | None = None


def respond(prompt, focus, desk, model="", history=()):
    prompt = prompt.strip()
    if not prompt or len(prompt) > 3000:
        raise DeskError("Enter a question of up to 3,000 characters.")
    if re.match(r"^(?:please\s+)?(?:buy|sell)\b", prompt, re.I):
        m = re.fullmatch(r"(?:please\s+)?(buy|sell)\s+([.\d]+)\s+(?:(?:shares?|units?)\s+of\s+)?"
                         r"(\$?[\w./-]+?)\s*[.!]?", prompt, re.I)
        if not m:
            return Reply("Order agent", "Use a quantity and a symbol, for example: Buy 2 AAPL.")
        ticket = Ticket.parse(m[3], m[1], m[2])
        return Reply("Order agent", f"Ticket prepared: {ticket.side} {decimal_text(ticket.qty)} "
                     f"{ticket.symbol} in {desk.mode.value}. The order is ready in the Trade ticket tab.",
                     ticket=ticket)
    if prompt.lower().strip("?!.") in {"help", "hello", "hi", "what can you do"}:
        return Reply("Desk assistant", HELP)

    assets = mentioned_symbols(prompt)
    portfolio = re.search(r"\b(portfolio|account|holdings?|positions?|cash|balance|exposure|allocation)\b",
                          prompt, re.I)
    if not assets and not portfolio:
        if not model and not re.search(r"\b(research|quote|price|trend|model|pattern|analysis|momentum)\b",
                                       prompt, re.I):
            return Reply("Desk assistant", HELP + "\n\nFor open-ended conversation, connect a model in Local AI.")
        assets = [symbol(focus)]

    quotes = tuple(desk.quote(s) for s in assets)
    sections = [market_report(q) for q in quotes]
    if len(quotes) > 1 and all(len(q.closes) >= 5 for q in quotes):
        ranks = sorted(((pct(q.price, q.closes[-5]), q.symbol) for q in quotes), reverse=True)
        sections.append("Five-session change, highest first: " + ", ".join(f"{s} ({r:+.2f}%)" for r, s in ranks)
                        + ". Stock sessions skip weekends; crypto sessions do not.")
    if portfolio:
        sections.append(account_report(desk.account()))
        if not desk.mode.broker:
            sections.append("Paper positions use the last fetched price for each symbol.")
    facts = "\n\n".join(sections)
    agent = "Portfolio agent" if portfolio and not quotes else "Research agent"
    if model:
        try:
            explanation = ollama_explain(model, prompt, f"Workspace: {desk.mode.value}\n{facts}", history)
            return Reply(f"Local AI · {model}", f"{explanation}\n\nDesk readings\n{facts}", quotes)
        except DeskError as exc:
            facts += f"\n\nLocal AI unavailable: {exc} Built-in readings are shown above."
    return Reply(agent, facts, quotes)
