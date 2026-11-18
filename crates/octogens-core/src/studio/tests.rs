use std::collections::VecDeque;
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use super::view::*;
use super::*;
use crate::store::{Effort, MemorySecrets};

const KEY: &str = "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa";
const DAY: i64 = 86_400_000;

fn dec(text: &str) -> Decimal {
    Decimal::from_str(text).expect("test decimal")
}

/// Collects everything a turn streams.
#[derive(Default)]
struct Events(Mutex<Vec<TurnEvent>>);

impl TurnSink for Events {
    fn emit(&self, event: TurnEvent) {
        self.0.lock().expect("events").push(event);
    }
}

impl Events {
    fn kinds(&self) -> Vec<&'static str> {
        self.0
            .lock()
            .expect("events")
            .iter()
            .map(|event| match event {
                TurnEvent::Started { .. } => "started",
                TurnEvent::Text { .. } => "text",
                TurnEvent::Round => "round",
                TurnEvent::Reasoning { .. } => "reasoning",
                TurnEvent::Step { .. } => "step",
                TurnEvent::Ticket { .. } => "ticket",
                TurnEvent::Finished { .. } => "finished",
            })
            .collect()
    }
}

/// A Bybit that lists every symbol asked for, at one price with a chosen daily history.
struct Bybit {
    price: &'static str,
    closes: Vec<i64>,
}

impl Respond for Bybit {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let symbol = request
            .url
            .query_pairs()
            .find(|(key, _)| key == "symbol")
            .map(|(_, value)| value.to_string())
            .unwrap_or_default();
        let now = Utc::now().timestamp_millis();
        let today = now / DAY * DAY;
        let body = match request.url.path() {
            "/v5/market/instruments-info" => json!({"retCode": 0, "result": {"category": "spot", "list": [{
                "symbol": symbol, "baseCoin": symbol.trim_end_matches("USDT"), "quoteCoin": "USDT", "status": "Trading", "symbolType": "xstocks"}]}}),
            "/v5/market/tickers" => {
                json!({"retCode": 0, "time": now, "result": {"list": [{"symbol": symbol, "lastPrice": self.price, "price24hPcnt": "0.01"}]}})
            }
            "/v5/market/kline" => {
                let mut rows = vec![json!([
                    today.to_string(),
                    self.price,
                    self.price,
                    self.price,
                    self.price,
                    "1",
                    "1"
                ])];
                for (age, close) in self.closes.iter().rev().enumerate() {
                    let c = close.to_string();
                    rows.push(json!([(today - (age as i64 + 1) * DAY).to_string(), c, c, c, c, "1", "1"]));
                }
                json!({"retCode": 0, "result": {"list": rows}})
            }
            "/v5/market/orderbook" => {
                json!({"retCode": 0, "result": {"ts": now, "b": [["99.9", "10"]], "a": [["100.1", "5"]]}})
            }
            _ => json!({"retCode": 10001, "retMsg": "not mocked"}),
        };
        ResponseTemplate::new(200).set_body_json(body)
    }
}

async fn bybit(price: &'static str, closes: Vec<i64>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET")).respond_with(Bybit { price, closes }).mount(&server).await;
    server
}

/// Replies with each scripted response in turn, then with a 500.
struct Script(Mutex<VecDeque<ResponseTemplate>>);

impl Respond for Script {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        self.0.lock().expect("script").pop_front().unwrap_or_else(|| ResponseTemplate::new(500))
    }
}

fn sse(chunks: &[Value]) -> ResponseTemplate {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str(&format!("data: {chunk}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    ResponseTemplate::new(200).set_body_raw(body, "text/event-stream")
}

fn says(text: &str) -> ResponseTemplate {
    sse(&[
        json!({"choices": [{"delta": {"content": text}, "finish_reason": null}]}),
        json!({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 900, "completion_tokens": 40, "cost": 0.002}}),
    ])
}

fn calls(tools: &[(&str, Value)]) -> ResponseTemplate {
    let tool_calls: Vec<Value> = tools
        .iter()
        .enumerate()
        .map(|(index, (name, arguments))| json!({"index": index, "id": format!("call_{name}"), "type": "function", "function": {"name": name, "arguments": arguments.to_string()}}))
        .collect();
    sse(&[
        json!({"choices": [{"delta": {"tool_calls": tool_calls}, "finish_reason": null}]}),
        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 800, "completion_tokens": 20, "cost": 0.001}}),
    ])
}

/// An OpenRouter with one tool-capable and one plain model, answering chats from a script.
async fn openrouter(script: Vec<ResponseTemplate>) -> MockServer {
    let server = MockServer::start().await;
    let model = |id: &str, parameters: Value| {
        json!({"id": id, "name": id, "context_length": 200_000, "created": 1, "pricing": {"prompt": "0.000001", "completion": "0.000002"},
        "endpoints": ["/api/v1/chat/completions"], "architecture": {"output_modalities": ["text"]}, "supported_parameters": parameters})
    };
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [model("lab/agent", json!(["tools", "temperature", "reasoning"])), model("lab/plain", json!(["temperature"]))]})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(Script(Mutex::new(script.into())))
        .mount(&server)
        .await;
    server
}

struct Desk {
    studio: Arc<Studio>,
    secrets: Arc<MemorySecrets>,
}

fn open(dir: &Path, secrets: Arc<MemorySecrets>, configure: impl FnOnce(&mut StudioConfig)) -> Desk {
    let mut config = StudioConfig::new(dir.to_path_buf(), secrets.clone());
    // Unconfigured services point nowhere, so a test can never reach the internet.
    for venue in VenueId::ALL {
        config.venue_bases.insert(venue, "http://127.0.0.1:9".to_string());
    }
    config.openrouter_base = Some("http://127.0.0.1:9".to_string());
    config.ollama_base = Some("http://127.0.0.1:9".to_string());
    configure(&mut config);
    Desk { studio: Studio::open(config).expect("studio"), secrets }
}

