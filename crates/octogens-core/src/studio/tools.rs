//! Carries out the tool calls a model makes during a turn.
//!
//! This is the boundary between the model and the desk. Every tool here either
//! reads something or drafts a ticket; none can place, change or cancel an
//! order, and exchange-server tools are limited to those marked read-only.

use std::str::FromStr;

use futures_util::future::join_all;
use rust_decimal::Decimal;
use serde_json::{Value, json};

use super::Studio;
use super::turn::Trace;
use super::view::Destination;
use crate::assistant::ToolHost;
use crate::assistant::tools::{
    self as t, account_json, book_json, candles_json, number, plan_position, quote_json, schemas,
};
use crate::error::Result;
use crate::indicators::{MIN_BARS, analyze};
use crate::instruments::resolve;
use crate::llm::openrouter::ToolCall;
use crate::model::{Feed, Side, Timeframe, VenueId, decimal_text, pct};
use crate::{bail, desk_err};

const PRIVATE_PREVIEW: &str = "Private result, not kept.";
/// Candles read for an analysis: enough for EMA200 with room to settle.
const ANALYSIS_BARS: usize = 240;

pub(super) struct DeskTools<'a> {
    pub studio: &'a Studio,
    pub trace: &'a Trace<'a>,
    /// An exchange MCP server is attached, so its two tools are offered.
    pub servers: bool,
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    match args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => Ok(value),
        None => bail!("Missing required argument: {key}."),
    }
}

fn optional_text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// A number given as JSON number or numeric text.
fn optional_number(args: &Value, key: &str) -> Result<Option<Decimal>> {
    let raw = match args.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.trim().to_string(),
        Some(_) => bail!("{key} must be a number."),
    };
    Decimal::from_str(&raw)
        .or_else(|_| Decimal::from_scientific(&raw))
        .map(Some)
        .map_err(|_| desk_err!("{key} must be a number."))
}

fn required_number(args: &Value, key: &str) -> Result<Decimal> {
    optional_number(args, key)?.ok_or_else(|| desk_err!("Missing required argument: {key}."))
}

/// A short, human-readable summary of a call for the trace.
fn describe(name: &str, args: &Value) -> String {
    let word = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        t::GET_QUOTE => args
            .get("pairs")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
            .unwrap_or_default(),
        t::ANALYZE_MARKET | t::GET_CANDLES => format!("{} {}", word("pair"), word("timeframe")),
        t::GET_ORDER_BOOK | t::COMPARE_VENUES | t::PLAN_POSITION => word("pair"),
        t::PROPOSE_ORDER => {
            let size = optional_text(args, "quantity")
                .map(str::to_string)
                .or_else(|| optional_text(args, "quote_amount").map(|a| format!("{a} USDT of")));
            format!("{} {} {}", word("side"), size.unwrap_or_default(), word("pair"))
        }
        t::LIST_EXCHANGE_TOOLS => word("venue"),
        t::CALL_EXCHANGE_TOOL => format!("{} {}", word("venue"), word("name")),
        _ => String::new(),
    }
}

