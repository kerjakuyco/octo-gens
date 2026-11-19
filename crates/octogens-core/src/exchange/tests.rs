use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::signing::recover;
use super::*;
use crate::net::http_client;

const DAY: i64 = 86_400_000;
/// The example API wallet from the exchange's documentation.
const AGENT_KEY: &str = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1";
const AGENT: &str = "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";
const USER: &str = "0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e";

fn dec(text: &str) -> Decimal {
    Decimal::from_str(text).expect("test decimal")
}

fn symbol(name: &str, base: &str, quote: &str, status: &str) -> Value {
    json!({
        "symbol": name, "baseAsset": base, "quoteAsset": quote, "status": status, "contractType": "PERPETUAL",
        "maintMarginPercent": "2.5000",
        "filters": [
            {"filterType": "PRICE_FILTER", "tickSize": "0.1", "minPrice": "1", "maxPrice": "1000000"},
            {"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "1000"},
            {"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "120"},
            {"filterType": "MIN_NOTIONAL", "notional": "5"},
        ],
    })
}

fn exchange_info() -> Value {
    json!({"symbols": [
        symbol("BTCUSDT", "BTC", "USDT", "TRADING"),
        symbol("ETHUSDT", "ETH", "USDT", "TRADING"),
        symbol("XAUUSD1", "XAU", "USD1", "TRADING"),
        symbol("ETHUSD1", "ETH", "USD1", "TRADING"),
        symbol("币安人生USDT", "币安人生", "USDT", "TRADING"),
        symbol("B-MONEYUSDT", "B-MONEY", "USDT", "TRADING"),
        symbol("OLDUSDT", "OLD", "USDT", "SETTLING"),
        {"symbol": "ODDUSDT", "baseAsset": "ODD", "quoteAsset": "USDT", "status": "TRADING", "contractType": ""},
    ]})
}

async fn serve(server: &MockServer, verb: &str, route: &str, body: Value) {
    Mock::given(method(verb))
        .and(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

async fn fail(server: &MockServer, verb: &str, route: &str, status: u16, body: Value) {
    Mock::given(method(verb))
        .and(path(route))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(server)
        .await;
}

async fn client(network: Network, server: &MockServer) -> ExchangeClient {
    // The clock check must never reach the internet from a test.
    serve(server, "GET", "/fapi/v3/time", json!({"serverTime": Utc::now().timestamp_millis()})).await;
    ExchangeClient::new(network, http_client().expect("client")).with_base(&server.uri())
}

fn wallet() -> Wallet {
    Wallet {
        user: Address::parse(USER).expect("user"),
        agent: AgentKey::parse(AGENT_KEY).expect("agent"),
        expires: None,
    }
}

/// Splits a signed request into the string that was signed and its signature.
fn signed_parts(request: &Request) -> (String, String) {
    let query = request.url.query().expect("query");
    let (params, signature) = query.split_once("&signature=").expect("signed");
    (params.to_string(), signature.to_string())
}

fn sent<'a>(requests: &'a [Request], route: &str) -> Vec<&'a Request> {
    requests.iter().filter(|r| r.url.path() == route).collect()
}

fn accepted(placement: Placement) -> OrderAck {
    match placement {
        Placement::Accepted(ack) => ack,
        other => panic!("the order was not accepted: {other:?}"),
    }
}

fn rejected(placement: Placement) -> String {
    match placement {
        Placement::Rejected(error) => error.0,
        other => panic!("the order was not rejected: {other:?}"),
    }
}

fn unknown(placement: Placement) -> String {
    match placement {
        Placement::Unknown(reason) => reason,
        other => panic!("the order's outcome was not unknown: {other:?}"),
    }
}

fn param(params: &str, key: &str) -> Option<String> {
    params.split('&').find_map(|pair| pair.strip_prefix(&format!("{key}=")).map(str::to_string))
}

#[tokio::test]
async fn only_trading_perpetuals_are_listed_and_names_resolve_without_guessing() {
    let server = MockServer::start().await;
    serve(&server, "GET", "/fapi/v3/exchangeInfo", exchange_info()).await;
    let venue = client(Network::Mainnet, &server).await;
    let markets = venue.markets().await.expect("markets");
    assert_eq!(
        markets.all().iter().map(|m| m.symbol.as_str()).collect::<Vec<_>>(),
        ["BTCUSDT", "ETHUSDT", "XAUUSD1", "ETHUSD1", "币安人生USDT", "B-MONEYUSDT"],
        "settling and non-perpetual symbols are left out"
    );
    let btc = markets.get("BTCUSDT").expect("btc");
    assert_eq!(
        (btc.tick, btc.step, btc.min_qty, btc.max_qty),
        (dec("0.1"), dec("0.001"), dec("0.001"), dec("120"))
    );
    assert_eq!((btc.min_notional, btc.maint_margin), (dec("5"), dec("0.025")));

    for (typed, expected) in [
        ("btc", "BTCUSDT"),
        ("$BTC", "BTCUSDT"),
        ("BTC/USDT", "BTCUSDT"),
        ("btcusdt", "BTCUSDT"),
        ("BTC-PERP", "BTCUSDT"),
        ("eth", "ETHUSDT"),
        ("ETHUSD1", "ETHUSD1"),
        ("xau", "XAUUSD1"),
        ("币安人生", "币安人生USDT"),
        ("b-money", "B-MONEYUSDT"),
        ("B-MONEYUSDT", "B-MONEYUSDT"),
    ] {
        assert_eq!(
            markets.resolve(typed).unwrap_or_else(|e| panic!("{typed}: {e}")).symbol,
            expected,
            "{typed}"
        );
    }
    for unknown in ["", "OLD", "ODD", "TSLA", "BTCUSD"] {
        assert!(markets.resolve(unknown).is_err(), "{unknown} should not resolve");
    }

    // The list is cached: asking again does not ask the exchange again.
    assert_eq!(venue.market("eth").await.expect("market").symbol, "ETHUSDT");
    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(sent(&requests, "/fapi/v3/exchangeInfo").len(), 1);
}

#[tokio::test]
async fn a_quote_joins_price_mark_funding_and_completed_daily_closes() {
    let server = MockServer::start().await;
    let now = Utc::now().timestamp_millis();
    let today = now / DAY * DAY;
    serve(&server, "GET", "/fapi/v3/ticker/24hr", json!({"symbol": "BTCUSDT", "lastPrice": "62786.0", "priceChangePercent": "-2.330",
        "highPrice": "64937.1", "lowPrice": "62025.8", "volume": "9232.446", "quoteVolume": "584209412.95", "closeTime": now})).await;
    serve(
        &server,
        "GET",
        "/fapi/v3/premiumIndex",
        json!({"symbol": "BTCUSDT", "markPrice": "62786.71219928", "indexPrice": "62819.82804348",
        "lastFundingRate": "0.00004898", "nextFundingTime": today + DAY, "time": now}),
    )
    .await;
    // Newest first here: the client must not rely on the venue's order.
    serve(
        &server,
        "GET",
        "/fapi/v3/klines",
        json!([
            [today, "62900", "63000", "62000", "62786", "70.1", today + DAY - 1],
            [today - DAY, "64000", "64500", "62500", "62900", "500.2", today - 1],
            [today - 2 * DAY, "65000", "65500", "63500", "64000", "410.9", today - DAY - 1],
        ]),
    )
    .await;
    let venue = client(Network::Testnet, &server).await;

    let quote = venue.quote("BTCUSDT").await.expect("quote");
    assert_eq!(
        (quote.symbol.as_str(), quote.price, quote.source.as_str()),
        ("BTCUSDT", dec("62786"), "Testnet")
    );
    assert_eq!((quote.mark, quote.index), (Some(dec("62786.71219928")), Some(dec("62819.82804348"))));
    assert_eq!(quote.reference(), dec("62786.71219928"), "estimates use the mark price");
    assert!((quote.funding_pct().expect("funding") - 0.004898).abs() < 1e-9);
    assert_eq!(quote.next_funding.map(|t| t.timestamp_millis()), Some(today + DAY));
    assert_eq!(quote.closes, [dec("64000"), dec("62900")], "the candle still forming is not a close");
    assert_eq!(
        (quote.stats.change_pct, quote.stats.high, quote.stats.quote_volume),
        (Some(-2.33), Some(dec("64937.1")), Some(dec("584209412.95")))
    );

    let candles = venue.candles("BTCUSDT", Timeframe::D1, 2).await.expect("candles");
    assert_eq!(
        candles.iter().map(|c| c.t).collect::<Vec<_>>(),
        [today - DAY, today],
        "oldest first, trimmed to the newest two"
    );
    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(
        sent(&requests, "/fapi/v3/klines")[0].url.query(),
        Some("symbol=BTCUSDT&interval=1d&limit=91")
    );
}

#[tokio::test]
async fn one_call_refreshes_every_ticker_and_the_book_is_read_best_first() {
    let server = MockServer::start().await;
    let now = Utc::now().timestamp_millis();
    serve(
        &server,
        "GET",
        "/fapi/v3/ticker/24hr",
        json!([
            {"symbol": "BTCUSDT", "lastPrice": "62786.0", "priceChangePercent": "-2.33", "closeTime": now},
            {"symbol": "ETHUSDT", "lastPrice": "1770.14", "priceChangePercent": "1.5", "closeTime": now},
            {"symbol": "BROKEN", "lastPrice": "0"},
        ]),
    )
    .await;
    serve(&server, "GET", "/fapi/v3/premiumIndex", json!([
        {"symbol": "BTCUSDT", "markPrice": "62786.7", "lastFundingRate": "-0.0001", "nextFundingTime": now + 3_600_000},
        {"symbol": "ETHUSDT", "markPrice": "1770.2", "indexPrice": "1770.0", "lastFundingRate": "0.0001", "nextFundingTime": 0},
    ])).await;
    serve(&server, "GET", "/fapi/v3/depth", json!({"lastUpdateId": 1, "E": 1_795_054_683_238_i64,
        "bids": [["62775.2", "0.591"], ["62775.1", "0.398"]], "asks": [["62775.3", "2.6"], ["62775.9", "0"]]})).await;
    let venue = client(Network::Mainnet, &server).await;

    let ticks = venue.tickers().await.expect("tickers");
    assert_eq!(
        (ticks.len(), ticks["ETHUSDT"].price, ticks["ETHUSDT"].stats.change_pct),
        (2, dec("1770.14"), Some(1.5))
    );
    let premiums = venue.premiums().await.expect("premiums");
    assert_eq!(
        (premiums["BTCUSDT"].funding_rate, premiums["ETHUSDT"].next_funding),
        (Some(dec("-0.0001")), None)
    );

    let book = venue.depth("BTCUSDT", 60).await.expect("depth");
    assert_eq!(
        (book.bids[0], book.asks[0], book.as_of.timestamp_millis()),
        ((dec("62775.2"), dec("0.591")), (dec("62775.3"), dec("2.6")), 1_795_054_683_238)
    );
    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(
        sent(&requests, "/fapi/v3/depth")[0].url.query(),
        Some("symbol=BTCUSDT&limit=100"),
        "rounded up to a size the exchange offers"
    );
}

#[tokio::test]
async fn open_interest_funding_history_and_the_tape_are_read() {
    let server = MockServer::start().await;
    serve(
        &server,
        "GET",
        "/fapi/v3/openInterest",
        json!({"openInterest": "8421.350", "symbol": "BTCUSDT", "time": 1_795_054_683_238_i64}),
    )
    .await;
    // Newest first here: the client must not rely on the venue's order.
    serve(
        &server,
        "GET",
        "/fapi/v3/fundingRate",
        json!([
            {"symbol": "BTCUSDT", "fundingRate": "-0.00002100", "fundingTime": 1_795_046_400_000_i64},
            {"symbol": "BTCUSDT", "fundingRate": "0.00010000", "fundingTime": 1_795_017_600_000_i64},
            {"symbol": "BTCUSDT", "fundingRate": "n/a", "fundingTime": 1_794_988_800_000_i64},
        ]),
    )
    .await;
    serve(&server, "GET", "/fapi/v3/fundingInfo", json!([
        {"symbol": "ETHUSDT", "fundingIntervalHours": 4},
        {"symbol": "BTCUSDT", "interestRate": "0.00010000", "fundingIntervalHours": 8, "fundingFeeCap": 0.003},
    ])).await;
    serve(&server, "GET", "/fapi/v3/trades", json!([
        {"id": 1, "price": "62570.1", "qty": "0.250", "quoteQty": "15642.5", "time": 1_795_054_680_000_i64, "isBuyerMaker": true},
        {"id": 2, "price": "62571.4", "qty": "0.010", "quoteQty": "625.7", "time": 1_795_054_683_000_i64, "isBuyerMaker": false},
        {"id": 3, "price": "0", "qty": "1", "time": 1_795_054_684_000_i64, "isBuyerMaker": false},
    ])).await;
    let venue = client(Network::Mainnet, &server).await;

    assert_eq!(venue.open_interest("BTCUSDT").await.expect("open interest"), dec("8421.35"));
    let history = venue.funding_history("BTCUSDT", 5000).await.expect("history");
    assert_eq!(
        history.iter().map(|(time, rate)| (time.timestamp_millis(), *rate)).collect::<Vec<_>>(),
        [(1_795_017_600_000, dec("0.0001")), (1_795_046_400_000, dec("-0.000021"))],
        "oldest first, unreadable rows left out"
    );
    assert_eq!(venue.funding_interval("BTCUSDT").await.expect("interval"), Some(8));
    assert_eq!(venue.funding_interval("SOLUSDT").await.expect("interval"), None);
    let tape = venue.trades("BTCUSDT", 2).await.expect("tape");
    assert_eq!(
        tape.iter().map(|t| (t.price, t.qty, t.taker)).collect::<Vec<_>>(),
        [(dec("62571.4"), dec("0.01"), Side::Buy), (dec("62570.1"), dec("0.25"), Side::Sell)],
        "newest first; a trade with no price is not a trade"
    );
    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(sent(&requests, "/fapi/v3/fundingRate")[0].url.query(), Some("symbol=BTCUSDT&limit=1000"));
    assert!(
        requests.iter().all(|r| !r.url.query().unwrap_or_default().contains("signature")),
        "all of it is public data"
    );
}

#[tokio::test]
async fn account_calls_are_signed_by_the_api_wallet_over_exactly_what_is_sent() {
    for network in Network::ALL {
        let server = MockServer::start().await;
        serve(&server, "GET", "/fapi/v3/account", json!({
            "totalWalletBalance": "1000.5", "totalUnrealizedProfit": "-12.25", "totalMarginBalance": "988.25",
            "availableBalance": "640.00", "totalInitialMargin": "348.25",
            "assets": [{"asset": "USDT", "walletBalance": "1000.5", "availableBalance": "640.00"}, {"asset": "USD1", "walletBalance": "0", "availableBalance": "0"}],
        })).await;
        serve(&server, "GET", "/fapi/v3/positionRisk", json!([
            {"symbol": "BTCUSDT", "positionAmt": "0.015", "entryPrice": "63600.0", "markPrice": "62786.7", "liquidationPrice": "43100.5",
             "leverage": "3", "marginType": "isolated", "unRealizedProfit": "-12.25", "notional": "941.80", "isolatedMargin": "318.0", "positionSide": "BOTH"},
            {"symbol": "ETHUSDT", "positionAmt": "0.000", "entryPrice": "0.0", "markPrice": "1770.2", "liquidationPrice": "0",
             "leverage": "20", "marginType": "cross", "unRealizedProfit": "0", "notional": "0", "isolatedMargin": "0", "positionSide": "BOTH"},
        ])).await;
        serve(&server, "GET", "/fapi/v3/openOrders", json!([
            {"orderId": 77, "clientOrderId": "abc-sl", "symbol": "BTCUSDT", "side": "SELL", "type": "STOP_MARKET", "price": "0", "stopPrice": "61000",
             "origQty": "0.015", "executedQty": "0", "reduceOnly": true, "status": "NEW", "time": 1_795_054_683_238_i64},
        ])).await;
        let venue = client(network, &server).await;
        assert!(
            venue
                .account()
                .await
                .expect_err("no wallet")
                .to_string()
                .starts_with(&format!("Connect a wallet on {} first.", network.name()))
        );
        venue.set_wallet(Some(wallet()));

        let account = venue.account().await.unwrap_or_else(|e| panic!("{network:?}: {e}"));
        assert_eq!(
            (account.equity, account.wallet_balance, account.available),
            (dec("988.25"), dec("1000.5"), dec("640"))
        );
        assert_eq!(
            (account.unrealized_pnl, account.margin_used, account.balances.len()),
            (dec("-12.25"), dec("348.25"), 1)
        );
        assert_eq!(account.positions.len(), 1, "flat positions are left out");
        let position = account.position("BTCUSDT").expect("position");
        assert_eq!(
            (position.amount, position.leverage, position.isolated, position.liquidation_price),
            (dec("0.015"), 3, true, Some(dec("43100.5")))
        );
        assert_eq!((position.is_long(), position.margin()), (true, dec("318")));
        let order = &account.orders[0];
        assert_eq!(
            (order.id.as_str(), order.kind.as_str(), order.side, order.price, order.stop_price),
            ("77", "STOP_MARKET", Side::Sell, None, Some(dec("61000")))
        );
        assert!(order.reduce_only);

        // Asking for one symbol returns its leverage and margin mode even when flat.
        let flat = venue.positions(Some("ETHUSDT")).await.expect("positions");
        assert_eq!(
            flat.len(),
            2,
            "the mock returns every row; flat rows are kept when a symbol is asked for"
        );

        let requests = server.received_requests().await.expect("recorded");
        let mut nonces = Vec::new();
        for request in requests.iter().filter(|r| r.url.query().is_some_and(|q| q.contains("signature="))) {
            let (params, signature) = signed_parts(request);
            assert_eq!(
                recover(network.chain_id(), &params, &signature).expect("recovers").to_string(),
                AGENT,
                "{}",
                request.url.path()
            );
            assert_eq!(param(&params, "signer").as_deref(), Some(AGENT));
            assert!(!params.contains(USER), "the main wallet address is not part of an API wallet request");
            assert!(!request.url.as_str().contains(&AGENT_KEY[2..]), "the key itself never travels");
            nonces.push(param(&params, "nonce").expect("nonce").parse::<u64>().expect("number"));
        }
        assert!(nonces.len() >= 4);
        let micros = Utc::now().timestamp_micros() as u64;
        assert!(
            nonces.iter().all(|nonce| micros.abs_diff(*nonce) < 60_000_000),
            "nonces are microseconds near now"
        );
        let mut unique = nonces.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), nonces.len(), "no nonce is used twice");
        // A signature made for one network does not verify on the other.
        let (params, signature) = signed_parts(sent(&requests, "/fapi/v3/account")[0]);
        let other = if network == Network::Mainnet { Network::Testnet } else { Network::Mainnet };
        assert_ne!(recover(other.chain_id(), &params, &signature).expect("recovers").to_string(), AGENT);
    }
}

