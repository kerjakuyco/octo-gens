"""Atomic, long-only paper accounts backed by a per-user SQLite database."""

from contextlib import closing, contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
import sqlite3

from .domain import Account, DeskError, Holding, Order, Quote, Ticket, Workspace, cents, decimal_text
from .market import check_paper_price


class PaperBook:
    def __init__(self, path: Path, workspace: Workspace):
        if workspace.broker:
            raise ValueError("A broker workspace cannot use a paper book")
        self.path = path
        self.book = workspace.name
        self.sample = workspace == Workspace.DEMO
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS accounts (book TEXT PRIMARY KEY, cash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS positions (
                    book TEXT, symbol TEXT, qty TEXT NOT NULL, cost TEXT NOT NULL,
                    PRIMARY KEY (book, symbol));
                CREATE TABLE IF NOT EXISTS marks (
                    book TEXT, symbol TEXT, price TEXT NOT NULL, as_of TEXT NOT NULL,
                    PRIMARY KEY (book, symbol));
                CREATE TABLE IF NOT EXISTS fills (
                    seq INTEGER PRIMARY KEY, book TEXT, id TEXT, symbol TEXT, side TEXT,
                    qty TEXT, price TEXT, submitted TEXT, quote_at TEXT, source TEXT,
                    UNIQUE (book, id));
            """)
            db.execute("INSERT OR IGNORE INTO accounts VALUES (?, '100000.00')", (self.book,))

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=8)) as db:
            db.row_factory = sqlite3.Row
            with db:
                yield db

    def _mark(self, db, q):
        if q.sample != self.sample:
            raise DeskError("The quote belongs to a different workspace.")
        db.execute("""
            INSERT INTO marks VALUES (?, ?, ?, ?)
            ON CONFLICT (book, symbol) DO UPDATE SET price=excluded.price, as_of=excluded.as_of
            WHERE excluded.as_of >= marks.as_of
        """, (self.book, q.symbol, str(q.price), q.as_of.isoformat()))

    def remember(self, q: Quote):
        with self.connection() as db:
            self._mark(db, q)

    @staticmethod
    def _order(row):
        return Order(row["id"], row["symbol"], row["side"], row["qty"], row["qty"],
                     Decimal(row["price"]), "filled", row["submitted"])

    def order_by_id(self, client_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM fills WHERE book=? AND id=?", (self.book, client_id)).fetchone()
            return self._order(row) if row else None

    def submit(self, ticket: Ticket, q: Quote):
        if q.symbol != ticket.symbol or q.sample != self.sample:
            raise DeskError("The quote does not match this ticket and workspace.")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM fills WHERE book=? AND id=?",
                                  (self.book, ticket.client_id)).fetchone()
            if existing:
                return self._order(existing)
            check_paper_price(q)
            gross = ticket.qty * q.price
            if gross < Decimal("0.01"):
                raise DeskError("Paper orders must be worth at least $0.01.")
            amount = cents(gross)
            key = self.book, q.symbol
            cash = Decimal(db.execute("SELECT cash FROM accounts WHERE book=?", (self.book,)).fetchone()[0])
            pos = db.execute("SELECT qty, cost FROM positions WHERE book=? AND symbol=?", key).fetchone()
            held, cost = (Decimal(pos[0]), Decimal(pos[1])) if pos else (Decimal(0), Decimal(0))
            if ticket.side == "buy":
                if amount > cash:
                    raise DeskError("There is not enough paper cash for this order.")
                held, cost, cash = held + ticket.qty, cost + amount, cash - amount
            else:
                if ticket.qty > held:
                    raise DeskError("The sell quantity exceeds your paper holding.")
                cost -= cents(cost * ticket.qty / held)
                held, cash = held - ticket.qty, cash + amount
            if held:
                db.execute("INSERT OR REPLACE INTO positions VALUES (?, ?, ?, ?)",
                           (*key, str(held), str(cost)))
            else:
                db.execute("DELETE FROM positions WHERE book=? AND symbol=?", key)
            db.execute("UPDATE accounts SET cash=? WHERE book=?", (str(cash), self.book))
            self._mark(db, q)
            submitted = datetime.now(UTC).isoformat(timespec="seconds")
            qty = decimal_text(ticket.qty)
            db.execute("""INSERT INTO fills (book,id,symbol,side,qty,price,submitted,quote_at,source)
                          VALUES (?,?,?,?,?,?,?,?,?)""",
                       (self.book, ticket.client_id, q.symbol, ticket.side, qty, str(q.price),
                        submitted, q.as_of.isoformat(), q.source))
            return Order(ticket.client_id, q.symbol, ticket.side, qty, qty, q.price, "filled", submitted)

    def snapshot(self):
        with self.connection() as db:
            db.execute("BEGIN")
            cash = Decimal(db.execute("SELECT cash FROM accounts WHERE book=?", (self.book,)).fetchone()[0])
            rows = db.execute("""SELECT symbol, qty, cost, price FROM positions
                JOIN marks USING (book, symbol) WHERE book=? ORDER BY symbol""", (self.book,))
            holdings = tuple(Holding(r["symbol"], Decimal(r["qty"]),
                                     cents(Decimal(r["qty"]) * Decimal(r["price"])), Decimal(r["cost"]))
                             for r in rows)
            fills = db.execute("SELECT * FROM fills WHERE book=? ORDER BY seq DESC LIMIT 50", (self.book,))
            return Account(cash, cash + sum(h.value for h in holdings), holdings,
                           tuple(self._order(r) for r in fills))
