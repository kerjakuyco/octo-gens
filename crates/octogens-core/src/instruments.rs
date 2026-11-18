//! The tradable universe: spot tokens quoted in USDT. There is no equity fallback.
//!
//! Tokenized stocks (xStocks such as `TSLAx`) are their own spot markets. Asking
//! for the underlying ticker (`TSLA`) is an error, never a silent substitution.

use std::str::FromStr;

use rust_decimal::Decimal;

use crate::bail;
use crate::error::Result;

pub const QUOTE: &str = "USDT";
pub const DEFAULT_PAIR: &str = "BTC/USDT";

#[derive(Clone, Debug, PartialEq)]
pub struct Instrument {
    /// Display ticker with its original casing, e.g. `BTC` or `TSLAx`.
    pub ticker: String,
    pub name: String,
    /// Underlying equity for a tokenized stock.
    pub underlying: Option<String>,
    /// Anchor price for the fictional sample tape. Custom tokens have none.
    pub sample: Option<Decimal>,
    /// Resolved from user input rather than the built-in universe.
    pub custom: bool,
}

impl Instrument {
    /// Upper-case base asset, e.g. `TSLAX`.
    pub fn base(&self) -> String {
        self.ticker.to_ascii_uppercase()
    }

    /// Canonical pair, e.g. `TSLAX/USDT`.
    pub fn pair(&self) -> String {
        format!("{}/{QUOTE}", self.base())
    }

    pub fn is_xstock(&self) -> bool {
        self.underlying.is_some()
    }

    pub fn kind(&self) -> &'static str {
        if self.is_xstock() { "Tokenized stock" } else { "Crypto" }
    }
}

/// `(ticker, name, sample anchor, underlying)`. Sample anchors are fictional.
const UNIVERSE: &[(&str, &str, &str, &str)] = &[
    ("BTC", "Bitcoin", "84215.50", ""),
    ("ETH", "Ethereum", "2145.72", ""),
    ("SOL", "Solana", "142.08", ""),
    ("BNB", "BNB", "612.40", ""),
    ("XRP", "XRP", "2.3140", ""),
    ("DOGE", "Dogecoin", "0.18340", ""),
    ("ADA", "Cardano", "0.74210", ""),
    ("AVAX", "Avalanche", "23.870", ""),
    ("LINK", "Chainlink", "15.620", ""),
    ("SUI", "Sui", "2.9400", ""),
    ("TSLAx", "Tesla xStock", "324.70", "TSLA"),
    ("AAPLx", "Apple xStock", "219.38", "AAPL"),
    ("NVDAx", "NVIDIA xStock", "144.58", "NVDA"),
    ("SPYx", "SPDR S&P 500 ETF xStock", "587.16", "SPY"),
];

/// Tickers that are also everyday words. They only match when typed in upper case.
const AMBIGUOUS: &[&str] = &["LINK", "ADA", "SUI", "SOL"];

/// The built-in instruments, in watchlist order.
pub fn universe() -> Vec<Instrument> {
    UNIVERSE
        .iter()
        .map(|(ticker, name, sample, underlying)| Instrument {
            ticker: (*ticker).to_string(),
            name: (*name).to_string(),
            underlying: (!underlying.is_empty()).then(|| (*underlying).to_string()),
            sample: Decimal::from_str(sample).ok(),
            custom: false,
        })
        .collect()
}