#[tokio::test]
async fn orders_carry_the_right_shape_for_entries_and_protective_orders() {
    let server = MockServer::start().await;
    serve(
        &server,
        "POST",
        "/fapi/v3/order",
        json!({"orderId": 22542179, "clientOrderId": "echoed", "status": "FILLED",
        "executedQty": "0.015", "avgPrice": "62790.10", "symbol": "BTCUSDT"}),
    )
    .await;
    serve(
        &server,
        "POST",
        "/fapi/v3/leverage",
        json!({"leverage": 3, "symbol": "BTCUSDT", "maxNotionalValue": "1000000"}),
    )
    .await;
    fail(
        &server,
        "POST",
        "/fapi/v3/marginType",
        400,
        json!({"code": -4046, "msg": "No need to change margin type."}),
    )
    .await;
    serve(&server, "DELETE", "/fapi/v3/order", json!({"orderId": 77, "status": "CANCELED"})).await;
    serve(
        &server,
        "DELETE",
        "/fapi/v3/allOpenOrders",
        json!({"code": 200, "msg": "The operation of cancel all open order is done."}),
    )
    .await;
    let venue = client(Network::Testnet, &server).await;
    venue.set_wallet(Some(wallet()));
    let order = |kind, side, reduce_only, id: &str| OrderRequest {
        symbol: "BTCUSDT".into(),
        side,
        kind,
        qty: dec("0.0150"),
        reduce_only,
        client_id: id.into(),
    };

    let ack = accepted(venue.place_order(&order(OrderKind::Market, Side::Buy, false, "entry-1")).await);
    assert_eq!(
        (ack.order_id.as_str(), ack.status.as_str(), ack.executed_qty, ack.avg_price),
        ("22542179", "FILLED", dec("0.015"), dec("62790.1"))
    );
    let stop = order(OrderKind::StopMarket { trigger: dec("61000.0") }, Side::Sell, true, "entry-1-sl");
    accepted(venue.place_order(&stop).await);
    let target = order(OrderKind::TakeProfitMarket { trigger: dec("66000") }, Side::Sell, true, "entry-1-tp");
    accepted(venue.place_order(&target).await);
    venue.set_leverage("BTCUSDT", 3).await.expect("leverage");
    venue.set_margin_type("BTCUSDT", true).await.expect("already isolated is fine");
    venue.cancel_order("BTCUSDT", "77").await.expect("cancel");
    venue.cancel_all("BTCUSDT").await.expect("cancel all");

    let requests = server.received_requests().await.expect("recorded");
    let orders: Vec<String> = sent(&requests, "/fapi/v3/order")
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| signed_parts(r).0)
        .collect();
    assert!(orders[0].starts_with("symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.015&newClientOrderId=entry-1&newOrderRespType=RESULT&nonce="), "{}", orders[0]);
    assert!(!orders[0].contains("reduceOnly"));
    assert!(
        orders[1].starts_with("symbol=BTCUSDT&side=SELL&type=STOP_MARKET&stopPrice=61000&workingType=MARK_PRICE&quantity=0.015&reduceOnly=true&newClientOrderId=entry-1-sl"),
        "{}",
        orders[1]
    );
    assert!(
        orders[2].contains("type=TAKE_PROFIT_MARKET&stopPrice=66000&workingType=MARK_PRICE"),
        "{}",
        orders[2]
    );
    assert!(
        requests.iter().filter(|r| r.method.as_str() != "GET").all(|r| r.body.is_empty()),
        "parameters travel in the signed query only"
    );
    assert!(
        signed_parts(sent(&requests, "/fapi/v3/leverage")[0])
            .0
            .starts_with("symbol=BTCUSDT&leverage=3&nonce=")
    );
    assert!(
        signed_parts(sent(&requests, "/fapi/v3/marginType")[0])
            .0
            .starts_with("symbol=BTCUSDT&marginType=ISOLATED&nonce=")
    );
    let cancel = requests
        .iter()
        .find(|r| r.method.as_str() == "DELETE" && r.url.path() == "/fapi/v3/order")
        .expect("cancel sent");
    assert!(signed_parts(cancel).0.starts_with("symbol=BTCUSDT&orderId=77&nonce="));
}