async fn with_model(desk: &Desk, model: &str) {
    let request = AssistantRequest {
        provider: Provider::OpenRouter,
        model: model.to_string(),
        key: Some(KEY.to_string()),
        effort: Effort::Auto,
        live_tickets: false,
    };
    desk.studio.save_assistant(request).await.expect("model saved");
}

fn chat_bodies(requests: &[Request]) -> Vec<Value> {
    requests
        .iter()
        .filter(|r| r.url.path() == "/chat/completions")
        .map(|r| serde_json::from_slice(&r.body).expect("json"))
        .collect()
}

#[tokio::test]
async fn the_desk_opens_on_the_sample_tape_with_a_fresh_paper_account() {
    let folder = tempfile::tempdir().expect("tempdir");
    let desk = open(folder.path(), Arc::default(), |_| {});
    let snapshot = desk.studio.boot().await.expect("boot");
    assert_eq!((snapshot.feed, snapshot.focus.as_str(), snapshot.busy), (Feed::Sample, "BTC/USDT", false));
    assert_eq!(snapshot.instruments.len(), 14);
    assert_eq!(snapshot.quotes.len(), 14);
    assert!(snapshot.quotes.values().all(|q| q.sample && q.source == "Sample tape" && q.closes.len() == 64));
    assert_eq!(
        (snapshot.account.cash.as_str(), snapshot.account.equity.as_str()),
        ("100000.00", "100000.00")
    );
    assert_eq!(
        (snapshot.assistant.provider, snapshot.assistant.label.as_str(), snapshot.assistant.has_key),
        (Provider::Builtin, "Built-in agents", false)
    );
    assert_eq!(
        snapshot
            .venues
            .iter()
            .map(|v| (v.name, v.credentials, v.official_package.is_some()))
            .collect::<Vec<_>>(),
        [("Binance", false, false), ("Bybit", false, true), ("OKX", false, true)]
    );
    assert!(!snapshot.thread.is_empty() && snapshot.runs.is_empty() && snapshot.draft.is_none());

    let series = desk.studio.candles("eth", "4h").await.expect("candles");
    assert_eq!(
        (series.pair.as_str(), series.timeframe.as_str(), series.rows.len(), series.sample),
        ("ETH/USDT", "4h", 200, true)
    );
    assert!(desk.studio.candles("eth", "2h").await.is_err());
}

#[tokio::test]
async fn a_typed_order_drafts_a_ticket_that_fills_once_and_dies_with_its_feed() {
    let folder = tempfile::tempdir().expect("tempdir");
    let venue = bybit("225.50", vec![224; 24]).await;
    let desk = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, venue.uri());
    });
    let studio = &desk.studio;
    studio.boot().await.expect("boot");

    let events = Events::default();
    let snapshot = studio.ask("buy 0.25 AAPLx", &events).await.expect("turn");
    let run = &snapshot.runs[0];
    assert_eq!(
        (run.agent.as_str(), run.status, run.thread == snapshot.thread),
        ("Order agent", RunStatus::Complete, true)
    );
    assert!(
        run.output.contains("Ticket ready: buy 0.25 AAPLX/USDT") && run.output.contains("sample tape"),
        "{}",
        run.output
    );
    let old = snapshot.draft.clone().expect("draft");
    assert_eq!(
        (old.pair.as_str(), old.qty.as_str(), old.destination, old.feed),
        ("AAPLX/USDT", "0.25", Destination::Paper, Feed::Sample)
    );
    assert_eq!(run.ticket.as_ref(), Some(&old));
    assert_eq!(events.kinds(), ["started", "step", "step", "ticket", "finished"]);

    // Switching feed invalidates a ticket priced on the old one.
    let snapshot = studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");
    assert_eq!(
        (snapshot.feed, snapshot.draft.is_none(), snapshot.quotes.len()),
        (Feed::Venue(VenueId::Bybit), true, 14)
    );
    assert_eq!(snapshot.quotes["AAPLX/USDT"].source, "Bybit spot");
    assert!(studio.submit_ticket(&old.id).await.expect_err("expired").to_string().contains("expired"));

    let snapshot = studio.ask("compare TSLAx and AAPLx", &Silent).await.expect("turn");
    let run = &snapshot.runs[0];
    assert_eq!((run.agent.as_str(), run.status), ("Research agent", RunStatus::Complete));
    assert_eq!(
        run.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["get_quote", "analyze_market", "get_quote", "analyze_market"]
    );
    assert!(run.steps.iter().all(|s| s.status == StepStatus::Ok));
    assert!(
        run.output.contains("Tesla xStock")
            && run.output.contains("225.50 USDT (Bybit spot")
            && run.output.contains("strongest first"),
        "{}",
        run.output
    );
    assert!(!run.output.contains("sample tape"));
    assert_eq!(snapshot.focus, "TSLAX/USDT");

    let draft = studio.ask("buy 0.25 AAPLx", &Silent).await.expect("turn").draft.expect("draft");
    let snapshot = studio.submit_ticket(&draft.id).await.expect("fill");
    // 0.25 x 225.50 = 56.375, booked as 56.38.
    assert_eq!(snapshot.account.cash, "99943.62");
    assert_eq!(snapshot.receipts[&draft.id], "Paper fill: buy 0.25 AAPLX/USDT at 225.50 USDT.");
    assert!(snapshot.draft.is_none());
    assert_eq!((snapshot.runs[0].agent.as_str(), snapshot.runs[0].thread.as_str()), ("Execution", ""));
    assert!(studio.submit_ticket(&draft.id).await.is_err(), "a ticket is consumed by its first submission");

    // Each feed keeps its own book.
    let snapshot = studio.set_feed(Feed::Sample).await.expect("sample");
    assert_eq!((snapshot.account.cash.as_str(), snapshot.account.orders.len()), ("100000.00", 0));

    // The journal and the last conversation survive a restart.
    let thread = snapshot.thread.clone();
    studio.close().await;
    let reopened = open(folder.path(), Arc::default(), |_| {});
    let restored = reopened.studio.snapshot();
    assert_eq!(restored.thread, thread);
    assert_eq!(restored.runs.len(), 4);
    assert_eq!(restored.runs[0].agent, "Execution");
}

