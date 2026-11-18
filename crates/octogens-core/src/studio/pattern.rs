//! The pattern agent: a small rule-based trader for the paper account.
//!
//! It compares the last three daily returns with the five most similar earlier
//! patterns. If at least four of them moved the same way the next day, and the
//! average agrees, it trades up to a budget. Otherwise it holds. It only ever
//! touches the paper account, at most once per pair per quote date.

use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use rust_decimal::{Decimal, RoundingStrategy};

use super::Studio;
use super::view::{Snapshot, StepStatus, StepView, WatchView};
use crate::bail;
use crate::error::Result;
use crate::indicators::pattern_outcomes;
use crate::instruments::resolve;
use crate::ledger::check_paper_price;
use crate::model::{Side, Ticket, decimal_text, price_text};

/// How often a watch re-evaluates. It runs only while the app is open.
const WATCH_INTERVAL: Duration = Duration::from_secs(900);

/// Parses the largest value one pattern trade may have, in USDT.
fn budget(raw: &str) -> Result<Decimal> {
    let text = raw.trim();
    let (whole, cents) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let shaped = !whole.is_empty()
        && whole.len() <= 9
        && digits(whole)
        && digits(cents)
        && cents.len() <= 2
        && (text.contains('.') != cents.is_empty());
    match Decimal::from_str(text).ok().filter(|value| shaped && *value > Decimal::ZERO) {
        Some(value) => Ok(value),
        None => bail!("Enter a positive maximum trade value in USDT, with up to two decimal places."),
    }
}

impl Studio {
    /// Evaluates the pattern once and trades the paper account if it is decisive.
    async fn pattern_decision(&self, pair: &str, cap: Decimal) -> Result<String> {
        let instrument = resolve(pair)?;
        let feed = self.feed();
        let quote = self.quote(&instrument).await?;
        check_paper_price(&quote, Utc::now())?;
        let book = self.book(feed)?;
        let reading = format!(
            "{} at {} USDT, {}, {}",
            quote.pair,
            price_text(quote.price),
            quote.source,
            quote.stamp()
        );

        // One simulated fill per pair and quote date, across runs and restarts.
        let key = format!("pattern-v1:{}:{}", quote.pair, quote.as_of.date_naive());
        if let Some(prior) = book.order_by_id(&key)? {
            return Ok(format!(
                "Already traded on this quote date: {} {} {}.\n{reading}",
                prior.side,
                decimal_text(prior.qty),
                quote.pair
            ));
        }
        let outcomes = pattern_outcomes(&quote.closes);
        if outcomes.is_empty() {
            return Ok(format!("Hold: too little completed price history to compare patterns.\n{reading}"));
        }
        let up = outcomes.iter().filter(|v| **v > 0.0).count();
        let down = outcomes.iter().filter(|v| **v < 0.0).count();
        let mean = outcomes.iter().sum::<f64>() / outcomes.len() as f64;
        let evidence =
            format!("{up} of 5 past matches rose and {down} fell; mean next-session move {mean:+.2}%.");
        let side = if up >= 4 && mean > 0.0 {
            Side::Buy
        } else if down >= 4 && mean < 0.0 {
            Side::Sell
        } else {
            return Ok(format!(
                "Hold: the historical matches do not agree strongly enough.\n{evidence}\n{reading}"
            ));
        };

        let account = book.snapshot()?;
        let held = account.holdings.iter().find(|h| h.pair == quote.pair).map_or(Decimal::ZERO, |h| h.qty);
        let spendable = if side == Side::Buy { cap.min(account.cash) } else { cap };
        let mut qty = (spendable / quote.price).round_dp_with_strategy(8, RoundingStrategy::ToZero);
        if side == Side::Sell {
            qty = qty.min(held);
        }
        if qty * quote.price < Decimal::new(1, 2) {
            let reason = if side == Side::Buy {
                "not enough paper cash"
            } else {
                "nothing to sell within the trade limit"
            };
            return Ok(format!("Hold: {reason}.\n{evidence}\n{reading}"));
        }
        let ticket = Ticket::with_id(&quote.pair, side, qty, key)?;
        let fill = book.submit(&ticket, &quote)?;
        Ok(format!(
            "Paper fill: {} {} {} at {} USDT.\n{evidence}\n{reading}",
            fill.side,
            decimal_text(fill.qty),
            fill.pair,
            price_text(fill.price)
        ))
    }

    async fn pattern_run(&self, pair: &str, cap: Decimal) -> Result<String> {
        let started = Instant::now();
        let feed = self.feed();
        let outcome = self.pattern_decision(pair, cap).await;
        let ticker = resolve(pair).map(|i| i.ticker).unwrap_or_else(|_| pair.to_string());
        let step = StepView {
            name: "pattern.evaluate".to_string(),
            detail: format!("{pair}, up to {} USDT", decimal_text(cap)),
            status: if outcome.is_ok() { StepStatus::Ok } else { StepStatus::Error },
            ms: started.elapsed().as_millis() as u64,
            preview: String::new(),
        };
        let run = self.quick_run(
            "Pattern agent",
            &format!("Evaluate {ticker}"),
            feed,
            started,
            vec![step],
            &outcome,
        );
        self.record(run, false);
        outcome
    }

    /// Runs the pattern agent once.
    pub async fn run_pattern(&self, pair: &str, raw_budget: &str) -> Result<Snapshot> {
        let pair = resolve(pair)?.pair();
        self.pattern_run(&pair, budget(raw_budget)?).await?;
        Ok(self.snapshot())
    }

    /// Runs the pattern agent now and then every 15 minutes until stopped, the
    /// feed changes, or the app closes.
    pub async fn start_watch(self: &Arc<Self>, pair: &str, raw_budget: &str) -> Result<Snapshot> {
        let pair = resolve(pair)?.pair();
        let cap = budget(raw_budget)?;
        self.stop_watch();
        self.pattern_run(&pair, cap).await?;
        let plan = WatchView { pair: pair.clone(), budget: decimal_text(cap), feed: self.feed() };
        self.state().watch = Some(plan.clone());

        // A weak handle: the watch must not keep a closed studio alive.
        let studio = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(WATCH_INTERVAL).await;
                let Some(studio) = studio.upgrade() else {
                    break;
                };
                if studio.state().watch.as_ref() != Some(&plan) {
                    break;
                }
                // A failed evaluation is already in the journal; the watch carries on.
                let _ = studio.pattern_run(&plan.pair, cap).await;
                studio.notify();
            }
        });
        *self.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(task);
        Ok(self.snapshot())
    }

    pub fn stop_watch(&self) {
        if let Some(task) = self.watcher.lock().unwrap_or_else(|p| p.into_inner()).take() {
            task.abort();
        }
        self.state().watch = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_are_positive_amounts_with_at_most_two_decimals() {
        assert_eq!(budget(" 250 ").expect("valid"), Decimal::from(250));
        assert_eq!(budget("0.5").expect("valid").to_string(), "0.5");
        for bad in ["", "0", "0.00", "-5", "1.234", "1e3", "1,000", ".5", "5.", "1234567890"] {
            assert!(budget(bad).is_err(), "{bad} should be rejected");
        }
    }
}
