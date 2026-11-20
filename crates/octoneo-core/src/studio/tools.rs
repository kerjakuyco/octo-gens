//! Carries out the tool calls a model makes during a turn.
//!
//! This is the boundary between the model and the desk. Every tool here either
//! reads something or drafts a ticket; none can place, change or cancel an
//! order, and tool-server tools are limited to those marked read-only.

use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::Utc;
use futures_util::future::join_all;
use rust_decimal::Decimal;
use serde_json::{Value, json};

use super::turn::Trace;
use super::view::{
    CardView, GridBotView, GridPreviewView, GridRequest, MarketRow, NewsView, OrderBookView, PlanView,
    QuoteView, TechnicalFrame,
};
use super::{ANALYSIS_BARS, CARD_LEVELS, DEFAULT_LEVERAGE, Intent, Size, Studio, TicketSpec};
use crate::assistant::tools::{
    self as t, Offered, PlanRequest, account_json, book_json, candles_json, news_json, page_json,
    plan_position, quote_json, schemas,
};
use crate::assistant::{Limits, ToolHost};
use crate::error::Result;
use crate::grid::{GridDirection, GridSpacing};
use crate::indicators::{MIN_BARS, analyze};
use crate::llm::ToolCall;
use crate::model::{Side, Timeframe, decimal_text};
use crate::{bail, desk_err};

const PRIVATE_PREVIEW: &str = "Private result, not kept.";
/// Markets ranked when looking for movers: the most traded, so that a market
/// nobody trades cannot top the list on one stray print.
const MOVERS_POOL: usize = 100;
/// Rows in each list of movers.
const MOVERS_SHOWN: usize = 5;
/// News searches and page reads one answer may make. An answer that needs more is a report.
const SEARCHES_PER_TURN: usize = 4;
const READS_PER_TURN: usize = 4;
/// A query longer than this is not a few words.
const QUERY_CHARS: usize = 200;

/// A figure the interface holds as text, as a JSON number for the model.
fn figure(text: &str) -> Value {
    text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
}

fn mover_json(row: &MarketRow) -> Value {
    json!({
        "symbol": row.symbol,
        "last_price": figure(&row.price),
        "change_24h_pct": row.change_pct.map(|change| (change * 100.0).round() / 100.0),
        "volume_24h_quote": row.quote_volume24h.as_deref().map_or(Value::Null, figure),
        "funding_rate_pct": row.funding_rate_pct,
    })
}

/// A figure the interface holds as text that may be missing.
fn optional_figure(text: Option<&str>) -> Value {
    text.map_or(Value::Null, figure)
}

