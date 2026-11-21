//! Domain types shared by the market feed, the account and the assistant.
//!
//! Everything here describes the exchange's perpetual futures. Money is always a
//! [`Decimal`]; floats are for percentages and indicators only.

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

use crate::bail;
use crate::error::Result;

/// Largest price or quantity the desk accepts. Anything above is a bad feed.
const CEILING: i64 = 1_000_000_000_000;
/// Largest balance, position size or volume the desk accepts.
const AMOUNT_CEILING: i64 = 1_000_000_000_000_000;

/// Which network the desk is on. Testnet is the practice network: same
/// order flow, test funds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    pub const ALL: [Network; 2] = [Network::Mainnet, Network::Testnet];

    pub fn as_str(self) -> &'static str {
        match self {
            Network::Mainnet => "mainnet",
            Network::Testnet => "testnet",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Network::Mainnet => "Mainnet",
            Network::Testnet => "Testnet",
        }
    }

    /// How market data from this network is labelled.
    pub fn source(self) -> &'static str {
        match self {
            Network::Mainnet => "Mainnet",
            Network::Testnet => "Testnet",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "mainnet" => Ok(Network::Mainnet),
            "testnet" => Ok(Network::Testnet),
            _ => bail!("Choose Mainnet or Testnet."),
        }
    }
}

/// The side of an order. Buying opens or adds to a long and reduces a short;
/// selling does the opposite.
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

    /// The value the exchange's API expects.
    pub fn venue(self) -> &'static str {
        match self {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        }
    }

    pub fn opposite(self) -> Self {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }

    /// The direction a position opened with this side has.
    pub fn direction(self) -> &'static str {
        match self {
            Side::Buy => "long",
            Side::Sell => "short",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "buy" | "long" => Ok(Side::Buy),
            "sell" | "short" => Ok(Side::Sell),
            _ => bail!("Choose Buy (long) or Sell (short)."),
        }
    }
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Candle intervals the desk offers.
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

    /// Bars in a 365-day year, for annualising volatility. Perpetuals never close.
    pub fn bars_per_year(self) -> f64 {
        365.0 * 86_400_000.0 / self.millis() as f64
    }
}

/// A perpetual market and the trading rules the exchange publishes for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Market {
    /// Exchange symbol, e.g. `BTCUSDT`.
    pub symbol: String,
    pub base: String,
    /// Quote and margin asset.
    pub quote: String,
    /// Smallest price increment.
    pub tick: Decimal,
    /// Quantity increment for market orders.
    pub step: Decimal,
    pub min_qty: Decimal,
    /// Largest quantity one market order may have.
    pub max_qty: Decimal,
    /// Smallest order value in the quote asset.
    pub min_notional: Decimal,
    /// Maintenance margin as a fraction of position value at the lowest tier.
    pub maint_margin: Decimal,
    /// The exchange takes a market buy only while the best ask is at most this multiple of the
    /// mark price. `None` where it publishes no such band.
    pub band_up: Option<Decimal>,
    /// The exchange takes a market sell only while the best bid is at least this multiple of the
    /// mark price. `None` where it publishes no such band.
    pub band_down: Option<Decimal>,
}

impl Market {
    /// Rounds a quantity down to the market's step, the only direction that
    /// can never spend more than was asked for.
    pub fn floor_qty(&self, qty: Decimal) -> Decimal {
        if self.step.is_zero() {
            return qty.normalize();
        }
        // A step too small to divide by is a broken listing; no quantity fits it.
        let steps = qty.checked_div(self.step).map(|steps| steps.floor());
        steps
            .and_then(|steps| steps.checked_mul(self.step))
            .map_or(Decimal::ZERO, |fitted| fitted.normalize())
    }

    /// Rounds a trigger price to the market's tick.
    pub fn round_price(&self, price: Decimal) -> Decimal {
        if self.tick.is_zero() {
            return price.normalize();
        }
        let ticks = price
            .checked_div(self.tick)
            .map(|ticks| ticks.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero));
        ticks.and_then(|ticks| ticks.checked_mul(self.tick)).unwrap_or(price).normalize()
    }
}

