//! Reads live public market data through an exchange adapter.
//!
//! ```sh
//! cargo run -p octogens-core --example probe -- binance BTC
//! ```
//!
//! No API keys are involved. Use it to check an adapter against the real venue
//! after changing it, or to see whether a token is listed.

use octogens_core::instruments::resolve;
use octogens_core::model::{Timeframe, VenueId};
use octogens_core::net::http_client;
use octogens_core::venues::VenueClient;

#[tokio::main]
async fn main() -> Result<(), octogens_core::DeskError> {
    let mut args = std::env::args().skip(1);
    let venue = VenueId::parse(&args.next().unwrap_or_else(|| "binance".to_string()))?;
    let instrument = resolve(&args.next().unwrap_or_else(|| "BTC".to_string()))?;
    let client = VenueClient::new(venue, http_client()?);

    println!("{} on {}: listed = {}", instrument.pair(), venue.name(), client.listed(&instrument).await?);
    let quote = client.quote(&instrument).await?;
    println!(
        "price {} at {} ({} daily closes, 24h change {:?}%)",
        quote.price,
        quote.stamp(),
        quote.closes.len(),
        quote.stats.change_pct
    );
    println!(
        "24h high {:?} low {:?} volume {:?} bid {:?} ask {:?}",
        quote.stats.high, quote.stats.low, quote.stats.volume, quote.stats.bid, quote.stats.ask
    );
    for timeframe in Timeframe::ALL {
        let candles = client.candles(&instrument, timeframe, 5).await?;
        let last =
            candles.last().map(|c| format!("t={} o={} h={} l={} c={} v={}", c.t, c.o, c.h, c.l, c.c, c.v));
        println!("{:>3}: {} candles, newest {}", timeframe.as_str(), candles.len(), last.unwrap_or_default());
    }
    let book = client.depth(&instrument, 5).await?;
    println!(
        "best bid {:?}, best ask {:?}, {} x {} levels",
        book.bids.first(),
        book.asks.first(),
        book.bids.len(),
        book.asks.len()
    );
    Ok(())
}
