//! Keeps the Rust views and `src/api/types.ts` in step.
//!
//! The interface and the core are compiled by different toolchains, so nothing
//! else would notice a field renamed on one side only. This test serialises
//! real values and compares their keys with the TypeScript declarations.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::Arc;

use chrono::Utc;
use octoneo_core::assistant::tools::{PlanRequest, plan_position};
use octoneo_core::exchange::{Premium, Tick, Trade};
use octoneo_core::indicators::analyze;
use octoneo_core::llm::{ModelInfo, Usage};
use octoneo_core::mcp::{ToolInfo, Transport};
use octoneo_core::model::{
    Account, AssetBalance, Candle, DayStats, Market, Network, OpenOrder, OrderBook, Position, Quote, Side,
    Timeframe,
};
use octoneo_core::store::MemorySecrets;
use octoneo_core::studio::view::{
    AccountView, CandleSeries, CardView, FundingView, GridBotView, GridDirection, GridDraftView,
    GridLevelView, GridPreviewView, GridRequest, GridSpacing, GridStatus, InstrumentView, MarketRow, McpView,
    NewsDesk, NewsFeedView, NewsView, OrderBookView, PendingWalletView, PlanView, QuoteView, RunStatus,
    RunView, StepStatus, StepView, StoryView, TechnicalFrame, TechnicalsView, ThreadView, TicketView,
    TradeView, Trend, TurnEvent, WalletNoticeView, WalletTask, WalletView,
};
use octoneo_core::studio::{Studio, StudioConfig};
use rust_decimal::Decimal;
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

fn dec(text: &str) -> Decimal {
    Decimal::from_str(text).expect("test decimal")
}

/// The values a union type such as `export type Network = "a" | "b";` allows.
fn union(name: &str) -> BTreeSet<String> {
    let line = TYPES
        .lines()
        .find(|line| line.starts_with(&format!("export type {name} =")))
        .unwrap_or_else(|| panic!("{name} is missing"));
    line.split('"').skip(1).step_by(2).map(str::to_string).collect()
}

fn wire<T: Serialize>(values: &[T]) -> BTreeSet<String> {
    values
        .iter()
        .map(|value| serde_json::to_value(value).expect("serialises").as_str().expect("a string").to_string())
        .collect()
}

fn account() -> Account {
    let now = Utc::now();
    Account {
        equity: dec("988.25"),
        wallet_balance: dec("1000.5"),
        available: dec("640"),
        unrealized_pnl: dec("-12.25"),
        margin_used: dec("348.25"),
        balances: vec![AssetBalance { asset: "USDT".into(), balance: dec("1000.5"), available: dec("640") }],
        positions: vec![Position {
            symbol: "BTCUSDT".into(),
            amount: dec("-0.015"),
            entry_price: dec("62000"),
            mark_price: dec("62816.67"),
            liquidation_price: Some(dec("81116.7")),
            leverage: 3,
            isolated: true,
            unrealized_pnl: dec("-12.25"),
            notional: dec("-942.25"),
            isolated_margin: dec("310"),
        }],
        orders: vec![OpenOrder {
            id: "77".into(),
            client_id: "abc-sl".into(),
            symbol: "BTCUSDT".into(),
            side: Side::Buy,
            kind: "STOP_MARKET".into(),
            price: None,
            stop_price: Some(dec("64000")),
            qty: dec("0.015"),
            filled: Decimal::ZERO,
            reduce_only: true,
            status: "NEW".into(),
            time: now,
        }],
        multi_assets: true,
        as_of: now,
    }
}

fn ticket() -> TicketView {
    TicketView {
        id: "a".repeat(32),
        network: Network::Testnet,
        symbol: "BTCUSDT".into(),
        side: Side::Buy,
        qty: "0.01".into(),
        price: "62000".into(),
        notional: "620".into(),
        leverage: 3,
        margin: "206.67".into(),
        reduce_only: false,
        stop_loss: Some("60000".into()),
        take_profit: None,
        est_liquidation: Some("42883.3".into()),
        effect: "Opens a 0.01 BTC long at 3x with isolated margin".into(),
        rationale: String::new(),
    }
}