#[tokio::test]
async fn failures_tell_the_trader_what_to_do() {
    let cases = [
        (
            400,
            json!({"code": -5050, "msg": "This function can only be used after deposit"}),
            "after this wallet's first deposit. Make a deposit, then try again.",
        ),
        (
            400,
            json!({"code": -1022, "msg": "Signature for this request is not valid."}),
            "reconnect the wallet",
        ),
        (400, json!({"code": -4225, "msg": "Nonce Expired"}), "Check this computer's clock"),
        (
            400,
            json!({"code": -2019, "msg": "Margin is insufficient."}),
            "Exchange: Margin is insufficient (code -2019)",
        ),
        (429, json!({"code": -1003, "msg": "Too many requests."}), "rate limiting"),
        (403, Value::String("<html>403 Forbidden</html>".into()), "Your network or region may be blocked"),
    ];
    for (status, body, expected) in cases {
        let server = MockServer::start().await;
        fail(&server, "POST", "/fapi/v3/order", status, body.clone()).await;
        fail(&server, "GET", "/fapi/v3/balance", status, body).await;
        let venue = client(Network::Testnet, &server).await;
        venue.set_wallet(Some(wallet()));
        let order = OrderRequest {
            symbol: "BTCUSDT".into(),
            side: Side::Buy,
            kind: OrderKind::Market,
            qty: dec("1"),
            reduce_only: false,
            client_id: "x".into(),
        };
        // A refusal is definite: nothing was placed, and the trader is told why.
        let error = rejected(venue.place_order(&order).await);
        assert!(error.contains(expected), "{status}: {error}");
        assert!(!error.contains(&AGENT_KEY[2..]));
        if status == 400 && expected.contains("deposit") {
            assert!(venue.needs_deposit().await.expect("deposit check"));
        }
    }

    // A funded wallet passes the deposit check.
    let server = MockServer::start().await;
    serve(&server, "GET", "/fapi/v3/balance", json!([{"asset": "USDT", "balance": "10"}])).await;
    let venue = client(Network::Mainnet, &server).await;
    venue.set_wallet(Some(wallet()));
    assert!(!venue.needs_deposit().await.expect("deposit check"));

    // No answer to an order is not the same as no order.
    let dead =
        ExchangeClient::new(Network::Mainnet, http_client().expect("client")).with_base("http://127.0.0.1:9");
    dead.set_wallet(Some(wallet()));
    let order = OrderRequest {
        symbol: "BTCUSDT".into(),
        side: Side::Buy,
        kind: OrderKind::Market,
        qty: dec("1"),
        reduce_only: false,
        client_id: "lost-1".into(),
    };
    assert!(unknown(dead.place_order(&order).await).contains("Could not reach the exchange"));
    assert!(
        dead.ticker("BTCUSDT")
            .await
            .expect_err("unreachable")
            .to_string()
            .contains("Could not reach the exchange")
    );
    assert!(
        dead.find_order("BTCUSDT", "lost-1").await.is_err(),
        "and asking about it fails loudly, it does not say 'no order'"
    );
}