#[tokio::test]
async fn orders_the_account_cannot_cover_are_refused_before_a_ticket_exists() {
    let folder = tempfile::tempdir().expect("tempdir");
    let desk = open(folder.path(), Arc::default(), |_| {});
    let studio = &desk.studio;
    studio.boot().await.expect("boot");
    let request = |side, qty: Option<&str>, amount: Option<&str>, destination| TicketRequest {
        pair: "BTC".to_string(),
        side,
        qty: qty.map(str::to_string),
        quote_amount: amount.map(str::to_string),
        destination,
    };
    let refused = [
        (request(Side::Sell, Some("0.1"), None, Destination::Paper), "holds 0 BTC"),
        (request(Side::Buy, Some("5"), None, Destination::Paper), "in cash"),
        (request(Side::Buy, None, None, Destination::Paper), "either a quantity"),
        (request(Side::Buy, Some("1"), Some("100"), Destination::Paper), "not both"),
        (request(Side::Buy, None, Some("0.0000001"), Destination::Paper), "smallest tradable unit"),
        (request(Side::Buy, Some("0.01"), None, Destination::Exchange), "need a live feed"),
    ];
    for (ticket, reason) in refused {
        let error = studio.prepare_ticket(ticket).await.expect_err(reason).to_string();
        assert!(error.contains(reason), "{error}");
    }
    assert!(studio.snapshot().draft.is_none());

    let draft = studio
        .prepare_ticket(request(Side::Buy, None, Some("1000"), Destination::Paper))
        .await
        .expect("draft")
        .draft
        .expect("draft");
    let spent = dec(&draft.qty) * dec(&draft.price);
    assert!(spent <= dec("1000") && spent > dec("999.99"), "{spent}");
    assert!(studio.dismiss_ticket().draft.is_none());
    assert!(studio.submit_ticket(&draft.id).await.is_err());
}

#[tokio::test]
async fn the_assistant_researches_with_tools_and_drafts_a_ticket_the_trader_confirms() {
    let folder = tempfile::tempdir().expect("tempdir");
    let router = openrouter(vec![
        calls(&[("get_quote", json!({"pairs": ["BTC"]})), ("get_portfolio", json!({}))]),
        calls(&[("propose_order", json!({"pair": "BTC", "side": "buy", "quote_amount": "1000", "rationale": "Trend intact above 80,000."}))]),
        says("The ticket is ready for your review: about **1,000 USDT of BTC** on the paper account."),
        says("You asked about BTC a moment ago."),
    ])
    .await;
    let desk = open(folder.path(), Arc::default(), |config| config.openrouter_base = Some(router.uri()));
    let studio = &desk.studio;
    studio.boot().await.expect("boot");
    with_model(&desk, "lab/agent").await;
    assert!(studio.snapshot().assistant.tools && studio.snapshot().assistant.has_key);

    let events = Events::default();
    let snapshot = studio.ask("Buy about 1000 USDT of bitcoin", &events).await.expect("turn");
    let run = &snapshot.runs[0];
    assert_eq!(
        (run.agent.as_str(), run.status, run.model.as_str()),
        ("Assistant", RunStatus::Complete, "lab/agent")
    );
    assert!(run.output.starts_with("The ticket is ready for your review"));
    assert_eq!(
        run.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["model", "get_quote", "get_portfolio", "model", "propose_order", "model"]
    );
    assert!(run.steps.iter().all(|s| s.status == StepStatus::Ok), "{:?}", run.steps);
    assert_eq!(run.steps[1].detail, "BTC");
    assert_eq!(run.steps[4].detail, "buy 1000 USDT of BTC");
    let usage = run.usage.clone().expect("usage");
    assert_eq!((usage.prompt_tokens, usage.completion_tokens), (2500, 80));
    let kinds = events.kinds();
    assert_eq!((kinds[0], kinds[kinds.len() - 1]), ("started", "finished"));
    assert_eq!(kinds.iter().filter(|k| **k == "round").count(), 2);
    assert!(kinds.contains(&"ticket") && kinds.contains(&"text"));

    // The ticket is a draft: nothing was bought until the trader confirms.
    let draft = snapshot.draft.clone().expect("draft");
    assert_eq!(
        (draft.destination, draft.rationale.as_str(), run.ticket.as_ref() == Some(&draft)),
        (Destination::Paper, "Trend intact above 80,000.", true)
    );
    assert_eq!(snapshot.account.cash, "100000.00");
    let confirmed = studio.submit_ticket(&draft.id).await.expect("fill");
    assert!(dec(&confirmed.account.cash) < dec("99000.01") && confirmed.account.holdings.len() == 1);

    // What the model was told and shown.
    let bodies = chat_bodies(&router.received_requests().await.expect("recorded"));
    let first = bodies[0]["messages"].as_array().expect("messages");
    assert!(first[0]["content"].as_str().is_some_and(|system| system.starts_with("You are Octo")));
    let user = first[1]["content"].as_str().expect("user");
    assert!(
        user.starts_with("Buy about 1000 USDT of bitcoin\n\n<desk>")
            && user.contains("feed: sample (fictional practice data"),
        "{user}"
    );
    assert!(
        user.contains("paper_account: equity 100,000.00 USDT")
            && user.contains("live_trading: not available")
    );
    let offered: Vec<&str> = bodies[0]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(offered.contains(&"propose_order") && !offered.contains(&"call_exchange_tool"));
    let second = bodies[1]["messages"].as_array().expect("messages");
    let quote_result: Value =
        serde_json::from_str(second[3]["content"].as_str().expect("tool result")).expect("json");
    assert_eq!(
        (&quote_result["quotes"][0]["price_usdt"], &quote_result["quotes"][0]["sample_data"]),
        (&json!(84215.5), &json!(true))
    );
    let third = bodies[2]["messages"].as_array().expect("messages");
    let proposed = third.last().and_then(|m| m["content"].as_str()).expect("tool result");
    assert!(proposed.contains("not placed until they confirm"), "{proposed}");

    // The next turn carries the conversation and the new state of the desk.
    studio.ask("What did I ask about?", &Silent).await.expect("turn");
    let bodies = chat_bodies(&router.received_requests().await.expect("recorded"));
    let followup = bodies[3]["messages"].as_array().expect("messages");
    assert_eq!(
        followup.iter().filter_map(|m| m["role"].as_str()).collect::<Vec<_>>(),
        ["system", "user", "assistant", "user"]
    );
    assert_eq!(followup[1]["content"], "Buy about 1000 USDT of bitcoin");
    assert!(
        followup[3]["content"]
            .as_str()
            .is_some_and(|c| c.contains("positions: 0.0118") && c.contains("pending_ticket: none"))
    );

    // The key lives in the secret store only.
    assert_eq!(desk.secrets.get(OPENROUTER_SECRET).expect("secret").as_deref(), Some(KEY));
    assert!(!serde_json::to_string(&studio.snapshot()).expect("json").contains(KEY));
    for file in ["preferences.json", "journal.sqlite3"] {
        let bytes = std::fs::read(folder.path().join(file)).expect(file);
        assert!(!String::from_utf8_lossy(&bytes).contains(KEY), "{file} holds the key");
    }
    // A new conversation starts without the old turns.
    let fresh = studio.new_thread();
    assert_ne!(fresh.thread, snapshot.thread);
}

