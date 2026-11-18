//! The built-in agents: plain commands that work with no language model.
//!
//! These parsers decide what a prompt is asking for. They are deliberately
//! strict: a trading instruction is either understood exactly or rejected with
//! an example, never guessed at.

use serde_json::Value;

use crate::bail;
use crate::error::Result;
use crate::model::{Side, VenueId};

pub const HELP: &str = "Try \"Analyze BTC\", \"Compare ETH and SOL\" or \"Review my portfolio\". To draft an order, type \"Buy 0.01 BTC\" or \"Sell 2 SOL\". Add an OpenRouter key in Settings for open questions, trade plans and multi-step research.";

/// What a prompt is, before any model is involved.
#[derive(Debug, PartialEq)]
pub enum Command {
    /// `buy 0.5 BTC`: draft a paper ticket at once.
    Order {
        side: Side,
        quantity: String,
        symbol: String,
    },
    /// `@bybit tool_name {"arg": 1}`: call a tool on an attached exchange server.
    ExchangeTool {
        venue: VenueId,
        name: String,
        arguments: Value,
    },
    Portfolio,
    Help,
    /// Anything else: research the named instruments, or hand over to the model.
    Open,
}

fn word(token: &str) -> String {
    token.trim_matches(|c: char| matches!(c, '.' | '!' | '?' | ',')).to_ascii_lowercase()
}

/// Classifies a prompt. Only an exact order or tool command is acted on directly.
pub fn parse(prompt: &str) -> Result<Command> {
    let text = prompt.trim();
    if let Some(rest) = text.strip_prefix('@') {
        return exchange_tool(rest);
    }
    let mut tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.first().is_some_and(|t| word(t) == "please") {
        tokens.remove(0);
    }
    if let Some(side) = tokens.first().map(|t| word(t)).filter(|w| w == "buy" || w == "sell") {
        // "buy 0.5 BTC", "sell 2 of SOL", "buy 10 units of ETH".
        let rest: Vec<&str> = tokens[1..]
            .iter()
            .copied()
            .filter(|t| !matches!(word(t).as_str(), "of" | "unit" | "units" | "token" | "tokens"))
            .collect();
        let quantity = rest.first().map(|t| t.trim_end_matches(','));
        let numeric =
            quantity.is_some_and(|q| !q.is_empty() && q.bytes().all(|b| b.is_ascii_digit() || b == b'.'));
        if rest.len() != 2 || !numeric {
            bail!("To draft an order, give a quantity and a token, for example: Buy 0.5 BTC.");
        }
        return Ok(Command::Order {
            side: Side::parse(&side)?,
            quantity: quantity.unwrap_or_default().to_string(),
            symbol: rest[1].trim_end_matches(['.', '!']).to_string(),
        });
    }
    let lowered = text.to_ascii_lowercase();
    if matches!(
        lowered.trim_end_matches(['?', '!', '.']),
        "help" | "hello" | "hi" | "hey" | "what can you do"
    ) {
        return Ok(Command::Help);
    }
    let asks_portfolio = lowered.split(|c: char| !c.is_ascii_alphabetic()).any(|w| {
        matches!(
            w,
            "portfolio" | "holdings" | "positions" | "balance" | "balances" | "exposure" | "cash" | "equity"
        )
    });
    Ok(if asks_portfolio { Command::Portfolio } else { Command::Open })
}

fn exchange_tool(rest: &str) -> Result<Command> {
    let usage =
        "Use @venue tool_name {\"parameter\": \"value\"} with a tool from the attached server's catalog.";
    let (venue, rest) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let rest = rest.trim();
    let (name, raw) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let valid_name = !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if !valid_name {
        bail!("{usage}");
    }
    let arguments = match raw.trim() {
        "" => Value::Object(Default::default()),
        raw => match serde_json::from_str::<Value>(raw) {
            Ok(value) if value.is_object() => value,
            _ => bail!("{usage}"),
        },
    };
    Ok(Command::ExchangeTool { venue: VenueId::parse(venue)?, name: name.to_string(), arguments })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn order(side: Side, quantity: &str, symbol: &str) -> Command {
        Command::Order { side, quantity: quantity.to_string(), symbol: symbol.to_string() }
    }

    #[test]
    fn explicit_orders_are_parsed_exactly_or_rejected_with_an_example() {
        assert_eq!(parse("Buy 0.5 TSLAx").expect("order"), order(Side::Buy, "0.5", "TSLAx"));
        assert_eq!(parse("please sell 2 of SOL.").expect("order"), order(Side::Sell, "2", "SOL"));
        assert_eq!(
            parse("  BUY .25 units of btc/usdt!").expect("order"),
            order(Side::Buy, ".25", "btc/usdt")
        );
        for vague in [
            "buy BTC",
            "buy some bitcoin",
            "sell everything",
            "buy 1 BTC and 2 ETH",
            "buy -1 BTC",
            "buy 1e3 BTC",
            "Sell",
        ] {
            let error = parse(vague).expect_err(vague).to_string();
            assert!(error.contains("Buy 0.5 BTC"), "{vague}: {error}");
        }
    }

    #[test]
    fn negations_and_questions_are_not_orders() {
        for open in
            ["Don't buy 1 BTC", "should I buy 1 BTC?", "Why did you buy 1 BTC", "is it time to sell 2 ETH"]
        {
            assert_eq!(parse(open).expect(open), Command::Open, "{open}");
        }
    }

    #[test]
    fn tool_commands_need_a_venue_a_name_and_an_object() {
        assert_eq!(
            parse("@bybit get_tickers {\"category\": \"spot\", \"symbol\": \"BTCUSDT\"}").expect("tool"),
            Command::ExchangeTool {
                venue: VenueId::Bybit,
                name: "get_tickers".to_string(),
                arguments: json!({"category": "spot", "symbol": "BTCUSDT"})
            }
        );
        assert_eq!(
            parse("@okx market.ticker").expect("tool"),
            Command::ExchangeTool {
                venue: VenueId::Okx,
                name: "market.ticker".to_string(),
                arguments: json!({})
            }
        );
        for bad in [
            "@",
            "@bybit",
            "@bybit get tickers",
            "@bybit get_tickers [1]",
            "@bybit get_tickers {broken",
            "@kraken ping {}",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn portfolio_help_and_open_prompts_are_told_apart() {
        for prompt in ["Review my portfolio", "what's my cash balance?", "show holdings", "exposure?"] {
            assert_eq!(parse(prompt).expect(prompt), Command::Portfolio, "{prompt}");
        }
        for prompt in ["help", "Hello!", "what can you do?"] {
            assert_eq!(parse(prompt).expect(prompt), Command::Help, "{prompt}");
        }
        for prompt in ["Compare BTC and ETH", "is cashless the future", "What is moving?"] {
            assert_eq!(parse(prompt).expect(prompt), Command::Open, "{prompt}");
        }
    }
}