#[tokio::test]
async fn an_answer_that_settles_nothing_is_not_read_as_a_refusal() {
    let order = OrderRequest {
        symbol: "BTCUSDT".into(),
        side: Side::Buy,
        kind: OrderKind::Market,
        qty: dec("1"),
        reduce_only: false,
        client_id: "maybe-1".into(),
    };
    // The exchange's documentation: a 5xx leaves the execution status unknown, and so do codes -1006 and -1007.
    let unclear = [
        ResponseTemplate::new(503).set_body_string("<html>Service Unavailable</html>"),
        ResponseTemplate::new(504),
        ResponseTemplate::new(500).set_body_json(json!({"code": -1001, "msg": "Internal error."})),
        ResponseTemplate::new(400).set_body_json(
            json!({"code": -1007, "msg": "Timeout waiting for response from backend server."}),
        ),
        ResponseTemplate::new(400)
            .set_body_json(json!({"code": -1006, "msg": "An unexpected response was received."})),
        ResponseTemplate::new(200).set_body_string("<html>ok</html>"),
        ResponseTemplate::new(200).set_body_json(json!({"status": "FILLED"})),
    ];
    for response in unclear {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/fapi/v3/order")).respond_with(response).mount(&server).await;
        let venue = client(Network::Testnet, &server).await;
        venue.set_wallet(Some(wallet()));
        let reason = unknown(venue.place_order(&order).await);
        assert!(reason.ends_with('.') && !reason.contains(&AGENT_KEY[2..]), "{reason}");
        assert_eq!(
            server
                .received_requests()
                .await
                .expect("recorded")
                .iter()
                .filter(|r| r.url.path() == "/fapi/v3/order")
                .count(),
            1,
            "sent once, never retried"
        );
    }

    // Asking about an order by its client id: found, not there, or no answer.
    let server = MockServer::start().await;
    serve(
        &server,
        "GET",
        "/fapi/v3/order",
        json!({"orderId": 9001, "clientOrderId": "maybe-1", "status": "FILLED",
        "executedQty": "1", "avgPrice": "62000.5", "symbol": "BTCUSDT"}),
    )
    .await;
    let venue = client(Network::Testnet, &server).await;
    assert!(
        venue
            .find_order("BTCUSDT", "maybe-1")
            .await
            .expect_err("no wallet")
            .to_string()
            .contains("Connect a wallet")
    );
    venue.set_wallet(Some(wallet()));
    let found = venue.find_order("BTCUSDT", "maybe-1").await.expect("lookup").expect("found");
    assert_eq!(
        (found.order_id.as_str(), found.status.as_str(), found.executed_qty, found.avg_price),
        ("9001", "FILLED", dec("1"), dec("62000.5"))
    );
    let requests = server.received_requests().await.expect("recorded");
    let lookup = sent(&requests, "/fapi/v3/order")[0];
    assert!(signed_parts(lookup).0.starts_with("symbol=BTCUSDT&origClientOrderId=maybe-1&nonce="));
    assert_eq!(
        recover(Network::Testnet.chain_id(), &signed_parts(lookup).0, &signed_parts(lookup).1)
            .expect("recovers")
            .to_string(),
        AGENT
    );

    let server = MockServer::start().await;
    fail(&server, "GET", "/fapi/v3/order", 400, json!({"code": -2013, "msg": "Order does not exist."})).await;
    let venue = client(Network::Testnet, &server).await;
    venue.set_wallet(Some(wallet()));
    assert_eq!(venue.find_order("BTCUSDT", "maybe-1").await.expect("lookup"), None);

    let server = MockServer::start().await;
    fail(&server, "GET", "/fapi/v3/order", 503, json!({"code": -1001, "msg": "Internal error."})).await;
    let venue = client(Network::Testnet, &server).await;
    venue.set_wallet(Some(wallet()));
    assert!(venue.find_order("BTCUSDT", "maybe-1").await.is_err());
}

