//! Keeps the Rust views and `src/api/types.ts` in step.
//!
//! The interface and the core are compiled by different toolchains, so nothing
//! else would notice a field renamed on one side only. This test serialises
//! real values and compares their keys with the TypeScript declarations.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use octogens_core::llm::openrouter::{ModelInfo, Usage};
use octogens_core::mcp::{ToolInfo, Transport};
use octogens_core::model::{Feed, VenueId};
use octogens_core::store::MemorySecrets;
use octogens_core::studio::view::{BalanceRow, McpView, TurnEvent, TurnSink, WatchView};
use octogens_core::studio::{Studio, StudioConfig};
use serde::Serialize;
use serde_json::{Value, json};

const TYPES: &str = include_str!("../../../src/api/types.ts");

/// Field names of every `export interface` in the contract file.
fn interfaces() -> BTreeMap<String, BTreeSet<String>> {
    let mut found = BTreeMap::new();
    let mut current: Option<(String, BTreeSet<String>)> = None;
    for line in TYPES.lines() {
        if let Some(rest) = line.strip_prefix("export interface ") {
            current = Some((rest.split_whitespace().next().unwrap_or_default().to_string(), BTreeSet::new()));
        } else if line == "}" {
            if let Some((name, fields)) = current.take() {
                found.insert(name, fields);
            }
        } else if let Some((_, fields)) = current.as_mut() {
            // A field is `  name: type;` or `  name?: type;`. Methods and comments are skipped.
            let trimmed = line.trim_start();
            let name: String =
                trimmed.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            let after = &trimmed[name.len()..];
            if !name.is_empty()
                && line.starts_with("  ")
                && !line.starts_with("   ")
                && (after.starts_with(':') || after.starts_with("?:"))
            {
                fields.insert(name);
            }
        }
    }
    found
}

fn keys(value: &Value) -> BTreeSet<String> {
    value.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default()
}

fn same(interface: &str, value: &impl Serialize, contract: &BTreeMap<String, BTreeSet<String>>) {
    let declared = contract.get(interface).unwrap_or_else(|| panic!("{interface} is missing from types.ts"));
    let sent = keys(&serde_json::to_value(value).expect("serialises"));
    assert_eq!(&sent, declared, "{interface}: the core sends different fields than types.ts declares");
}

#[derive(Default)]
struct Events(Mutex<Vec<TurnEvent>>);

impl TurnSink for Events {
    fn emit(&self, event: TurnEvent) {
        self.0.lock().expect("events").push(event);
    }
}

