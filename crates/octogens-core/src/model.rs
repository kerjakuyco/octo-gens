//! Domain types shared by the feeds, the ledger and the assistant.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

use crate::bail;
use crate::error::Result;

/// Largest price or quantity the desk accepts. Anything above is a bad feed.
const CEILING: i64 = 1_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "buy" => Ok(Side::Buy),
            "sell" => Ok(Side::Sell),
            _ => bail!("Choose Buy or Sell."),
        }
    }
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Candle intervals every supported venue offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Timeframe {
    M15,
    H1,
    H4,
    D1,
}

impl Timeframe {
    pub const ALL: [Timeframe; 4] = [Timeframe::M15, Timeframe::H1, Timeframe::H4, Timeframe::D1];

    pub fn as_str(self) -> &'static str {
        match self {
            Timeframe::M15 => "15m",
            Timeframe::H1 => "1h",
            Timeframe::H4 => "4h",
            Timeframe::D1 => "1d",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "15m" => Ok(Timeframe::M15),
            "1h" => Ok(Timeframe::H1),
            "4h" => Ok(Timeframe::H4),
            "1d" | "d" | "daily" => Ok(Timeframe::D1),
            _ => bail!("Choose a timeframe of 15m, 1h, 4h or 1d."),
        }
    }

    pub fn millis(self) -> i64 {
        match self {
            Timeframe::M15 => 15 * 60_000,
            Timeframe::H1 => 3_600_000,
            Timeframe::H4 => 4 * 3_600_000,
            Timeframe::D1 => 86_400_000,
        }
    }

    /// Bars in a 365-day year, for annualising volatility. Crypto never closes.
    pub fn bars_per_year(self) -> f64 {
        365.0 * 86_400_000.0 / self.millis() as f64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VenueId {
    Binance,
    Bybit,
    Okx,
}

impl VenueId {
    pub const ALL: [VenueId; 3] = [VenueId::Binance, VenueId::Bybit, VenueId::Okx];

    pub fn as_str(self) -> &'static str {
        match self {
            VenueId::Binance => "binance",
            VenueId::Bybit => "bybit",
            VenueId::Okx => "okx",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            VenueId::Binance => "Binance",
            VenueId::Bybit => "Bybit",
            VenueId::Okx => "OKX",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "binance" => Ok(VenueId::Binance),
            "bybit" => Ok(VenueId::Bybit),
            "okx" => Ok(VenueId::Okx),
            _ => bail!("Unknown exchange: {raw}. Choose Binance, Bybit or OKX."),
        }
    }
}

/// Where prices come from: the fictional sample tape or a live venue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Feed {
    Sample,
    Venue(VenueId),
}

impl Feed {
    pub fn as_str(self) -> &'static str {
        match self {
            Feed::Sample => "sample",
            Feed::Venue(venue) => venue.as_str(),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Feed::Sample => "Sample tape",
            Feed::Venue(venue) => venue.name(),
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        if raw.trim().eq_ignore_ascii_case("sample") {
            return Ok(Feed::Sample);
        }
        VenueId::parse(raw).map(Feed::Venue)
    }

    pub fn venue(self) -> Option<VenueId> {
        match self {
            Feed::Sample => None,
            Feed::Venue(venue) => Some(venue),
        }
    }
}

impl Serialize for Feed {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Feed {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Feed::parse(&raw).map_err(serde::de::Error::custom)
    }
}

/// 24-hour statistics. Live venues fill these; the sample tape leaves them empty.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayStats {
    pub change_pct: Option<f64>,
    pub high: Option<Decimal>,
    pub low: Option<Decimal>,
    /// Base-unit volume.
    pub volume: Option<Decimal>,
    /// USDT volume.
    pub quote_volume: Option<Decimal>,
    pub bid: Option<Decimal>,
    pub ask: Option<Decimal>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub pair: String,
    pub price: Decimal,
    pub as_of: DateTime<Utc>,
    pub source: String,
    /// Completed daily closes strictly before the UTC date of the quote, oldest first.
    pub closes: Vec<Decimal>,
    /// True for fictional sample prices.
    pub sample: bool,
    pub stats: DayStats,
}

impl Quote {
    pub fn stamp(&self) -> String {
        self.as_of.format("%Y-%m-%d %H:%M UTC").to_string()
    }