#[tokio::test]
async fn hedge_mode_accounts_are_turned_away_with_the_reason() {
    let server = MockServer::start().await;
    serve(
        &server,
        "GET",
        "/fapi/v3/positionRisk",
        json!([{"symbol": "BTCUSDT", "positionAmt": "1", "positionSide": "LONG"}]),
    )
    .await;
    serve(&server, "GET", "/fapi/v3/positionSide/dual", json!({"dualSidePosition": true})).await;
    let venue = client(Network::Mainnet, &server).await;
    venue.set_wallet(Some(wallet()));
    assert!(venue.hedge_mode().await.expect("mode"));
    assert!(venue.positions(None).await.expect_err("hedge").to_string().contains("one-way mode"));
}

#[tokio::test]
async fn a_wallet_approval_is_sent_as_the_exact_message_that_was_signed() {
    let server = MockServer::start().await;
    serve(&server, "POST", "/fapi/v3/registerAndApproveAgent", json!({"code": 200, "msg": "success"})).await;
    let venue = client(Network::Testnet, &server).await;
    let (user_key, agent) = (
        AgentKey::generate().expect("stand-in for the trader's wallet"),
        Address::parse(AGENT).expect("agent"),
    );
    let (user, nonce, expires) = (user_key.address(), venue.nonce().await, 1_800_000_000_000_i64);
    let message = approval_message(&user, nonce, &agent, expires);
    assert_eq!(
        message,
        format!(
            "user={user}&nonce={nonce}&agentName=OctoGens&agentAddress={AGENT}&expired=1800000000000&signatureChainId=56&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist="
        )
    );
    let signature = user_key.sign(APPROVAL_CHAIN_ID, &message);
    venue.register_agent(&user, nonce, &agent, expires, &signature).await.expect("accepted");

    let requests = server.received_requests().await.expect("recorded");
    let body =
        String::from_utf8_lossy(&sent(&requests, "/fapi/v3/registerAndApproveAgent")[0].body).to_string();
    let (signed, sent_signature) = body.split_once("&signature=").expect("signature");
    assert_eq!(signed, message);
    assert_eq!(
        recover(APPROVAL_CHAIN_ID, signed, sent_signature).expect("recovers"),
        user,
        "The exchange can verify it came from the main wallet"
    );

    let server = MockServer::start().await;
    fail(
        &server,
        "POST",
        "/fapi/v3/registerAndApproveAgent",
        400,
        json!({"code": -1000, "msg": "nonce expired"}),
    )
    .await;
    let venue = client(Network::Testnet, &server).await;
    let error = venue
        .register_agent(&user, nonce, &agent, expires, &signature)
        .await
        .expect_err("rejected")
        .to_string();
    assert_eq!(error, "The exchange did not accept the wallet's approval: nonce expired");
}