#[tokio::test]
async fn every_market_tool_answers_on_a_live_feed_and_reports_what_it_could_not_reach() {
    let folder = tempfile::tempdir().expect("tempdir");
    let venue = bybit("100", (40..104).collect()).await;
    let router = openrouter(vec![
        calls(&[
            ("analyze_market", json!({"pair": "ETH", "timeframe": "1d"})),
            ("get_candles", json!({"pair": "ETH", "timeframe": "4h", "limit": 5})),
            ("get_order_book", json!({"pair": "ETH"})),
            ("compare_venues", json!({"pair": "ETH"})),
            ("scan_watchlist", json!({})),
            (
                "plan_position",
                json!({"pair": "ETH", "entry": 100, "stop": "95", "risk_pct": 2, "target": 115}),
            ),
            ("get_portfolio", json!({"include_exchange": true})),
            ("get_quote", json!({"pairs": []})),
            ("made_up_tool", json!({})),
        ]),
        says("Done."),
    ])
    .await;
    let desk = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, venue.uri());
        config.openrouter_base = Some(router.uri());
    });
    let studio = &desk.studio;
    studio.boot().await.expect("boot");
    with_model(&desk, "lab/agent").await;
    studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");

    // Refreshing a watchlist whose history is recent reads tickers only.
    let klines =
        |requests: &[Request]| requests.iter().filter(|r| r.url.path() == "/v5/market/kline").count();
    let before = klines(&venue.received_requests().await.expect("recorded"));
    studio.refresh_quotes().await.expect("refresh");
    assert_eq!(
        klines(&venue.received_requests().await.expect("recorded")),
        before,
        "daily history was re-read"
    );

    let snapshot = studio.ask("Give me the full picture on ETH", &Silent).await.expect("turn");
    let run = &snapshot.runs[0];
    assert_eq!((run.status, snapshot.focus.as_str()), (RunStatus::Complete, "ETH/USDT"));
    let bodies = chat_bodies(&router.received_requests().await.expect("recorded"));
    let messages = bodies[1]["messages"].as_array().expect("messages");
    let result = |name: &str| -> Value {
        let id = format!("call_{name}");
        let message = messages
            .iter()
            .find(|m| m["tool_call_id"] == id.as_str())
            .unwrap_or_else(|| panic!("no result for {name}"));
        serde_json::from_str(message["content"].as_str().expect("content")).expect("json")
    };

    let analysis = result("analyze_market");
    assert_eq!(
        (&analysis["pair"], &analysis["timeframe"], &analysis["sample_data"], &analysis["trend"]["label"]),
        (&json!("ETH/USDT"), &json!("1d"), &json!(false), &json!("uptrend"))
    );
    assert!(analysis["momentum"]["rsi14"].as_f64().is_some_and(|rsi| rsi > 70.0) && analysis["bars"] == 65);
    assert_eq!(result("get_candles")["candles"].as_array().map(Vec::len), Some(5));
    let book = result("get_order_book");
    assert_eq!(
        (&book["best_bid"], &book["best_ask"], &book["source"]),
        (&json!(99.9), &json!(100.1), &json!("Bybit spot"))
    );

    // Two venues are unreachable in this test: that is reported per venue, not as a failed tool.
    let compared = result("compare_venues");
    let venues = compared["venues"].as_array().expect("venues");
    assert_eq!(venues.iter().filter(|v| v.get("error").is_some()).count(), 2);
    assert_eq!(venues.iter().find(|v| v["venue"] == "bybit").map(|v| &v["price_usdt"]), Some(&json!(100.0)));
    assert!(compared["highest_vs_lowest_pct"].is_null());

    let scan = result("scan_watchlist");
    assert_eq!(
        (&scan["sample_data"], &scan["change_basis"], scan["instruments"].as_array().map(Vec::len)),
        (&json!(false), &json!("24h"), Some(14))
    );
    let plan = result("plan_position");
    // 2% of 100,000 at risk over a 5 USDT stop distance is 400 tokens, but spot caps the cost at the account.
    assert_eq!(
        (&plan["quantity"], &plan["reward_to_risk"], &plan["equity_usdt"]),
        (&json!("400"), &json!(3.0), &json!(100000.0))
    );

    for (name, reason) in [
        ("get_portfolio", "API keys"),
        ("get_quote", "between one and eight"),
        ("made_up_tool", "Unknown tool"),
    ] {
        let error = result(name)["error"].as_str().unwrap_or_default().to_string();
        assert!(error.contains(reason), "{name}: {error}");
    }
    let failed: Vec<&str> =
        run.steps.iter().filter(|s| s.status == StepStatus::Error).map(|s| s.name.as_str()).collect();
    assert_eq!(failed, ["get_portfolio", "get_quote", "made_up_tool"]);
    assert_eq!(
        run.steps.iter().find(|s| s.name == "get_portfolio").map(|s| s.preview.contains("API keys")),
        Some(true)
    );
}

