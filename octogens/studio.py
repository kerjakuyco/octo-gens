"""The desktop harness: venue-scoped tools, USDT paper books, tickets and run traces."""

from collections import deque
from contextlib import closing
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
import json
from pathlib import Path
import re
import sqlite3
from threading import RLock, Timer
from time import perf_counter
from uuid import uuid4

from .agents import ollama_explain, pattern_outcomes, pct
from .domain import DeskError, Quote, Ticket, Workspace, decimal_text
from .instruments import DEFAULT_PAIR, UNIVERSE, VENUES, in_prompt, instrument
from .market import sample_quote
from .mcp_link import Harness, Link
from .mcp_presets import PACKAGES, node_runtime, official_stdio
from .paper import PaperBook
from .strategy import run_pattern, trade_budget


def number(n):
    return f"{n:,.2f}"


def as_quote(data, venue, pair):
    if not isinstance(data, dict) or (data.get("venue"), data.get("pair"), data.get("market"),
                                      data.get("listed")) != (venue, pair, "spot", True):
        raise DeskError("MCP returned a different venue, pair, or market type.")
    try:
        price = Decimal(str(data["price"]))
        closes = tuple(Decimal(str(v)) for v in data["closes"][-120:])
        stamp = datetime.fromisoformat(data["as_of"])
        if stamp.tzinfo is None or any(not p.is_finite() or not 0 < p < 10**12 for p in (*closes, price)):
            raise ValueError
    except (KeyError, ValueError, TypeError, ArithmeticError):
        raise DeskError("The MCP quote did not contain valid spot prices and a UTC timestamp.") from None
    return Quote(pair, price, stamp.astimezone(UTC), VENUES[venue] + " spot MCP", closes)


def render_quote(q):
    return {"pair": q.symbol, "price": str(q.price), "closes": [str(p) for p in q.closes],
            "asOf": q.stamp, "source": q.source, "sample": q.sample,
            "change": float(pct(q.price, q.closes[-1])) if q.closes else None}


def render_account(a):
    return {"cash": str(a.cash), "equity": str(a.equity),
            "holdings": [{k: str(v) for k, v in asdict(h).items()} for h in a.holdings],
            "orders": [{**asdict(o), "price": str(o.price) if o.price is not None else None} for o in a.orders]}


class SpotDesk:
    currency = "USDT"

    def __init__(self, directory, source, link):
        self.source, self.link = source, link
        self.mode = Workspace.DEMO if source == "sample" else Workspace.MARKET
        self.book = PaperBook(directory / f"spot-usdt-{source}.sqlite3", self.mode)
        self.quotes = {}

    def quote(self, asset, *, refresh=False):
        i = instrument(asset)
        if self.source == "sample":
            q = sample_quote(i.pair, i.sample)
        else:
            q = as_quote(self.link.call("spot_quote", {"pair": i.pair}), self.source, i.pair)
        self.book.remember(q)
        self.quotes[i.pair] = q
        return q

    def account(self):
        return self.book.snapshot()


