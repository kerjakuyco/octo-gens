//! Technical readings computed from candles.
//!
//! These are deterministic so the language model never has to do arithmetic:
//! it asks for an [`Analysis`] and reports the numbers it was given.

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde_json::{Value, json};

use crate::model::{Candle, Timeframe};

/// Fewest candles that give a meaningful reading.
pub const MIN_BARS: usize = 15;

pub fn sma(values: &[f64], period: usize) -> Option<f64> {
    if period == 0 || values.len() < period {
        return None;
    }
    Some(values[values.len() - period..].iter().sum::<f64>() / period as f64)
}

/// Exponential moving average, seeded with the simple average of the first `period` values.
pub fn ema_series(values: &[f64], period: usize) -> Vec<f64> {
    if period == 0 || values.len() < period {
        return Vec::new();
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut current = values[..period].iter().sum::<f64>() / period as f64;
    let mut series = vec![current];
    for value in &values[period..] {
        current = value * k + current * (1.0 - k);
        series.push(current);
    }
    series
}

pub fn ema(values: &[f64], period: usize) -> Option<f64> {
    ema_series(values, period).last().copied()
}

/// Wilder's relative strength index.
pub fn rsi(closes: &[f64], period: usize) -> Option<f64> {
    if period == 0 || closes.len() <= period {
        return None;
    }
    let changes: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();
    let mut gain = changes[..period].iter().filter(|c| **c > 0.0).sum::<f64>() / period as f64;
    let mut loss = -changes[..period].iter().filter(|c| **c < 0.0).sum::<f64>() / period as f64;
    for change in &changes[period..] {
        gain = (gain * (period as f64 - 1.0) + change.max(0.0)) / period as f64;
        loss = (loss * (period as f64 - 1.0) + (-change).max(0.0)) / period as f64;
    }
    if loss == 0.0 {
        return Some(if gain == 0.0 { 50.0 } else { 100.0 });
    }
    Some(100.0 - 100.0 / (1.0 + gain / loss))
}

/// MACD(12, 26, 9) as `(line, signal, histogram)`.
pub fn macd(closes: &[f64]) -> Option<(f64, f64, f64)> {
    let fast = ema_series(closes, 12);
    let slow = ema_series(closes, 26);
    if slow.is_empty() {
        return None;
    }
    // Align both series on the same closes: the slow one starts 14 bars later.
    let line: Vec<f64> = slow.iter().enumerate().map(|(i, s)| fast[i + 14] - s).collect();
    let signal = ema(&line, 9)?;
    let last = *line.last()?;
    Some((last, signal, last - signal))
}

/// Bollinger bands as `(middle, upper, lower)`.
pub fn bollinger(closes: &[f64], period: usize, width: f64) -> Option<(f64, f64, f64)> {
    let middle = sma(closes, period)?;
    let window = &closes[closes.len() - period..];
    let variance = window.iter().map(|c| (c - middle).powi(2)).sum::<f64>() / period as f64;
    let band = width * variance.sqrt();
    Some((middle, middle + band, middle - band))
}

/// Wilder's average true range over `(high, low, close)` rows.
pub fn atr(rows: &[(f64, f64, f64)], period: usize) -> Option<f64> {
    if period == 0 || rows.len() <= period {
        return None;
    }
    let ranges: Vec<f64> = rows
        .windows(2)
        .map(|w| {
            let (previous_close, (high, low, _)) = (w[0].2, w[1]);
            (high - low).max((high - previous_close).abs()).max((low - previous_close).abs())
        })
        .collect();
    let mut value = ranges[..period].iter().sum::<f64>() / period as f64;
    for range in &ranges[period..] {
        value = (value * (period as f64 - 1.0) + range) / period as f64;
    }
    Some(value)
}

/// Annualised standard deviation of log returns over the last `window` bars, in percent.
pub fn realized_volatility(closes: &[f64], window: usize, bars_per_year: f64) -> Option<f64> {
    if window < 2 || closes.len() <= window {
        return None;
    }
    let returns: Vec<f64> = closes[closes.len() - window - 1..]
        .windows(2)
        .filter(|w| w[0] > 0.0 && w[1] > 0.0)
        .map(|w| (w[1] / w[0]).ln())
        .collect();
    if returns.len() < 2 {
        return None;
    }
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let variance = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (returns.len() as f64 - 1.0);
    Some(variance.sqrt() * bars_per_year.sqrt() * 100.0)
}

/// Swing highs above and swing lows below `price`, nearest first, at most three each.
pub fn swing_levels(rows: &[(f64, f64, f64)], price: f64) -> (Vec<f64>, Vec<f64>) {
    const WING: usize = 3;
    let (mut supports, mut resistances) = (Vec::new(), Vec::new());
    if rows.len() > 2 * WING {
        for i in WING..rows.len() - WING {
            let window = &rows[i - WING..=i + WING];
            let (high, low, _) = rows[i];
            if window.iter().all(|r| r.0 <= high) && high > price {
                resistances.push(high);
            }
            if window.iter().all(|r| r.1 >= low) && low < price {
                supports.push(low);
            }
        }
    }
    let nearest = |mut levels: Vec<f64>| {
        levels.sort_by(|a, b| (a - price).abs().total_cmp(&(b - price).abs()));
        // Levels within 0.3% of each other are the same level for practical purposes.
        let mut kept: Vec<f64> = Vec::new();
        for level in levels {
            if kept.iter().all(|k| (k - level).abs() / price > 0.003) {
                kept.push(level);
            }
            if kept.len() == 3 {
                break;
            }
        }
        kept
    };
    (nearest(supports), nearest(resistances))
}

/// Next-bar returns (percent) of the five earlier three-return patterns closest to
/// the latest one. A training pattern and its outcome must both precede the query
/// window, so the comparison never sees the future.
pub fn pattern_outcomes(closes: &[Decimal]) -> Vec<f64> {
    if closes.len() < 16 {
        return Vec::new();
    }
    let returns: Vec<f64> = closes.windows(2).map(|w| crate::model::pct(w[1], w[0]).unwrap_or(0.0)).collect();
    let query = &returns[returns.len() - 3..];
    let mut ranked: Vec<(f64, usize, f64)> = (0..returns.len() - 6)
        .map(|i| {
            let distance = returns[i..i + 3].iter().zip(query).map(|(a, b)| (a - b).powi(2)).sum::<f64>();
            (distance, i, returns[i + 3])
        })
        .collect();
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    ranked.into_iter().take(5).map(|(_, _, outcome)| outcome).collect()
}

/// Rounds to six significant figures: enough for any price without float noise.
fn tidy(value: f64) -> f64 {
    if value == 0.0 || !value.is_finite() {
        return 0.0;
    }
    let magnitude = 10f64.powi(5 - value.abs().log10().floor() as i32);
    (value * magnitude).round() / magnitude
}

fn two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn pct_between(to: f64, from: f64) -> Option<f64> {
    (from != 0.0).then(|| two((to / from - 1.0) * 100.0))
}

/// A full technical reading of one pair on one timeframe.
#[derive(Clone, Debug, PartialEq)]
pub struct Analysis {
    pub pair: String,
    pub timeframe: Timeframe,
    pub source: String,
    pub sample: bool,
    pub bars: usize,
    pub price: f64,
    /// `(bars back, percent change)`.
    pub returns: Vec<(usize, f64)>,
    pub ema20: Option<f64>,
    pub ema50: Option<f64>,
    pub ema200: Option<f64>,
    pub trend: &'static str,
    pub rsi14: Option<f64>,
    pub macd: Option<(f64, f64, f64)>,
    pub bollinger: Option<(f64, f64, f64)>,
    pub atr14: Option<f64>,
    pub volatility: Option<f64>,
    pub high20: Option<f64>,
    pub low20: Option<f64>,
    pub high60: Option<f64>,
    pub low60: Option<f64>,
    pub supports: Vec<f64>,
    pub resistances: Vec<f64>,
    pub volume_ratio: Option<f64>,
    /// Daily timeframe only; see [`pattern_outcomes`].
    pub pattern: Vec<f64>,
}

/// Reads `candles` (oldest first). `price` is the latest traded price, which may
/// differ from the last close when the newest candle is still forming.
pub fn analyze(
    pair: &str,
    timeframe: Timeframe,
    candles: &[Candle],
    price: Decimal,
    source: &str,
    sample: bool,
) -> Analysis {
    let f = |d: Decimal| d.to_f64().unwrap_or(0.0);
    let closes: Vec<f64> = candles.iter().map(|c| f(c.c)).collect();
    let rows: Vec<(f64, f64, f64)> = candles.iter().map(|c| (f(c.h), f(c.l), f(c.c))).collect();
    let volumes: Vec<f64> = candles.iter().map(|c| f(c.v)).collect();
    let price = f(price);

    let extreme = |n: usize, high: bool| -> Option<f64> {
        (rows.len() >= n).then(|| {
            let window = rows[rows.len() - n..].iter();
            if high {
                window.map(|r| r.0).fold(f64::MIN, f64::max)
            } else {
                window.map(|r| r.1).fold(f64::MAX, f64::min)
            }
        })
    };
    let (ema20, ema50, ema200) = (ema(&closes, 20), ema(&closes, 50), ema(&closes, 200));
    let trend = match (ema20, ema50) {
        (Some(fast), Some(slow)) if price > fast && fast > slow => "uptrend",
        (Some(fast), Some(slow)) if price < fast && fast < slow => "downtrend",
        (Some(_), Some(_)) => "mixed",
        _ => "not enough history",
    };
    let returns = [1usize, 5, 20, 60]
        .into_iter()
        .filter(|n| closes.len() > *n)
        .filter_map(|n| pct_between(price, closes[closes.len() - 1 - n]).map(|p| (n, p)))
        .collect();
    let (supports, resistances) = swing_levels(&rows, price);
    let volume_ratio = match (volumes.len() > 21, sma(&volumes[..volumes.len().saturating_sub(1)], 20)) {
        // The newest candle may still be forming, so compare the last completed one.
        (true, Some(average)) if average > 0.0 => Some(two(volumes[volumes.len() - 2] / average)),
        _ => None,
    };
    let pattern = if timeframe == Timeframe::D1 {
        let completed: Vec<Decimal> =
            candles.iter().take(candles.len().saturating_sub(1)).map(|c| c.c).collect();
        pattern_outcomes(&completed)
    } else {
        Vec::new()
    };

    Analysis {
        pair: pair.to_string(),
        timeframe,
        source: source.to_string(),
        sample,
        bars: candles.len(),
        price,
        returns,
        ema20,
        ema50,
        ema200,
        trend,
        rsi14: rsi(&closes, 14),
        macd: macd(&closes),
        bollinger: bollinger(&closes, 20, 2.0),
        atr14: atr(&rows, 14),
        volatility: realized_volatility(&closes, 30, timeframe.bars_per_year()),
        high20: extreme(20, true),
        low20: extreme(20, false),
        high60: extreme(60, true),
        low60: extreme(60, false),
        supports,
        resistances,
        volume_ratio,
        pattern,
    }
}

impl Analysis {
    /// Compact JSON for the model. Absent readings are `null`, never guessed.
    pub fn to_json(&self) -> Value {
        let price = |v: Option<f64>| v.map(tidy);
        let against = |level: Option<f64>| level.and_then(|l| pct_between(self.price, l));
        let returns: Vec<Value> =
            self.returns.iter().map(|(bars, pct)| json!({"bars_back": bars, "pct": pct})).collect();
        let pattern = if self.pattern.is_empty() {
            Value::Null
        } else {
            let mean = self.pattern.iter().sum::<f64>() / self.pattern.len() as f64;
            json!({
                "closest_matches": self.pattern.len(),
                "rose_next_day": self.pattern.iter().filter(|v| **v > 0.0).count(),
                "fell_next_day": self.pattern.iter().filter(|v| **v < 0.0).count(),
                "mean_next_day_pct": two(mean),
                "note": "Historical examples only. Five matches are not a probability.",
            })
        };
        json!({
            "pair": self.pair,
            "timeframe": self.timeframe.as_str(),
            "source": self.source,
            "sample_data": self.sample,
            "bars": self.bars,
            "price": tidy(self.price),
            "returns": returns,
            "trend": {
                "label": self.trend,
                "ema20": price(self.ema20),
                "ema50": price(self.ema50),
                "ema200": price(self.ema200),
                "price_vs_ema20_pct": against(self.ema20),
                "price_vs_ema50_pct": against(self.ema50),
                "price_vs_ema200_pct": against(self.ema200),
            },
            "momentum": {
                "rsi14": self.rsi14.map(two),
                "macd": self.macd.map(|(line, signal, histogram)| json!({
                    "line": tidy(line), "signal": tidy(signal), "histogram": tidy(histogram),
                })),
            },
            "volatility": {
                "atr14": price(self.atr14),
                "atr14_pct_of_price": self.atr14.and_then(|a| (self.price != 0.0).then(|| two(a / self.price * 100.0))),
                "realized_annual_pct": self.volatility.map(two),
                "bollinger20": self.bollinger.map(|(middle, upper, lower)| json!({
                    "upper": tidy(upper), "middle": tidy(middle), "lower": tidy(lower),
                    "percent_b": (upper != lower).then(|| two((self.price - lower) / (upper - lower))),
                })),
            },
            "range": {
                "high_20_bars": price(self.high20),
                "low_20_bars": price(self.low20),
                "high_60_bars": price(self.high60),
                "low_60_bars": price(self.low60),
                "below_60_bar_high_pct": against(self.high60),
            },
            "levels": {
                "support": self.supports.iter().map(|v| tidy(*v)).collect::<Vec<_>>(),
                "resistance": self.resistances.iter().map(|v| tidy(*v)).collect::<Vec<_>>(),
            },
            "last_completed_volume_vs_20_bar_average": self.volume_ratio,
            "daily_pattern_matches": pattern,
        })
    }

    /// A few plain sentences for the built-in agents, which have no model to phrase them.
    pub fn summary(&self) -> String {
        let mut lines = Vec::new();
        if let Some((bars, change)) = self.returns.iter().find(|(bars, _)| *bars == 5) {
            let span = match self.timeframe {
                Timeframe::M15 => "15-minute",
                Timeframe::H1 => "hourly",
                Timeframe::H4 => "4-hour",
                Timeframe::D1 => "daily",
            };
            lines.push(format!("Change over {bars} {span} bars: {change:+.2}%."));
        }
        if let (Some(fast), Some(slow)) = (self.ema20, self.ema50) {
            lines.push(format!("Trend: {} (EMA20 {}, EMA50 {}).", self.trend, tidy(fast), tidy(slow)));
        }
        if let Some(value) = self.rsi14 {
            let read = if value >= 70.0 {
                "stretched to the upside"
            } else if value <= 30.0 {
                "stretched to the downside"
            } else {
                "neutral"
            };
            lines.push(format!("RSI(14) {value:.1}, {read}."));
        }
        if let Some(value) = self.atr14.filter(|_| self.price != 0.0) {
            lines.push(format!("Average true range {:.2}% of price.", value / self.price * 100.0));
        }
        if !self.pattern.is_empty() {
            let rose = self.pattern.iter().filter(|v| **v > 0.0).count();
            lines.push(format!(
                "{rose} of {} closest historical patterns rose the next session (examples, not odds).",
                self.pattern.len()
            ));
        }
        if lines.is_empty() {
            lines.push("Too little price history for a technical reading.".to_string());
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::resolve;
    use crate::sample::sample_candles;

    fn near(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
    }

    #[test]
    fn moving_averages_match_hand_calculations() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0];
        near(sma(&values, 3).expect("sma"), 4.0);
        assert_eq!(sma(&values, 6), None);
        // Seed = mean(1,2,3) = 2; k = 0.5; then 4*0.5+2*0.5 = 3; 5*0.5+3*0.5 = 4.
        near(ema(&values, 3).expect("ema"), 4.0);
        assert!(ema_series(&values, 9).is_empty());
    }

    #[test]
    fn rsi_reads_one_sided_and_balanced_markets() {
        let rising: Vec<f64> = (1..=30).map(f64::from).collect();
        near(rsi(&rising, 14).expect("rsi"), 100.0);
        let falling: Vec<f64> = (1..=30).rev().map(f64::from).collect();
        near(rsi(&falling, 14).expect("rsi"), 0.0);
        near(rsi(&[5.0; 30], 14).expect("rsi"), 50.0);
        let zigzag: Vec<f64> = (0..40).map(|i| if i % 2 == 0 { 100.0 } else { 101.0 }).collect();
        let value = rsi(&zigzag, 14).expect("rsi");
        assert!((40.0..60.0).contains(&value), "{value}");
        assert_eq!(rsi(&rising[..14], 14), None);
    }

    #[test]
    fn bands_range_and_volatility_are_exact_on_simple_series() {
        let (middle, upper, lower) = bollinger(&[10.0; 20], 20, 2.0).expect("bands");
        assert_eq!((middle, upper, lower), (10.0, 10.0, 10.0));
        // Constant 2-point bars that never gap: true range is always 2.
        let rows: Vec<(f64, f64, f64)> = (0..30).map(|_| (11.0, 9.0, 10.0)).collect();
        near(atr(&rows, 14).expect("atr"), 2.0);
        near(realized_volatility(&[10.0; 40], 30, 365.0).expect("vol"), 0.0);
        let (line, signal, histogram) = macd(&[7.0; 60]).expect("macd");
        assert_eq!((line, signal, histogram), (0.0, 0.0, 0.0));
        assert_eq!(macd(&[7.0; 20]), None);
    }

    #[test]
    fn swing_levels_are_nearest_first_and_on_the_correct_side() {
        let mut rows: Vec<(f64, f64, f64)> = (0..40).map(|_| (101.0, 99.0, 100.0)).collect();
        rows[10] = (120.0, 99.0, 100.0);
        rows[20] = (110.0, 99.0, 100.0);
        rows[30] = (101.0, 80.0, 100.0);
        let (supports, resistances) = swing_levels(&rows, 100.0);
        assert_eq!(resistances[..2], [101.0, 110.0]);
        assert!(supports.contains(&80.0) && supports.iter().all(|s| *s < 100.0));
    }

    #[test]
    fn the_pattern_model_does_not_train_on_the_query_outcome() {
        let mut closes = vec![Decimal::from(100); 13];
        closes.extend([200, 400, 800].map(Decimal::from));
        assert_eq!(pattern_outcomes(&closes), vec![0.0; 5]);
        assert!(pattern_outcomes(&closes[..4]).is_empty());
    }

    #[test]
    fn analysis_reports_every_reading_with_enough_history_and_nulls_without() {
        let btc = resolve("BTC").expect("btc");
        let candles = sample_candles(&btc, Timeframe::D1, 240).expect("candles");
        let price = candles[239].c;
        let full = analyze("BTC/USDT", Timeframe::D1, &candles, price, "Sample tape", true);
        let json = full.to_json();
        assert_eq!(json["sample_data"], true);
        for path in [
            "/trend/ema200",
            "/momentum/rsi14",
            "/momentum/macd/line",
            "/volatility/atr14",
            "/range/high_60_bars",
        ] {
            assert!(json.pointer(path).is_some_and(|v| v.is_number()), "{path} missing in {json}");
        }
        assert_eq!(json["daily_pattern_matches"]["closest_matches"], 5);
        assert!(full.summary().contains("RSI(14)"));

        let short = analyze("BTC/USDT", Timeframe::H1, &candles[..10], price, "Sample tape", true);
        let json = short.to_json();
        assert!(json["trend"]["ema20"].is_null() && json["momentum"]["rsi14"].is_null());
        assert!(json["daily_pattern_matches"].is_null());
        assert_eq!(short.trend, "not enough history");
        assert!(short.summary().contains("Change over") || short.summary().contains("Too little"));
    }
}