/// A wire word such as `neutral` or `running`, as the interface spells it.
fn word_of(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// A grid bot's dry run, for the model.
fn grid_json(preview: &GridPreviewView) -> Value {
    json!({
        "network": preview.network.as_str(),
        "symbol": preview.symbol,
        "direction": preview.direction.as_str(),
        "spacing": word_of(preview.spacing),
        "mark_price": figure(&preview.mark_price),
        "lower_price": figure(&preview.lower_price),
        "upper_price": figure(&preview.upper_price),
        "grids": preview.grids,
        "leverage": preview.leverage,
        "margin_mode": if preview.isolated { "isolated" } else { "cross" },
        "margin_usdt": figure(&preview.margin),
        "quantity_per_order": figure(&preview.qty_per_grid),
        "value_per_order_usdt": figure(&preview.notional_per_grid),
        "total_value_usdt": figure(&preview.total_notional),
        "minimum_margin_usdt": figure(&preview.min_margin),
        "profit_per_grid_after_fees_pct": {"lowest": preview.profit_per_grid_min_pct, "highest": preview.profit_per_grid_max_pct},
        "first_market_order": preview.initial_side.map(|side| json!({
            "side": side.as_str(),
            "quantity": optional_figure(preview.initial_qty.as_deref()),
        })),
        "resting_buy_orders": preview.buy_orders,
        "resting_sell_orders": preview.sell_orders,
        "estimated_liquidation_if_long": optional_figure(preview.est_liq_long.as_deref()),
        "estimated_liquidation_if_short": optional_figure(preview.est_liq_short.as_deref()),
        "stop_lower": optional_figure(preview.stop_lower.as_deref()),
        "stop_upper": optional_figure(preview.stop_upper.as_deref()),
        "warnings": preview.warnings,
    })
}

/// One of the trader's grid bots, for the model.
fn bot_json(bot: &GridBotView) -> Value {
    json!({
        "symbol": bot.symbol,
        "direction": bot.direction.as_str(),
        "status": word_of(bot.status),
        "lower_price": figure(&bot.lower_price),
        "upper_price": figure(&bot.upper_price),
        "grids": bot.grids,
        "margin_usdt": figure(&bot.margin),
        "leverage": bot.leverage,
        "mark_price": optional_figure(bot.mark_price.as_deref()),
        "completed_grid_trades": bot.matched_trades,
        "grid_profit_usdt": figure(&bot.realized_pnl),
        "position_unrealized_pnl_usdt": figure(&bot.unrealized_pnl),
        "resting_buy_orders": bot.active_buy_orders,
        "resting_sell_orders": bot.active_sell_orders,
        "trigger_price": optional_figure(bot.trigger_price.as_deref()),
        "stop_lower": optional_figure(bot.stop_lower.as_deref()),
        "stop_upper": optional_figure(bot.stop_upper.as_deref()),
        "started_utc": bot.created_at,
        "last_checked_utc": bot.updated_at,
        "last_note": bot.last_note,
    })
}

/// The grid bot a model asked about, as the desk takes it.
fn grid_request(args: &Value, limit: u32) -> Result<GridRequest> {
    let direction = match text(args, "direction")? {
        "neutral" => GridDirection::Neutral,
        "long" => GridDirection::Long,
        "short" => GridDirection::Short,
        other => bail!("direction must be neutral, long or short, not {other}."),
    };
    let spacing = match optional_text(args, "spacing").unwrap_or("arithmetic") {
        "arithmetic" => GridSpacing::Arithmetic,
        "geometric" => GridSpacing::Geometric,
        other => bail!("spacing must be arithmetic or geometric, not {other}."),
    };
    let grids = whole(args, "grids")?.ok_or_else(|| desk_err!("Missing required argument: grids."))?;
    let leverage = whole(args, "leverage")?.unwrap_or(limit.min(DEFAULT_LEVERAGE));
    if leverage > limit {
        bail!("Leverage {leverage}x is above the trader's limit of {limit}x.");
    }
    let price = |key: &str| required_number(args, key).map(decimal_text);
    let stop = |key: &str| optional_number(args, key).map(|value| value.map(decimal_text));
    Ok(GridRequest {
        symbol: text(args, "symbol")?.to_string(),
        direction,
        spacing,
        lower_price: price("lower")?,
        upper_price: price("upper")?,
        grids,
        margin: price("margin_usdt")?,
        leverage,
        trigger_price: None,
        stop_upper: stop("stop_upper")?,
        stop_lower: stop("stop_lower")?,
        close_on_stop: None,
        post_only: None,
    })
}

pub(super) struct DeskTools<'a> {
    pub studio: &'a Studio,
    pub trace: &'a Trace<'a>,
    /// Which optional tools this turn has: the web, and attached tool servers.
    pub offered: Offered,
    pub limits: Limits,
    /// Links in the trader's message. The assistant may read these pages.
    pub typed: Vec<String>,
    searches: AtomicUsize,
    reads: AtomicUsize,
}

impl<'a> DeskTools<'a> {
    pub(super) fn new(
        studio: &'a Studio,
        trace: &'a Trace<'a>,
        offered: Offered,
        limits: Limits,
        typed: Vec<String>,
    ) -> Self {
        Self {
            studio,
            trace,
            offered,
            limits,
            typed,
            searches: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
        }
    }
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

/// An amount the schema asks for as text. Models often send a number instead.
fn amount(args: &Value, key: &str) -> Option<String> {
    match args.get(key) {
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    }
}

/// A number given as JSON number or numeric text.
fn optional_number(args: &Value, key: &str) -> Result<Option<Decimal>> {
    let Some(raw) = amount(args, key) else {
        return match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(_)) => Ok(None),
            Some(_) => bail!("{key} must be a number."),
        };
    };
    Decimal::from_str(&raw)
        .or_else(|_| Decimal::from_scientific(&raw))
        .map(Some)
        .map_err(|_| desk_err!("{key} must be a number."))
}