class Studio:
    def __init__(self, directory: Path, connect=Link):
        directory.mkdir(parents=True, exist_ok=True)
        self.directory, self.connect, self.lock = directory, connect, RLock()
        self.prefs = directory / "preferences.json"
        try:
            self.model = str(json.loads(self.prefs.read_text(encoding="utf8"))["model"])
        except (OSError, KeyError, TypeError, ValueError):
            self.model = ""
        self.links, self.draft, self.timer, self.watch = {}, None, None, None
        self.active, self.focus, self.feed_error = None, DEFAULT_PAIR, ""
        self.desk = SpotDesk(directory, "sample", None)
        self.logfile = directory / "studio-runs.sqlite3"
        with closing(sqlite3.connect(self.logfile)) as db:
            db.execute("CREATE TABLE IF NOT EXISTS runs(seq INTEGER PRIMARY KEY, entry TEXT NOT NULL)")
            self.runs = deque((json.loads(r[0]) for r in db.execute(
                "SELECT entry FROM runs ORDER BY seq DESC LIMIT 40")), maxlen=40)

    def bootstrap(self):
        if self.desk.source == "sample" and not self.desk.quotes:
            for pair in UNIVERSE:
                self.desk.quote(pair)

    def state(self):
        return {"assets": [i.view() for i in UNIVERSE.values()], "source": self.desk.source, "focus": self.focus,
                "quotes": {k: render_quote(v) for k, v in self.desk.quotes.items()}, "feedError": self.feed_error,
                "account": render_account(self.desk.account()), "model": self.model, "watch": self.watch,
                "runs": list(self.runs), "links": {k: self._link_view(k) for k in VENUES},
                "runtime": {"node": node_runtime() is not None}, "packages": PACKAGES}

    def _link_view(self, venue):
        link = self.links.get(venue)
        if not link or not link.connected:
            return {"connected": False, "name": VENUES[venue], "count": 0}
        return {"connected": True, "name": link.name, "version": link.version, "transport": link.transport,
                "count": len(link.tools), "feed": "spot_quote" in link.tools,
                "trading": "spot_market_order" in link.tools}

    def _source(self, source):
        if source != "sample" and (source not in VENUES or not self._link_view(source).get("feed")):
            raise DeskError("Connect a spot-quote MCP feed first.")
        self.stop_watch()
        self.draft = None
        self.desk = SpotDesk(self.directory, source, self.links.get(source))
        self.bootstrap()
        self.select(self.focus, soft=True)

    def select(self, raw, soft=False):
        self.focus, self.feed_error = instrument(raw).pair, ""
        try:
            self.desk.quote(self.focus)
        except Exception as exc:
            self.desk.quotes.pop(self.focus, None)
            self.feed_error = str(exc)
            if not soft:
                raise

    def _run(self, agent, title, work, private=False):
        run = {"id": uuid4().hex[:10], "agent": agent, "title": title[:250], "source": self.desk.source,
               "time": datetime.now(UTC).isoformat(), "steps": [], "status": "running", "output": ""}
        start = perf_counter()
        self.active = run
        def step(name, detail, fn):
            t = perf_counter()
            entry = {"name": name, "detail": detail, "status": "running", "ms": 0}
            run["steps"].append(entry)
            try:
                result = fn()
                entry["status"] = "ok"
                return result
            except Exception:
                entry["status"] = "error"
                raise
            finally:
                entry["ms"] = round((perf_counter() - t) * 1000)
        try:
            output, result = work(step)
            run.update(status="complete", output=output)
            return result
        except Exception as exc:
            run.update(status="failed", output=str(exc)[:2000])
            raise
        finally:
            run["ms"] = round((perf_counter() - start) * 1000)
            self.active = None
            self.runs.appendleft(run)
            stored = {**run, "output": "Private tool result was session-only."} if private else run
            with closing(sqlite3.connect(self.logfile)) as db, db:
                db.execute("INSERT INTO runs(entry) VALUES(?)", (json.dumps(stored),))
                db.execute("DELETE FROM runs WHERE seq <= (SELECT MAX(seq)-100 FROM runs)")

    def _read(self, pair, step):
        prefix = "sample.quote" if self.desk.source == "sample" else self.desk.source + ".spot_quote"
        return step(prefix, pair, lambda: self.desk.quote(pair))

    def _analyze(self, question, step):
        pairs = in_prompt(question) or [self.focus]
        if len(pairs) > 4:
            raise DeskError("Compare up to four instruments in a run.")
        quotes = [self._read(pair, step) for pair in pairs]
        def analyze():
            reports, momentum = [], []
            for q in quotes:
                i = instrument(q.symbol)
                lines = [f"{i.name} · {number(q.price)} USDT", f"{q.source} · {q.stamp}"]
                if len(q.closes) >= 5:
                    move = pct(q.price, q.closes[-5])
                    momentum.append((move, i.ticker))
                    lines.append(f"Five-session move {move:+.2f}% · previous close {number(q.closes[-1])} USDT.")
                outcomes = pattern_outcomes(q.closes)
                if outcomes:
                    lines.append(f"{sum(v > 0 for v in outcomes)} of 5 historical pattern matches rose next session.")
                reports.append("\n".join(lines))
            if len(momentum) > 1:
                reports.append("Five-session ranking: " + "  /  ".join(f"{s} {r:+.2f}%" for r, s in sorted(momentum, reverse=True)))
            return "\n\n".join(reports)
        output = step("research.patterns", f"{len(quotes)} spot instrument(s)", analyze)
        if self.model:
            try:
                explanation = step("ollama.chat", self.model, lambda: ollama_explain(
                    self.model, question, output, ()))
                output = explanation + "\n\n" + output
            except DeskError as exc:
                output += f"\n\nLocal model unavailable: {exc}"
        self.focus, self.feed_error = quotes[0].symbol, ""
        return output, None

    def _prepare(self, raw, side, qty, destination, step):
        i = instrument(raw)
        if destination not in ("paper", "exchange"):
            raise DeskError("Choose an order destination.")
        if destination == "exchange" and not self._link_view(self.desk.source).get("trading"):
            raise DeskError("Connect a credentialed spot MCP server to send exchange orders.")
        t = Ticket.parse(i.pair, side, str(qty))
        q = self._read(i.pair, step)
        self.draft = (self.desk, t, destination)
        preview = {"id": t.client_id, "pair": i.pair, "side": t.side, "qty": decimal_text(t.qty),
                   "source": self.desk.source, "destination": destination, "price": str(q.price),
                   "value": str(q.price * t.qty)}
        return f"{t.side.title()} {preview['qty']} {i.ticker} · estimated {number(q.price*t.qty)} USDT · {destination} ticket.", {"ticket": preview}

    def _submit(self, cid, step):
        if not self.draft or self.draft[0] is not self.desk or self.draft[1].client_id != cid:
            raise DeskError("This ticket expired. Preview a new ticket in the current workspace.")
        _, t, destination = self.draft
        self.draft = None
        if destination == "exchange":
            try:
                order = step(self.desk.source + ".spot_market_order", t.symbol, lambda: self.desk.link.call(
                    "spot_market_order", {"pair": t.symbol, "side": t.side, "quantity": decimal_text(t.qty),
                                          "client_id": t.client_id}))
            except Exception as exc:
                raise DeskError(f"{exc} Check the venue for client ID {t.client_id} before resubmitting.") from None
            return f"{VENUES[self.desk.source]} · {order['status']} · order {order['id']}", None
        q = self._read(t.symbol, step)
        fill = step("paper.fill", t.symbol, lambda: self.desk.book.submit(t, q))
        return f"Paper fill · {fill.side} {fill.quantity} {fill.symbol} at {number(fill.price)} USDT.", None

    def ask(self, question):
        question = str(question).strip()
        if not 0 < len(question) <= 2500:
            raise DeskError("Enter a prompt of 1–2,500 characters.")
        match = re.fullmatch(r"(?:please\s+)?(buy|sell)\s+([\d.]+)\s+([\w/-]+)[.!]?", question, re.I)
        if match:
            return self._run("Order agent", question, lambda step: self._prepare(
                match[3], match[1].lower(), match[2], "paper", step))
        if re.match(r"^(?:please\s+)?(buy|sell)\b", question, re.I):
            raise DeskError("Use a quantity and token symbol, e.g. Buy 0.5 TSLAx.")
        if question.startswith("@"):
            cmd = re.fullmatch(r"@(\w+)\s+([\w.-]+)(?:\s+(\{.*\}))?", question, re.S)
            if not cmd:
                raise DeskError('Use @venue tool_name {"parameter":"value"} from the MCP tool catalog.')
            return self.tool(cmd[1].lower(), cmd[2], json.loads(cmd[3] or "{}"), from_agent=True)
        if re.search(r"\b(portfolio|exposure|holdings|cash|balance)\b", question, re.I):
            def portfolio(step):
                a = step("paper.snapshot", self.desk.source, self.desk.account)
                lines = [f"Paper equity {number(a.equity)} USDT · cash {number(a.cash)} USDT."]
                for h in sorted(a.holdings, key=lambda p: -p.value):
                    lines.append(f"{h.symbol}: {decimal_text(h.qty)} units · {number(h.value)} USDT.")
                return "\n".join(lines if a.holdings else lines + ["No open positions in this workspace."]), None
            return self._run("Portfolio agent", question, portfolio)
        return self._run("Research agent", question, lambda step: self._analyze(question, step))

    def pattern(self, pair, cap):
        def work(step):
            decision = step("pattern.evaluate", f"{pair} · max {cap} USDT", lambda: run_pattern(self.desk, pair, cap))
            return decision.text, None
        return self._run("Pattern agent", "Evaluate " + instrument(pair).ticker, work)

    def stop_watch(self):
        if self.timer:
            self.timer.cancel()
        self.timer = self.watch = None

    def start_watch(self, pair, cap):
        i, amount = instrument(pair), trade_budget(cap, "USDT")
        self.stop_watch()
        self.pattern(i.pair, str(amount))
        plan = self.watch = {"pair": i.pair, "budget": str(amount), "source": self.desk.source}
        def schedule():
            self.timer = Timer(900, tick)
            self.timer.daemon = True
            self.timer.start()
        def tick():
            with self.lock:
                if self.watch is plan:
                    try:
                        self.pattern(plan["pair"], plan["budget"])
                    except Exception:
                        pass  # Failed runs are recorded in the journal.
                    schedule()
        schedule()

    def tool(self, venue, name, args, from_agent=False):
        link = self.links.get(venue)
        if not link or not link.connected or name not in link.tools:
            raise DeskError("Connect the server and choose a discovered tool.")
        if name == "spot_market_order" and link.transport == "bundled":
            raise DeskError("Use the exchange ticket to submit a spot order.")
        if from_agent and not (link.tools[name]["readOnly"] or
                               (link.transport == "bundled" and name in ("spot_listing", "spot_quote", "spot_balances"))):
            raise DeskError("This server does not mark the tool read-only. Run it explicitly in the tool inspector.")
        def work(step):
            result = step(f"{venue}.{name}", "MCP tools/call", lambda: link.call(name, args))
            text = result if isinstance(result, str) else json.dumps(result, indent=2, ensure_ascii=False)
            return text[:12000], {"toolOutput": text[:32000]}
        return self._run("MCP operator", f"{VENUES[venue]} / {name}", work, private=True)

    def _connect(self, venue, cfg):
        if cfg.get("transport") != "official":
            return self.connect(venue, cfg)
        keys = {name: cfg.get(name, "") for name in ("key", "secret", "passphrase")}
        bundled = official = None
        try:
            bundled = self.connect(venue, {"transport": "bundled", **keys})
            official = self.connect(venue, official_stdio(venue, cfg))
            return Harness(bundled, official)
        except Exception:
            if official:
                official.close()
            if bundled:
                bundled.close()
            raise

    def action(self, op, p):
        if op == "boot":
            self.bootstrap()
        elif op == "connect":
            venue, cfg = p["venue"], dict(p["config"])
            new = self._connect(venue, cfg)
            old = self.links.get(venue)
            self.links[venue] = new
            if old:
                old.close()
            if "spot_quote" in new.tools:
                self._source(venue)
            elif self.desk.source == venue:
                self._source("sample")
        elif op == "disconnect":
            venue = p["venue"]
            if self.desk.source == venue:
                self._source("sample")
            if link := self.links.pop(venue, None):
                link.close()
        elif op == "source":
            self._source(p["source"])
        elif op == "select":
            self.select(p["pair"])
        elif op == "ask":
            return self.ask(p["prompt"])
        elif op == "prepare":
            return self._run("Order agent", "Preview spot ticket", lambda step: self._prepare(
                p["pair"], p["side"], p["qty"], p["destination"], step))
        elif op == "submit":
            return self._run("Execution", "Submit spot ticket", lambda step: self._submit(p["id"], step))
        elif op == "pattern":
            return self.pattern(instrument(p["pair"]).pair, str(trade_budget(p["budget"], "USDT")))
        elif op == "watch":
            self.start_watch(p["pair"], p["budget"])
        elif op == "stop":
            self.stop_watch()
        elif op == "catalog":
            link = self.links.get(p["venue"])
            if not link or not link.connected:
                raise DeskError("Connect the MCP server first.")
            return {"tools": list(link.tools.values())}
        elif op == "tool":
            return self.tool(p["venue"], p["name"], p["args"])
        elif op == "model":
            name = p["model"].strip()
            if name and not re.fullmatch(r"[\w.][\w./:-]{0,159}", name):
                raise DeskError("Enter a locally installed Ollama model tag.")
            self.prefs.write_text(json.dumps({"model": name}), encoding="utf8")
            self.model = name
        elif op != "state":
            raise DeskError("Unknown studio action.")

    def close(self):
        with self.lock:
            self.stop_watch()
            for link in self.links.values():
                link.close()
            self.links.clear()