/// 24-hour statistics of a market.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayStats {
    pub change_pct: Option<f64>,
    pub high: Option<Decimal>,
    pub low: Option<Decimal>,
    /// Base-unit volume.
    pub volume: Option<Decimal>,
    /// Quote-asset volume.
    pub quote_volume: Option<Decimal>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub symbol: String,
    /// Last traded price.
    pub price: Decimal,
    /// Mark price: what liquidations and unrealized P/L are computed from.
    pub mark: Option<Decimal>,
    pub index: Option<Decimal>,
    /// Current funding rate as a fraction per interval. Positive: longs pay shorts.
    pub funding_rate: Option<Decimal>,
    pub next_funding: Option<DateTime<Utc>>,
    pub as_of: DateTime<Utc>,
    pub source: String,
    /// Completed daily closes strictly before the UTC date of the quote, oldest first.
    pub closes: Vec<Decimal>,
    pub stats: DayStats,
}

impl Quote {
    pub fn stamp(&self) -> String {
        self.as_of.format("%Y-%m-%d %H:%M UTC").to_string()
    }

    /// The price estimates should use: the mark when known, otherwise the last trade.
    pub fn reference(&self) -> Decimal {
        self.mark.unwrap_or(self.price)
    }

    /// 24h change when reported, otherwise the move since the last daily close.
    pub fn change_pct(&self) -> Option<f64> {
        self.stats.change_pct.or_else(|| self.closes.last().and_then(|close| pct(self.price, *close)))
    }