fn required_number(args: &Value, key: &str) -> Result<Decimal> {
    optional_number(args, key)?.ok_or_else(|| desk_err!("Missing required argument: {key}."))
}

/// A whole number such as a leverage, given as a JSON number or as text like `5` or `5x`.
fn whole(args: &Value, key: &str) -> Result<Option<u32>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => match number.as_u64().and_then(|n| u32::try_from(n).ok()) {
            Some(value) => Ok(Some(value)),
            None => bail!("{key} must be a whole number."),
        },
        Some(Value::String(text)) => match text.trim().trim_end_matches(['x', 'X']).parse::<u32>() {
            Ok(value) => Ok(Some(value)),
            Err(_) => bail!("{key} must be a whole number."),
        },
        Some(_) => bail!("{key} must be a whole number."),
    }
}

/// A short, human-readable summary of a call for the trace.
fn describe(name: &str, args: &Value) -> String {
    let word = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        t::GET_QUOTE => args
            .get("symbols")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
            .unwrap_or_default(),
        t::ANALYZE_MARKET | t::GET_CANDLES => format!("{} {}", word("symbol"), word("timeframe")),
        t::GET_ORDER_BOOK | t::PLAN_POSITION => word("symbol"),
        t::PLAN_GRID | t::PROPOSE_GRID => {
            let bound = |key: &str| amount(args, key).unwrap_or_default();
            format!("{} {} {} to {}", word("symbol"), word("direction"), bound("lower"), bound("upper"))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        }
        t::PROPOSE_ORDER => {
            let size = amount(args, "quantity")
                .or_else(|| amount(args, "notional_usdt").map(|value| format!("{value} USDT of")));
            format!("{} {} {}", word("action"), size.unwrap_or_default(), word("symbol"))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        }
        t::SEARCH_NEWS => word("query"),
        // The site is enough to say what was read; a whole link is noise in a list of steps.
        t::READ_PAGE => crate::net::host_of(&word("url")).trim_start_matches("www.").to_string(),
        t::LIST_SERVER_TOOLS => word("server"),
        t::CALL_SERVER_TOOL => format!("{} {}", word("server"), word("name")),
        _ => String::new(),
    }
}

/// What the trace keeps of a result. Account figures are summarised and
/// tool-server output is left out, so neither is copied into the journal.
fn preview(name: &str, value: &Value) -> String {
    match name {
        t::CALL_SERVER_TOOL => PRIVATE_PREVIEW.to_string(),
        t::GET_ACCOUNT => format!(
            "equity {} USDT, {} open position(s), {} open order(s)",
            value["equity_usdt"],
            value["positions"].as_array().map_or(0, Vec::len),
            value["open_orders"].as_array().map_or(0, Vec::len)
        ),
        // How the trader's bots are doing is kept out of the journal, as the account is.
        t::GET_GRIDS => {
            let bots = value["grid_bots"].as_array().map(Vec::as_slice).unwrap_or_default();
            let listed: Vec<String> = bots
                .iter()
                .map(|bot| {
                    format!(
                        "{} {}",
                        bot["symbol"].as_str().unwrap_or("?"),
                        bot["status"].as_str().unwrap_or("?")
                    )
                })
                .collect();
            if listed.is_empty() { "no grid bots".to_string() } else { listed.join(", ") }
        }
        _ => value.to_string(),
    }
}