fn grid_level() -> GridLevelView {
    GridLevelView {
        index: 0,
        price: "60000".into(),
        side: Some(Side::Buy),
        order_id: Some("101".into()),
        filled_count: 1,
    }
}

fn grid_preview() -> GridPreviewView {
    GridPreviewView {
        network: Network::Testnet,
        symbol: "BTCUSDT".into(),
        base: "BTC".into(),
        quote: "USDT".into(),
        mark_price: "62000".into(),
        direction: GridDirection::Neutral,
        spacing: GridSpacing::Arithmetic,
        lower_price: "60000".into(),
        upper_price: "64000".into(),
        grids: 4,
        leverage: 3,
        isolated: true,
        margin: "500".into(),
        qty_per_grid: "0.005".into(),
        notional_per_grid: "310".into(),
        total_notional: "1240".into(),
        min_margin: "20".into(),
        profit_per_grid_min_pct: 1.5,
        profit_per_grid_max_pct: 1.6,
        initial_side: None,
        initial_qty: None,
        est_liq_long: Some("42000".into()),
        est_liq_short: Some("82000".into()),
        buy_orders: 2,
        sell_orders: 2,
        trigger_price: None,
        stop_upper: Some("66000".into()),
        stop_lower: Some("58000".into()),
        close_on_stop: true,
        post_only: true,
        levels: vec![grid_level()],
        warnings: vec!["Tight grid spacing.".into()],
    }
}

fn grid_bot() -> GridBotView {
    GridBotView {
        id: "g1".into(),
        network: Network::Testnet,
        symbol: "BTCUSDT".into(),
        base: "BTC".into(),
        quote: "USDT".into(),
        direction: GridDirection::Long,
        spacing: GridSpacing::Geometric,
        status: GridStatus::Running,
        lower_price: "60000".into(),
        upper_price: "64000".into(),
        grids: 4,
        leverage: 3,
        isolated: true,
        margin: "500".into(),
        qty_per_grid: "0.005".into(),
        entry_price: "62000".into(),
        mark_price: Some("62100".into()),
        trigger_price: None,
        stop_upper: Some("66000".into()),
        stop_lower: Some("58000".into()),
        close_on_stop: true,
        post_only: true,
        matched_trades: 3,
        realized_pnl: "12.5".into(),
        unrealized_pnl: "4.2".into(),
        total_pnl: "16.7".into(),
        roi_pct: Some(3.34),
        profit_per_grid_min_pct: 1.5,
        profit_per_grid_max_pct: 1.6,
        active_buy_orders: 2,
        active_sell_orders: 2,
        created_at: "2026-11-19T00:00:00Z".into(),
        updated_at: "2026-11-19T01:00:00Z".into(),
        stopped_at: None,
        last_note: "Running".into(),
        levels: vec![grid_level()],
    }
}

/// A grid bot the assistant drafted, with every optional setting of its request given.
fn grid_draft() -> GridDraftView {
    GridDraftView {
        id: "d".repeat(32),
        network: Network::Testnet,
        request: GridRequest {
            symbol: "BTCUSDT".into(),
            direction: GridDirection::Neutral,
            spacing: GridSpacing::Arithmetic,
            lower_price: "60000".into(),
            upper_price: "64000".into(),
            grids: 4,
            margin: "500".into(),
            leverage: 3,
            trigger_price: Some("61000".into()),
            stop_upper: Some("66000".into()),
            stop_lower: Some("58000".into()),
            close_on_stop: Some(true),
            post_only: Some(true),
        },
        preview: grid_preview(),
        rationale: "Range-bound on 4h; a close below 60,000 breaks it.".into(),
    }
}

