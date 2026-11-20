//! Perpetual futures grid bots: price levels, order sizes, the first orders, and
//! what to do each time the bot looks at the exchange again.
//!
//! A grid keeps buy orders below the price and sell orders above it, between a
//! lower and an upper bound. Each fill is answered with the opposite order one
//! level away, so the bot earns the gap between levels as the price moves back
//! and forth. It comes in three directions (neutral, long, short), with equal
//! price steps or equal percentage steps, an optional trigger price that arms it,
//! and optional stop prices beyond the range. Everything here is pure: the studio
//! reads the exchange and passes the facts in.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use serde::{Deserialize, Serialize};

use crate::assistant::tools::estimate_liquidation;
use crate::error::Result;
use crate::model::{Market, Network, Side, decimal_text, price_text};
use crate::{bail, desk_err};

/// Minimum number of grid intervals allowed on a perpetual futures grid.
pub const MIN_GRIDS: u32 = 2;
/// Maximum number of grid intervals placed by one local bot so rate limits stay comfortable.
pub const MAX_GRIDS: u32 = 50;
/// Maker fee assumption per leg (0.02% = 2 bps, 0.04% round-trip).
const MAKER_FEE_ROUNDTRIP_PCT: f64 = 0.04;
/// Reserve 5% of buying power for fees and price movement across rungs.
const MARGIN_BUFFER_FACTOR: i64 = 95;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridDirection {
    /// Starts flat; places buy limits below mark and sell limits above mark.
    Neutral,
    /// Opens an initial long leg and layers buy limits below and sell limits above mark.
    Long,
    /// Opens an initial short leg and layers sell limits above and buy limits below mark.
    Short,
}

impl GridDirection {
    pub const ALL: [GridDirection; 3] = [GridDirection::Neutral, GridDirection::Long, GridDirection::Short];

