//! The shapes that cross to the user interface.
//!
//! These mirror `src/api/types.ts` field for field (camelCase on the wire).
//! Change both together. Decimal amounts are sent as strings so no precision is
//! lost on the way; nothing here contains a secret.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::instruments::Instrument;
use crate::llm::openrouter::Usage;
use crate::mcp::Transport;
use crate::model::{Account, Candle, Feed, Quote, Side, VenueId, decimal_text};
use crate::store::{Effort, Provider, Theme};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentView {
    pub pair: String,
    pub ticker: String,
    pub name: String,
    /// `crypto` or `xstock`.
    pub kind: &'static str,
    pub underlying: Option<String>,
    pub custom: bool,
}

impl From<&Instrument> for InstrumentView {
    fn from(instrument: &Instrument) -> Self {
        Self {
            pair: instrument.pair(),
            ticker: instrument.ticker.clone(),
            name: instrument.name.clone(),
            kind: if instrument.is_xstock() { "xstock" } else { "crypto" },
            underlying: instrument.underlying.clone(),
            custom: instrument.custom,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteView {
    pub pair: String,
    pub price: String,
    pub change_pct: Option<f64>,
    pub high24h: Option<String>,
    pub low24h: Option<String>,
    pub volume24h: Option<String>,
    pub quote_volume24h: Option<String>,
    pub bid: Option<String>,
    pub ask: Option<String>,
    pub closes: Vec<String>,
    pub as_of: String,
    pub source: String,
    pub sample: bool,
}

impl From<&Quote> for QuoteView {
    fn from(quote: &Quote) -> Self {
        let text = |value: &Option<rust_decimal::Decimal>| value.map(decimal_text);
        Self {
            pair: quote.pair.clone(),
            price: decimal_text(quote.price),
            change_pct: quote.change_pct(),
            high24h: text(&quote.stats.high),
            low24h: text(&quote.stats.low),
            volume24h: text(&quote.stats.volume),
            quote_volume24h: text(&quote.stats.quote_volume),
            bid: text(&quote.stats.bid),
            ask: text(&quote.stats.ask),
            closes: quote.closes.iter().map(|c| decimal_text(*c)).collect(),
            as_of: quote.as_of.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            source: quote.source.clone(),
            sample: quote.sample,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingView {
    pub pair: String,
    pub qty: String,
    pub value: String,
    pub cost: String,
    pub pnl: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillView {
    pub id: String,
    pub pair: String,
    pub side: Side,
    pub qty: String,
    pub price: String,
    pub status: String,
    pub submitted: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub cash: String,
    pub equity: String,
    pub holdings: Vec<HoldingView>,
    pub orders: Vec<FillView>,
}

impl From<&Account> for AccountView {
    fn from(account: &Account) -> Self {
        Self {
            cash: account.cash.to_string(),
            equity: account.equity.to_string(),
            holdings: account
                .holdings
                .iter()
                .map(|h| HoldingView {
                    pair: h.pair.clone(),
                    qty: decimal_text(h.qty),
                    value: h.value.to_string(),
                    cost: h.cost.to_string(),
                    pnl: (h.value - h.cost).to_string(),
                })
                .collect(),
            orders: account
                .orders
                .iter()
                .map(|f| FillView {
                    id: f.id.clone(),
                    pair: f.pair.clone(),
                    side: f.side,
                    qty: decimal_text(f.qty),
                    price: decimal_text(f.price),
                    status: f.status.clone(),
                    submitted: f.submitted.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    pub name: String,
    pub version: String,
    pub transport: Transport,
    pub tools: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueView {
    pub id: VenueId,
    pub name: &'static str,
    pub credentials: bool,
    pub remembered: bool,
    pub mcp: Option<McpView>,
    pub official_package: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantView {
    pub provider: Provider,
    pub model: String,
    pub label: String,
    pub has_key: bool,
    pub tools: bool,
    pub reasoning: bool,
    pub effort: Effort,
    pub live_tickets: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepView {
    pub name: String,
    pub detail: String,
    pub status: StepStatus,
    pub ms: u64,
    #[serde(default)]
    pub preview: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    Paper,
    Exchange,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketView {
    pub id: String,
    pub pair: String,
    pub side: Side,
    pub qty: String,
    pub price: String,
    pub value: String,
    pub feed: Feed,
    pub destination: Destination,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Complete,
    Failed,
    Stopped,
}

/// One unit of agent work: a chat turn, an order, a pattern check or a tool call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: String,
    /// Conversation id for chat turns; empty for everything else.
    #[serde(default)]
    pub thread: String,
    pub agent: String,
    pub title: String,
    pub feed: Feed,
    pub time: String,
    pub status: RunStatus,
    #[serde(default)]
    pub steps: Vec<StepView>,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub ms: u64,
    #[serde(default)]
    pub ticket: Option<TicketView>,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchView {
    pub pair: String,
    pub budget: String,
    pub feed: Feed,
}

/// Everything the user interface renders.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: &'static str,
    pub feed: Feed,
    pub focus: String,
    pub feed_error: String,
    pub instruments: Vec<InstrumentView>,
    pub quotes: HashMap<String, QuoteView>,
    pub account: AccountView,
    pub venues: Vec<VenueView>,
    pub assistant: AssistantView,
    pub theme: Theme,
    pub thread: String,
    pub runs: Vec<RunView>,
    pub draft: Option<TicketView>,
    pub receipts: HashMap<String, String>,
    pub watch: Option<WatchView>,
    pub node_runtime: bool,
    pub busy: bool,
}

/// `[open time ms, open, high, low, close, volume]`.
pub type CandleRow = (i64, String, String, String, String, String);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandleSeries {
    pub pair: String,
    pub timeframe: String,
    pub rows: Vec<CandleRow>,
    pub source: String,
    pub sample: bool,
}

impl CandleSeries {
    pub fn new(pair: &str, timeframe: &str, source: &str, sample: bool, candles: &[Candle]) -> Self {
        Self {
            pair: pair.to_string(),
            timeframe: timeframe.to_string(),
            rows: candles
                .iter()
                .map(|c| {
                    (
                        c.t,
                        decimal_text(c.o),
                        decimal_text(c.h),
                        decimal_text(c.l),
                        decimal_text(c.c),
                        decimal_text(c.v),
                    )
                })
                .collect(),
            source: source.to_string(),
            sample,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRow {
    pub asset: String,
    pub total: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRequest {
    pub pair: String,
    pub side: Side,
    #[serde(default)]
    pub qty: Option<String>,
    #[serde(default)]
    pub quote_amount: Option<String>,
    pub destination: Destination,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsRequest {
    pub venue: VenueId,
    pub key: String,
    pub secret: String,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRequest {
    pub provider: Provider,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub effort: Effort,
    #[serde(default)]
    pub live_tickets: bool,
}

/// Streamed to the user interface while a turn runs.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TurnEvent {
    Started {
        run: RunView,
    },
    Text {
        delta: String,
    },
    /// A new model round began; interim text shown so far is superseded.
    Round,
    Reasoning {
        delta: String,
    },
    Step {
        index: usize,
        step: StepView,
    },
    Ticket {
        ticket: TicketView,
    },
    Finished {
        run: RunView,
    },
}

/// Receives [`TurnEvent`]s. The desktop shell forwards them over an IPC channel.
pub trait TurnSink: Sync {
    fn emit(&self, event: TurnEvent);
}

/// Discards events, for work nobody is watching live.
pub struct Silent;

impl TurnSink for Silent {
    fn emit(&self, _: TurnEvent) {}
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn wire_names_match_the_typescript_contract() {
        let step = StepView {
            name: "get_quote".into(),
            detail: "BTC/USDT".into(),
            status: StepStatus::Ok,
            ms: 12,
            preview: "{}".into(),
        };
        assert_eq!(
            serde_json::to_value(TurnEvent::Step { index: 0, step: step.clone() }).expect("json"),
            json!({"type": "step", "index": 0, "step": {"name": "get_quote", "detail": "BTC/USDT", "status": "ok", "ms": 12, "preview": "{}"}})
        );
        assert_eq!(serde_json::to_value(TurnEvent::Round).expect("json"), json!({"type": "round"}));
        assert_eq!(
            serde_json::to_value(TurnEvent::Text { delta: "hi".into() }).expect("json"),
            json!({"type": "text", "delta": "hi"})
        );

        let ticket = TicketView {
            id: "a".repeat(32),
            pair: "BTC/USDT".into(),
            side: Side::Buy,
            qty: "0.5".into(),
            price: "100".into(),
            value: "50".into(),
            feed: Feed::Venue(VenueId::Okx),
            destination: Destination::Exchange,
            rationale: String::new(),
        };
        let wire = serde_json::to_value(&ticket).expect("json");
        assert_eq!(
            (&wire["side"], &wire["feed"], &wire["destination"]),
            (&json!("buy"), &json!("okx"), &json!("exchange"))
        );

        let request: TicketRequest = serde_json::from_value(
            json!({"pair": "BTC/USDT", "side": "sell", "quoteAmount": "250", "destination": "paper"}),
        )
        .expect("request");
        assert_eq!(
            (request.quote_amount.as_deref(), request.qty, request.destination),
            (Some("250"), None, Destination::Paper)
        );
        let assistant: AssistantRequest = serde_json::from_value(
            json!({"provider": "openrouter", "model": "a/b", "effort": "low", "liveTickets": true}),
        )
        .expect("request");
        assert!(assistant.live_tickets && assistant.key.is_none());

        // A run written by an older build still loads: missing fields default.
        let old: RunView = serde_json::from_value(json!({"id": "1", "agent": "Research agent", "title": "t", "feed": "sample", "time": "2026-01-01T00:00:00Z", "status": "complete"})).expect("old run");
        assert!(old.thread.is_empty() && old.steps.is_empty() && old.usage.is_none());
    }
}