fn run() -> RunView {
    RunView {
        id: "r1".into(),
        thread: "t1".into(),
        agent: "Assistant".into(),
        title: "Analyze BTC".into(),
        network: Network::Testnet,
        time: "2026-11-19T00:00:00Z".into(),
        status: RunStatus::Complete,
        steps: vec![StepView {
            name: "get_quote".into(),
            detail: "BTCUSDT".into(),
            status: StepStatus::Ok,
            ms: 12,
            preview: "{}".into(),
        }],
        output: "Done.".into(),
        reasoning: String::new(),
        ms: 40,
        ticket: Some(ticket()),
        grid: Some(grid_draft()),
        cards: vec![CardView::Account],
        usage: Some(Usage::default()),
        model: "lab/agent".into(),
    }
}

#[test]
fn every_view_sends_exactly_the_fields_the_interface_declares() {
    let contract = interfaces();
    assert!(contract.len() >= 36, "the contract parser found only {:?}", contract.keys());

    // A desk that has not reached the network yet still sends every field of the snapshot.
    let folder = tempfile::tempdir().expect("tempdir");
    let studio =
        Studio::open(StudioConfig::new(folder.path().to_path_buf(), Arc::new(MemorySecrets::default())))
            .expect("studio");
    let snapshot = studio.snapshot();
    same("Snapshot", &snapshot, &contract);
    same("WalletView", &snapshot.wallets[0], &contract);
    same("AssistantView", &snapshot.assistant, &contract);
    same("ProviderView", &snapshot.assistant.providers[0], &contract);
    assert_eq!(
        snapshot.assistant.providers.iter().map(|p| p.id).collect::<Vec<_>>(),
        octoneo_core::store::Provider::CONNECTABLE,
        "one entry per provider a model can be connected through, in display order"
    );
    same("RiskView", &snapshot.risk, &contract);
    assert_eq!(
        snapshot.wallets.iter().map(|w| w.network).collect::<Vec<_>>(),
        Network::ALL,
        "one wallet entry per network, mainnet first"
    );

    let market = Market {
        symbol: "BTCUSDT".into(),
        base: "BTC".into(),
        quote: "USDT".into(),
        tick: dec("0.1"),
        step: dec("0.001"),
        min_qty: dec("0.001"),
        max_qty: dec("120"),
        min_notional: dec("5"),
        maint_margin: dec("0.025"),
        band_up: Some(dec("1.02")),
        band_down: Some(dec("0.98")),
    };
    let quote = Quote {
        symbol: "BTCUSDT".into(),
        price: dec("62786"),
        mark: Some(dec("62786.7")),
        index: None,
        funding_rate: Some(dec("0.0001")),
        next_funding: Some(Utc::now()),
        as_of: Utc::now(),
        source: "Testnet".into(),
        closes: vec![dec("62000")],
        stats: DayStats::default(),
    };
    let account = AccountView::from(&account());
    let candle = Candle { t: 0, o: dec("1"), h: dec("2"), l: dec("1"), c: dec("2"), v: dec("3") };
    let run = run();
    let connected = WalletView {
        network: Network::Testnet,
        connected: true,
        user: Some("0x1".into()),
        agent: Some("0x2".into()),
        expires: None,
        needs_deposit: false,
    };
    same("WalletView", &connected, &contract);
    same(
        "InstrumentView",
        &InstrumentView { symbol: "BTCUSDT".into(), base: "BTC".into(), quote: "USDT".into(), custom: false },
        &contract,
    );
    same("QuoteView", &QuoteView::from(&quote), &contract);

    // Market data for the screener and the panel.
    let now = Utc::now();
    let tick = Tick { price: dec("62786"), as_of: now, stats: DayStats::default() };
    let premium = Premium {
        mark: dec("62786.7"),
        index: None,
        funding_rate: Some(dec("0.0001")),
        next_funding: Some(now),
    };
    let row = MarketRow::new(&market, &tick, Some(&premium));
    same("MarketRow", &row, &contract);
    let depth =
        OrderBook { bids: vec![(dec("62786"), dec("2"))], asks: vec![(dec("62787"), dec("3"))], as_of: now };
    let book = OrderBookView::new("BTCUSDT", &depth, 20).expect("book");
    same("OrderBookView", &book, &contract);
    same("BookLevel", &book.bids[0], &contract);
    let trade = Trade { time: now, price: dec("62786"), qty: dec("0.5"), taker: Side::Sell };
    same("TradeView", &TradeView::from(&trade), &contract);
    let funding = FundingView::new("BTCUSDT", &premium, Some(8), &[(now, dec("0.0001"))], Some(dec("10")));
    same("FundingView", &funding, &contract);
    assert_eq!(
        serde_json::to_value(&funding.history).expect("serialises")[0][1],
        json!(0.01),
        "a funding point is [time, percent], as FundingPoint declares"
    );
    let bars: Vec<Candle> = (0..80_i64)
        .map(|i| {
            let close = Decimal::from(100 + i);
            Candle {
                t: i * 3_600_000,
                o: close,
                h: close + Decimal::ONE,
                l: close - Decimal::ONE,
                c: close,
                v: Decimal::ONE,
            }
        })
        .collect();
    let frame = TechnicalFrame::from(&analyze("BTCUSDT", Timeframe::H1, &bars, dec("179"), "Testnet"));
    same("TechnicalFrame", &frame, &contract);
    assert!(union("Timeframe").contains(&frame.timeframe) && frame.trend == Trend::Uptrend);
    let technicals = TechnicalsView {
        symbol: "BTCUSDT".into(),
        price: "179".into(),
        frames: vec![frame.clone()],
        as_of: String::new(),
    };
    same("TechnicalsView", &technicals, &contract);
    let request = PlanRequest {
        equity: dec("10000"),
        entry: dec("62000"),
        stop: dec("60000"),
        risk_pct: Decimal::ONE,
        leverage: 3,
        target: Some(dec("68000")),
    };
    let plan = PlanView::from(&plan_position(&market, &request).expect("plan"));
    same("PlanView", &plan, &contract);
    assert_eq!((plan.direction.as_str(), plan.reward_to_risk), ("long", Some(3.0)));
    same(
        "ThreadView",
        &ThreadView {
            id: "t1".into(),
            title: "Analyze BTC".into(),
            time: String::new(),
            network: Network::Mainnet,
            turns: 1,
        },
        &contract,
    );

    let headline = NewsView {
        title: "Bitcoin slides 12%".into(),
        source: "CoinDesk".into(),
        url: "https://www.coindesk.com/markets/a".into(),
        published: Some("2026-11-19T06:00:00Z".into()),
    };
    // Every card the core can attach to an answer is a variant the interface draws, with the same fields.
    let mut cards: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for line in TYPES.lines().filter(|line| line.trim_start().starts_with("| { kind: \"")) {
        let body = line.trim().trim_start_matches("| {").trim_end_matches(['}', ';', ' ']);
        let fields = body
            .split(';')
            .map(|part| part.split(':').next().unwrap_or("").trim())
            .filter(|name| !name.is_empty() && *name != "kind")
            .map(str::to_string);
        cards.entry(line.split('"').nth(1).unwrap_or_default().to_string()).or_default().extend(fields);
    }
    let attached = [
        CardView::Quotes { quotes: vec![QuoteView::for_card(&quote)] },
        CardView::Technicals { symbol: "BTCUSDT".into(), frame },
        CardView::Book { book },
        CardView::Movers { rows: vec![row] },
        CardView::Plan { plan },
        CardView::News { query: "BTC".into(), articles: vec![headline.clone()] },
        CardView::Account,
        CardView::Grid { preview: Box::new(grid_preview()) },
        CardView::Grids { bots: vec![grid_bot()] },
    ];
    same("NewsView", &headline, &contract);
    // The News page, and every desk a story can come from.
    let story = StoryView {
        title: "Bitcoin slides 12%".into(),
        source: "CoinDesk".into(),
        url: "https://www.coindesk.com/markets/a".into(),
        published: Some("2026-11-19T06:00:00Z".into()),
        summary: "Forced selling explained most of the move.".into(),
        image: Some("https://cdn.example.com/a.jpg".into()),
        topics: vec!["Markets".into()],
        markets: vec!["BTCUSDT".into()],
        desk: NewsDesk::Crypto,
    };
    same("StoryView", &story, &contract);
    same(
        "NewsFeedView",
        &NewsFeedView {
            stories: vec![story],
            publishers: vec!["CoinDesk".into()],
            missing: Vec::new(),
            read_at: "2026-11-19T06:05:00Z".into(),
        },
        &contract,
    );
    assert_eq!(wire(&[NewsDesk::Crypto, NewsDesk::Macro]), union("NewsDesk"));
    let mut drawn = BTreeSet::new();
    for card in &attached {
        let wire = serde_json::to_value(card).expect("serialises");
        let kind = wire["kind"].as_str().expect("tagged").to_string();
        let mut fields = keys(&wire);
        fields.remove("kind");
        assert_eq!(Some(&fields), cards.get(&kind), "card `{kind}` differs from types.ts");
        // A card is kept in the journal with its answer, so it must read back as it was written.
        assert_eq!(&serde_json::from_value::<CardView>(wire).expect("reads back"), card);
        drawn.insert(kind);
    }
    assert_eq!(drawn, cards.keys().cloned().collect::<BTreeSet<_>>(), "every declared card was checked");
    same("AccountView", &account, &contract);
    same("BalanceView", &account.balances[0], &contract);
    same("PositionView", &account.positions[0], &contract);
    same("OpenOrderView", &account.orders[0], &contract);
    same("RunView", &run, &contract);
    same("StepView", &run.steps[0], &contract);
    same("TicketView", &ticket(), &contract);
    same("GridLevelView", &grid_level(), &contract);
    same("GridPreviewView", &grid_preview(), &contract);
    same("GridBotView", &grid_bot(), &contract);
    // A drafted grid bot carries the request starting it launches. A setting left out is left out
    // on the wire too, as the interface's optional fields are.
    let draft = grid_draft();
    same("GridDraftView", &draft, &contract);
    same("GridRequest", &draft.request, &contract);
    let bare = GridRequest {
        trigger_price: None,
        stop_upper: None,
        stop_lower: None,
        close_on_stop: None,
        post_only: None,
        ..draft.request.clone()
    };
    let sent = keys(&serde_json::to_value(&bare).expect("serialises"));
    assert!(sent.is_subset(&contract["GridRequest"]) && !sent.contains("triggerPrice"), "{sent:?}");
    // A run that drafted one is kept in the journal, so it must read back as it was written.
    let stored = serde_json::to_value(&run).expect("serialises");
    assert_eq!(serde_json::from_value::<RunView>(stored).expect("reads back"), run);
    // A run journaled before grid drafts existed still loads.
    let mut older = serde_json::to_value(&run).expect("serialises");
    older.as_object_mut().expect("object").remove("grid");
    assert_eq!(serde_json::from_value::<RunView>(older).expect("an older run").grid, None);
    same("UsageView", &Usage::default(), &contract);
    same("CandleSeries", &CandleSeries::new("BTCUSDT", "1h", "Testnet", &[candle]), &contract);
    same(
        "McpView",
        &McpView {
            id: "news".into(),
            name: "n".into(),
            version: "1".into(),
            transport: Transport::Http,
            tools: 1,
        },
        &contract,
    );
    same(
        "PendingWalletView",
        &PendingWalletView {
            network: Network::Testnet,
            task: WalletTask::Deposit,
            url: "http://127.0.0.1:1/x".into(),
        },
        &contract,
    );
    same(
        "WalletNoticeView",
        &WalletNoticeView {
            network: Network::Testnet,
            task: WalletTask::Withdraw,
            ok: true,
            text: "Withdrawal requested.".into(),
        },
        &contract,
    );
    assert_eq!(
        wire(&[WalletTask::Connect, WalletTask::Deposit, WalletTask::Withdraw]),
        union("WalletTask"),
        "the tasks of a wallet page"
    );
    same(
        "ToolInfo",
        &ToolInfo { name: "t".into(), description: String::new(), schema: json!({}), read_only: true },
        &contract,
    );
    // A short position is sent as a side and a positive size, never as a signed amount.
    let position = serde_json::to_value(&account.positions[0]).expect("serialises");
    assert_eq!(
        (&position["side"], &position["qty"], &position["notional"]),
        (&json!("short"), &json!("0.015"), &json!("942.25"))
    );

    // The core may know more about a model than the interface shows, never less.
    let model = keys(&serde_json::to_value(ModelInfo::default()).expect("serialises"));
    assert!(
        contract["ModelInfo"].is_subset(&model),
        "ModelInfo lacks {:?}",
        contract["ModelInfo"].difference(&model).collect::<Vec<_>>()
    );

    // Every turn event the core can emit is a variant the interface handles, with the same fields.
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
    let emitted = [
        TurnEvent::Started { run: run.clone() },
        TurnEvent::Text { delta: String::new() },
        TurnEvent::Round,
        TurnEvent::Reasoning { delta: String::new() },
        TurnEvent::Step { index: 0, step: run.steps[0].clone() },
        TurnEvent::Card { card: CardView::Account },
        TurnEvent::Ticket { ticket: ticket() },
        TurnEvent::Grid { grid: grid_draft() },
        TurnEvent::Finished { run },
    ];
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
    use octoneo_core::mcp::McpConnectRequest;
    use octoneo_core::store::{Effort, Provider, Theme};
    use octoneo_core::studio::view::{
        AssistantRequest, FundingRequest, GridRequest, ModelsRequest, RiskRequest, TicketRequest,
        WalletBrowserRequest, WalletKeyRequest,
    };

    let contract = interfaces();
    // One sample per request type, carrying every field the interface may send.
    let ticket = json!({"symbol": "BTCUSDT", "side": "sell", "qty": "0.1", "notional": "100", "leverage": 3, "reduceOnly": false,
        "stopLoss": "64000", "takeProfit": "58000"});
    let key = json!({"network": "testnet", "user": "0xabc", "agentKey": "0xdef"});
    let browser = json!({"network": "mainnet", "days": 30});
    let funding = json!({"network": "testnet", "task": "withdraw"});
    let risk = json!({"maxLeverage": 5, "isolated": true});
    let assistant = json!({"provider": "cloudflare", "model": "a/b", "key": "token", "account": "abc", "gateway": "desk",
        "url": "http://127.0.0.1:1234", "effort": "medium", "liveTickets": true});
    let models = json!({"provider": "lmstudio", "key": "k", "account": "abc", "gateway": "desk", "url": "http://127.0.0.1:1234"});
    let grid = json!({"symbol": "BTCUSDT", "direction": "neutral", "spacing": "arithmetic", "lowerPrice": "60000",
        "upperPrice": "66000", "grids": 10, "margin": "500", "leverage": 3, "triggerPrice": "62500",
        "stopUpper": "68000", "stopLower": "58000", "closeOnStop": true, "postOnly": true});
    for (interface, sample) in [
        ("TicketRequest", &ticket),
        ("GridRequest", &grid),
        ("WalletKeyRequest", &key),
        ("WalletBrowserRequest", &browser),
        ("FundingRequest", &funding),
        ("RiskRequest", &risk),
        ("AssistantRequest", &assistant),
        ("ModelsRequest", &models),
    ] {
        assert_eq!(
            &keys(sample),
            &contract[interface],
            "{interface}: the sample must cover every declared field"
        );
    }
    let parsed = serde_json::from_value::<TicketRequest>(ticket).expect("ticket request");
    assert_eq!(
        (parsed.side, parsed.leverage, parsed.reduce_only, parsed.stop_loss.as_deref()),
        (Side::Sell, Some(3), Some(false), Some("64000"))
    );
    assert_eq!(
        serde_json::from_value::<WalletKeyRequest>(key).expect("key request").network,
        Network::Testnet
    );
    assert_eq!(serde_json::from_value::<WalletBrowserRequest>(browser).expect("browser request").days, 30);
    let parsed = serde_json::from_value::<FundingRequest>(funding).expect("funding request");
    assert_eq!((parsed.network, parsed.task), (Network::Testnet, WalletTask::Withdraw));
    assert_eq!(serde_json::from_value::<RiskRequest>(risk).expect("risk request").max_leverage, 5);
    let parsed = serde_json::from_value::<AssistantRequest>(assistant).expect("assistant request");
    assert_eq!(
        (parsed.provider, parsed.account.as_deref(), parsed.gateway.as_deref(), parsed.live_tickets),
        (Provider::Cloudflare, Some("abc"), Some("desk"), true)
    );
    let parsed = serde_json::from_value::<ModelsRequest>(models).expect("models request");
    assert_eq!((parsed.provider, parsed.url.as_deref()), (Provider::LmStudio, Some("http://127.0.0.1:1234")));
    // Only the provider is required: the rest falls back to what is stored.
    serde_json::from_value::<ModelsRequest>(json!({"provider": "ollama"})).expect("a minimal models request");
    serde_json::from_value::<AssistantRequest>(
        json!({"provider": "ollama", "model": "qwen3:8b", "effort": "auto", "liveTickets": false}),
    )
    .expect("a minimal assistant request");
    // Only what the form needs is required.
    serde_json::from_value::<TicketRequest>(json!({"symbol": "BTCUSDT", "side": "buy", "qty": "1"}))
        .expect("a minimal ticket");
    let parsed_grid = serde_json::from_value::<GridRequest>(grid).expect("grid request");
    assert_eq!(
        (parsed_grid.direction, parsed_grid.spacing, parsed_grid.grids, parsed_grid.close_on_stop),
        (GridDirection::Neutral, GridSpacing::Arithmetic, 10, Some(true))
    );
    serde_json::from_value::<GridRequest>(json!({
        "symbol": "ETHUSDT", "direction": "long", "spacing": "geometric",
        "lowerPrice": "2800", "upperPrice": "3400", "grids": 8, "margin": "300", "leverage": 3
    }))
    .expect("a minimal grid request");

    let stdio = json!({"id": "files", "transport": "stdio", "command": "node", "args": ["server.js"], "env": {"A": "1"}});
    let http = json!({"id": "news", "transport": "http", "url": "https://example.com/mcp", "token": "t"});
    for (sample, id) in [(stdio, "files"), (http, "news")] {
        // The union in types.ts declares these fields for this transport.
        let transport = sample["transport"].as_str().expect("transport").to_string();
        let line = TYPES
            .lines()
            .find(|line| {
                line.trim_start().starts_with("| {") && line.contains(&format!("transport: \"{transport}\""))
            })
            .expect("declared transport");
        for field in keys(&sample) {
            assert!(
                line.contains(&format!("{field}:")) || line.contains(&format!("{field}?:")),
                "{transport}: {field} is not declared in {line}"
            );
        }
        assert_eq!(serde_json::from_value::<McpConnectRequest>(sample).expect("connect request").id(), id);
    }

    // Unions carry the same words on both sides.
    assert_eq!(union("Network"), wire(&Network::ALL));
    assert_eq!(union("Side"), wire(&[Side::Buy, Side::Sell]));
    assert_eq!(union("Timeframe"), Timeframe::ALL.iter().map(|tf| tf.as_str().to_string()).collect());
    let providers: Vec<Provider> = std::iter::once(Provider::None).chain(Provider::CONNECTABLE).collect();
    assert_eq!(union("Provider"), wire(&providers));
    assert_eq!(
        union("Trend"),
        wire(&[
            octoneo_core::studio::view::Trend::Uptrend,
            octoneo_core::studio::view::Trend::Downtrend,
            octoneo_core::studio::view::Trend::Mixed,
            octoneo_core::studio::view::Trend::Unknown
        ])
    );
    assert_eq!(union("Effort"), wire(&[Effort::Auto, Effort::Low, Effort::Medium, Effort::High]));
    assert_eq!(union("Theme"), wire(&[Theme::System, Theme::Light, Theme::Dark]));
    assert_eq!(union("GridDirection"), wire(&GridDirection::ALL));
    assert_eq!(union("GridSpacing"), wire(&GridSpacing::ALL));
    assert_eq!(union("GridStatus"), wire(&GridStatus::ALL));
    for (interface, field, values) in [
        ("PositionView", "side", vec!["long", "short"]),
        ("PlanView", "direction", vec!["long", "short"]),
        ("StepView", "status", vec!["running", "ok", "error"]),
        ("RunView", "status", vec!["running", "complete", "failed", "stopped"]),
        ("McpView", "transport", vec!["stdio", "http"]),
    ] {
        let line = TYPES
            .lines()
            .skip_while(|line| !line.starts_with(&format!("export interface {interface} ")))
            .find(|line| line.trim_start().starts_with(&format!("{field}:")))
            .unwrap_or_else(|| panic!("{interface}.{field} is missing"));
        let declared: BTreeSet<&str> = line.split('"').skip(1).step_by(2).collect();
        assert_eq!(declared, values.into_iter().collect(), "{interface}.{field}");
    }
    assert_eq!(
        wire(&[RunStatus::Running, RunStatus::Complete, RunStatus::Failed, RunStatus::Stopped]).len(),
        4
    );
    assert_eq!(
        wire(&[StepStatus::Running, StepStatus::Ok, StepStatus::Error]),
        ["running", "ok", "error"].map(String::from).into()
    );
}