#[tokio::test]
async fn nonces_follow_the_exchanges_clock_when_this_computers_is_off() {
    let server = MockServer::start().await;
    let ahead = Utc::now().timestamp_millis() + 300_000;
    serve(&server, "GET", "/fapi/v3/time", json!({"serverTime": ahead})).await;
    let venue =
        ExchangeClient::new(Network::Mainnet, http_client().expect("client")).with_base(&server.uri());
    let nonce = venue.nonce().await;
    assert!((nonce as i64 - ahead * 1000).abs() < 5_000_000, "the nonce is in server time: {nonce}");
    venue.nonce().await;
    assert_eq!(
        server.received_requests().await.expect("recorded").len(),
        1,
        "the clock is measured once, not per request"
    );
}

#[test]
fn shares_funds_and_commodities_are_known_by_what_the_news_calls_them() {
    let tracked = |name: &str, base: &str, status: &str, kinds: Value, tags: Value| {
        let mut row = symbol(name, base, "USDT", status);
        row["underlyingSubType"] = kinds;
        row["tags"] = tags;
        row
    };
    let rows = vec![
        symbol("BTCUSDT", "BTC", "USDT", "TRADING"),
        tracked(
            "NVDAUSDT",
            "NVDA",
            "TRADING",
            json!(["STOCK", "Semiconductor"]),
            json!(["NVIDIA", "Stock", "股票"]),
        ),
        tracked("NVDAUSD1", "NVDA", "TRADING", json!(["STOCK"]), json!(["NVIDIA", "Stock"])),
        tracked("MSTRUSDT", "MSTR", "TRADING", json!(["STOCK"]), json!(["Strategy"])),
        tracked("STRCUSDT", "STRC", "TRADING", json!(["STOCK"]), json!(["Strategy"])),
        tracked("QQQUSDT", "QQQ", "TRADING", json!(["ETF"]), json!(["Nasdaq", "ETF", "QQQ"])),
        tracked("XAUUSD1", "XAU", "TRADING", json!(["Commodities"]), json!(["金"])),
        tracked("PAXGUSDT", "PAXG", "TRADING", json!(["Commodities"]), json!([])),
        tracked("ANTUSD1", "ANT", "TRADING", json!(["STOCK", "pre-launch"]), json!(["Anthropic"])),
        tracked("GONEUSDT", "GONE", "BREAK", json!(["STOCK"]), json!(["Goneco"])),
    ];
    let markets = Markets::new(rows.iter().filter_map(market_from).collect()).with_news(news_symbols(&rows));

    // A share is found by its base asset, by either of its markets, and by the company's name.
    for asked in ["NVDA", "nvda", "$NVDA", " NVDAUSDT ", "nvdausd1", "Nvidia"] {
        assert_eq!(markets.news_symbol(asked), Some("NVDA"), "{asked}");
    }
    assert_eq!((markets.news_symbol("QQQ"), markets.news_symbol("nasdaq")), (Some("QQQ"), Some("QQQ")));
    assert_eq!(markets.news_symbol("MSTR"), Some("MSTR"));
    // The news writes the company's name where the exchange writes a ticker.
    assert_eq!(markets.news_names("NVDA"), ["nvidia"]);
    assert_eq!(markets.news_names("QQQ"), ["nasdaq"]);
    assert_eq!((markets.news_names("MSTR"), markets.news_names("BTC")), (Vec::<String>::new(), Vec::new()));
    // A commodity is filed under its future.
    assert_eq!((markets.news_symbol("XAU"), markets.news_symbol("XAUUSD1")), (Some("GC=F"), Some("GC=F")));
    for asked in [
        "BTC", // a coin: its news is not filed by ticker
        "BTCUSDT",
        "PAXG", // a token about gold, not gold
        "ANT",  // not listed anywhere yet: these letters belong to someone else
        "Anthropic",
        "Strategy", // two markets share the name
        "GONE",     // not trading
        "Stock",
        "nothing",
        "",
    ] {
        assert_eq!(markets.news_symbol(asked), None, "{asked}");
    }
    assert_eq!(Markets::new(Vec::new()).news_symbol("NVDA"), None);
}