#[tokio::test]
async fn live_tickets_from_the_assistant_need_the_traders_permission() {
    let folder = tempfile::tempdir().expect("tempdir");
    let live_order = json!({"pair": "BTC", "side": "buy", "quantity": "0.01", "destination": "exchange", "rationale": "The trader asked for a live order."});
    let router = openrouter(vec![
        calls(&[("propose_order", live_order)]),
        says("Live tickets are turned off, so nothing was drafted."),
    ])
    .await;
    let desk = open(folder.path(), Arc::default(), |config| config.openrouter_base = Some(router.uri()));
    desk.studio.boot().await.expect("boot");
    with_model(&desk, "lab/agent").await;

    let snapshot = desk.studio.ask("Place a real order for 0.01 BTC", &Silent).await.expect("turn");
    assert!(snapshot.draft.is_none() && snapshot.runs[0].ticket.is_none());
    assert_eq!(snapshot.runs[0].steps[1].status, StepStatus::Error);
    let bodies = chat_bodies(&router.received_requests().await.expect("recorded"));
    let result = bodies[1]["messages"]
        .as_array()
        .and_then(|m| m.last())
        .and_then(|m| m["content"].as_str())
        .expect("tool result");
    assert!(result.contains("turned off") && result.starts_with("{\"error\""), "{result}");
}

#[tokio::test]
async fn a_model_without_tools_explains_readings_the_desk_gathered() {
    let folder = tempfile::tempdir().expect("tempdir");
    let router = openrouter(vec![says("ETH is the stronger of the two on the sample tape.")]).await;
    let desk = open(folder.path(), Arc::default(), |config| config.openrouter_base = Some(router.uri()));
    desk.studio.boot().await.expect("boot");
    with_model(&desk, "lab/plain").await;
    assert!(!desk.studio.snapshot().assistant.tools);

    let snapshot = desk.studio.ask("Compare BTC and ETH", &Silent).await.expect("turn");
    let run = &snapshot.runs[0];
    assert_eq!((run.agent.as_str(), run.status), ("Assistant", RunStatus::Complete));
    assert!(
        run.output.starts_with("ETH is the stronger")
            && run.output.contains("**Desk readings**")
            && run.output.contains("**Bitcoin** 84,215.50 USDT"),
        "{}",
        run.output
    );
    assert_eq!(run.steps.last().map(|s| s.name.as_str()), Some("model"));
    let body = &chat_bodies(&router.received_requests().await.expect("recorded"))[0];
    assert!(body.get("tools").is_none() && body.get("tool_choice").is_none());
    let user = body["messages"][1]["content"].as_str().expect("user");
    assert!(
        user.contains("<readings>")
            && user.contains("RSI(14)")
            && body["messages"][0]["content"].as_str().is_some_and(|s| s.contains("cannot call tools"))
    );
}

#[tokio::test]
async fn stopping_a_turn_frees_the_desk_and_a_second_turn_must_wait() {
    let folder = tempfile::tempdir().expect("tempdir");
    let router = openrouter(vec![says("too late").set_delay(Duration::from_secs(30))]).await;
    let desk = open(folder.path(), Arc::default(), |config| config.openrouter_base = Some(router.uri()));
    desk.studio.boot().await.expect("boot");
    with_model(&desk, "lab/agent").await;

    let studio = Arc::clone(&desk.studio);
    let running = tokio::spawn(async move { studio.ask("Analyze BTC", &Silent).await });
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(desk.studio.snapshot().busy);
    assert!(
        desk.studio.ask("another", &Silent).await.expect_err("busy").to_string().contains("still working")
    );
    assert!(
        desk.studio
            .set_feed(Feed::Sample)
            .await
            .expect_err("busy")
            .to_string()
            .contains("before switching the price feed")
    );

    desk.studio.stop_turn();
    let snapshot = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("stops promptly")
        .expect("joined")
        .expect("turn");
    assert_eq!(
        (snapshot.runs[0].status, snapshot.runs[0].output.as_str(), snapshot.busy),
        (RunStatus::Stopped, "Stopped before an answer.", false)
    );
    desk.studio.set_feed(Feed::Sample).await.expect("idle again");
}

#[tokio::test]
async fn the_built_in_agents_answer_without_any_model() {
    let folder = tempfile::tempdir().expect("tempdir");
    let desk = open(folder.path(), Arc::default(), |_| {});
    let studio = &desk.studio;
    studio.boot().await.expect("boot");
    let ask = async |prompt: &str| studio.ask(prompt, &Silent).await.expect("turn").runs[0].clone();

    let portfolio = ask("Review my portfolio").await;
    assert_eq!((portfolio.agent.as_str(), portfolio.status), ("Portfolio agent", RunStatus::Complete));
    assert!(
        portfolio.output.contains("Paper equity **100,000.00 USDT**")
            && portfolio.output.contains("No open positions")
    );

    let research = ask("How is bitcoin doing?").await;
    assert!(
        research.output.contains("**Bitcoin** 84,215.50 USDT (Sample tape")
            && research.output.contains("fictional practice data"),
        "{}",
        research.output
    );
    assert!(ask("hello").await.output.contains("Buy 0.01 BTC"));

    for (prompt, reason) in [
        ("buy some bitcoin", "Buy 0.5 BTC"),
        ("@bybit get_tickers {}", "No MCP server is attached to Bybit"),
        ("@bybit", "Use @venue tool_name"),
        ("Analyze TSLA", "underlying share"),
        ("Compare BTC, ETH, SOL, XRP and DOGE", "up to four"),
        ("sell 1 BTC", "holds 0 BTC"),
    ] {
        let run = ask(prompt).await;
        assert_eq!(run.status, RunStatus::Failed, "{prompt}");
        assert!(run.output.contains(reason), "{prompt}: {}", run.output);
    }
    assert!(studio.ask("   ", &Silent).await.is_err());
    assert!(studio.ask(&"x".repeat(4001), &Silent).await.is_err());
    assert!(!studio.snapshot().busy);

    // A model picked without a key is explained, not silently ignored.
    desk.studio.state().prefs.provider = Provider::OpenRouter;
    assert!(ask("Analyze BTC").await.output.contains("Add your OpenRouter key"));
}