#[tokio::test]
async fn every_view_sends_exactly_the_fields_the_interface_declares() {
    let contract = interfaces();
    assert!(contract.len() >= 20, "the contract parser found only {:?}", contract.keys());

    let folder = tempfile::tempdir().expect("tempdir");
    let studio =
        Studio::open(StudioConfig::new(folder.path().to_path_buf(), Arc::new(MemorySecrets::default())))
            .expect("studio");
    studio.boot().await.expect("boot");
    let events = Events::default();
    let snapshot = studio.ask("buy 0.01 BTC", &events).await.expect("turn");
    let run = &snapshot.runs[0];
    let ticket = snapshot.draft.clone().expect("draft");
    let filled = studio.submit_ticket(&ticket.id).await.expect("fill");

    same("Snapshot", &snapshot, &contract);
    same("InstrumentView", &snapshot.instruments[0], &contract);
    same("QuoteView", &snapshot.quotes["BTC/USDT"], &contract);
    same("AccountView", &filled.account, &contract);
    same("HoldingView", &filled.account.holdings[0], &contract);
    same("FillView", &filled.account.orders[0], &contract);
    same("VenueView", &snapshot.venues[0], &contract);
    same("AssistantView", &snapshot.assistant, &contract);
    same("RunView", run, &contract);
    same("StepView", &run.steps[0], &contract);
    same("TicketView", &ticket, &contract);
    same("CandleSeries", &studio.candles("BTC", "1h").await.expect("candles"), &contract);
    same(
        "McpView",
        &McpView { name: "n".into(), version: "1".into(), transport: Transport::Http, tools: 1 },
        &contract,
    );
    same(
        "WatchView",
        &WatchView { pair: "BTC/USDT".into(), budget: "100".into(), feed: Feed::Sample },
        &contract,
    );
    same("UsageView", &Usage::default(), &contract);
    same(
        "ToolInfo",
        &ToolInfo { name: "t".into(), description: String::new(), schema: json!({}), read_only: true },
        &contract,
    );
    same("BalanceRow", &BalanceRow { asset: "USDT".into(), total: "1".into() }, &contract);

    // The core may know more about a model than the interface shows, never less.
    let model = keys(&serde_json::to_value(ModelInfo::default()).expect("serialises"));
    assert!(
        contract["ModelInfo"].is_subset(&model),
        "ModelInfo lacks {:?}",
        contract["ModelInfo"].difference(&model).collect::<Vec<_>>()
    );

    // Every turn event the core emits is a variant the interface handles, with the same fields.
    let mut declared: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for line in TYPES.lines().filter(|line| line.trim_start().starts_with("| { type: \"")) {
        let body = line.trim().trim_start_matches("| {").trim_end_matches(['}', ';', ' ']);
        let mut fields: Vec<&str> = body
            .split(';')
            .map(|part| part.split(':').next().unwrap_or("").trim())
            .filter(|name| !name.is_empty())
            .collect();
        let kind = line.split('"').nth(1).unwrap_or_default().to_string();
        fields.retain(|name| *name != "type");
        declared.entry(kind).or_default().extend(fields.into_iter().map(str::to_string));
    }
    let mut emitted: Vec<TurnEvent> = events.0.lock().expect("events").clone();
    emitted.extend([
        TurnEvent::Round,
        TurnEvent::Text { delta: String::new() },
        TurnEvent::Reasoning { delta: String::new() },
    ]);
    let mut seen = BTreeSet::new();
    for event in &emitted {
        let wire = serde_json::to_value(event).expect("serialises");
        let kind = wire["type"].as_str().expect("tagged").to_string();
        let mut fields = keys(&wire);
        fields.remove("type");
        assert_eq!(Some(&fields), declared.get(&kind), "turn event `{kind}` differs from types.ts");
        seen.insert(kind);
    }
    assert_eq!(
        seen,
        declared.keys().cloned().collect::<BTreeSet<_>>(),
        "every declared turn event was checked"
    );
}

#[test]
fn requests_from_the_interface_are_understood_field_for_field() {
    use octogens_core::mcp::McpConnectRequest;
    use octogens_core::studio::view::{AssistantRequest, CredentialsRequest, TicketRequest};

    let contract = interfaces();
    // One sample per request type, carrying every field the interface may send.
    let ticket = json!({"pair": "BTC/USDT", "side": "buy", "qty": "0.1", "quoteAmount": "100", "destination": "paper"});
    let credentials = json!({"venue": "okx", "key": "k", "secret": "s", "passphrase": "p", "remember": true});
    let assistant = json!({"provider": "openrouter", "model": "a/b", "key": "sk-or-v1-x", "effort": "medium", "liveTickets": true});
    for (interface, sample) in
        [("TicketRequest", &ticket), ("CredentialsRequest", &credentials), ("AssistantRequest", &assistant)]
    {
        assert_eq!(
            &keys(sample),
            &contract[interface],
            "{interface}: the sample must cover every declared field"
        );
    }
    serde_json::from_value::<TicketRequest>(ticket).expect("ticket request");
    serde_json::from_value::<CredentialsRequest>(credentials).expect("credentials request");
    serde_json::from_value::<AssistantRequest>(assistant).expect("assistant request");

    for sample in [
        json!({"venue": "bybit", "transport": "official", "key": "k", "secret": "s", "testnet": true, "profile": "demo"}),
        json!({"venue": "okx", "transport": "stdio", "command": "node", "args": ["server.js"], "env": {"A": "1"}}),
        json!({"venue": "binance", "transport": "http", "url": "https://example.com/mcp", "token": "t"}),
    ] {
        let request = serde_json::from_value::<McpConnectRequest>(sample).expect("connect request");
        assert!(VenueId::ALL.contains(&request.venue()));
    }
    for (name, values) in
        [("Feed", vec!["sample", "binance", "bybit", "okx"]), ("Timeframe", vec!["15m", "1h", "4h", "1d"])]
    {
        let line = TYPES.lines().find(|line| line.starts_with(&format!("export type {name} ="))).expect(name);
        assert!(
            values.iter().all(|value| line.contains(&format!("\"{value}\""))),
            "{name} values drifted: {line}"
        );
    }
    assert!(VenueId::ALL.iter().all(|venue| Feed::parse(venue.as_str()).is_ok()));
}
