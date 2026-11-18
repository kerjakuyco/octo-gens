//! Atomic, long-only paper accounts in a per-user SQLite file.
//!
//! Each price feed has its own book, so a fill priced on the sample tape can
//! never sit beside one priced on a live venue.

use std::path::Path;
use std::str::FromStr;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use rust_decimal::Decimal;

use crate::bail;
use crate::error::{DeskError, Result};
use crate::model::{Account, Fill, Holding, Quote, Side, Ticket, cents, decimal_text};

/// Cash every new paper book starts with, in USDT.
pub const STARTING_CASH: &str = "100000.00";
/// A live quote older than this cannot fill a paper order.
const MAX_QUOTE_AGE_MINUTES: i64 = 15;

/// Rejects live quotes that are stale or dated in the future. Sample quotes carry
/// a fixed timestamp by design and always pass.
pub fn check_paper_price(quote: &Quote, now: DateTime<Utc>) -> Result<()> {
    if quote.sample {
        return Ok(());
    }
    let age = now - quote.as_of;
    if age > chrono::Duration::minutes(MAX_QUOTE_AGE_MINUTES) || age < chrono::Duration::minutes(-5) {
        bail!(
            "The {} quote is dated {}; refresh it before filling a paper order.",
            quote.pair,
            quote.stamp()
        );
    }
    Ok(())
}

/// Fixed-width UTC text, so SQLite can order timestamps as strings.
fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Micros, true)
}

pub struct PaperBook {
    db: Mutex<Connection>,
    /// Row key inside the file: `DEMO` for the sample tape, `MARKET` for live prices.
    book: &'static str,
    sample: bool,
}