#[tokio::test]
async fn the_pattern_agent_trades_within_its_budget_once_per_quote_date() {
    let folder = tempfile::tempdir().expect("tempdir");
    let rising = bybit("100", (100..164).collect()).await;
    let desk = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, rising.uri());
    });
    let studio = &desk.studio;
    studio.boot().await.expect("boot");
    studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");

    let snapshot = studio.run_pattern("BTC", "250").await.expect("pattern");
    let run = &snapshot.runs[0];
    assert_eq!(
        (run.agent.as_str(), run.title.as_str(), run.thread.as_str()),
        ("Pattern agent", "Evaluate BTC", "")
    );
    assert!(
        run.output.starts_with("Paper fill: buy 2.5 BTC/USDT at 100.00 USDT.\n5 of 5 past matches rose"),
        "{}",
        run.output
    );
    assert_eq!(snapshot.account.cash, "99750.00");

    // A larger budget on the same quote date does not trade again, even after a restart.
    let again = studio.run_pattern("BTC", "500").await.expect("pattern");
    assert!(
        again.runs[0].output.starts_with("Already traded on this quote date: buy 2.5 BTC/USDT."),
        "{}",
        again.runs[0].output
    );
    studio.close().await;
    let restarted = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, rising.uri());
    });
    restarted.studio.boot().await.expect("boot");
    restarted.studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");
    let third = restarted.studio.run_pattern("BTC", "500").await.expect("pattern");
    assert!(third.runs[0].output.starts_with("Already traded"));
    assert_eq!((third.account.cash.as_str(), third.account.orders.len()), ("99750.00", 1));

    // A watch runs once at once, is visible, and ends when the feed changes.
    let watching = restarted.studio.start_watch("ETH", "100").await.expect("watch");
    assert_eq!(
        watching.watch,
        Some(WatchView {
            pair: "ETH/USDT".to_string(),
            budget: "100".to_string(),
            feed: Feed::Venue(VenueId::Bybit)
        })
    );
    assert_eq!(watching.account.orders.len(), 2);
    assert!(restarted.studio.set_feed(Feed::Sample).await.expect("sample").watch.is_none());
    for bad in ["0", "abc", "1.234"] {
        assert!(restarted.studio.run_pattern("BTC", bad).await.is_err(), "{bad}");
    }
}

#[tokio::test]
async fn a_flat_history_makes_the_pattern_agent_hold() {
    let folder = tempfile::tempdir().expect("tempdir");
    let flat = bybit("100", vec![100; 30]).await;
    let desk = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, flat.uri());
    });
    desk.studio.boot().await.expect("boot");
    desk.studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");
    let snapshot = desk.studio.run_pattern("BTC", "100").await.expect("pattern");
    assert!(
        snapshot.runs[0].output.starts_with("Hold: the historical matches do not agree"),
        "{}",
        snapshot.runs[0].output
    );
    assert!(snapshot.account.orders.is_empty());
}

#[tokio::test]
async fn an_unreachable_venue_leaves_the_desk_on_its_current_feed() {
    let folder = tempfile::tempdir().expect("tempdir");
    let desk = open(folder.path(), Arc::default(), |_| {});
    desk.studio.boot().await.expect("boot");
    let error = desk.studio.set_feed(Feed::Venue(VenueId::Okx)).await.expect_err("down").to_string();
    assert!(error.contains("127.0.0.1"), "{error}");
    let snapshot = desk.studio.snapshot();
    assert_eq!((snapshot.feed, snapshot.quotes.len()), (Feed::Sample, 14));
    assert!(
        desk.studio.watch_add("PEPE").await.expect_err("no sample").to_string().contains("no sample data")
    );
}

#[tokio::test]
async fn the_last_live_feed_is_restored_on_launch_or_its_failure_is_explained() {
    let folder = tempfile::tempdir().expect("tempdir");
    let venue = bybit("100", vec![100; 20]).await;
    let desk = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, venue.uri());
    });
    desk.studio.boot().await.expect("boot");
    assert_eq!(desk.studio.restore_feed().await.feed, Feed::Sample, "nothing to restore on a first launch");
    desk.studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");
    desk.studio.close().await;

    let reopened = open(folder.path(), Arc::default(), |config| {
        config.venue_bases.insert(VenueId::Bybit, venue.uri());
    });
    assert_eq!(
        reopened.studio.boot().await.expect("boot").feed,
        Feed::Sample,
        "the window opens at once on the sample tape"
    );
    let restored = reopened.studio.restore_feed().await;
    assert_eq!((restored.feed, restored.feed_error.as_str()), (Feed::Venue(VenueId::Bybit), ""));
    reopened.studio.close().await;

    // The venue is gone: the desk says so and keeps working on the sample tape.
    let offline = open(folder.path(), Arc::default(), |_| {});
    offline.studio.boot().await.expect("boot");
    let fallback = offline.studio.restore_feed().await;
    assert_eq!(fallback.feed, Feed::Sample);
    assert!(
        fallback.feed_error.starts_with("Could not return to Bybit:")
            && fallback.feed_error.ends_with("Showing the sample tape."),
        "{}",
        fallback.feed_error
    );
    assert_eq!(fallback.quotes.len(), 14);
}

