//! The sample tape: reproducible, fictional prices so the desk works offline.
//!
//! Nothing here is market data. Every quote and candle from this module is
//! flagged `sample`, carries a fixed timestamp, and must be labeled as sample
//! data wherever it is shown or summarised.

use chrono::{DateTime, TimeZone, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;

use crate::bail;
use crate::error::Result;
use crate::instruments::Instrument;
use crate::model::{Candle, DayStats, Quote, Timeframe};

pub const SAMPLE_SOURCE: &str = "Sample tape";
const DAILY_SWING: f64 = 0.0255;

/// The fixed moment the sample tape is frozen at.
pub fn sample_clock() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2025, 3, 7, 21, 0, 0).single().unwrap_or_default()
}

/// SplitMix64: tiny, deterministic, and identical on every platform.
struct Rng(u64);

impl Rng {
    fn seeded(text: &str) -> Self {
        // FNV-1a over the seed text.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in text.bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
        }
        Self(hash)
    }

    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn anchor(instrument: &Instrument) -> Result<Decimal> {
    match instrument.sample {
        Some(price) => Ok(price),
        None => bail!(
            "{} has no sample data. Switch the feed to Binance, Bybit or OKX to research it.",
            instrument.pair()
        ),
    }
}

fn price_scale(anchor: Decimal) -> u32 {
    if anchor >= Decimal::from(10) {
        2
    } else if anchor >= Decimal::new(1, 1) {
        4
    } else {
        6
    }
}

/// `limit` fictional candles ending at the sample clock. The last close is the
/// instrument's anchor price, so quotes and candles always agree.
pub fn sample_candles(instrument: &Instrument, timeframe: Timeframe, limit: usize) -> Result<Vec<Candle>> {
    let anchor = anchor(instrument)?;
    let limit = limit.clamp(2, 500);
    let swing = DAILY_SWING / (86_400_000.0 / timeframe.millis() as f64).sqrt();
    let mut rng = Rng::seeded(&format!("{}:{}", instrument.pair(), timeframe.as_str()));

    // A random walk with a slow cycle, built forwards then rescaled to end on the anchor.
    let mut levels = vec![1.0_f64];
    let mut wicks = Vec::with_capacity(limit);
    for i in 0..limit {
        let step = (rng.unit() * 2.0 - 1.0) * swing + 0.16 * swing * (i as f64 / 3.0).sin();
        levels.push(levels[i] * (1.0 + step));
        wicks.push((rng.unit(), rng.unit(), rng.unit()));
    }
    let last = levels[limit];
    let scale = price_scale(anchor);
    let price = |level: f64| -> Decimal {
        let ratio = Decimal::from_f64(level / last).unwrap_or(Decimal::ONE);
        (anchor * ratio).round_dp(scale).max(Decimal::new(1, scale))
    };
    let turnover = Decimal::from(4_000_000)
        * Decimal::from_f64(timeframe.millis() as f64 / 86_400_000.0).unwrap_or(Decimal::ONE);
    let end = sample_clock().timestamp_millis() / timeframe.millis() * timeframe.millis();

    let mut candles = Vec::with_capacity(limit);
    for i in 0..limit {
        let (up, down, flow) = wicks[i];
        let open = price(levels[i]);
        let close = if i + 1 == limit { anchor } else { price(levels[i + 1]) };
        let high = price(levels[i].max(levels[i + 1]) * (1.0 + up * swing * 0.6)).max(open).max(close);
        let low = price(levels[i].min(levels[i + 1]) * (1.0 - down * swing * 0.6)).min(open).min(close);
        let volume =
            (turnover * Decimal::from_f64(0.6 + flow * 0.8).unwrap_or(Decimal::ONE) / close).round_dp(4);
        let t = end - (limit - 1 - i) as i64 * timeframe.millis();
        candles.push(Candle { t, o: open, h: high, l: low, c: close, v: volume });
    }
    Ok(candles)
}

/// The sample quote: anchor price plus 64 completed fictional daily closes.
pub fn sample_quote(instrument: &Instrument) -> Result<Quote> {
    let candles = sample_candles(instrument, Timeframe::D1, 65)?;
    let (current, completed) = match candles.split_last() {
        Some(parts) => parts,
        None => bail!("The sample tape is empty."),
    };
    Ok(Quote {
        pair: instrument.pair(),
        price: current.c,
        as_of: sample_clock(),
        source: SAMPLE_SOURCE.to_string(),
        closes: completed.iter().map(|c| c.c).collect(),
        sample: true,
        stats: DayStats::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::resolve;

    #[test]
    fn the_tape_is_reproducible_and_ends_on_the_anchor() {
        let btc = resolve("BTC").expect("btc");
        let first = sample_quote(&btc).expect("quote");
        assert_eq!(first, sample_quote(&btc).expect("quote"));
        assert_eq!(first.price.to_string(), "84215.50");
        assert_eq!(first.closes.len(), 64);
        assert!(first.sample && first.source == SAMPLE_SOURCE);
        assert_ne!(first.closes, sample_quote(&resolve("ETH").expect("eth")).expect("quote").closes);
    }

    #[test]
    fn candles_are_well_formed_on_every_timeframe_and_price_scale() {
        for symbol in ["BTC", "DOGE", "XRP"] {
            let instrument = resolve(symbol).expect(symbol);
            for timeframe in Timeframe::ALL {
                let candles = sample_candles(&instrument, timeframe, 120).expect("candles");
                assert_eq!(candles.len(), 120);
                assert_eq!(candles[119].c, instrument.sample.expect("anchor"));
                for pair in candles.windows(2) {
                    assert_eq!(pair[1].t - pair[0].t, timeframe.millis());
                    assert_eq!(
                        pair[1].o,
                        pair[0].c,
                        "{symbol} {} opens on the prior close",
                        timeframe.as_str()
                    );
                }
                for c in &candles {
                    assert!(
                        c.l <= c.o.min(c.c)
                            && c.h >= c.o.max(c.c)
                            && c.l > Decimal::ZERO
                            && c.v > Decimal::ZERO
                    );
                }
            }
        }
    }

    #[test]
    fn custom_tokens_have_no_sample_data() {
        let error = sample_quote(&resolve("PEPE").expect("custom")).expect_err("no sample");
        assert!(error.to_string().contains("no sample data"));
    }
}
