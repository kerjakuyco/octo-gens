//! Which markets the desk shows by default.
//!
//! The markets themselves come from the exchange ([`crate::exchange::Markets`]). Nothing
//! here invents a market: a name either matches one the exchange lists or is left out.

use crate::exchange::Markets;

/// Shown on a first launch, where the network lists them.
pub const DEFAULT_WATCHLIST: &[&str] = &[
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
    "ADAUSDT", "HYPEUSDT",
];
pub const DEFAULT_SYMBOL: &str = "BTCUSDT";

/// The default watchlist for a network: the usual majors that it lists.
pub fn default_watchlist(markets: &Markets) -> Vec<String> {
    let listed: Vec<String> = DEFAULT_WATCHLIST
        .iter()
        .filter(|symbol| markets.get(symbol).is_some())
        .map(|s| (*s).to_string())
        .collect();
    if listed.is_empty() { markets.all().iter().take(8).map(|m| m.symbol.clone()).collect() } else { listed }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use rust_decimal::Decimal;

    use super::*;
    use crate::model::Market;

    fn market(symbol: &str, base: &str, quote: &str) -> Market {
        let dec = |text: &str| Decimal::from_str(text).expect("decimal");
        Market {
            symbol: symbol.into(),
            base: base.into(),
            quote: quote.into(),
            tick: dec("0.1"),
            step: dec("0.001"),
            min_qty: dec("0.001"),
            max_qty: dec("100"),
            min_notional: dec("5"),
            maint_margin: dec("0.025"),
        }
    }

    fn markets() -> Markets {
        Markets::new(vec![
            market("BTCUSDT", "BTC", "USDT"),
            market("ETHUSDT", "ETH", "USDT"),
            market("SOLUSDT", "SOL", "USDT"),
            market("LINKUSDT", "LINK", "USDT"),
            market("XAUUSD1", "XAU", "USD1"),
            market("PEPEUSDT", "PEPE", "USDT"),
            market("MEUSDT", "ME", "USDT"),
            market("币安人生USDT", "币安人生", "USDT"),
        ])
    }

    #[test]
    fn the_default_watchlist_is_whatever_the_network_lists_of_the_majors() {
        assert_eq!(default_watchlist(&markets()), ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"]);
        let small = Markets::new(vec![market("FOOUSDT", "FOO", "USDT")]);
        assert_eq!(default_watchlist(&small), ["FOOUSDT"]);
    }
}