fn valid_base(base: &str) -> bool {
    (2..=12).contains(&base.len()) && base.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// Resolves user or model input (`btc`, `$BTC`, `BTC/USDT`, `BTC-USDT`, `BTCUSDT`,
/// `Bitcoin`) to an instrument. Unknown tokens resolve to a custom instrument
/// whose listing the venue still has to confirm.
pub fn resolve(raw: &str) -> Result<Instrument> {
    let text = raw.trim().trim_start_matches('$').to_ascii_uppercase().replace('-', "/");
    if text.is_empty() {
        bail!("Enter a token symbol such as BTC or a pair such as BTC/USDT.");
    }
    for instrument in universe() {
        let base = instrument.base();
        if text == base
            || text == instrument.pair()
            || text == format!("{base}{QUOTE}")
            || text == instrument.name.to_ascii_uppercase()
        {
            return Ok(instrument);
        }
        if let Some(underlying) = &instrument.underlying
            && (text == *underlying
                || text == format!("{underlying}/{QUOTE}")
                || text == format!("{underlying}{QUOTE}"))
        {
            bail!(
                "{underlying} is the underlying share, which this desk does not trade. Use {}/{QUOTE} for its xStock token.",
                instrument.ticker
            );
        }
    }
    let base = match text.split_once('/') {
        Some((base, quote)) if quote == QUOTE => base.to_string(),
        Some((_, quote)) => bail!("Only {QUOTE} spot pairs are supported, not {quote}."),
        None => match text.strip_suffix(QUOTE) {
            Some(base) if valid_base(base) => base.to_string(),
            _ => text.clone(),
        },
    };
    if !valid_base(&base) || base == QUOTE {
        bail!(
            "Unknown spot instrument: {}. Use a token symbol such as BTC or a pair such as BTC/USDT.",
            raw.trim()
        );
    }
    Ok(Instrument { ticker: base.clone(), name: base, underlying: None, sample: None, custom: true })
}

/// Finds the instruments a free-text prompt mentions, in order, without duplicates.
///
/// Built-in tickers and names match in any case, except tickers that are also
/// common words. Other tokens need an explicit form: `$PEPE` or `PEPE/USDT`.
pub fn in_prompt(text: &str) -> Result<Vec<String>> {
    let known = universe();
    let mut found: Vec<String> = Vec::new();
    let is_word = |c: char| c.is_ascii_alphanumeric() || matches!(c, '$' | '/' | '-');
    for word in text.split(|c: char| !is_word(c)).filter(|w| !w.is_empty()) {
        let trimmed = word.trim_matches(|c| matches!(c, '/' | '-'));
        let upper = trimmed.trim_start_matches('$').to_ascii_uppercase().replace('-', "/");
        let explicit = trimmed.starts_with('$') || upper.ends_with("/USDT");
        let base = upper.split('/').next().unwrap_or_default().to_string();
        let builtin = known.iter().any(|i| {
            let typed_upper = !trimmed.chars().any(|c| c.is_ascii_lowercase()) || trimmed == i.ticker;
            let ticker = base == i.base() && (typed_upper || !AMBIGUOUS.contains(&base.as_str()));
            let name =
                i.name.split(' ').count() == 1 && upper == i.name.to_ascii_uppercase() && base != i.base();
            let underlying = typed_upper && i.underlying.as_deref() == Some(base.as_str());
            ticker || name || underlying || upper == format!("{}{QUOTE}", i.base())
        });
        if builtin || (explicit && valid_base(&base)) {
            let pair = resolve(trimmed)?.pair();
            if !found.contains(&pair) {
                found.push(pair);
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spelling_of_a_builtin_resolves_to_the_same_pair() {
        for spelling in ["btc", "BTC", "$btc", "BTC/USDT", "btc-usdt", "BTCUSDT", "Bitcoin"] {
            assert_eq!(resolve(spelling).expect(spelling).pair(), "BTC/USDT");
        }
        let tesla = resolve("tslax").expect("xstock");
        assert_eq!(
            (tesla.ticker.as_str(), tesla.pair().as_str(), tesla.kind()),
            ("TSLAx", "TSLAX/USDT", "Tokenized stock")
        );
    }

    #[test]
    fn the_underlying_share_is_rejected_not_substituted() {
        for spelling in ["TSLA", "tsla", "$TSLA", "TSLA/USDT", "TSLAUSDT"] {
            let error = resolve(spelling).expect_err(spelling).to_string();
            assert!(error.contains("underlying") && error.contains("TSLAx/USDT"), "{error}");
        }
    }

    #[test]
    fn unknown_tokens_become_custom_usdt_instruments() {
        let pepe = resolve("pepe").expect("custom");
        assert_eq!((pepe.pair().as_str(), pepe.custom, pepe.sample), ("PEPE/USDT", true, None));
        assert_eq!(resolve("1000SATSUSDT").expect("custom").pair(), "1000SATS/USDT");
        for bad in ["", "BTC/USD", "B", "USDT", "not a token", "TOOLONGTOKENNAME"] {
            assert!(resolve(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn prompts_name_instruments_without_tripping_on_plain_words() {
        assert_eq!(in_prompt("Compare TSLAx and nvdax").expect("ok"), ["TSLAX/USDT", "NVDAX/USDT"]);
        assert_eq!(
            in_prompt("is bitcoin stronger than eth? and BTC again").expect("ok"),
            ["BTC/USDT", "ETH/USDT"]
        );
        assert_eq!(
            in_prompt("what is the link between the sun (sol) and ada lovelace").expect("ok"),
            Vec::<String>::new()
        );
        assert_eq!(
            in_prompt("LINK vs $pepe vs WIF/USDT").expect("ok"),
            ["LINK/USDT", "PEPE/USDT", "WIF/USDT"]
        );
        assert_eq!(in_prompt("review my portfolio").expect("ok"), Vec::<String>::new());
        assert!(in_prompt("Analyze TSLA").expect_err("underlying").to_string().contains("underlying"));
    }
}