    /// 24h change when the venue reports it, otherwise the move since the last close.
    pub fn change_pct(&self) -> Option<f64> {
        self.stats.change_pct.or_else(|| self.closes.last().and_then(|close| pct(self.price, *close)))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candle {
    /// Open time in Unix milliseconds.
    pub t: i64,
    pub o: Decimal,
    pub h: Decimal,
    pub l: Decimal,
    pub c: Decimal,
    /// Base-unit volume.
    pub v: Decimal,
}

/// Price levels as `(price, size)`, best first.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderBook {
    pub bids: Vec<(Decimal, Decimal)>,
    pub asks: Vec<(Decimal, Decimal)>,
    pub as_of: DateTime<Utc>,
}

/// A market order for a spot pair, in base units. The client id makes it idempotent.
#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    pub pair: String,
    pub side: Side,
    pub qty: Decimal,
    pub client_id: String,
}

impl Ticket {
    pub fn new(pair: &str, side: Side, qty: Decimal) -> Result<Self> {
        Self::with_id(pair, side, qty, uuid::Uuid::new_v4().simple().to_string())
    }

    pub fn with_id(pair: &str, side: Side, qty: Decimal, client_id: String) -> Result<Self> {
        if !valid_pair(pair) {
            bail!("Choose a token/USDT spot pair such as BTC/USDT.");
        }
        if qty <= Decimal::ZERO || qty >= Decimal::from(1_000_000_000) || qty.normalize().scale() > 8 {
            bail!("Quantity must be positive with up to eight decimal places.");
        }
        Ok(Self { pair: pair.to_string(), side, qty: qty.normalize(), client_id })
    }

    /// Parses user-typed text. Only plain decimals are accepted: no signs,
    /// exponents or thousands separators.
    pub fn parse(pair: &str, side: &str, raw_qty: &str) -> Result<Self> {
        Self::new(pair, Side::parse(side)?, parse_quantity(raw_qty)?)
    }