/// Every call the interface makes is a command the desktop shell registers, and
/// the other way round. A command renamed on one side only would fail at run
/// time, in front of the trader.
#[test]
fn the_interface_calls_exactly_the_commands_the_shell_offers() {
    const BRIDGE: &str = include_str!("../../../src/api/tauri.ts");
    const SHELL: &str = include_str!("../../../src-tauri/src/lib.rs");

    let called: BTreeSet<&str> = BRIDGE
        .split("invoke")
        .skip(1)
        .filter_map(|rest| {
            // `invoke<T>("name", …)` or `invoke("name")`.
            let rest = rest.trim_start();
            let rest = if rest.starts_with('<') { rest.split_once('>')?.1 } else { rest };
            let name = rest.trim_start().strip_prefix("(\"")?.split('"').next()?;
            Some(name)
        })
        .collect();
    let registered = SHELL.split_once("generate_handler![").expect("the shell registers its commands").1;
    let registered = registered.split_once(']').expect("the list ends").0;
    let offered: BTreeSet<&str> =
        registered.split(',').map(str::trim).filter(|name| !name.is_empty()).collect();
    assert!(called.len() >= 30, "the bridge parser found only {called:?}");
    assert_eq!(called, offered, "src/api/tauri.ts and src-tauri/src/lib.rs disagree about the commands");
    for command in &offered {
        assert!(SHELL.contains(&format!("fn {command}(")), "{command} is registered but not defined");
    }
}