    pub fn as_str(self) -> &'static str {
        match self {
            GridDirection::Neutral => "neutral",
            GridDirection::Long => "long",
            GridDirection::Short => "short",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridSpacing {
    /// Equal quote-currency price steps between consecutive grid lines.
    Arithmetic,
    /// Equal percentage ratio between consecutive grid lines.
    Geometric,
}

impl GridSpacing {
    pub const ALL: [GridSpacing; 2] = [GridSpacing::Arithmetic, GridSpacing::Geometric];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridStatus {
    /// Waiting for mark price to reach `trigger_price` before placing rungs.
    Waiting,
    /// Actively maintaining buy/sell limit rungs on the exchange.
    Running,
    /// Halted by the trader or by a stop boundary; resting grid orders were cancelled.
    Stopped,
    /// Stopped after an exchange or sizing error that requires trader attention.
    Error,
}

impl GridStatus {
    pub const ALL: [GridStatus; 4] =
        [GridStatus::Waiting, GridStatus::Running, GridStatus::Stopped, GridStatus::Error];
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridLevel {
    pub index: usize,
    pub price: Decimal,
    pub side: Option<Side>,
    pub order_id: Option<String>,
    pub client_id: Option<String>,
    pub filled_count: u32,
    /// The order resting here closes inventory the grid opened, so its fill completes a cycle and
    /// earns one grid step. An order that opens inventory earns nothing until its pair fills.
    #[serde(default)]
    pub closing: bool,
}

/// Whether an order of the first ladder closes inventory. A long grid's sells sell off the position
/// it bought at the start and a short grid's buys cover the one it sold; a neutral grid starts flat,
/// so all of its first orders open inventory.
pub fn closes_at_start(direction: GridDirection, side: Side) -> bool {
    matches!((direction, side), (GridDirection::Long, Side::Sell) | (GridDirection::Short, Side::Buy))
}

/// Persistent state of one futures grid bot managed locally by OctoNeo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridBot {
    pub id: String,
    pub network: Network,
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub direction: GridDirection,
    pub spacing: GridSpacing,
    pub status: GridStatus,
    pub lower_price: Decimal,
    pub upper_price: Decimal,
    pub grids: u32,
    pub leverage: u32,
    pub isolated: bool,
    pub margin: Decimal,
    pub qty_per_grid: Decimal,
    pub entry_price: Decimal,
    pub trigger_price: Option<Decimal>,
    pub stop_upper: Option<Decimal>,
    pub stop_lower: Option<Decimal>,
    pub close_on_stop: bool,
    pub post_only: bool,
    pub matched_trades: u32,
    pub realized_pnl: Decimal,
    pub fees_est: Decimal,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub stopped_at: Option<DateTime<Utc>>,
    pub last_note: String,
    pub levels: Vec<GridLevel>,
    pub rebalance_seq: u32,
}

impl GridBot {
    pub fn client_order_id(&mut self, level_index: usize) -> String {
        self.rebalance_seq = self.rebalance_seq.saturating_add(1);
        let prefix: String = self.id.chars().take(10).collect();
        format!("ong_{prefix}_{level_index}_{}", self.rebalance_seq)
    }
}

/// Computes `grids + 1` monotonically increasing grid prices rounded to `market.tick`.
pub fn compute_levels(
    lower: Decimal,
    upper: Decimal,
    grids: u32,
    spacing: GridSpacing,
    market: &Market,
) -> Result<Vec<Decimal>> {
    if lower <= Decimal::ZERO || upper <= Decimal::ZERO {
        bail!("Lower and upper prices must be positive numbers.");
    }
    if lower >= upper {
        bail!("The top of the range must be above the bottom.");
    }
    if !(MIN_GRIDS..=MAX_GRIDS).contains(&grids) {
        bail!("Grid count must be between {MIN_GRIDS} and {MAX_GRIDS}.");
    }

    let count = grids as usize;
    let mut levels = Vec::with_capacity(count + 1);

    match spacing {
        GridSpacing::Arithmetic => {
            let step = (upper - lower) / Decimal::from(grids);
            for idx in 0..=count {
                let raw = if idx == count { upper } else { lower + step * Decimal::from(idx) };
                levels.push(market.round_price(raw));
            }
        }
        GridSpacing::Geometric => {
            let lo = lower.to_f64().ok_or_else(|| desk_err!("Lower price is out of range."))?;
            let hi = upper.to_f64().ok_or_else(|| desk_err!("Upper price is out of range."))?;
            let ratio = (hi / lo).powf(1.0 / grids as f64);
            for idx in 0..=count {
                let raw_f = if idx == count { hi } else { lo * ratio.powi(idx as i32) };
                let raw = Decimal::from_f64(raw_f)
                    .ok_or_else(|| desk_err!("Could not compute geometric grid level."))?;
                levels.push(market.round_price(raw));
            }
        }
    }

    for pair in levels.windows(2) {
        if pair[1] <= pair[0] {
            bail!(
                "The price levels are closer together than {} prices can go ({}). Use a wider range or fewer grids.",
                market.base,
                decimal_text(market.tick)
            );
        }
    }

    Ok(levels)
}

/// Minimum and maximum estimated net profit per completed grid cycle (in percent, after 0.04% round-trip maker fees).
pub fn profit_per_grid_pct(levels: &[Decimal]) -> (f64, f64) {
    if levels.len() < 2 {
        return (0.0, 0.0);
    }
    let mut min_pct = f64::INFINITY;
    let mut max_pct = f64::NEG_INFINITY;
    for pair in levels.windows(2) {
        let Some(lo) = pair[0].to_f64() else {
            continue;
        };
        let Some(hi) = pair[1].to_f64() else {
            continue;
        };
        if lo <= 0.0 {
            continue;
        }
        let gross = ((hi - lo) / lo) * 100.0;
        let net = gross - MAKER_FEE_ROUNDTRIP_PCT;
        if net < min_pct {
            min_pct = net;
        }
        if net > max_pct {
            max_pct = net;
        }
    }
    if !min_pct.is_finite() || !max_pct.is_finite() {
        return (0.0, 0.0);
    }
    ((min_pct * 100.0).round() / 100.0, (max_pct * 100.0).round() / 100.0)
}

/// Computes the base quantity per grid order, notional per grid at mark, and minimum required margin.
pub fn size_per_grid(
    margin: Decimal,
    leverage: u32,
    levels: &[Decimal],
    mark: Decimal,
    market: &Market,
) -> Result<(Decimal, Decimal, Decimal)> {
    if margin <= Decimal::ZERO {
        bail!("Enter an initial margin greater than zero.");
    }
    if leverage < 1 {
        bail!("Leverage must be at least 1x.");
    }
    if levels.len() < 2 {
        bail!("A grid needs at least two price levels.");
    }

    let grids = (levels.len() - 1) as u32;
    let lowest = levels[0];
    let avg_price = levels.iter().copied().sum::<Decimal>() / Decimal::from(levels.len() as u32);
    let ref_price = if mark > Decimal::ZERO { mark } else { avg_price };

    // Minimum qty that satisfies both min_qty and min_notional even at the lowest rung.
    let min_notional_floor = market.min_notional.max(Decimal::from(5));
    let mut min_qty_needed = market.min_qty;
    if lowest > Decimal::ZERO {
        let notional_qty = min_notional_floor / lowest;
        if notional_qty > min_qty_needed {
            // Round UP to the next step so lowest * qty >= min_notional.
            min_qty_needed = if market.step.is_zero() {
                notional_qty
            } else {
                let steps = (notional_qty / market.step).ceil();
                (steps * market.step).normalize()
            };
        }
    }

    let min_total_notional = min_qty_needed * avg_price * Decimal::from(grids);
    let min_margin = ((min_total_notional / Decimal::from(leverage)) * Decimal::from(100)
        / Decimal::from(MARGIN_BUFFER_FACTOR))
    .round_dp(2);

    let usable_notional =
        (margin * Decimal::from(leverage) * Decimal::from(MARGIN_BUFFER_FACTOR)) / Decimal::from(100);
    let per_grid_notional_target = usable_notional / Decimal::from(grids);
    let raw_qty =
        if avg_price > Decimal::ZERO { per_grid_notional_target / avg_price } else { Decimal::ZERO };
    let qty = market.floor_qty(raw_qty);

    if qty < min_qty_needed || qty * lowest < min_notional_floor {
        bail!(
            "The margin is too small for {grids} grids on {} at {leverage}x: it needs at least {} {}. Use fewer grids or more margin.",
            market.base,
            decimal_text(min_margin),
            market.quote
        );
    }
    if !market.max_qty.is_zero() && qty > market.max_qty {
        bail!(
            "Each order, {} {}, is larger than {} allows ({}). Use less margin or more grids.",
            decimal_text(qty),
            market.base,
            market.base,
            decimal_text(market.max_qty)
        );
    }

    let notional_per_grid = (qty * ref_price).round_dp(2);
    Ok((qty, notional_per_grid, min_margin))
}

/// The market order a long or short grid opens with: its side and quantity.
pub type FirstOrder = Option<(Side, Decimal)>;

/// The first resting orders: level index, side and price.
pub type Ladder = Vec<(usize, Side, Decimal)>;

/// Plans the initial market leg (for Long / Short grids) and the resting limit order ladder.
///
/// The grid line closest to `mark` is left empty as the active pivot so buys and sells
/// do not immediately cross the spread.
pub fn plan_initial_deployment(
    direction: GridDirection,
    levels: &[Decimal],
    mark: Decimal,
    qty_per_grid: Decimal,
) -> (FirstOrder, Ladder) {
    if levels.is_empty() {
        return (None, Vec::new());
    }

    // Find the grid line closest to the current mark price and leave it open as the pivot rung.
    let mut pivot = 0usize;
    let mut best_dist = (levels[0] - mark).abs();
    for (idx, price) in levels.iter().enumerate().skip(1) {
        let dist = (*price - mark).abs();
        if dist < best_dist {
            best_dist = dist;
            pivot = idx;
        }
    }

    let mut orders = Vec::with_capacity(levels.len().saturating_sub(1));
    let mut sells_above = 0u32;
    let mut buys_below = 0u32;

    for (idx, &price) in levels.iter().enumerate() {
        if idx == pivot {
            continue;
        }
        if price < mark {
            orders.push((idx, Side::Buy, price));
            buys_below += 1;
        } else if price > mark {
            orders.push((idx, Side::Sell, price));
            sells_above += 1;
        }
    }

    let initial = match direction {
        GridDirection::Neutral => None,
        GridDirection::Long => {
            if sells_above > 0 {
                Some((Side::Buy, (qty_per_grid * Decimal::from(sells_above)).normalize()))
            } else {
                None
            }
        }
        GridDirection::Short => {
            if buys_below > 0 {
                Some((Side::Sell, (qty_per_grid * Decimal::from(buys_below)).normalize()))
            } else {
                None
            }
        }
    };

    (initial, orders)
}

/// Conservative worst-case long and short liquidation estimates for a grid bot.
pub fn estimate_grid_liquidation(
    direction: GridDirection,
    lower: Decimal,
    upper: Decimal,
    mark: Decimal,
    leverage: u32,
    isolated: bool,
    market: &Market,
) -> (Option<Decimal>, Option<Decimal>) {
    let avg_long_entry = if mark > lower { (mark + lower) / Decimal::from(2) } else { lower };
    let avg_short_entry = if mark < upper { (mark + upper) / Decimal::from(2) } else { upper };
    let liq = |side: Side, entry: Decimal| {
        isolated
            .then(|| market.round_price(estimate_liquidation(side, entry, leverage, market.maint_margin)))
            .filter(|level| *level > Decimal::ZERO)
    };
    let long_liq = match direction {
        GridDirection::Long | GridDirection::Neutral => liq(Side::Buy, avg_long_entry),
        GridDirection::Short => None,
    };
    let short_liq = match direction {
        GridDirection::Short | GridDirection::Neutral => liq(Side::Sell, avg_short_entry),
        GridDirection::Long => None,
    };
    (long_liq, short_liq)
}

/// Validates optional trigger and stop-out prices against the grid bounds.
pub fn validate_triggers(
    lower: Decimal,
    upper: Decimal,
    stop_lower: Option<Decimal>,
    stop_upper: Option<Decimal>,
) -> Result<()> {
    if let Some(sl) = stop_lower {
        if sl <= Decimal::ZERO {
            bail!("The stop below must be a positive price.");
        }
        if sl >= lower {
            bail!(
                "The stop below, {}, must be under the bottom of the range, {}.",
                price_text(sl),
                price_text(lower)
            );
        }
    }
    if let Some(su) = stop_upper {
        if su <= Decimal::ZERO {
            bail!("The stop above must be a positive price.");
        }
        if su <= upper {
            bail!(
                "The stop above, {}, must be over the top of the range, {}.",
                price_text(su),
                price_text(upper)
            );
        }
    }
    Ok(())
}

/// What the exchange says became of one of the bot's orders.
#[derive(Clone, Debug, PartialEq)]
pub enum OrderFate {
    /// Still resting on the book, perhaps partly filled.
    Open,
    /// Filled in full.
    Filled,
    /// Ended without filling in full: cancelled, expired (a post-only order that would have crossed
    /// the spread), rejected, or unknown to the exchange. `executed` is what filled before it ended.
    Ended { status: String, executed: Decimal },
    /// Could not be checked this time. It is asked about again at the next look.
    Unknown,
}

impl OrderFate {
    /// Reads the status the exchange gives an order that is no longer among the open ones.
    /// Only a full fill counts as one: an order that is missing from the book may have been
    /// cancelled or may have expired, and treating that as a fill would trade on a fill that
    /// never happened.
    pub fn from_status(status: &str, executed: Decimal) -> Self {
        match status {
            "FILLED" => OrderFate::Filled,
            // The open orders were read a moment before the order was looked up.
            "NEW" | "PARTIALLY_FILLED" => OrderFate::Open,
            other => OrderFate::Ended { status: other.to_string(), executed },
        }
    }
}

/// The order to place on the neighbouring level after a fill.
#[derive(Clone, Debug, PartialEq)]
pub struct Counter {
    pub index: usize,
    pub side: Side,
    pub price: Decimal,
    /// The counter-order of an opening fill closes what it opened; of a closing fill, it opens again.
    pub closing: bool,
}

/// A level whose order filled.
#[derive(Clone, Debug, PartialEq)]
pub struct Fill {
    pub index: usize,
    pub side: Side,
    /// The gap of one grid step times the order size, before fees, when the fill closed a cycle;
    /// zero when it opened inventory.
    pub cycle_profit: Decimal,
    /// The paired order to place, when its level is free.
    pub counter: Option<Counter>,
}

/// A level whose order ended without filling.
#[derive(Clone, Debug, PartialEq)]
pub struct Ended {
    pub index: usize,
    /// The exchange's word for how it ended, e.g. `CANCELED` or `EXPIRED`.
    pub status: String,
    /// What filled before it ended.
    pub executed: Decimal,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SyncDecision {
    None,
    /// A waiting bot's trigger price was reached: deploy the grid now.
    Activate,
    /// The mark price reached a stop price: halt the bot.
    StopOut(String),
    /// Every order the bot had resting ended without filling, so they were cancelled outside the
    /// bot (for example with Cancel all). It stops managing the grid and sends nothing.
    Abandoned(String),
    /// Fills to answer with paired orders, and levels whose order ended without a fill.
    Update {
        fills: Vec<Fill>,
        ended: Vec<Ended>,
    },
}

/// Decides what a bot does, from the live mark price and what became of each of its orders.
/// `fates` holds an entry for every order id on the bot's levels; a missing entry counts as unknown.
pub fn plan_sync(bot: &GridBot, fates: &HashMap<String, OrderFate>, mark: Decimal) -> SyncDecision {
    if bot.status == GridStatus::Waiting {
        if let Some(trigger) = bot.trigger_price {
            let crossed = if bot.entry_price >= trigger { mark <= trigger } else { mark >= trigger };
            if crossed {
                return SyncDecision::Activate;
            }
        }
        return SyncDecision::None;
    }

    if bot.status != GridStatus::Running {
        return SyncDecision::None;
    }

    if let Some(stop_up) = bot.stop_upper
        && mark >= stop_up
    {
        return SyncDecision::StopOut(format!(
            "Stopped: {} reached the stop above, {}.",
            bot.base,
            price_text(stop_up)
        ));
    }

    if let Some(stop_down) = bot.stop_lower
        && mark <= stop_down
    {
        return SyncDecision::StopOut(format!(
            "Stopped: {} reached the stop below, {}.",
            bot.base,
            price_text(stop_down)
        ));
    }

    let fate = |level: &GridLevel| -> OrderFate {
        level.order_id.as_ref().and_then(|id| fates.get(id)).cloned().unwrap_or(OrderFate::Unknown)
    };
    let resting: Vec<&GridLevel> = bot.levels.iter().filter(|level| level.order_id.is_some()).collect();

    if !resting.is_empty() && resting.iter().all(|level| matches!(fate(level), OrderFate::Ended { .. })) {
        return SyncDecision::Abandoned(format!(
            "Stopped: its {} {} cancelled outside the bot, so it sent nothing more.",
            resting.len(),
            if resting.len() == 1 { "order was" } else { "orders were" }
        ));
    }

    // A level whose order still rests, or might, cannot take a paired order. A level whose order
    // filled or ended this time is free again.
    let occupied: HashSet<usize> = resting
        .iter()
        .filter(|level| matches!(fate(level), OrderFate::Open | OrderFate::Unknown))
        .map(|level| level.index)
        .collect();

    let mut fills = Vec::new();
    let mut ended = Vec::new();
    let mut planned = HashSet::new();

    for level in &resting {
        match fate(level) {
            OrderFate::Filled => {
                let Some(side) = level.side else {
                    continue;
                };
                let (target, counter_side) = match side {
                    Side::Buy => (level.index.checked_add(1), Side::Sell),
                    Side::Sell => (level.index.checked_sub(1), Side::Buy),
                };
                let target = target.filter(|&index| index < bot.levels.len());
                let cycle_profit = match target {
                    Some(index) if level.closing => {
                        (bot.levels[index].price - level.price).abs() * bot.qty_per_grid
                    }
                    _ => Decimal::ZERO,
                };
                let counter =
                    target.filter(|index| !occupied.contains(index) && planned.insert(*index)).map(|index| {
                        Counter {
                            index,
                            side: counter_side,
                            price: bot.levels[index].price,
                            closing: !level.closing,
                        }
                    });
                fills.push(Fill { index: level.index, side, cycle_profit, counter });
            }
            OrderFate::Ended { status, executed } => {
                ended.push(Ended { index: level.index, status, executed })
            }
            OrderFate::Open | OrderFate::Unknown => {}
        }
    }

    if fills.is_empty() && ended.is_empty() {
        SyncDecision::None
    } else {
        SyncDecision::Update { fills, ended }
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    fn dec(s: &str) -> Decimal {
        Decimal::from_str(s).expect("decimal")
    }

    fn btc_market() -> Market {
        Market {
            symbol: "BTCUSDT".into(),
            base: "BTC".into(),
            quote: "USDT".into(),
            tick: dec("0.1"),
            step: dec("0.001"),
            min_qty: dec("0.001"),
            max_qty: dec("100"),
            min_notional: dec("5"),
            maint_margin: dec("0.005"),
        }
    }

    #[test]
    fn arithmetic_and_geometric_levels_are_strictly_increasing_and_tick_rounded() {
        let m = btc_market();
        let arith =
            compute_levels(dec("60000"), dec("66000"), 6, GridSpacing::Arithmetic, &m).expect("levels");
        assert_eq!(
            arith,
            vec![
                dec("60000"),
                dec("61000"),
                dec("62000"),
                dec("63000"),
                dec("64000"),
                dec("65000"),
                dec("66000")
            ]
        );
        let (min_p, max_p) = profit_per_grid_pct(&arith);
        assert!(min_p > 1.4 && max_p < 1.7, "expected ~1.5-1.6% net profit per grid, got {min_p}..{max_p}");

        let geo = compute_levels(dec("60000"), dec("66000"), 6, GridSpacing::Geometric, &m).expect("levels");
        assert_eq!(geo.len(), 7);
        assert_eq!(geo[0], dec("60000"));
        assert_eq!(geo[6], dec("66000"));
        let (g_min, g_max) = profit_per_grid_pct(&geo);
        assert!((g_max - g_min).abs() <= 0.02, "geometric steps have constant % profit: {g_min}..{g_max}");
    }

    #[test]
    fn sizing_enforces_min_notional_and_returns_clear_min_margin() {
        let m = btc_market();
        let levels =
            compute_levels(dec("60000"), dec("66000"), 10, GridSpacing::Arithmetic, &m).expect("levels");
        // 10 grids * ~0.001 BTC (~63 USDT) = 630 notional -> at 5x needs ~133 USDT margin.
        let too_small = size_per_grid(dec("50"), 5, &levels, dec("63000"), &m);
        assert!(too_small.is_err());

        let (qty, notional, min_margin) =
            size_per_grid(dec("500"), 5, &levels, dec("63000"), &m).expect("a size");
        assert!(qty >= dec("0.003"));
        assert!(notional >= dec("180"));
        assert!(min_margin > dec("100"));
    }

    #[test]
    fn initial_deployment_handles_neutral_long_and_short_modes() {
        let m = btc_market();
        let levels =
            compute_levels(dec("60000"), dec("66000"), 6, GridSpacing::Arithmetic, &m).expect("levels");

        // Neutral: no initial market leg; 3 buys below 63k, 3 sells above 63k (63k is pivot).
        let (init_n, orders_n) =
            plan_initial_deployment(GridDirection::Neutral, &levels, dec("63000"), dec("0.01"));
        assert!(init_n.is_none());
        assert_eq!(orders_n.len(), 6);
        assert_eq!(orders_n.iter().filter(|(_, s, _)| *s == Side::Buy).count(), 3);
        assert_eq!(orders_n.iter().filter(|(_, s, _)| *s == Side::Sell).count(), 3);

        // Long: initial buy covers the 3 sell rungs above mark.
        let (init_l, _) = plan_initial_deployment(GridDirection::Long, &levels, dec("63000"), dec("0.01"));
        assert_eq!(init_l, Some((Side::Buy, dec("0.03"))));

        // Short: initial sell covers the 3 buy rungs below mark.
        let (init_s, _) = plan_initial_deployment(GridDirection::Short, &levels, dec("63000"), dec("0.01"));
        assert_eq!(init_s, Some((Side::Sell, dec("0.03"))));
    }

    /// A running bot on 60,000 to 64,000 in four steps of 1,000, with an order on every level but the middle one.
    fn grid(direction: GridDirection) -> GridBot {
        let now = Utc::now();
        let level = |index: usize, price: &str, side: Option<Side>| GridLevel {
            index,
            price: dec(price),
            side,
            order_id: side.map(|_| format!("o{index}")),
            client_id: side.map(|_| format!("c{index}")),
            filled_count: 0,
            closing: side.is_some_and(|side| closes_at_start(direction, side)),
        };
        GridBot {
            id: "grid1234".into(),
            network: Network::Testnet,
            symbol: "BTCUSDT".into(),
            base: "BTC".into(),
            quote: "USDT".into(),
            direction,
            spacing: GridSpacing::Arithmetic,
            status: GridStatus::Running,
            lower_price: dec("60000"),
            upper_price: dec("64000"),
            grids: 4,
            leverage: 3,
            isolated: true,
            margin: dec("500"),
            qty_per_grid: dec("0.005"),
            entry_price: dec("62000"),
            trigger_price: None,
            stop_upper: Some(dec("65000")),
            stop_lower: Some(dec("59000")),
            close_on_stop: true,
            post_only: true,
            matched_trades: 0,
            realized_pnl: Decimal::ZERO,
            fees_est: Decimal::ZERO,
            created_at: now,
            updated_at: now,
            stopped_at: None,
            last_note: String::new(),
            rebalance_seq: 4,
            levels: vec![
                level(0, "60000", Some(Side::Buy)),
                level(1, "61000", Some(Side::Buy)),
                level(2, "62000", None),
                level(3, "63000", Some(Side::Sell)),
                level(4, "64000", Some(Side::Sell)),
            ],
        }
    }

    /// Every resting order is still open, except the ones named.
    fn fates(bot: &GridBot, changed: &[(&str, OrderFate)]) -> HashMap<String, OrderFate> {
        let mut fates: HashMap<String, OrderFate> = bot
            .levels
            .iter()
            .filter_map(|level| level.order_id.clone())
            .map(|id| (id, OrderFate::Open))
            .collect();
        for (id, fate) in changed {
            fates.insert((*id).to_string(), fate.clone());
        }
        fates
    }

    fn ended(status: &str) -> OrderFate {
        OrderFate::Ended { status: status.into(), executed: Decimal::ZERO }
    }

    /// What the studio does with a decision: empties the levels that filled or ended, places the
    /// paired orders and credits the cycles that closed.
    fn apply(bot: &mut GridBot, decision: SyncDecision) {
        let SyncDecision::Update { fills, ended } = decision else {
            panic!("expected an update, got {decision:?}");
        };
        for fill in fills {
            let level = &mut bot.levels[fill.index];
            (level.order_id, level.client_id, level.side, level.closing) = (None, None, None, false);
            if fill.cycle_profit > Decimal::ZERO {
                bot.matched_trades += 1;
                bot.realized_pnl += fill.cycle_profit;
            }
            if let Some(counter) = fill.counter {
                let target = &mut bot.levels[counter.index];
                target.order_id = Some(format!("o{}-{}", counter.index, bot.rebalance_seq));
                target.side = Some(counter.side);
                target.closing = counter.closing;
                bot.rebalance_seq += 1;
            }
        }
        for gone in ended {
            let level = &mut bot.levels[gone.index];
            (level.order_id, level.client_id, level.side, level.closing) = (None, None, None, false);
        }
    }

    fn fill_at(bot: &mut GridBot, index: usize, mark: &str) {
        let id = bot.levels[index].order_id.clone().expect("an order rests there");
        let decision = plan_sync(bot, &fates(bot, &[(id.as_str(), OrderFate::Filled)]), dec(mark));
        apply(bot, decision);
    }

    #[test]
    fn only_a_fill_the_exchange_confirms_is_answered_with_a_paired_order() {
        let bot = grid(GridDirection::Neutral);
        let seen =
            fates(&bot, &[("o1", OrderFate::Filled), ("o3", ended("CANCELED")), ("o4", ended("EXPIRED"))]);
        let SyncDecision::Update { fills, ended } = plan_sync(&bot, &seen, dec("60950")) else {
            panic!("expected an update");
        };
        // The buy at 61,000 filled: a sell goes one level up, and nothing is earned yet.
        assert_eq!(
            fills,
            [Fill {
                index: 1,
                side: Side::Buy,
                cycle_profit: Decimal::ZERO,
                counter: Some(Counter { index: 2, side: Side::Sell, price: dec("62000"), closing: true }),
            }]
        );
        // A cancelled order and an expired post-only order are not fills: their levels are only emptied.
        assert_eq!(
            ended.iter().map(|e| (e.index, e.status.as_str())).collect::<Vec<_>>(),
            [(3, "CANCELED"), (4, "EXPIRED")]
        );

        // An order that could not be looked up is left for the next look, not guessed at.
        let unsure = fates(&bot, &[("o1", OrderFate::Unknown)]);
        assert_eq!(plan_sync(&bot, &unsure, dec("60950")), SyncDecision::None);
        let missing: HashMap<String, OrderFate> = HashMap::new();
        assert_eq!(plan_sync(&bot, &missing, dec("62000")), SyncDecision::None);
    }

    #[test]
    fn a_grid_whose_orders_were_all_cancelled_outside_it_stops_and_sends_nothing() {
        let bot = grid(GridDirection::Neutral);
        let all: Vec<(&str, OrderFate)> =
            ["o0", "o1", "o3", "o4"].into_iter().map(|id| (id, ended("CANCELED"))).collect();
        let decision = plan_sync(&bot, &fates(&bot, &all), dec("62000"));
        let SyncDecision::Abandoned(note) = decision else {
            panic!("expected the bot to stop, got {decision:?}");
        };
        assert_eq!(note, "Stopped: its 4 orders were cancelled outside the bot, so it sent nothing more.");

        // One order still resting, or one that could not be checked, keeps it running.
        let mut most = all.clone();
        most[0].1 = OrderFate::Unknown;
        assert!(matches!(plan_sync(&bot, &fates(&bot, &most), dec("62000")), SyncDecision::Update { .. }));
    }

    #[test]
    fn a_neutral_grid_earns_only_when_a_cycle_closes() {
        let mut bot = grid(GridDirection::Neutral);
        // The price rises through both sells. Each sell opens a short, so nothing is earned yet.
        fill_at(&mut bot, 3, "63100");
        fill_at(&mut bot, 4, "64100");
        assert_eq!((bot.matched_trades, bot.realized_pnl), (0, Decimal::ZERO));
        assert_eq!(
            bot.levels.iter().map(|l| (l.side, l.closing)).collect::<Vec<_>>(),
            [
                (Some(Side::Buy), false),
                (Some(Side::Buy), false),
                (Some(Side::Buy), true),
                (Some(Side::Buy), true),
                (None, false),
            ],
            "the buy-backs placed after the sells close the short they opened"
        );
        // It falls back. Each buy-back closes a cycle and earns one step of 1,000 on 0.005 BTC.
        fill_at(&mut bot, 3, "62900");
        fill_at(&mut bot, 2, "61900");
        assert_eq!((bot.matched_trades, bot.realized_pnl), (2, dec("10")));
        // The sells placed again open new shorts.
        assert_eq!((bot.levels[3].side, bot.levels[3].closing), (Some(Side::Sell), false));
        assert_eq!((bot.levels[4].side, bot.levels[4].closing), (Some(Side::Sell), false));
    }

    #[test]
    fn a_long_grid_earns_when_its_first_sells_offload_the_position() {
        let mut bot = grid(GridDirection::Long);
        assert!(bot.levels[3].closing && !bot.levels[1].closing);
        fill_at(&mut bot, 3, "63100");
        assert_eq!((bot.matched_trades, bot.realized_pnl), (1, dec("5")));
        // The buy placed one level down opens again, and earns nothing until its sell fills.
        assert_eq!((bot.levels[2].side, bot.levels[2].closing), (Some(Side::Buy), false));
        fill_at(&mut bot, 2, "61900");
        assert_eq!(bot.matched_trades, 1);
        assert_eq!((bot.levels[3].side, bot.levels[3].closing), (Some(Side::Sell), true));
    }

    #[test]
    fn a_stop_price_halts_the_bot_before_anything_else() {
        let bot = grid(GridDirection::Neutral);
        let seen = fates(&bot, &[("o1", OrderFate::Filled)]);
        assert_eq!(
            plan_sync(&bot, &seen, dec("65100")),
            SyncDecision::StopOut("Stopped: BTC reached the stop above, 65,000.00.".into())
        );
        assert_eq!(
            plan_sync(&bot, &seen, dec("58900")),
            SyncDecision::StopOut("Stopped: BTC reached the stop below, 59,000.00.".into())
        );
    }

    #[test]
    fn the_exchange_status_of_a_missing_order_decides_its_fate() {
        assert_eq!(OrderFate::from_status("FILLED", dec("0.005")), OrderFate::Filled);
        assert_eq!(OrderFate::from_status("PARTIALLY_FILLED", dec("0.002")), OrderFate::Open);
        assert_eq!(OrderFate::from_status("NEW", Decimal::ZERO), OrderFate::Open);
        assert_eq!(
            OrderFate::from_status("CANCELED", dec("0.002")),
            OrderFate::Ended { status: "CANCELED".into(), executed: dec("0.002") }
        );
        assert!(matches!(OrderFate::from_status("EXPIRED", Decimal::ZERO), OrderFate::Ended { .. }));
        assert!(matches!(OrderFate::from_status("REJECTED", Decimal::ZERO), OrderFate::Ended { .. }));
    }
}
