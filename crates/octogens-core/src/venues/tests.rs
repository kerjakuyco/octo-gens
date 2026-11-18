use std::str::FromStr;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use wiremock::matchers::{any, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::*;
use crate::instruments::resolve;
use crate::model::{Side, Ticket};
use crate::net::http_client;

const KEY: &str = "test-key";
const SECRET: &str = "test-secret";
const PASSPHRASE: &str = "test-passphrase";
const DAY: i64 = 86_400_000;

fn dec(text: &str) -> Decimal {
    Decimal::from_str(text).expect("test decimal")
}

async fn client(venue: VenueId, server: &MockServer) -> VenueClient {
    VenueClient::new(venue, http_client().expect("client")).with_base(&server.uri())
}

async fn serve(server: &MockServer, verb: &str, route: &str, body: Value) {
    Mock::given(method(verb))
        .and(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

fn header<'a>(request: &'a Request, name: &str) -> &'a str {
    request.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default()
}

/// A listing response that marks BTC/USDT as an active spot pair.
fn btc_listing(venue: VenueId) -> (&'static str, Value) {
    match venue {
        VenueId::Binance => (
            "/api/v3/exchangeInfo",
            json!({"symbols": [{"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "status": "TRADING", "isSpotTradingAllowed": true}]}),
        ),
        VenueId::Bybit => (
            "/v5/market/instruments-info",
            json!({"retCode": 0, "result": {"category": "spot", "list": [{"symbol": "BTCUSDT", "baseCoin": "BTC", "quoteCoin": "USDT", "status": "Trading"}]}}),
        ),
        VenueId::Okx => (
            "/api/v5/public/instruments",
            json!({"code": "0", "data": [{"instId": "BTC-USDT", "baseCcy": "BTC", "quoteCcy": "USDT", "state": "live", "instType": "SPOT"}]}),
        ),
    }
}

#[tokio::test]
async fn an_unlisted_xstock_is_reported_and_never_priced_from_another_market() {
    let server = MockServer::start().await;
    // The symbol exists but is not flagged as an xStock, so it is not the token we asked for.
    serve(
        &server,
        "GET",
        "/v5/market/instruments-info",
        json!({"retCode": 0, "result": {"category": "spot", "list": [
            {"symbol": "TSLAXUSDT", "baseCoin": "TSLAX", "quoteCoin": "USDT", "status": "Trading", "symbolType": "not-an-xstock"}]}}),
    )
    .await;
    let bybit = client(VenueId::Bybit, &server).await;
    let error = bybit.quote(&resolve("TSLAx").expect("xstock")).await.expect_err("unlisted");
    assert_eq!(error.to_string(), "No active spot listing for TSLAX/USDT on Bybit.");
    let requests = server.received_requests().await.expect("recorded");
    assert!(
        requests.iter().all(|r| r.url.path() == "/v5/market/instruments-info"),
        "nothing but the listing was asked"
    );
    assert_eq!(requests[0].url.query(), Some("category=spot&symbol=TSLAXUSDT"));

    // The answer is remembered, so a watchlist refresh does not ask again every few seconds.
    assert!(bybit.ticker(&resolve("TSLAx").expect("xstock")).await.is_err());
    assert_eq!(server.received_requests().await.expect("recorded").len(), requests.len());
}

#[tokio::test]
async fn an_unknown_symbol_error_means_not_listed_while_other_errors_surface() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/exchangeInfo"))
        .respond_with(
            ResponseTemplate::new(400).set_body_json(json!({"code": -1121, "msg": "Invalid symbol."})),
        )
        .mount(&server)
        .await;
    let binance = client(VenueId::Binance, &server).await;
    assert!(!binance.listed(&resolve("NOPE").expect("custom")).await.expect("handled"));

    let server = MockServer::start().await;
    serve(&server, "GET", "/v5/market/instruments-info", json!({"retCode": 10016, "retMsg": "Server error"}))
        .await;
    let bybit = client(VenueId::Bybit, &server).await;
    assert_eq!(
        bybit.listed(&resolve("BTC").expect("btc")).await.expect_err("error").to_string(),
        "Bybit 10016: Server error"
    );
}

#[tokio::test]
async fn quotes_keep_only_completed_daily_closes_and_read_24h_statistics() {
    let now = chrono::Utc::now().timestamp_millis();
    let today = now / DAY * DAY;
    // Venues disagree on row order and on strings versus numbers; all must normalise the same way.
    let fixtures: [(VenueId, &str, Value, &str, Value); 3] = [
        (
            VenueId::Binance,
            "/api/v3/ticker/24hr",
            json!({"symbol": "BTCUSDT", "lastPrice": "205.002", "bidPrice": "205.00", "askPrice": "205.01", "highPrice": "210", "lowPrice": "199",
                   "volume": "1200.5", "quoteVolume": "246000.1", "priceChangePercent": "2.501", "closeTime": now}),
            "/api/v3/klines",
            json!([
                [today - 2 * DAY, "198", "202", "197", "200", "10"],
                [today - DAY, "200", "203", "199", "201", "11"],
                [today, "201", "206", "200", "204", "3"]
            ]),
        ),
        (
            VenueId::Bybit,
            "/v5/market/tickers",
            json!({"retCode": 0, "time": now, "result": {"category": "spot", "list": [{"symbol": "BTCUSDT", "lastPrice": "205.002", "bid1Price": "205.00",
                   "ask1Price": "205.01", "highPrice24h": "210", "lowPrice24h": "199", "volume24h": "1200.5", "turnover24h": "246000.1", "price24hPcnt": "0.02501"}]}}),
            "/v5/market/kline",
            json!({"retCode": 0, "result": {"list": [[(today).to_string(), "201", "206", "200", "204", "3", "600"],
                   [(today - DAY).to_string(), "200", "203", "199", "201", "11", "2200"], [(today - 2 * DAY).to_string(), "198", "202", "197", "200", "10", "2000"]]}}),
        ),
        (
            VenueId::Okx,
            "/api/v5/market/ticker",
            json!({"code": "0", "data": [{"instId": "BTC-USDT", "instType": "SPOT", "last": "205.002", "bidPx": "205.00", "askPx": "205.01",
                   "open24h": "200", "high24h": "210", "low24h": "199", "vol24h": "1200.5", "volCcy24h": "246000.1", "ts": now.to_string()}]}),
            "/api/v5/market/candles",
            json!({"code": "0", "data": [[(today).to_string(), "201", "206", "200", "204", "3", "600", "600", "0"],
                   [(today - DAY).to_string(), "200", "203", "199", "201", "11", "2200", "2200", "1"], [(today - 2 * DAY).to_string(), "198", "202", "197", "200", "10", "2000", "2000", "1"]]}),
        ),
    ];
    for (venue, ticker_route, ticker, candle_route, candles) in fixtures {
        let server = MockServer::start().await;
        let (listing_route, listing) = btc_listing(venue);
        serve(&server, "GET", listing_route, listing).await;
        serve(&server, "GET", ticker_route, ticker).await;
        serve(&server, "GET", candle_route, candles).await;
        let venue_client = client(venue, &server).await;
        let btc = resolve("BTC").expect("btc");

        let quote = venue_client.quote(&btc).await.unwrap_or_else(|e| panic!("{venue:?}: {e}"));
        assert_eq!(
            (quote.pair.as_str(), quote.price, quote.sample),
            ("BTC/USDT", dec("205.002"), false),
            "{venue:?}"
        );
        assert_eq!(quote.closes, [dec("200"), dec("201")], "{venue:?} drops the candle still forming");
        assert_eq!(quote.source, format!("{} spot", venue.name()));
        assert_eq!((quote.stats.high, quote.stats.low), (Some(dec("210")), Some(dec("199"))), "{venue:?}");
        assert_eq!((quote.stats.bid, quote.stats.ask), (Some(dec("205")), Some(dec("205.01"))), "{venue:?}");
        assert_eq!(
            (quote.stats.volume, quote.stats.quote_volume),
            (Some(dec("1200.5")), Some(dec("246000.1"))),
            "{venue:?}"
        );
        let change = quote.stats.change_pct.expect("change");
        assert!((change - 2.501).abs() < 1e-6, "{venue:?} change {change}");

        // The listing is trusted for market data after the first check.
        venue_client.ticker(&btc).await.expect("second read");
        let listing_calls = server
            .received_requests()
            .await
            .expect("recorded")
            .iter()
            .filter(|r| r.url.path() == listing_route)
            .count();
        assert_eq!(listing_calls, 1, "{venue:?} re-checked the listing");

        let rows = venue_client.candles(&btc, Timeframe::D1, 3).await.expect("candles");
        assert_eq!(
            rows.iter().map(|c| c.t).collect::<Vec<_>>(),
            [today - 2 * DAY, today - DAY, today],
            "{venue:?} oldest first"
        );
        assert_eq!(
            (rows[2].o, rows[2].h, rows[2].l, rows[2].c, rows[2].v),
            (dec("201"), dec("206"), dec("200"), dec("204"), dec("3"))
        );
    }
}

#[tokio::test]
async fn order_books_parse_best_first_levels() {
    let fixtures = [
        (
            VenueId::Binance,
            "/api/v3/depth",
            json!({"lastUpdateId": 1, "bids": [["99.5", "2"], ["99", "5"]], "asks": [["100.5", "1.5"], ["101", "4"]]}),
        ),
        (
            VenueId::Bybit,
            "/v5/market/orderbook",
            json!({"retCode": 0, "result": {"s": "BTCUSDT", "ts": 1_770_000_000_000_i64, "b": [["99.5", "2"], ["99", "5"]], "a": [["100.5", "1.5"], ["101", "4"]]}}),
        ),
        (
            VenueId::Okx,
            "/api/v5/market/books",
            json!({"code": "0", "data": [{"ts": "1770000000000", "bids": [["99.5", "2", "0", "3"], ["99", "5", "0", "1"]], "asks": [["100.5", "1.5", "0", "2"], ["101", "4", "0", "1"]]}]}),
        ),
    ];
    for (venue, route, body) in fixtures {
        let server = MockServer::start().await;
        let (listing_route, listing) = btc_listing(venue);
        serve(&server, "GET", listing_route, listing).await;
        serve(&server, "GET", route, body).await;
        let book =
            client(venue, &server).await.depth(&resolve("BTC").expect("btc"), 50).await.expect("depth");
        assert_eq!(book.bids, [(dec("99.5"), dec("2")), (dec("99"), dec("5"))], "{venue:?}");
        assert_eq!(book.asks, [(dec("100.5"), dec("1.5")), (dec("101"), dec("4"))], "{venue:?}");
        if venue != VenueId::Binance {
            assert_eq!(book.as_of.timestamp_millis(), 1_770_000_000_000, "{venue:?}");
        }
    }
}

#[tokio::test]
async fn live_orders_use_base_units_the_spot_market_and_a_valid_signature() {
    for venue in VenueId::ALL {
        let server = MockServer::start().await;
        let (listing_route, listing) = btc_listing(venue);
        serve(&server, "GET", listing_route, listing).await;
        let (order_route, ack) = match venue {
            VenueId::Binance => ("/api/v3/order", json!({"orderId": 9001, "status": "NEW"})),
            VenueId::Bybit => ("/v5/order/create", json!({"retCode": 0, "result": {"orderId": "id1"}})),
            VenueId::Okx => {
                ("/api/v5/trade/order", json!({"code": "0", "data": [{"sCode": "0", "ordId": "id2"}]}))
            }
        };
        serve(&server, "POST", order_route, ack).await;
        let venue_client = client(venue, &server).await;
        let ticket = Ticket::with_id("BTC/USDT", Side::Buy, dec(".125"), "a".repeat(32)).expect("ticket");

        let unauthenticated = venue_client.market_order(&ticket).await.expect_err("no keys");
        assert!(unauthenticated.to_string().contains("API keys"), "{unauthenticated}");

        venue_client
            .set_credentials(Some(Credentials::new(venue, KEY, SECRET, PASSPHRASE).expect("credentials")));
        let ack = venue_client.market_order(&ticket).await.unwrap_or_else(|e| panic!("{venue:?}: {e}"));
        assert_eq!(
            (ack.qty, ack.client_id.as_str(), ack.side),
            (dec("0.125"), ticket.client_id.as_str(), Side::Buy)
        );

        let requests = server.received_requests().await.expect("recorded");
        let order = requests.iter().find(|r| r.url.path() == order_route).expect("order sent");
        let body = String::from_utf8_lossy(&order.body).to_string();
        let everything = format!("{} {:?} {body}", order.url, order.headers);
        assert!(!everything.contains(SECRET), "{venue:?} leaked the secret");

        match venue {
            VenueId::Binance => {
                assert_eq!(ack.status, "NEW");
                let query = order.url.query().expect("query");
                let (payload, signature) = query.split_once("&signature=").expect("signed");
                assert!(
                    payload
                        .starts_with("symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.125&newClientOrderId="),
                    "{payload}"
                );
                assert_eq!(signature, hex::encode(hmac_sha256(SECRET, payload)));
                assert_eq!(header(order, "X-MBX-APIKEY"), KEY);
                assert!(body.is_empty());
            }
            VenueId::Bybit => {
                let data: Value = serde_json::from_str(&body).expect("json");
                assert_eq!(
                    (&data["category"], &data["marketUnit"], &data["qty"], &data["isLeverage"]),
                    (&json!("spot"), &json!("baseCoin"), &json!("0.125"), &json!(0))
                );
                assert_eq!(
                    (&data["side"], &data["orderType"], &data["orderLinkId"]),
                    (&json!("Buy"), &json!("Market"), &json!("a".repeat(32)))
                );
                let payload = format!("{}{KEY}5000{body}", header(order, "X-BAPI-TIMESTAMP"));
                assert_eq!(header(order, "X-BAPI-SIGN"), hex::encode(hmac_sha256(SECRET, &payload)));
            }
            VenueId::Okx => {
                let data: Value = serde_json::from_str(&body).expect("json");
                assert_eq!(
                    (&data["tdMode"], &data["tgtCcy"], &data["sz"], &data["ordType"]),
                    (&json!("cash"), &json!("base_ccy"), &json!("0.125"), &json!("market"))
                );
                let stamp = header(order, "OK-ACCESS-TIMESTAMP");
                assert!(stamp.ends_with('Z') && stamp.len() == 24, "{stamp}");
                let payload = format!("{stamp}POST/api/v5/trade/order{body}");
                assert_eq!(header(order, "OK-ACCESS-SIGN"), STANDARD.encode(hmac_sha256(SECRET, &payload)));
                assert_eq!(header(order, "OK-ACCESS-PASSPHRASE"), PASSPHRASE);
            }
        }
        // An order never trusts the cached listing.
        assert_eq!(requests.iter().filter(|r| r.url.path() == listing_route).count(), 1);
        venue_client.market_order(&ticket).await.expect("second order");
        assert_eq!(
            server
                .received_requests()
                .await
                .expect("recorded")
                .iter()
                .filter(|r| r.url.path() == listing_route)
                .count(),
            2
        );
    }
}

#[tokio::test]
async fn rejected_orders_and_bad_ids_surface_the_venue_reason() {
    let server = MockServer::start().await;
    let (listing_route, listing) = btc_listing(VenueId::Okx);
    serve(&server, "GET", listing_route, listing).await;
    serve(&server, "POST", "/api/v5/trade/order", json!({"code": "1", "msg": "Operation failed.", "data": [{"sCode": "51008", "sMsg": "Insufficient balance", "ordId": ""}]})).await;
    let okx = client(VenueId::Okx, &server).await;
    okx.set_credentials(Some(Credentials::new(VenueId::Okx, KEY, SECRET, PASSPHRASE).expect("credentials")));
    let ticket = Ticket::with_id("BTC/USDT", Side::Sell, dec("1"), "b".repeat(32)).expect("ticket");
    assert_eq!(
        okx.market_order(&ticket).await.expect_err("rejected").to_string(),
        "OKX 1: Insufficient balance"
    );

    let odd =
        Ticket::with_id("BTC/USDT", Side::Sell, dec("1"), "not-a-client-id".to_string()).expect("ticket");
    assert_eq!(okx.market_order(&odd).await.expect_err("bad id").to_string(), "Invalid client order ID.");
}

#[tokio::test]
async fn balances_are_signed_reads_that_drop_empty_assets() {
    let server = MockServer::start().await;
    serve(&server, "GET", "/api/v3/account", json!({"balances": [{"asset": "USDT", "free": "120.5", "locked": "4.5"}, {"asset": "BTC", "free": "0.01", "locked": "0"}, {"asset": "DUST", "free": "0", "locked": "0"}]})).await;
    let binance = client(VenueId::Binance, &server).await;
    assert!(binance.balances().await.is_err());
    binance.set_credentials(Some(Credentials::new(VenueId::Binance, KEY, SECRET, "").expect("credentials")));
    assert!(binance.has_credentials());
    let balances = binance.balances().await.expect("balances");
    assert_eq!(
        balances.iter().map(|b| (b.asset.as_str(), b.total)).collect::<Vec<_>>(),
        [("BTC", dec("0.01")), ("USDT", dec("125"))]
    );
    let request = &server.received_requests().await.expect("recorded")[0];
    let (payload, signature) = request.url.query().expect("query").split_once("&signature=").expect("signed");
    assert!(payload.starts_with("omitZeroBalances=true&timestamp=") && payload.ends_with("&recvWindow=5000"));
    assert_eq!(signature, hex::encode(hmac_sha256(SECRET, payload)));

    let server = MockServer::start().await;
    serve(
        &server,
        "GET",
        "/v5/account/wallet-balance",
        json!({"retCode": 0, "result": {"list": [{"coin": [{"coin": "USDT", "walletBalance": "50"}]}]}}),
    )
    .await;
    let bybit = client(VenueId::Bybit, &server).await;
    bybit.set_credentials(Some(Credentials::new(VenueId::Bybit, KEY, SECRET, "").expect("credentials")));
    assert_eq!(bybit.balances().await.expect("balances")[0].total, dec("50"));
    let request = &server.received_requests().await.expect("recorded")[0];
    let payload = format!("{}{KEY}5000accountType=UNIFIED", header(request, "X-BAPI-TIMESTAMP"));
    assert_eq!(header(request, "X-BAPI-SIGN"), hex::encode(hmac_sha256(SECRET, &payload)));

    let server = MockServer::start().await;
    serve(
        &server,
        "GET",
        "/api/v5/account/balance",
        json!({"code": "0", "data": [{"details": [{"ccy": "ETH", "cashBal": "1.25"}]}]}),
    )
    .await;
    let okx = client(VenueId::Okx, &server).await;
    okx.set_credentials(Some(Credentials::new(VenueId::Okx, KEY, SECRET, PASSPHRASE).expect("credentials")));
    assert_eq!(okx.balances().await.expect("balances")[0].asset, "ETH");
    let request = &server.received_requests().await.expect("recorded")[0];
    let payload = format!("{}GET/api/v5/account/balance", header(request, "OK-ACCESS-TIMESTAMP"));
    assert_eq!(header(request, "OK-ACCESS-SIGN"), STANDARD.encode(hmac_sha256(SECRET, &payload)));
}

#[test]
fn credentials_must_be_complete_and_never_print() {
    assert!(Credentials::new(VenueId::Binance, "key", "", "").is_err());
    assert!(
        Credentials::new(VenueId::Okx, "key", "secret", "")
            .expect_err("passphrase")
            .to_string()
            .contains("passphrase")
    );
    let credentials = Credentials::new(VenueId::Okx, " key ", " secret ", " phrase ").expect("credentials");
    assert_eq!((credentials.key.as_str(), credentials.secret.as_str()), ("key", "secret"));
    assert_eq!(format!("{credentials:?}"), "Credentials(redacted)");
}

#[tokio::test]
async fn an_unreachable_venue_is_named_without_leaking_the_request() {
    let venue_client =
        VenueClient::new(VenueId::Binance, http_client().expect("client")).with_base("http://127.0.0.1:9");
    let error = venue_client.ticker(&resolve("BTC").expect("btc")).await.expect_err("down").to_string();
    assert!(error.starts_with("Could not reach 127.0.0.1") || error.contains("did not answer"), "{error}");
    assert!(!error.contains("symbol="), "{error}");
}

#[tokio::test]
async fn public_reads_fall_back_to_the_mirror_but_signed_calls_never_do() {
    let blocked = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(403).set_body_string("<html>blocked</html>"))
        .mount(&blocked)
        .await;
    let mirror = MockServer::start().await;
    let (listing_route, listing) = btc_listing(VenueId::Binance);
    serve(&mirror, "GET", listing_route, listing).await;
    serve(
        &mirror,
        "GET",
        "/api/v3/ticker/24hr",
        json!({"symbol": "BTCUSDT", "lastPrice": "62452.01000000", "closeTime": 1_795_020_000_000_i64}),
    )
    .await;
    let btc = resolve("BTC").expect("btc");

    for primary in [blocked.uri(), "http://127.0.0.1:9".to_string()] {
        let binance = VenueClient::new(VenueId::Binance, http_client().expect("client"))
            .with_base(&primary)
            .with_mirror(&mirror.uri());
        assert_eq!(binance.ticker(&btc).await.expect("served by the mirror").price.to_string(), "62452.01");
    }

    let binance = VenueClient::new(VenueId::Binance, http_client().expect("client"))
        .with_base(&blocked.uri())
        .with_mirror(&mirror.uri());
    binance.ticker(&btc).await.expect("first read finds the mirror");
    let asked_primary = blocked.received_requests().await.expect("recorded").len();
    binance.ticker(&btc).await.expect("second read");
    assert_eq!(
        blocked.received_requests().await.expect("recorded").len(),
        asked_primary,
        "the mirror is asked first once it has answered"
    );

    binance.set_credentials(Some(Credentials::new(VenueId::Binance, KEY, SECRET, "").expect("credentials")));
    let refused = binance.balances().await.expect_err("signed calls stay on the main host").to_string();
    assert!(refused.starts_with("Binance refused the request (403)."), "{refused}");
    let ticket = Ticket::with_id("BTC/USDT", Side::Buy, dec("1"), "c".repeat(32)).expect("ticket");
    assert!(binance.market_order(&ticket).await.is_err());
    let mirrored = mirror.received_requests().await.expect("recorded");
    assert!(
        mirrored
            .iter()
            .all(|r| r.method.as_str() == "GET" && r.url.query().is_none_or(|q| !q.contains("signature")))
    );
    assert!(
        mirrored.iter().all(|r| r.headers.get("X-MBX-APIKEY").is_none()),
        "the API key never reaches the mirror"
    );
}