fn decimal(row: &Row<'_>, column: &str) -> rusqlite::Result<Decimal> {
    let text: String = row.get(column)?;
    Decimal::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

fn fill_from(row: &Row<'_>) -> rusqlite::Result<Fill> {
    let side: String = row.get("side")?;
    Ok(Fill {
        id: row.get("id")?,
        pair: row.get("symbol")?,
        side: if side == "sell" { Side::Sell } else { Side::Buy },
        qty: decimal(row, "qty")?,
        price: decimal(row, "price")?,
        status: "filled".to_string(),
        submitted: row.get("submitted")?,
    })
}

impl PaperBook {
    pub fn open(path: &Path, sample: bool) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(8))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS accounts (book TEXT PRIMARY KEY, cash TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS positions (
                 book TEXT, symbol TEXT, qty TEXT NOT NULL, cost TEXT NOT NULL,
                 PRIMARY KEY (book, symbol));
             CREATE TABLE IF NOT EXISTS marks (
                 book TEXT, symbol TEXT, price TEXT NOT NULL, as_of TEXT NOT NULL,
                 PRIMARY KEY (book, symbol));
             CREATE TABLE IF NOT EXISTS fills (
                 seq INTEGER PRIMARY KEY, book TEXT, id TEXT, symbol TEXT, side TEXT,
                 qty TEXT, price TEXT, submitted TEXT, quote_at TEXT, source TEXT,
                 UNIQUE (book, id));",
        )?;
        let book = if sample { "DEMO" } else { "MARKET" };
        db.execute("INSERT OR IGNORE INTO accounts VALUES (?1, ?2)", params![book, STARTING_CASH])?;
        Ok(Self { db: Mutex::new(db), book, sample })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another thread panicked; SQLite itself stays consistent.
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mark(&self, db: &Connection, quote: &Quote) -> Result<()> {
        if quote.sample != self.sample {
            bail!("The quote belongs to a different feed than this paper account.");
        }
        db.execute(
            "INSERT INTO marks VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (book, symbol) DO UPDATE SET price = excluded.price, as_of = excluded.as_of
             WHERE excluded.as_of >= marks.as_of",
            params![self.book, quote.pair, quote.price.to_string(), stamp(quote.as_of)],
        )?;
        Ok(())
    }

    /// Records the latest price so open positions can be valued.
    pub fn remember(&self, quote: &Quote) -> Result<()> {
        self.mark(&self.lock(), quote)
    }

    pub fn order_by_id(&self, client_id: &str) -> Result<Option<Fill>> {
        let db = self.lock();
        let fill = db
            .query_row(
                "SELECT * FROM fills WHERE book = ?1 AND id = ?2",
                params![self.book, client_id],
                fill_from,
            )
            .optional()?;
        Ok(fill)
    }

    /// Fills `ticket` at the quote price, or returns the earlier fill when the same
    /// client id was already processed. Nothing changes if any check fails.
    pub fn submit(&self, ticket: &Ticket, quote: &Quote) -> Result<Fill> {
        if quote.pair != ticket.pair || quote.sample != self.sample {
            bail!("The quote does not match this ticket and paper account.");
        }
        let mut db = self.lock();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT * FROM fills WHERE book = ?1 AND id = ?2",
                params![self.book, ticket.client_id],
                fill_from,
            )
            .optional()?;
        if let Some(fill) = existing {
            return Ok(fill);
        }
        check_paper_price(quote, Utc::now())?;
        let gross = ticket.qty * quote.price;
        if gross < Decimal::new(1, 2) {
            bail!("Paper orders must be worth at least 0.01 USDT.");
        }
        let amount = cents(gross);
        let text_decimal = |text: String| {
            Decimal::from_str(&text).map_err(|_| DeskError::new("The paper ledger holds an invalid amount."))
        };
        let mut cash = text_decimal(tx.query_row(
            "SELECT cash FROM accounts WHERE book = ?1",
            params![self.book],
            |r| r.get(0),
        )?)?;
        let position: Option<(String, String)> = tx
            .query_row(
                "SELECT qty, cost FROM positions WHERE book = ?1 AND symbol = ?2",
                params![self.book, quote.pair],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (mut held, mut cost) = match position {
            Some((qty, cost)) => (text_decimal(qty)?, text_decimal(cost)?),
            None => (Decimal::ZERO, Decimal::ZERO),
        };
        match ticket.side {
            Side::Buy => {
                if amount > cash {
                    bail!("There is not enough paper cash for this order.");
                }
                held += ticket.qty;
                cost += amount;
                cash -= amount;
            }
            Side::Sell => {
                if ticket.qty > held {
                    bail!("The sell quantity exceeds your paper holding.");
                }
                cost -= cents(cost * ticket.qty / held);
                held -= ticket.qty;
                cash += amount;
            }
        }
        if held.is_zero() {
            tx.execute(
                "DELETE FROM positions WHERE book = ?1 AND symbol = ?2",
                params![self.book, quote.pair],
            )?;
        } else {
            tx.execute(
                "INSERT OR REPLACE INTO positions VALUES (?1, ?2, ?3, ?4)",
                params![self.book, quote.pair, held.normalize().to_string(), cost.to_string()],
            )?;
        }
        tx.execute("UPDATE accounts SET cash = ?1 WHERE book = ?2", params![cash.to_string(), self.book])?;
        self.mark(&tx, quote)?;
        let submitted = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let qty = decimal_text(ticket.qty);
        tx.execute(
            "INSERT INTO fills (book, id, symbol, side, qty, price, submitted, quote_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                self.book,
                ticket.client_id,
                quote.pair,
                ticket.side.as_str(),
                qty,
                quote.price.to_string(),
                submitted,
                stamp(quote.as_of),
                quote.source
            ],
        )?;
        tx.commit()?;
        Ok(Fill {
            id: ticket.client_id.clone(),
            pair: quote.pair.clone(),
            side: ticket.side,
            qty: ticket.qty,
            price: quote.price,
            status: "filled".to_string(),
            submitted,
        })
    }

    /// Cash, positions valued at their last recorded price, and the 50 latest fills.
    pub fn snapshot(&self) -> Result<Account> {
        let mut db = self.lock();
        let tx = db.transaction()?;
        let cash: String =
            tx.query_row("SELECT cash FROM accounts WHERE book = ?1", params![self.book], |r| r.get(0))?;
        let cash = Decimal::from_str(&cash)
            .map_err(|_| DeskError::new("The paper ledger holds an invalid amount."))?;
        let holdings = {
            let mut statement = tx.prepare(
                "SELECT symbol, qty, cost, price FROM positions JOIN marks USING (book, symbol)
                 WHERE book = ?1 ORDER BY symbol",
            )?;
            let rows = statement.query_map(params![self.book], |row| {
                let qty = decimal(row, "qty")?;
                Ok(Holding {
                    pair: row.get("symbol")?,
                    qty,
                    value: cents(qty * decimal(row, "price")?),
                    cost: decimal(row, "cost")?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let orders = {
            let mut statement =
                tx.prepare("SELECT * FROM fills WHERE book = ?1 ORDER BY seq DESC LIMIT 50")?;
            let rows = statement.query_map(params![self.book], fill_from)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let equity = cash + holdings.iter().map(|h| h.value).sum::<Decimal>();
        Ok(Account { cash, equity, holdings, orders })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::instruments::resolve;
    use crate::sample::sample_quote;

    fn dec(text: &str) -> Decimal {
        Decimal::from_str(text).expect("test decimal")
    }

    fn btc() -> Quote {
        sample_quote(&resolve("BTC").expect("btc")).expect("quote")
    }

    fn priced(price: &str) -> Quote {
        Quote { price: dec(price), ..btc() }
    }

    #[test]
    fn partial_sale_persists_cash_basis_and_mark_without_double_fill() {
        let folder = tempfile::tempdir().expect("tempdir");
        let path = folder.path().join("paper.sqlite3");
        let book = PaperBook::open(&path, true).expect("book");
        let fill = |book: &PaperBook, side: &str, qty: &str, price: &str| {
            let ticket = Ticket::parse("BTC/USDT", side, qty).expect("ticket");
            let quote = priced(price);
            let receipt = book.submit(&ticket, &quote).expect("fill");
            (ticket, quote, receipt)
        };
        fill(&book, "buy", "2", "100");
        fill(&book, "buy", "1", "160");
        let (ticket, quote, receipt) = fill(&book, "sell", "1", "150");
        drop(book);

        let reopened = PaperBook::open(&path, true).expect("reopen");
        assert_eq!(reopened.submit(&ticket, &quote).expect("idempotent"), receipt);
        let account = reopened.snapshot().expect("snapshot");
        assert_eq!((account.cash, account.equity), (dec("99790"), dec("100090")));
        assert_eq!((account.holdings[0].qty, account.holdings[0].cost), (dec("2"), dec("240")));
        assert_eq!(account.orders.len(), 3);
        assert_eq!(account.orders[0].side, Side::Sell);

        fill(&reopened, "sell", "2", "140");
        let account = reopened.snapshot().expect("snapshot");
        assert_eq!(account.equity, dec("100070"));
        assert!(account.holdings.is_empty());
    }

    #[test]
    fn rejected_orders_do_not_change_the_account() {
        let folder = tempfile::tempdir().expect("tempdir");
        let book = PaperBook::open(&folder.path().join("paper.sqlite3"), true).expect("book");
        let before = book.snapshot().expect("snapshot");
        for (side, qty, reason) in
            [("sell", "0.1", "exceeds"), ("buy", "500", "not enough"), ("buy", ".00000001", "at least")]
        {
            let ticket = Ticket::parse("BTC/USDT", side, qty).expect("ticket");
            let error = book.submit(&ticket, &btc()).expect_err("rejected").to_string();
            assert!(error.contains(reason), "{error}");
        }
        assert_eq!(book.snapshot().expect("snapshot"), before);
    }

    #[test]
    fn concurrent_orders_cannot_both_spend_the_same_cash() {
        let folder = tempfile::tempdir().expect("tempdir");
        let book = Arc::new(PaperBook::open(&folder.path().join("paper.sqlite3"), true).expect("book"));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let book = Arc::clone(&book);
                std::thread::spawn(move || {
                    book.submit(&Ticket::parse("BTC/USDT", "buy", "1").expect("ticket"), &btc()).is_ok()
                })
            })
            .collect();
        let filled = handles.into_iter().map(|h| h.join().expect("thread")).filter(|ok| *ok).count();
        assert_eq!(filled, 1);
        assert_eq!(book.snapshot().expect("snapshot").cash, dec("15784.50"));
    }

    #[test]
    fn sample_and_market_books_never_mix_and_stale_prices_do_not_fill() {
        let folder = tempfile::tempdir().expect("tempdir");
        let path = folder.path().join("paper.sqlite3");
        let demo = PaperBook::open(&path, true).expect("demo");
        let ticket = Ticket::parse("BTC/USDT", "buy", ".001").expect("ticket");
        demo.submit(&ticket, &btc()).expect("sample fill");

        let market = PaperBook::open(&path, false).expect("market");
        let stale = Quote { sample: false, as_of: Utc::now() - chrono::Duration::hours(1), ..btc() };
        assert!(
            market.submit(&ticket, &btc()).expect_err("sample quote").to_string().contains("does not match")
        );
        assert!(market.submit(&ticket, &stale).expect_err("stale").to_string().contains("refresh"));
        assert!(market.remember(&btc()).is_err());
        let account = market.snapshot().expect("snapshot");
        assert_eq!((account.cash, account.orders.len()), (dec("100000"), 0));
        assert_eq!(demo.snapshot().expect("snapshot").cash, dec("99915.78"));

        let fresh = Quote { sample: false, as_of: Utc::now(), ..btc() };
        market.submit(&ticket, &fresh).expect("live-priced fill");
        assert_eq!(market.order_by_id(&ticket.client_id).expect("lookup").expect("found").qty, dec("0.001"));
        assert!(market.order_by_id("missing").expect("lookup").is_none());
    }

    #[test]
    fn a_book_written_by_the_python_releases_still_opens_and_trades() {
        let folder = tempfile::tempdir().expect("tempdir");
        let path = folder.path().join("spot-usdt-sample.sqlite3");
        {
            // The schema and row formats the 0.2 releases wrote, timestamps included.
            let db = Connection::open(&path).expect("legacy file");
            db.execute_batch(
                "CREATE TABLE accounts (book TEXT PRIMARY KEY, cash TEXT NOT NULL);
                 CREATE TABLE positions (book TEXT, symbol TEXT, qty TEXT NOT NULL, cost TEXT NOT NULL, PRIMARY KEY (book, symbol));
                 CREATE TABLE marks (book TEXT, symbol TEXT, price TEXT NOT NULL, as_of TEXT NOT NULL, PRIMARY KEY (book, symbol));
                 CREATE TABLE fills (seq INTEGER PRIMARY KEY, book TEXT, id TEXT, symbol TEXT, side TEXT,
                     qty TEXT, price TEXT, submitted TEXT, quote_at TEXT, source TEXT, UNIQUE (book, id));
                 INSERT INTO accounts VALUES ('DEMO', '99000.00');
                 INSERT INTO positions VALUES ('DEMO', 'BTC/USDT', '0.5', '1000.00');
                 INSERT INTO marks VALUES ('DEMO', 'BTC/USDT', '2000', '2025-03-07T21:00:00+00:00');
                 INSERT INTO fills (book, id, symbol, side, qty, price, submitted, quote_at, source)
                     VALUES ('DEMO', 'legacy-1', 'BTC/USDT', 'buy', '0.5', '2000', '2025-03-07T21:00:05+00:00', '2025-03-07T21:00:00+00:00', 'Sample feed');",
            )
            .expect("legacy rows");
        }
        let book = PaperBook::open(&path, true).expect("opens");
        let account = book.snapshot().expect("snapshot");
        assert_eq!((account.cash, account.equity), (dec("99000"), dec("100000")));
        assert_eq!((account.holdings[0].qty, account.holdings[0].cost), (dec("0.5"), dec("1000")));
        assert_eq!(
            (account.orders[0].id.as_str(), account.orders[0].submitted.as_str()),
            ("legacy-1", "2025-03-07T21:00:05+00:00")
        );

        // A quote from this version replaces the old mark, and the position can be sold.
        book.remember(&btc()).expect("mark");
        assert_eq!(book.snapshot().expect("snapshot").holdings[0].value, dec("42107.75"));
        book.submit(&Ticket::parse("BTC/USDT", "sell", "0.5").expect("ticket"), &btc()).expect("sell");
        let account = book.snapshot().expect("snapshot");
        assert_eq!((account.cash, account.holdings.len(), account.orders.len()), (dec("141107.75"), 0, 2));
    }

    #[test]
    fn an_older_quote_never_overwrites_a_newer_mark() {
        let folder = tempfile::tempdir().expect("tempdir");
        let book = PaperBook::open(&folder.path().join("paper.sqlite3"), false).expect("book");
        let now = Utc::now();
        let newer = Quote { sample: false, as_of: now, price: dec("200"), ..btc() };
        let older =
            Quote { sample: false, as_of: now - chrono::Duration::minutes(3), price: dec("100"), ..btc() };
        book.submit(&Ticket::parse("BTC/USDT", "buy", "1").expect("ticket"), &newer).expect("fill");
        book.remember(&older).expect("ignored");
        assert_eq!(book.snapshot().expect("snapshot").holdings[0].value, dec("200"));
    }
}