    pub fn value(&self, price: Decimal) -> Decimal {
        self.qty * price
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Holding {
    pub pair: String,
    pub qty: Decimal,
    pub value: Decimal,
    pub cost: Decimal,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Fill {
    pub id: String,
    pub pair: String,
    pub side: Side,
    pub qty: Decimal,
    pub price: Decimal,
    pub status: String,
    /// ISO-8601 UTC, second precision.
    pub submitted: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub cash: Decimal,
    pub equity: Decimal,
    pub holdings: Vec<Holding>,
    /// Most recent first.
    pub orders: Vec<Fill>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Balance {
    pub asset: String,
    pub total: Decimal,
}

/// What a venue returned after accepting a live order.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderAck {
    pub venue: VenueId,
    pub pair: String,
    pub side: Side,
    pub qty: Decimal,
    pub id: String,
    pub status: String,
    pub client_id: String,
}

fn valid_pair(pair: &str) -> bool {
    match pair.strip_suffix("/USDT") {
        Some(base) => {
            (1..=12).contains(&base.len())
                && base.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        }
        None => false,
    }
}

/// Parses a positive plain decimal with at most nine integer and eight fractional digits.
pub fn parse_quantity(raw: &str) -> Result<Decimal> {
    let text = raw.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let shaped = digits(whole)
        && digits(fraction)
        && whole.len() <= 9
        && fraction.len() <= 8
        && !(whole.is_empty() && fraction.is_empty())
        && !(text.contains('.') && fraction.is_empty());
    let value = if shaped { Decimal::from_str(&format!("0{text}")).ok() } else { None };
    match value {
        Some(value) if value > Decimal::ZERO => Ok(value),
        _ => bail!("Enter a positive quantity with up to eight decimal places."),
    }
}

/// Parses a price or size from a venue and rejects anything that cannot be a real one.
/// Trailing zeros are dropped: venues pad to eight places.
pub fn positive(raw: &str) -> Result<Decimal> {
    let value = Decimal::from_str(raw.trim()).or_else(|_| Decimal::from_scientific(raw.trim()));
    match value {
        Ok(value) if value > Decimal::ZERO && value < Decimal::from(CEILING) => Ok(value.normalize()),
        _ => bail!("The venue returned an invalid price."),
    }
}

/// Parses a non-negative amount (volumes and balances may be zero).
pub fn non_negative(raw: &str) -> Result<Decimal> {
    let value = Decimal::from_str(raw.trim()).or_else(|_| Decimal::from_scientific(raw.trim()));
    match value {
        Ok(value) if value >= Decimal::ZERO => Ok(value.normalize()),
        _ => bail!("The venue returned an invalid amount."),
    }
}

/// Percent change from `from` to `to`.
pub fn pct(to: Decimal, from: Decimal) -> Option<f64> {
    use rust_decimal::prelude::ToPrimitive;
    if from.is_zero() {
        return None;
    }
    ((to / from - Decimal::ONE) * Decimal::from(100)).to_f64()
}

/// Rounds to whole cents, half away from zero, like a ledger does.
pub fn cents(value: Decimal) -> Decimal {
    value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
}

/// Shortest exact text for a decimal: `0.5`, not `0.50000000`.
pub fn decimal_text(value: Decimal) -> String {
    value.normalize().to_string()
}

/// `1,234.56` for display in agent text.
pub fn money(value: Decimal) -> String {
    let rounded = cents(value);
    let text = format!("{:.2}", rounded.abs());
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, "00"));
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let sign = if rounded.is_sign_negative() && !rounded.is_zero() { "-" } else { "" };
    format!("{sign}{grouped}.{fraction}")
}

/// A price for display: two decimals above one USDT, full precision below.
pub fn price_text(value: Decimal) -> String {
    if value.abs() >= Decimal::ONE { money(value) } else { decimal_text(value) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(text: &str) -> Decimal {
        Decimal::from_str(text).expect("test decimal")
    }

    #[test]
    fn quantities_are_finite_positive_plain_decimals() {
        for bad in ["NaN", "Infinity", "-1", "0", "1e4", ".000000001", "1,500", "", ".", "1.", "1234567890"] {
            assert!(Ticket::parse("BTC/USDT", "buy", bad).is_err(), "{bad} should be rejected");
        }
        assert_eq!(Ticket::parse("BTC/USDT", "BUY", ".125").expect("valid").qty, dec("0.125"));
        assert_eq!(Ticket::parse("BTC/USDT", "sell", "2.50").expect("valid").qty.to_string(), "2.5");
    }

    #[test]
    fn tickets_only_accept_usdt_spot_pairs() {
        for bad in ["BTC", "BTC/USD", "btc/USDT", "/USDT", "BTC-USDT", "AVERYLONGTOKEN/USDT"] {
            assert!(Ticket::parse(bad, "buy", "1").is_err(), "{bad} should be rejected");
        }
        let ticket = Ticket::parse("TSLAX/USDT", "buy", "1").expect("valid");
        assert_eq!(ticket.client_id.len(), 32);
        assert!(ticket.client_id.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn venue_numbers_must_be_real_prices() {
        assert_eq!(positive("84215.50").expect("valid"), dec("84215.5"));
        assert_eq!(positive("1.5e-7").expect("valid"), dec("0.00000015"));
        for bad in ["0", "-3", "abc", "", "1000000000000"] {
            assert!(positive(bad).is_err(), "{bad} should be rejected");
        }
        assert_eq!(non_negative("0").expect("valid"), Decimal::ZERO);
    }

    #[test]
    fn display_helpers_format_like_a_ledger() {
        assert_eq!(money(dec("1234567.891")), "1,234,567.89");
        assert_eq!(money(dec("-0.005")), "-0.01");
        assert_eq!(money(dec("999.995")), "1,000.00");
        assert_eq!(money(dec("0")), "0.00");
        assert_eq!(price_text(dec("0.18340")), "0.1834");
        assert_eq!(cents(dec("2.345")), dec("2.35"));
        assert_eq!(decimal_text(dec("0.50000000")), "0.5");
        assert_eq!(pct(dec("110"), dec("100")), Some(10.0));
        assert_eq!(pct(dec("1"), Decimal::ZERO), None);
    }

    #[test]
    fn feeds_and_timeframes_round_trip() {
        for feed in ["sample", "binance", "bybit", "okx"] {
            assert_eq!(Feed::parse(feed).expect("valid").as_str(), feed);
        }
        assert!(Feed::parse("kraken").is_err());
        for tf in Timeframe::ALL {
            assert_eq!(Timeframe::parse(tf.as_str()).expect("valid"), tf);
        }
        assert_eq!(serde_json::to_string(&Feed::Venue(VenueId::Okx)).expect("json"), "\"okx\"");
    }
}