#[tokio::test]
async fn the_watchlist_grows_only_with_tokens_the_feed_can_price() {
    let folder = tempfile::tempdir().expect("tempdir");
    let venue = bybit("0.5", vec![1; 20]).await;
    let configure = |config: &mut StudioConfig| {
        config.venue_bases.insert(VenueId::Bybit, venue.uri());
    };
    let desk = open(folder.path(), Arc::default(), configure);
    let studio = &desk.studio;
    studio.boot().await.expect("boot");
    studio.set_feed(Feed::Venue(VenueId::Bybit)).await.expect("live feed");

    let snapshot = studio.watch_add("$pepe").await.expect("added");
    assert_eq!((snapshot.instruments.len(), snapshot.focus.as_str()), (15, "PEPE/USDT"));
    assert!(snapshot.instruments[14].custom && snapshot.quotes["PEPE/USDT"].price == "0.5");
    assert_eq!(studio.watch_add("PEPE/USDT").await.expect("already there").instruments.len(), 15);
    assert!(studio.watch_add("TSLA").await.expect_err("underlying").to_string().contains("underlying share"));
    assert!(
        studio.watch_remove("BTC/USDT").expect_err("built in").to_string().contains("Only tokens you added")
    );

    // The addition is remembered; removing it restores the default focus.
    studio.close().await;
    let reopened = open(folder.path(), Arc::default(), configure);
    assert_eq!(
        reopened
            .studio
            .snapshot()
            .instruments
            .iter()
            .filter(|i| i.custom)
            .map(|i| i.pair.as_str())
            .collect::<Vec<_>>(),
        ["PEPE/USDT"]
    );
    assert_eq!(reopened.studio.snapshot().focus, "PEPE/USDT");
    let removed = reopened.studio.watch_remove("PEPE/USDT").expect("removed");
    assert_eq!((removed.instruments.len(), removed.focus.as_str()), (14, "BTC/USDT"));
}

#[tokio::test]
async fn venue_keys_are_proved_before_use_and_remembered_only_on_request() {
    let folder = tempfile::tempdir().expect("tempdir");
    let venue = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/account"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"balances": [{"asset": "USDT", "free": "250", "locked": "0"}]})),
        )
        .mount(&venue)
        .await;
    let secrets: Arc<MemorySecrets> = Arc::default();
    let configure = |config: &mut StudioConfig| {
        config.venue_bases.insert(VenueId::Binance, venue.uri());
    };
    let desk = open(folder.path(), secrets.clone(), configure);
    let request = |venue, remember| CredentialsRequest {
        venue,
        key: "id-1".to_string(),
        secret: "secret-1".to_string(),
        passphrase: None,
        remember,
    };

    // Bybit is unreachable here, so its keys cannot be proved and are not kept.
    assert!(
        desk.studio
            .set_credentials(request(VenueId::Bybit, true))
            .await
            .expect_err("unproved")
            .to_string()
            .starts_with("Bybit did not accept these keys")
    );
    assert!(
        !desk.studio.snapshot().venues[1].credentials && secrets.get("venue-bybit").expect("get").is_none()
    );

    let session_only = desk.studio.set_credentials(request(VenueId::Binance, false)).await.expect("accepted");
    assert_eq!((session_only.venues[0].credentials, session_only.venues[0].remembered), (true, false));
    assert!(secrets.get("venue-binance").expect("get").is_none());
    assert_eq!(
        desk.studio.balances(VenueId::Binance).await.expect("balances"),
        [BalanceRow { asset: "USDT".to_string(), total: "250".to_string() }]
    );

    let remembered = desk.studio.set_credentials(request(VenueId::Binance, true)).await.expect("accepted");
    assert!(remembered.venues[0].remembered);
    assert!(secrets.get("venue-binance").expect("get").is_some_and(|stored| stored.contains("secret-1")));
    let on_disk = std::fs::read_to_string(folder.path().join("preferences.json")).expect("prefs");
    assert!(on_disk.contains("binance") && !on_disk.contains("secret-1") && !on_disk.contains("id-1"));
    assert!(!serde_json::to_string(&remembered).expect("json").contains("secret-1"));

    // Remembered keys come back after a restart; forgetting them clears every copy.
    desk.studio.close().await;
    let reopened = open(folder.path(), secrets.clone(), configure);
    assert!(reopened.studio.snapshot().venues[0].credentials);
    let cleared = reopened.studio.clear_credentials(VenueId::Binance).expect("cleared");
    assert_eq!((cleared.venues[0].credentials, cleared.venues[0].remembered), (false, false));
    assert!(secrets.get("venue-binance").expect("get").is_none());
    assert!(reopened.studio.balances(VenueId::Binance).await.is_err());
}