impl DeskTools<'_> {
    async fn get_quote(&self, args: &Value) -> Result<Value> {
        let names: Vec<&str> = args
            .get("symbols")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if names.is_empty() || names.len() > 8 {
            bail!("Pass between one and eight symbols.");
        }
        let studio = self.studio;
        let markets = studio.client(studio.network()).markets().await?;
        let quotes = join_all(names.iter().map(|raw| {
            let resolved = markets.resolve(raw).map(|market| market.symbol.clone());
            async move {
                match resolved {
                    Ok(symbol) => studio.quote(&symbol).await.map_err(|error| (symbol, error)),
                    Err(error) => Err(((*raw).to_string(), error)),
                }
            }
        }))
        .await;
        if let Some(first) = quotes.iter().find_map(|quote| quote.as_ref().ok()) {
            studio.focus(&first.symbol);
        }
        let shown: Vec<QuoteView> =
            quotes.iter().filter_map(|quote| quote.as_ref().ok()).map(QuoteView::for_card).collect();
        if !shown.is_empty() {
            self.trace.card(CardView::Quotes { quotes: shown });
        }
        let rows: Vec<Value> = quotes
            .iter()
            .map(|quote| match quote {
                Ok(quote) => quote_json(quote),
                Err((symbol, error)) => json!({"symbol": symbol, "error": error.0}),
            })
            .collect();
        Ok(json!({"quotes": rows}))
    }

    async fn analyze_market(&self, args: &Value) -> Result<Value> {
        let network = self.studio.network();
        let client = self.studio.client(network);
        let market = client.market(text(args, "symbol")?).await?;
        let timeframe = Timeframe::parse(text(args, "timeframe")?)?;
        let candles = client.candles(&market.symbol, timeframe, ANALYSIS_BARS).await?;
        let Some(last) = candles.last().filter(|_| candles.len() >= MIN_BARS) else {
            bail!(
                "Only {} {} candles exist for {}, too few for a technical reading.",
                candles.len(),
                timeframe.as_str(),
                market.symbol
            );
        };
        self.studio.focus(&market.symbol);
        // The newest candle is still forming, so its close is the latest trade.
        let reading = analyze(&market.symbol, timeframe, &candles, last.c, network.source());
        self.trace.card(CardView::Technicals {
            symbol: market.symbol.clone(),
            frame: TechnicalFrame::from(&reading),
        });
        Ok(reading.to_json())
    }

    async fn get_candles(&self, args: &Value) -> Result<Value> {
        let network = self.studio.network();
        let client = self.studio.client(network);
        let market = client.market(text(args, "symbol")?).await?;
        let timeframe = Timeframe::parse(text(args, "timeframe")?)?;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(30).clamp(5, 120) as usize;
        let candles = client.candles(&market.symbol, timeframe, limit).await?;
        Ok(candles_json(&market.symbol, timeframe.as_str(), network.source(), &candles))
    }

    async fn get_order_book(&self, args: &Value) -> Result<Value> {
        let network = self.studio.network();
        let client = self.studio.client(network);
        let market = client.market(text(args, "symbol")?).await?;
        let book = client.depth(&market.symbol, 100).await?;
        let summary = book_json(&market.symbol, network.source(), &book)?;
        self.trace.card(CardView::Book { book: OrderBookView::new(&market.symbol, &book, CARD_LEVELS)? });
        Ok(summary)
    }

    async fn scan_watchlist(&self) -> Result<Value> {
        let network = self.studio.network();
        self.studio.load_quotes(network).await?;
        let (mut rows, shown) = {
            let state = self.studio.state();
            let mut shown = Vec::new();
            let rows: Vec<(Option<f64>, Value)> = state
                .watchlist
                .iter()
                .map(|instrument| match state.quotes.get(&instrument.symbol) {
                    Some(quote) => {
                        let row = quote_json(quote);
                        let change = row["change_24h_pct"].as_f64();
                        let kept = json!({
                            "symbol": row["symbol"],
                            "last_price": row["last_price"],
                            "change_24h_pct": row["change_24h_pct"],
                            "funding_rate_pct": row["funding_rate_pct"],
                            "as_of_utc": row["as_of_utc"],
                        });
                        shown.push(MarketRow::from_quote(instrument, quote));
                        (change, kept)
                    }
                    None => (None, json!({"symbol": instrument.symbol, "error": "no price right now"})),
                })
                .collect();
            (rows, shown)
        };
        rows.sort_by(|a, b| b.0.unwrap_or(f64::MIN).total_cmp(&a.0.unwrap_or(f64::MIN)));
        let mut shown = shown;
        shown.sort_by(|a, b| b.change_pct.unwrap_or(f64::MIN).total_cmp(&a.change_pct.unwrap_or(f64::MIN)));
        if !shown.is_empty() {
            self.trace.card(CardView::Movers { rows: shown });
        }
        Ok(json!({
            "network": network.as_str(),
            "source": network.source(),
            "funding_note": "Per funding interval. Positive: longs pay shorts.",
            "markets": rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>(),
        }))
    }

    async fn get_movers(&self) -> Result<Value> {
        let network = self.studio.network();
        let mut pool = self.studio.market_overview().await?;
        let counted = pool.len();
        let volume = |row: &MarketRow| {
            row.quote_volume24h.as_deref().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
        };
        pool.sort_by(|a, b| volume(b).total_cmp(&volume(a)));
        let most_traded: Vec<MarketRow> = pool.iter().take(MOVERS_SHOWN).cloned().collect();
        pool.truncate(MOVERS_POOL);
        pool.retain(|row| row.change_pct.is_some());
        pool.sort_by(|a, b| b.change_pct.unwrap_or(0.0).total_cmp(&a.change_pct.unwrap_or(0.0)));
        if pool.is_empty() {
            bail!("There are no 24h statistics right now.");
        }
        let gainers: Vec<MarketRow> =
            pool.iter().take(MOVERS_SHOWN).filter(|row| row.change_pct > Some(0.0)).cloned().collect();
        let losers: Vec<MarketRow> = pool
            .iter()
            .rev()
            .take(MOVERS_SHOWN)
            .filter(|row| row.change_pct < Some(0.0))
            // A market cannot be on both lists.
            .filter(|row| gainers.iter().all(|gainer| gainer.symbol != row.symbol))
            .cloned()
            .collect();
        let list = |rows: &[MarketRow]| rows.iter().map(mover_json).collect::<Vec<_>>();
        let summary = json!({
            "network": network.as_str(),
            "source": network.source(),
            "markets_listed": counted,
            "ranked": format!("the {} most traded markets", pool.len()),
            "gainers_24h": list(&gainers),
            "losers_24h": list(&losers),
            "most_traded_24h": list(&most_traded),
            "funding_note": "Per funding interval. Positive: longs pay shorts.",
        });
        // Strongest first, weakest last, the way a list of movers reads.
        let mut shown = gainers;
        shown.extend(losers.into_iter().rev());
        if !shown.is_empty() {
            self.trace.card(CardView::Movers { rows: shown });
        }
        Ok(summary)
    }

    async fn get_account(&self) -> Result<Value> {
        let network = self.studio.network();
        let account = self.studio.fetch_account(network).await?;
        self.trace.card(CardView::Account);
        Ok(account_json(&account, network))
    }

    async fn plan_position(&self, args: &Value) -> Result<Value> {
        let network = self.studio.network();
        let market = self.studio.client(network).market(text(args, "symbol")?).await?;
        let limit = self.studio.state().prefs.max_leverage;
        let leverage = whole(args, "leverage")?.unwrap_or(limit.min(DEFAULT_LEVERAGE));
        if leverage > limit {
            bail!("Leverage {leverage}x is above the trader's limit of {limit}x.");
        }
        let equity = match optional_number(args, "equity_usdt")? {
            Some(equity) => equity,
            None => match self.studio.account(network).await {
                Ok(account) => account.equity,
                Err(error) => bail!("{} To plan without the account, pass equity_usdt.", error.0),
            },
        };
        let plan = PlanRequest {
            equity,
            entry: required_number(args, "entry")?,
            stop: required_number(args, "stop")?,
            risk_pct: optional_number(args, "risk_pct")?.unwrap_or(Decimal::ONE),
            leverage,
            target: optional_number(args, "target")?,
        };
        let plan = plan_position(&market, &plan)?;
        self.trace.card(CardView::Plan { plan: PlanView::from(&plan) });
        Ok(plan.to_json())
    }

    async fn propose_order(&self, args: &Value) -> Result<Value> {
        let (quantity, notional) = (amount(args, "quantity"), amount(args, "notional_usdt"));
        let size: Result<Size<'_>> = match (quantity.as_deref(), notional.as_deref()) {
            (Some(quantity), None) => Ok(Size::Qty(quantity)),
            (None, Some(notional)) => Ok(Size::Notional(notional)),
            (None, None) => Err(desk_err!("Give a size: quantity in the base asset, or notional_usdt.")),
            _ => Err(desk_err!("Give either quantity or notional_usdt, not both.")),
        };
        let intent = match text(args, "action")? {
            "open_long" => Intent::Open { side: Side::Buy, size: size? },
            "open_short" => Intent::Open { side: Side::Sell, size: size? },
            "reduce" => Intent::Reduce { size: size? },
            "close" => Intent::Close,
            other => bail!("action must be open_long, open_short, reduce or close, not {other}."),
        };
        let (stop_loss, take_profit) = (amount(args, "stop_loss"), amount(args, "take_profit"));
        let spec = TicketSpec {
            symbol: text(args, "symbol")?,
            intent,
            leverage: whole(args, "leverage")?,
            stop_loss: stop_loss.as_deref(),
            take_profit: take_profit.as_deref(),
            rationale: optional_text(args, "rationale").unwrap_or(""),
            by_assistant: true,
        };
        let ticket = self.studio.draft_ticket(spec).await?;
        let summary = json!({
            "status": "Ticket drafted and shown to the trader. It is not placed until they confirm it in the app.",
            "ticket": {
                "network": ticket.network.as_str(),
                "symbol": ticket.symbol,
                "side": ticket.side.as_str(),
                "effect": ticket.effect,
                "quantity": ticket.qty,
                "reference_price": ticket.price,
                "estimated_value_usdt": ticket.notional,
                "leverage": ticket.leverage,
                "estimated_margin_usdt": ticket.margin,
                "reduce_only": ticket.reduce_only,
                "stop_loss": ticket.stop_loss,
                "take_profit": ticket.take_profit,
                "estimated_liquidation_price": ticket.est_liquidation,
            },
        });
        self.trace.ticket(ticket);
        Ok(summary)
    }

    async fn plan_grid(&self, args: &Value) -> Result<Value> {
        let limit = self.studio.state().prefs.max_leverage;
        let preview = self.studio.preview_grid(grid_request(args, limit)?).await?;
        let mut summary = grid_json(&preview);
        summary["note"] = json!("Dry run: nothing was sent.");
        self.trace.card(CardView::Grid { preview: Box::new(preview) });
        Ok(summary)
    }

    async fn propose_grid(&self, args: &Value) -> Result<Value> {
        let limit = self.studio.state().prefs.max_leverage;
        let request = grid_request(args, limit)?;
        let draft = self.studio.draft_grid(request, optional_text(args, "rationale").unwrap_or("")).await?;
        let summary = json!({
            "status": "Grid bot drafted and shown to the trader. It does not start until they start it in the app, and it runs only while the app is open.",
            "grid": grid_json(&draft.preview),
        });
        self.trace.grid(draft);
        Ok(summary)
    }

    async fn get_grids(&self) -> Result<Value> {
        let network = self.studio.network();
        let bots = {
            let state = self.studio.state();
            self.studio.grid_views(&state)
        };
        if bots.is_empty() {
            return Ok(json!({
                "network": network.as_str(),
                "grid_bots": [],
                "note": format!("The trader has no grid bots on {}.", network.name()),
            }));
        }
        let rows: Vec<Value> = bots.iter().map(bot_json).collect();
        self.trace.card(CardView::Grids { bots });
        Ok(json!({
            "network": network.as_str(),
            "grid_bots": rows,
            "note": "As the app last checked them. Grid profit counts completed grid trades after estimated fees; unrealized is the whole position in that market.",
        }))
    }

    async fn search_news(&self, args: &Value) -> Result<Value> {
        let query = optional_text(args, "query").unwrap_or_default();
        if query.chars().count() > QUERY_CHARS {
            bail!("Search for a few words, not a paragraph.");
        }
        if self.searches.fetch_add(1, Ordering::Relaxed) >= SEARCHES_PER_TURN {
            bail!("That is enough searching for one answer. Answer with what you have.");
        }
        let mut found = self.studio.news(query).await?;
        found.truncate(self.limits.headlines);
        // What the assistant was shown is what it may read, and what the trader sees.
        self.studio.remember_sources(found.iter().map(|article| article.url.clone()));
        if !found.is_empty() {
            self.trace.card(CardView::News {
                query: query.to_string(),
                articles: found.iter().map(NewsView::from).collect(),
            });
        }
        Ok(news_json(query, &found, Utc::now()))
    }

    async fn read_page(&self, args: &Value) -> Result<Value> {
        let Some(link) = self.studio.known_source(text(args, "url")?, &self.typed) else {
            bail!(
                "That link is not a search result or a link the trader gave. Search first, then pass a result's url exactly as it is."
            );
        };
        if self.reads.fetch_add(1, Ordering::Relaxed) >= READS_PER_TURN {
            bail!("That is enough reading for one answer. Answer with what you have.");
        }
        let page = self.studio.page(&link).await?;
        Ok(page_json(&page, self.limits.page_bytes))
    }

    async fn list_server_tools(&self, args: &Value) -> Result<Value> {
        let server = text(args, "server")?;
        let words: Vec<String> = optional_text(args, "search")
            .map(|s| s.to_ascii_lowercase().split_whitespace().map(str::to_string).collect())
            .unwrap_or_default();
        let tools = self.studio.mcp_tools(server).await?;
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
        Ok(json!({"server": server, "read_only_tools": read_only, "shown": matches.len(), "tools": matches}))
    }

    async fn call_server_tool(&self, args: &Value) -> Result<Value> {
        let arguments = args.get("arguments").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
        self.studio.server_tool(text(args, "server")?, text(args, "name")?, &arguments, false).await
    }

    async fn dispatch(&self, name: &str, args: &Value) -> Result<Value> {
        match name {
            t::GET_QUOTE => self.get_quote(args).await,
            t::ANALYZE_MARKET => self.analyze_market(args).await,
            t::GET_CANDLES => self.get_candles(args).await,
            t::GET_ORDER_BOOK => self.get_order_book(args).await,
            t::SCAN_WATCHLIST => self.scan_watchlist().await,
            t::GET_MOVERS => self.get_movers().await,
            t::GET_ACCOUNT => self.get_account().await,
            t::PLAN_POSITION => self.plan_position(args).await,
            t::PROPOSE_ORDER => self.propose_order(args).await,
            t::PLAN_GRID => self.plan_grid(args).await,
            t::PROPOSE_GRID => self.propose_grid(args).await,
            t::GET_GRIDS => self.get_grids().await,
            t::SEARCH_NEWS if self.offered.web => self.search_news(args).await,
            t::READ_PAGE if self.offered.web => self.read_page(args).await,
            t::LIST_SERVER_TOOLS if self.offered.servers => self.list_server_tools(args).await,
            t::CALL_SERVER_TOOL if self.offered.servers => self.call_server_tool(args).await,
            _ => bail!("Unknown tool: {name}."),
        }
    }
}

