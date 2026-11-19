//! Reads live market data from the exchange the way the desk does, on both networks:
//! the watchlist, the screener, and everything the market panel shows. It is
//! read-only: no wallet and no model are connected, and nothing is signed or sent.
//!
//!     cargo run -p octogens-core --example probe
//!
//! Useful to check that exchange is reachable from your network and that its
//! answers still parse after a change to the client.

use std::sync::Arc;

use octogens_core::model::Network;
use octogens_core::store::MemorySecrets;
use octogens_core::studio::view::Snapshot;
use octogens_core::studio::{Studio, StudioConfig};

fn report(title: &str, snapshot: &Snapshot) {
    println!("\n== {title} ==");
    if !snapshot.feed_error.is_empty() {
        println!("feed error: {}", snapshot.feed_error);
    }
    for instrument in &snapshot.instruments {
        match snapshot.quotes.get(&instrument.symbol) {
            Some(quote) => println!(
                "{:<12} last {:>12}  mark {:>12}  24h {:>7}  funding {:>9}  closes {:>2}  {}",
                instrument.symbol,
                quote.price,
                quote.mark_price.as_deref().unwrap_or("-"),
                quote.change_pct.map_or("-".to_string(), |change| format!("{change:+.2}%")),
                quote.funding_rate_pct.map_or("-".to_string(), |rate| format!("{rate:+.4}%")),
                quote.closes.len(),
                quote.as_of,
            ),
            None => println!("{:<12} no quote", instrument.symbol),
        }
    }
}

/// What the market panel reads for one market. Each part is reported on its
/// own, so one endpoint that changed does not hide the others.
async fn panel(studio: &Studio, symbol: &str) {
    match studio.market_overview().await {
        Ok(rows) => {
            let mut movers: Vec<_> = rows.iter().filter(|row| row.change_pct.is_some()).collect();
            movers.sort_by(|a, b| b.change_pct.unwrap_or(0.0).total_cmp(&a.change_pct.unwrap_or(0.0)));
            let top: Vec<String> = movers
                .iter()
                .take(3)
                .map(|row| format!("{} {:+.2}%", row.symbol, row.change_pct.unwrap_or(0.0)))
                .collect();
            println!("screener: {} markets; strongest {}", rows.len(), top.join(", "));
        }
        Err(error) => println!("screener: {error}"),
    }
    match studio.order_book(symbol).await {
        Ok(book) => println!(
            "{symbol} book: mid {}, spread {} bps, {} + {} levels, {}% of resting size on the bid",
            book.mid,
            book.spread_bps.map_or("-".to_string(), |bps| format!("{bps:.2}")),
            book.bids.len(),
            book.asks.len(),
            book.bid_share_pct.map_or("-".to_string(), |share| format!("{share:.1}")),
        ),
        Err(error) => println!("{symbol} book: {error}"),
    }
    match studio.recent_trades(symbol).await {
        Ok(tape) => match tape.first() {
            Some(last) => {
                println!(
                    "{symbol} tape: {} trades, last {} {} at {}",
                    tape.len(),
                    last.side,
                    last.size,
                    last.price
                )
            }
            None => println!("{symbol} tape: empty"),
        },
        Err(error) => println!("{symbol} tape: {error}"),
    }
    match studio.market_funding(symbol).await {
        Ok(funding) => println!(
            "{symbol} funding: {}% every {} h ({}% a year), {} settled rates, open interest {} ({} in quote)",
            funding.rate_pct.map_or("-".to_string(), |rate| format!("{rate:+.4}")),
            funding.interval_hours.map_or("-".to_string(), |hours| hours.to_string()),
            funding.annual_pct.map_or("-".to_string(), |annual| format!("{annual:+.2}")),
            funding.history.len(),
            funding.open_interest.as_deref().unwrap_or("-"),
            funding.open_interest_value.as_deref().unwrap_or("-"),
        ),
        Err(error) => println!("{symbol} funding: {error}"),
    }
    match studio.market_technicals(symbol).await {
        Ok(technicals) => {
            for frame in &technicals.frames {
                println!(
                    "{symbol} {:<3} {:?}, RSI {}, ATR {}%, support {:?}, resistance {:?}",
                    frame.timeframe,
                    frame.trend,
                    frame.rsi14.map_or("-".to_string(), |rsi| format!("{rsi:.1}")),
                    frame.atr_pct.map_or("-".to_string(), |atr| format!("{atr:.2}")),
                    frame.support,
                    frame.resistance,
                );
            }
        }
        Err(error) => println!("{symbol} technicals: {error}"),
    }
}

#[tokio::main]
async fn main() -> Result<(), octogens_core::DeskError> {
    let folder = std::env::temp_dir().join(format!("octogens-probe-{}", std::process::id()));
    let studio = Studio::open(StudioConfig::new(folder.clone(), Arc::new(MemorySecrets::default())))?;

    let snapshot = studio.boot().await?;
    report("Mainnet", &snapshot);
    let series = studio.candles(&snapshot.focus, "4h").await?;
    let last = series.rows.last().map(|row| row.4.clone()).unwrap_or_default();
    println!(
        "{} {} candles: {} rows, last close {last} ({})",
        series.symbol,
        series.timeframe,
        series.rows.len(),
        series.source
    );
    panel(&studio, &snapshot.focus).await;

    match studio.set_network(Network::Testnet).await {
        Ok(snapshot) => {
            report("Testnet", &snapshot);
            panel(&studio, &snapshot.focus).await;
        }
        Err(error) => println!("\n== Testnet ==\nunreachable: {error}"),
    }

    studio.close().await;
    let _ = std::fs::remove_dir_all(folder);
    Ok(())
}