impl DeskTools<'_> {
    fn focus(&self, pair: &str) {
        let mut state = self.studio.state();
        state.focus = pair.to_string();
        state.feed_error.clear();
    }

    async fn get_quote(&self, args: &Value) -> Result<Value> {
        let pairs: Vec<&str> = args
            .get("pairs")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if pairs.is_empty() || pairs.len() > 8 {
            bail!("Pass between one and eight pairs.");
        }
        let studio = self.studio;
        let quotes = join_all(pairs.iter().map(|raw| async move {
            match resolve(raw) {
                Ok(instrument) => studio.quote(&instrument).await.map_err(|e| (instrument.pair(), e)),
                Err(error) => Err(((*raw).to_string(), error)),
            }
        }))
        .await;
        if let Some(first) = quotes.iter().find_map(|q| q.as_ref().ok()) {
            self.focus(&first.pair);
        }
        let rows: Vec<Value> = quotes
            .iter()
            .map(|quote| match quote {
                Ok(quote) => quote_json(quote),
                Err((pair, error)) => json!({"pair": pair, "error": error.0}),
            })
            .collect();
        Ok(json!({"quotes": rows}))
    }

    async fn analyze_market(&self, args: &Value) -> Result<Value> {
        let instrument = resolve(text(args, "pair")?)?;
        let timeframe = Timeframe::parse(text(args, "timeframe")?)?;
        let (candles, source, sample) =
            self.studio.read_candles(&instrument, timeframe, ANALYSIS_BARS).await?;
        let Some(last) = candles.last().filter(|_| candles.len() >= MIN_BARS) else {
            bail!(
                "Only {} {} candles exist for {}, too few for a technical reading.",
                candles.len(),
                timeframe.as_str(),
                instrument.pair()
            );
        };
        self.focus(&instrument.pair());
        // On a live venue the newest candle is still forming, so its close is the latest trade.
        Ok(analyze(&instrument.pair(), timeframe, &candles, last.c, &source, sample).to_json())
    }

    async fn get_candles(&self, args: &Value) -> Result<Value> {
        let instrument = resolve(text(args, "pair")?)?;
        let timeframe = Timeframe::parse(text(args, "timeframe")?)?;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(30).clamp(5, 120) as usize;
        let (candles, source, sample) = self.studio.read_candles(&instrument, timeframe, limit).await?;
        Ok(candles_json(&instrument.pair(), timeframe.as_str(), &source, sample, &candles))
    }

    async fn get_order_book(&self, args: &Value) -> Result<Value> {
        let instrument = resolve(text(args, "pair")?)?;
        let Feed::Venue(venue) = self.studio.feed() else {
            bail!(
                "The sample feed has no order book. Ask the trader to switch the feed to Binance, Bybit or OKX."
            );
        };
        let book = self.studio.venue(venue).depth(&instrument, 100).await?;
        book_json(&instrument.pair(), &format!("{} spot", venue.name()), &book)
    }

    async fn compare_venues(&self, args: &Value) -> Result<Value> {
        let instrument = resolve(text(args, "pair")?)?;
        let studio = self.studio;
        let instrument_ref = &instrument;
        let ticks = join_all(
            VenueId::ALL
                .into_iter()
                .map(|venue| async move { (venue, studio.venue(venue).ticker(instrument_ref).await) }),
        )
        .await;
        let prices: Vec<Decimal> =
            ticks.iter().filter_map(|(_, tick)| tick.as_ref().ok().map(|t| t.price)).collect();
        let rows: Vec<Value> = ticks
            .iter()
            .map(|(venue, tick)| match tick {
                Ok(tick) => json!({
                    "venue": venue.as_str(),
                    "price_usdt": number(tick.price),
                    "bid": tick.stats.bid.map(number),
                    "ask": tick.stats.ask.map(number),
                    "as_of_utc": tick.as_of.format("%Y-%m-%d %H:%M:%S").to_string(),
                }),
                Err(error) => json!({"venue": venue.as_str(), "error": error.0}),
            })
            .collect();
        let gap = match (prices.iter().max(), prices.iter().min()) {
            (Some(high), Some(low)) if prices.len() > 1 => {
                pct(*high, *low).map(|g| (g * 1000.0).round() / 1000.0)
            }
            _ => None,
        };
        Ok(
            json!({"pair": instrument.pair(), "live_data": true, "venues": rows, "highest_vs_lowest_pct": gap}),
        )
    }

    async fn scan_watchlist(&self) -> Result<Value> {
        self.studio.refresh_quotes().await?;
        let state = self.studio.state();
        let mut rows: Vec<(Option<f64>, Value)> = state
            .watchlist
            .iter()
            .map(|instrument| match state.quotes.get(&instrument.pair()) {
                Some(quote) => {
                    let change = quote.change_pct().map(|c| (c * 100.0).round() / 100.0);
                    (change, json!({"pair": quote.pair, "price_usdt": number(quote.price), "change_pct": change, "as_of_utc": quote.stamp()}))
                }
                None => (None, json!({"pair": instrument.pair(), "error": "no quote on this feed"})),
            })
            .collect();
        rows.sort_by(|a, b| b.0.unwrap_or(f64::MIN).total_cmp(&a.0.unwrap_or(f64::MIN)));
        let live = state.feed != Feed::Sample;
        Ok(json!({
            "feed": state.feed.as_str(),
            "sample_data": !live,
            "change_basis": if live { "24h" } else { "previous daily close" },
            "instruments": rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>(),
        }))
    }

    async fn get_portfolio(&self, args: &Value) -> Result<Value> {
        let feed = self.studio.feed();
        let account = self.studio.book(feed)?.snapshot()?;
        let mut result = account_json(&account, feed.as_str(), feed == Feed::Sample);
        if args.get("include_exchange").and_then(Value::as_bool) == Some(true) {
            let Feed::Venue(venue) = feed else {
                bail!(
                    "The sample feed has no exchange account. Real balances need a live feed and API keys."
                );
            };
            let balances = self.studio.venue(venue).balances().await?;
            result["exchange_balances"] = json!({
                "venue": venue.as_str(),
                "assets": balances.iter().map(|b| json!({"asset": b.asset, "total": decimal_text(b.total)})).collect::<Vec<_>>(),
            });
        }
        Ok(result)
    }

    fn plan_position(&self, args: &Value) -> Result<Value> {
        let instrument = resolve(text(args, "pair")?)?;
        let equity = match optional_number(args, "equity_usdt")? {
            Some(equity) => equity,
            None => self.studio.book(self.studio.feed())?.snapshot()?.equity,
        };
        let risk = optional_number(args, "risk_pct")?.unwrap_or(Decimal::ONE);
        plan_position(
            &instrument.pair(),
            equity,
            required_number(args, "entry")?,
            required_number(args, "stop")?,
            risk,
            optional_number(args, "target")?,
        )
    }

    async fn propose_order(&self, args: &Value) -> Result<Value> {
        let side = Side::parse(text(args, "side")?)?;
        let destination = match optional_text(args, "destination") {
            None | Some("paper") => Destination::Paper,
            Some("exchange") => Destination::Exchange,
            Some(other) => bail!("destination must be paper or exchange, not {other}."),
        };
        if destination == Destination::Exchange && !self.studio.state().prefs.live_tickets {
            bail!(
                "Live tickets from the assistant are turned off. The trader can allow them in Settings; until then, draft a paper ticket."
            );
        }
        let ticket = self
            .studio
            .draft_ticket(
                text(args, "pair")?,
                side,
                optional_text(args, "quantity"),
                optional_text(args, "quote_amount"),
                destination,
                optional_text(args, "rationale").unwrap_or(""),
            )
            .await?;
        let summary = json!({
            "status": "Ticket drafted and shown to the trader. It is not placed until they confirm it in the app.",
            "ticket": {
                "pair": ticket.pair,
                "side": ticket.side.as_str(),
                "quantity": ticket.qty,
                "reference_price_usdt": ticket.price,
                "estimated_value_usdt": ticket.value,
                "destination": if destination == Destination::Paper { "paper account" } else { "live exchange account" },
            },
        });
        self.trace.ticket(ticket);
        Ok(summary)
    }

    async fn list_exchange_tools(&self, args: &Value) -> Result<Value> {
        let venue = VenueId::parse(text(args, "venue")?)?;
        let words: Vec<String> = optional_text(args, "search")
            .map(|s| s.to_ascii_lowercase().split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();
        let tools = self.studio.mcp_tools(venue).await?;
        let read_only = tools.iter().filter(|tool| tool.read_only).count();
        let matches: Vec<Value> = tools
            .iter()
            .filter(|tool| tool.read_only)
            .filter(|tool| {
                let haystack = format!("{} {}", tool.name, tool.description).to_ascii_lowercase();
                words.iter().all(|word| haystack.contains(word))
            })
            .take(40)
            .map(|tool| json!({"name": tool.name, "description": tool.description.chars().take(300).collect::<String>(), "input_schema": tool.schema}))
            .collect();
        Ok(
            json!({"venue": venue.as_str(), "read_only_tools": read_only, "shown": matches.len(), "tools": matches}),
        )
    }

    async fn call_exchange_tool(&self, args: &Value) -> Result<Value> {
        let venue = VenueId::parse(text(args, "venue")?)?;
        let arguments = args.get("arguments").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
        self.studio.exchange_tool(venue, text(args, "name")?, &arguments, false).await
    }

    async fn dispatch(&self, name: &str, args: &Value) -> Result<Value> {
        match name {
            t::GET_QUOTE => self.get_quote(args).await,
            t::ANALYZE_MARKET => self.analyze_market(args).await,
            t::GET_CANDLES => self.get_candles(args).await,
            t::GET_ORDER_BOOK => self.get_order_book(args).await,
            t::COMPARE_VENUES => self.compare_venues(args).await,
            t::SCAN_WATCHLIST => self.scan_watchlist().await,
            t::GET_PORTFOLIO => self.get_portfolio(args).await,
            t::PLAN_POSITION => self.plan_position(args),
            t::PROPOSE_ORDER => self.propose_order(args).await,
            t::LIST_EXCHANGE_TOOLS if self.servers => self.list_exchange_tools(args).await,
            t::CALL_EXCHANGE_TOOL if self.servers => self.call_exchange_tool(args).await,
            _ => bail!("Unknown tool: {name}."),
        }
    }
}

impl ToolHost for DeskTools<'_> {
    fn tools(&self) -> Vec<Value> {
        schemas(self.servers)
    }

    async fn call(&self, call: &ToolCall) -> String {
        let args = match serde_json::from_str::<Value>(&call.arguments) {
            Ok(args) if args.is_object() => args,
            _ => json!(null),
        };
        let handle = self.trace.begin(&call.name, &describe(&call.name, &args));
        let outcome = if args.is_null() {
            Err(desk_err!("The arguments were not a JSON object. Call the tool again with valid arguments."))
        } else {
            self.dispatch(&call.name, &args).await
        };
        // Results that may hold account details are not copied into the journaled trace.
        let private = call.name == t::CALL_EXCHANGE_TOOL
            || (call.name == t::GET_PORTFOLIO
                && args.get("include_exchange").and_then(Value::as_bool) == Some(true));
        match outcome {
            Ok(value) => {
                let text = value.to_string();
                self.trace.end(handle, Ok(if private { PRIVATE_PREVIEW.to_string() } else { text.clone() }));
                text
            }
            Err(error) => {
                self.trace.end(handle, Err(error.0.clone()));
                json!({"error": error.0}).to_string()
            }
        }
    }
}