impl ToolHost for DeskTools<'_> {
    fn tools(&self) -> Vec<Value> {
        schemas(self.offered)
    }

    async fn call(&self, call: &ToolCall) -> String {
        let args = match serde_json::from_str::<Value>(&call.arguments) {
            Ok(args) if args.is_object() => args,
            // A tool without parameters may be called with no arguments at all.
            _ if call.arguments.trim().is_empty() => json!({}),
            _ => json!(null),
        };
        let handle = self.trace.begin(&call.name, &describe(&call.name, &args));
        let outcome = if args.is_null() {
            Err(desk_err!("The arguments were not a JSON object. Call the tool again with valid arguments."))
        } else {
            self.dispatch(&call.name, &args).await
        };
        match outcome {
            Ok(value) => {
                self.trace.end(handle, Ok(preview(&call.name, &value)));
                value.to_string()
            }
            Err(error) => {
                self.trace.end(handle, Err(error.0.clone()));
                json!({"error": error.0}).to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_are_read_leniently_but_never_guessed() {
        let args = json!({"quantity": 0.015, "notional_usdt": " 500 ", "leverage": "5x", "blank": "  ", "flag": true, "risk_pct": "0.5"});
        assert_eq!(
            (amount(&args, "quantity").as_deref(), amount(&args, "notional_usdt").as_deref()),
            (Some("0.015"), Some("500"))
        );
        assert_eq!(
            (amount(&args, "blank"), amount(&args, "missing"), amount(&args, "flag")),
            (None, None, None)
        );
        assert_eq!(whole(&args, "leverage").expect("leverage"), Some(5));
        assert_eq!(whole(&json!({"leverage": 10}), "leverage").expect("leverage"), Some(10));
        assert_eq!(whole(&args, "missing").expect("absent"), None);
        for bad in [
            json!({"leverage": 2.5}),
            json!({"leverage": -1}),
            json!({"leverage": "high"}),
            json!({"leverage": [3]}),
        ] {
            assert!(whole(&bad, "leverage").is_err(), "{bad}");
        }
        assert_eq!(optional_number(&args, "risk_pct").expect("number"), Some(Decimal::new(5, 1)));
        assert_eq!(optional_number(&args, "blank").expect("blank"), None);
        assert!(optional_number(&args, "flag").is_err() && required_number(&args, "missing").is_err());
        assert!(optional_number(&json!({"entry": "about 60k"}), "entry").is_err());
    }

    #[test]
    fn the_trace_describes_calls_and_keeps_private_results_out() {
        assert_eq!(describe(t::GET_QUOTE, &json!({"symbols": ["BTC", "ETHUSDT"]})), "BTC, ETHUSDT");
        assert_eq!(describe(t::ANALYZE_MARKET, &json!({"symbol": "BTC", "timeframe": "4h"})), "BTC 4h");
        assert_eq!(
            describe(t::PROPOSE_ORDER, &json!({"action": "open_long", "quantity": "0.01", "symbol": "BTC"})),
            "open_long 0.01 BTC"
        );
        assert_eq!(
            describe(
                t::PROPOSE_ORDER,
                &json!({"action": "open_short", "notional_usdt": 500, "symbol": "ETH"})
            ),
            "open_short 500 USDT of ETH"
        );
        assert_eq!(describe(t::PROPOSE_ORDER, &json!({"action": "close", "symbol": "BTC"})), "close BTC");
        assert_eq!(
            describe(t::CALL_SERVER_TOOL, &json!({"server": "news", "name": "search"})),
            "news search"
        );
        assert_eq!(describe(t::SEARCH_NEWS, &json!({"query": "solana etf"})), "solana etf");
        assert_eq!(describe(t::SEARCH_NEWS, &json!({})), "");
        assert_eq!(
            describe(
                t::READ_PAGE,
                &json!({"url": "https://www.coindesk.com/markets/2026/11/19/a-story?x=1"})
            ),
            "coindesk.com"
        );
        assert_eq!(describe(t::READ_PAGE, &json!({"url": "not a link"})), "the server");

        assert_eq!(preview(t::CALL_SERVER_TOOL, &json!({"balance": "12345.67"})), PRIVATE_PREVIEW);
        let account = json!({"equity_usdt": 988.25, "positions": [{"symbol": "BTCUSDT", "entry_price": 63600.0}], "open_orders": []});
        let kept = preview(t::GET_ACCOUNT, &account);
        assert_eq!(kept, "equity 988.25 USDT, 1 open position(s), 0 open order(s)");
        assert!(!kept.contains("63600"), "position details stay out of the journaled trace");
        assert_eq!(preview(t::GET_QUOTE, &json!({"quotes": []})), "{\"quotes\":[]}");
    }
}