#[tokio::test]
async fn model_settings_are_checked_against_the_catalog_and_old_keys_are_migrated() {
    let folder = tempfile::tempdir().expect("tempdir");
    // A preferences file from a release that kept the key in plain text.
    std::fs::write(
        folder.path().join("preferences.json"),
        format!(r#"{{"provider": "builtin", "openrouter_key": "{KEY}"}}"#),
    )
    .expect("prefs");
    let router = openrouter(Vec::new()).await;
    let desk = open(folder.path(), Arc::default(), |config| config.openrouter_base = Some(router.uri()));
    assert!(desk.studio.snapshot().assistant.has_key, "the old key was adopted");
    assert_eq!(desk.secrets.get(OPENROUTER_SECRET).expect("secret").as_deref(), Some(KEY));
    assert!(!std::fs::read_to_string(folder.path().join("preferences.json")).expect("prefs").contains(KEY));

    let models = desk.studio.list_models(None).await.expect("catalog");
    assert_eq!(
        models.iter().map(|m| (m.id.as_str(), m.tools)).collect::<Vec<_>>(),
        [("lab/agent", true), ("lab/plain", false)]
    );

    let request = |provider, model: &str, key: Option<&str>| AssistantRequest {
        provider,
        model: model.to_string(),
        key: key.map(str::to_string),
        effort: Effort::High,
        live_tickets: true,
    };
    for (bad, reason) in [
        (request(Provider::OpenRouter, "lab/missing", None), "not in the OpenRouter catalog"),
        (request(Provider::OpenRouter, "", None), "Choose a model"),
        (request(Provider::OpenRouter, "lab/agent", Some("nope")), "sk-or-"),
        (request(Provider::Ollama, "qwen3:4b", None), "not running"),
    ] {
        let error = desk.studio.save_assistant(bad).await.expect_err(reason).to_string();
        assert!(error.contains(reason), "{error}");
    }
    let saved =
        desk.studio.save_assistant(request(Provider::OpenRouter, "lab/agent", None)).await.expect("saved");
    assert_eq!(
        (
            saved.assistant.model.as_str(),
            saved.assistant.tools,
            saved.assistant.reasoning,
            saved.assistant.effort,
            saved.assistant.live_tickets
        ),
        ("lab/agent", true, true, Effort::High, true)
    );

    // Settings persist; going back to the built-in agents keeps the key for later.
    desk.studio.close().await;
    let reopened = open(folder.path(), desk.secrets.clone(), |_| {});
    assert_eq!(reopened.studio.snapshot().assistant.model, "lab/agent");
    let builtin =
        reopened.studio.save_assistant(request(Provider::Builtin, "ignored", None)).await.expect("saved");
    assert_eq!(
        (builtin.assistant.provider, builtin.assistant.model.as_str(), builtin.assistant.has_key),
        (Provider::Builtin, "", true)
    );
    assert_eq!(reopened.studio.set_theme(Theme::Dark).expect("theme").theme, Theme::Dark);

    let fresh = open(tempfile::tempdir().expect("tempdir").path(), Arc::default(), |_| {});
    assert!(
        fresh
            .studio
            .save_assistant(request(Provider::OpenRouter, "lab/agent", None))
            .await
            .expect_err("no key")
            .to_string()
            .contains("Paste an OpenRouter key first")
    );
}

/// A minimal MCP server: one read-only tool and one that changes things.
struct ToolServer;

impl Respond for ToolServer {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let rpc: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let Some(id) = rpc.get("id") else {
            return ResponseTemplate::new(202);
        };
        let result = match rpc["method"].as_str() {
            Some("initialize") => {
                json!({"protocolVersion": rpc["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "okx fixture", "version": "9"}})
            }
            Some("tools/list") => json!({"tools": [
                {"name": "funding_rate", "description": "Current funding rate", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true}},
                {"name": "transfer", "description": "Moves funds", "inputSchema": {"type": "object"}},
            ]}),
            Some("tools/call") => {
                json!({"content": [{"type": "text", "text": format!("{{\"tool\":{},\"balance\":\"12345.67\"}}", rpc["params"]["name"])}]})
            }
            _ => json!({}),
        };
        ResponseTemplate::new(200)
            .insert_header("Mcp-Session-Id", "s1")
            .set_body_json(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

#[tokio::test]
async fn attached_exchange_tools_are_read_only_for_everyone_but_the_trader() {
    let folder = tempfile::tempdir().expect("tempdir");
    let tools = MockServer::start().await;
    Mock::given(method("POST")).respond_with(ToolServer).mount(&tools).await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(405)).mount(&tools).await;
    Mock::given(method("DELETE")).respond_with(ResponseTemplate::new(200)).mount(&tools).await;
    let router = openrouter(vec![
        calls(&[("call_exchange_tool", json!({"venue": "okx", "name": "transfer", "arguments": {}}))]),
        says("That tool is not read-only."),
    ])
    .await;
    let desk = open(folder.path(), Arc::default(), |config| config.openrouter_base = Some(router.uri()));
    let studio = &desk.studio;
    studio.boot().await.expect("boot");

    let attached = studio
        .mcp_connect(McpConnectRequest::Http {
            venue: VenueId::Okx,
            url: format!("{}/mcp", tools.uri()),
            token: None,
        })
        .await
        .expect("attached");
    assert_eq!(
        attached.venues[2].mcp,
        Some(McpView {
            name: "okx fixture".to_string(),
            version: "9".to_string(),
            transport: crate::mcp::Transport::Http,
            tools: 2
        })
    );
    assert_eq!(studio.mcp_tools(VenueId::Okx).await.expect("catalog").len(), 2);
    assert!(studio.mcp_tools(VenueId::Bybit).await.is_err());

    // Typed in chat: the read-only tool runs, the other is refused.
    let typed = studio.ask("@okx funding_rate {\"symbol\": \"BTC-USDT\"}", &Silent).await.expect("turn");
    assert_eq!((typed.runs[0].agent.as_str(), typed.runs[0].status), ("Exchange tools", RunStatus::Complete));
    assert!(typed.runs[0].output.contains("12345.67"));
    let refused = studio.ask("@okx transfer {}", &Silent).await.expect("turn");
    assert!(
        refused.runs[0].status == RunStatus::Failed
            && refused.runs[0].output.contains("does not mark transfer as read-only")
    );

    // The assistant is offered the server's tools and is held to the same rule.
    with_model(&desk, "lab/agent").await;
    let turn = studio.ask("Move my funds", &Silent).await.expect("turn");
    assert_eq!(turn.runs[0].steps[1].status, StepStatus::Error);
    let bodies = chat_bodies(&router.received_requests().await.expect("recorded"));
    let offered: Vec<&str> = bodies[0]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| t["function"]["name"].as_str())
        .collect();
    assert!(offered.contains(&"list_exchange_tools") && offered.contains(&"call_exchange_tool"));
    assert!(
        bodies[0]["messages"][1]["content"]
            .as_str()
            .is_some_and(|user| user.contains("exchange_tool_servers: okx (okx fixture, 2 tools)"))
    );
    assert!(
        bodies[1]["messages"]
            .as_array()
            .and_then(|m| m.last())
            .and_then(|m| m["content"].as_str())
            .is_some_and(|r| r.contains("read-only"))
    );

    // The trader may run anything from the inspector. Its output is never written to disk.
    let output = studio.mcp_call(VenueId::Okx, "transfer", json!({})).await.expect("ran");
    assert!(output.contains("12345.67"));
    assert_eq!(studio.snapshot().runs[0].agent, "Tool inspector");
    let journal = std::fs::read(folder.path().join("journal.sqlite3")).expect("journal");
    assert!(
        !String::from_utf8_lossy(&journal).contains("12345.67"),
        "private tool output reached the journal"
    );

    assert!(studio.mcp_disconnect(VenueId::Okx).await.expect("detached").venues[2].mcp.is_none());
    assert!(studio.mcp_call(VenueId::Okx, "transfer", json!({})).await.is_err());
}