    /// Funding rate in percent per interval, e.g. `0.01`.
    pub fn funding_pct(&self) -> Option<f64> {
        use rust_decimal::prelude::ToPrimitive;
        self.funding_rate.and_then(|rate| rate.checked_mul(Decimal::from(100))).and_then(|pct| pct.to_f64())
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

#[derive(Clone, Debug, PartialEq)]
pub struct AssetBalance {
    pub asset: String,
    pub balance: Decimal,
    pub available: Decimal,
}

/// An open position in one-way mode.
#[derive(Clone, Debug, PartialEq)]
pub struct Position {
    pub symbol: String,
    /// Signed size in base units: positive is long, negative is short.
    pub amount: Decimal,
    pub entry_price: Decimal,
    pub mark_price: Decimal,
    /// `None` when the venue reports no liquidation price.
    pub liquidation_price: Option<Decimal>,
    pub leverage: u32,
    pub isolated: bool,
    pub unrealized_pnl: Decimal,
    /// Signed position value in the quote asset.
    pub notional: Decimal,
    /// Margin assigned to an isolated position; zero for cross.
    pub isolated_margin: Decimal,
}

impl Position {
    pub fn is_long(&self) -> bool {
        self.amount > Decimal::ZERO
    }

    /// The side of an order that reduces this position.
    pub fn closing_side(&self) -> Side {
        if self.is_long() { Side::Sell } else { Side::Buy }
    }

    /// Margin held by the position: the isolated margin, or value over leverage for cross.
    pub fn margin(&self) -> Decimal {
        if self.isolated && !self.isolated_margin.is_zero() {
            return self.isolated_margin;
        }
        if self.leverage == 0 {
            Decimal::ZERO
        } else {
            cents(self.notional.abs() / Decimal::from(self.leverage))
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenOrder {
    pub id: String,
    pub client_id: String,
    pub symbol: String,
    pub side: Side,
    /// Venue order type, e.g. `LIMIT` or `STOP_MARKET`.
    pub kind: String,
    pub price: Option<Decimal>,
    pub stop_price: Option<Decimal>,
    pub qty: Decimal,
    pub filled: Decimal,
    pub reduce_only: bool,
    pub status: String,
    pub time: DateTime<Utc>,
}

/// The futures account of a wallet. Totals are in USDT.
#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    /// Wallet balance plus unrealized P/L.
    pub equity: Decimal,
    pub wallet_balance: Decimal,
    /// Free to open new positions.
    pub available: Decimal,
    pub unrealized_pnl: Decimal,
    /// Initial margin in use by positions and open orders.
    pub margin_used: Decimal,
    pub balances: Vec<AssetBalance>,
    /// Non-zero positions only.
    pub positions: Vec<Position>,
    pub orders: Vec<OpenOrder>,
    /// The account is in the exchange's Multi-Assets mode: every asset backs every position, and a
    /// position can only use cross margin. The exchange refuses isolated margin in this mode.
    pub multi_assets: bool,
    pub as_of: DateTime<Utc>,
}

impl Account {
    pub fn position(&self, symbol: &str) -> Option<&Position> {
        self.positions.iter().find(|p| p.symbol == symbol)
    }
}

/// What the exchange returned after accepting an order.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderAck {
    pub order_id: String,
    pub client_id: String,
    pub symbol: String,
    pub status: String,
    pub executed_qty: Decimal,
    /// Average fill price; zero until something has filled.
    pub avg_price: Decimal,
}

/// Parses a positive plain decimal with at most nine integer and eight fractional digits.
/// Only plain decimals are accepted: no signs, exponents or thousands separators.
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
        _ => bail!("Enter a positive number with up to eight decimal places."),
    }
}

/// Parses a price or size from the venue and rejects anything that cannot be a real one.
/// Trailing zeros are dropped: venues pad their decimals.
pub fn positive(raw: &str) -> Result<Decimal> {
    let value = Decimal::from_str(raw.trim()).or_else(|_| Decimal::from_scientific(raw.trim()));
    match value {
        Ok(value) if value > Decimal::ZERO && value < Decimal::from(CEILING) => Ok(value.normalize()),
        _ => bail!("The exchange returned an invalid price."),
    }
}

/// Parses a non-negative amount (volumes and balances may be zero).
pub fn non_negative(raw: &str) -> Result<Decimal> {
    match signed(raw) {
        Ok(value) if value >= Decimal::ZERO => Ok(value),
        _ => bail!("The exchange returned an invalid amount."),
    }
}

/// Parses an amount that may be negative (position sizes, P/L, funding rates).
/// An amount too large to be real is rejected, like a price is.
pub fn signed(raw: &str) -> Result<Decimal> {
    match Decimal::from_str(raw.trim()).or_else(|_| Decimal::from_scientific(raw.trim())) {
        Ok(value) if value.abs() < Decimal::from(AMOUNT_CEILING) => Ok(value.normalize()),
        _ => bail!("The exchange returned an invalid amount."),
    }
}

/// Percent change from `from` to `to`.
pub fn pct(to: Decimal, from: Decimal) -> Option<f64> {
    use rust_decimal::prelude::ToPrimitive;
    if from.is_zero() {
        return None;
    }
    // Arithmetic on feed data is checked: an absurd price must not be able to stop the app.
    let ratio = to.checked_div(from)?.checked_sub(Decimal::ONE)?;
    ratio.checked_mul(Decimal::from(100))?.to_f64()
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

/// A price for display: two decimals above one, full precision below.
pub fn price_text(value: Decimal) -> String {
    if value.abs() >= Decimal::ONE { money(value) } else { decimal_text(value) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(text: &str) -> Decimal {
        Decimal::from_str(text).expect("test decimal")
    }

    fn btc() -> Market {
        Market {
            symbol: "BTCUSDT".into(),
            base: "BTC".into(),
            quote: "USDT".into(),
            tick: dec("0.1"),
            step: dec("0.001"),
            min_qty: dec("0.001"),
            max_qty: dec("120"),
            min_notional: dec("5"),
            maint_margin: dec("0.025"),
            band_up: None,
            band_down: None,
        }
    }

    #[test]
    fn quantities_are_finite_positive_plain_decimals() {
        for bad in ["NaN", "Infinity", "-1", "0", "1e4", ".000000001", "1,500", "", ".", "1.", "1234567890"] {
            assert!(parse_quantity(bad).is_err(), "{bad} should be rejected");
        }
        assert_eq!(parse_quantity(".125").expect("valid"), dec("0.125"));
        assert_eq!(parse_quantity("2.50").expect("valid").normalize().to_string(), "2.5");
    }

    #[test]
    fn quantities_round_down_to_the_step_and_prices_to_the_tick() {
        let market = btc();
        assert_eq!(market.floor_qty(dec("0.0159")), dec("0.015"));
        assert_eq!(market.floor_qty(dec("0.0009")), Decimal::ZERO);
        assert_eq!(market.floor_qty(dec("2")).to_string(), "2");
        assert_eq!(market.round_price(dec("62786.7122")), dec("62786.7"));
        assert_eq!(market.round_price(dec("62786.75")).to_string(), "62786.8");
        // A listing with an absurd step or tick cannot overflow the arithmetic.
        let broken = Market {
            step: dec("0.0000000000000000000000000001"),
            tick: dec("0.0000000000000000000000000001"),
            ..btc()
        };
        assert_eq!(broken.floor_qty(dec("999999999")), Decimal::ZERO);
        assert_eq!(broken.round_price(dec("999999999999")), dec("999999999999"));
        assert_eq!(pct(dec("999999999999"), dec("0.0000000000000000000000000001")), None);
    }

    #[test]
    fn venue_numbers_must_be_real() {
        assert_eq!(positive("84215.50").expect("valid"), dec("84215.5"));
        assert_eq!(positive("1.5e-7").expect("valid"), dec("0.00000015"));
        for bad in ["0", "-3", "abc", "", "1000000000000"] {
            assert!(positive(bad).is_err(), "{bad} should be rejected");
        }
        assert_eq!(non_negative("0").expect("valid"), Decimal::ZERO);
        assert!(non_negative("-1").is_err());
        assert!(
            signed("1000000000000000").is_err()
                && signed("-1e15").is_err()
                && signed("999999999999999").is_ok()
        );
        assert_eq!(signed("-0.0100").expect("valid"), dec("-0.01"));
        assert!(signed("n/a").is_err());
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
    fn sides_networks_and_timeframes_round_trip() {
        assert_eq!(
            (Side::parse("LONG").expect("side"), Side::parse("short").expect("side")),
            (Side::Buy, Side::Sell)
        );
        assert_eq!(
            (Side::Buy.venue(), Side::Buy.opposite(), Side::Sell.direction()),
            ("BUY", Side::Sell, "short")
        );
        assert!(Side::parse("hold").is_err());
        for network in Network::ALL {
            assert_eq!(Network::parse(network.as_str()).expect("network"), network);
        }
        assert!(Network::parse("devnet").is_err());
        assert_eq!(serde_json::to_string(&Network::Testnet).expect("json"), "\"testnet\"");
        for tf in Timeframe::ALL {
            assert_eq!(Timeframe::parse(tf.as_str()).expect("valid"), tf);
        }
    }

    #[test]
    fn positions_know_their_direction_and_margin() {
        let long = Position {
            symbol: "BTCUSDT".into(),
            amount: dec("0.5"),
            entry_price: dec("60000"),
            mark_price: dec("62000"),
            liquidation_price: Some(dec("41000")),
            leverage: 3,
            isolated: true,
            unrealized_pnl: dec("1000"),
            notional: dec("31000"),
            isolated_margin: dec("10000"),
        };
        assert_eq!((long.is_long(), long.closing_side(), long.margin()), (true, Side::Sell, dec("10000")));
        let short = Position {
            amount: dec("-0.5"),
            notional: dec("-31000"),
            isolated: false,
            isolated_margin: Decimal::ZERO,
            ..long
        };
        assert_eq!(
            (short.is_long(), short.closing_side(), short.margin()),
            (false, Side::Buy, dec("10333.33"))
        );
    }
}
