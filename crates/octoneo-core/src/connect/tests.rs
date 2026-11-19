use std::sync::Arc;

use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::exchange::signing::AgentKey;
use crate::model::Network;
use crate::net::http_client;

/// A mock exchange that accepts approvals, and a client pointed at it.
async fn stand_in(accept: bool) -> (MockServer, Arc<ExchangeClient>) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/fapi/v3/time"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"serverTime": Utc::now().timestamp_millis()})),
        )
        .mount(&server)
        .await;
    let response = if accept {
        ResponseTemplate::new(200).set_body_json(json!({"code": 200, "msg": "success"}))
    } else {
        ResponseTemplate::new(400).set_body_json(json!({"code": -1000, "msg": "nonce expired"}))
    };
    Mock::given(method("POST"))
        .and(path("/fapi/v3/registerAndApproveAgent"))
        .respond_with(response)
        .mount(&server)
        .await;
    let client = Arc::new(
        ExchangeClient::new(Network::Testnet, http_client().expect("client")).with_base(&server.uri()),
    );
    (server, client)
}

async fn post(url: &str, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new().post(url).json(&body).send().await.expect("request");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_wallet_approves_the_trading_key_with_one_signature() {
    let (mock, client) = stand_in(true).await;
    let (wallet, agent) = (
        AgentKey::generate().expect("the trader's wallet"),
        AgentKey::generate().expect("trading key").address(),
    );
    let pending = start(client, agent, 30).await.expect("page");
    assert!(pending.url.starts_with("http://127.0.0.1:"), "{}", pending.url);

    // The page the browser loads: self-contained, scripted only by its own nonce, and plain about what is approved.
    let page = reqwest::get(&pending.url).await.expect("page");
    assert_eq!(page.status(), 200);
    let html = page.text().await.expect("html");
    assert!(
        html.contains(&agent.to_string())
            && html.contains("\"days\":30")
            && html.contains("\"network\":\"Testnet\"")
    );
    assert!(html.contains("Can withdraw</dt><dd>No</dd>") && html.contains("eth_signTypedData_v4"));
    assert!(
        html.contains("default-src 'none'") && !html.contains("__NONCE__") && !html.contains("__CONFIG__")
    );
    assert!(
        !html.contains("http://") || html.matches("http://").count() == 0,
        "the page loads nothing from elsewhere"
    );

    // What the page does after the wallet connects: ask for the message, have the wallet sign it, hand it back.
    let (status, prepared) = post(
        &format!("{}/prepare", pending.url),
        json!({"account": wallet.address().to_string().to_lowercase()}),
    )
    .await;
    assert_eq!(status, 200, "{prepared}");
    let typed = &prepared["typedData"];
    assert_eq!((&typed["domain"]["chainId"], &typed["primaryType"]), (&json!(56), &json!("Message")));
    let message = typed["message"]["msg"].as_str().expect("message");
    assert!(message.starts_with(&format!("user={}&nonce=", wallet.address())), "{message}");
    assert!(
        message.contains(&format!("&agentAddress={agent}&"))
            && message.ends_with("&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=")
    );
    let signature = wallet.sign(56, message);
    let (status, submitted) = post(&format!("{}/submit", pending.url), json!({"signature": signature})).await;
    assert_eq!((status, &submitted["ok"]), (200, &json!(true)), "{submitted}");

    let approval = pending.outcome.await.expect("outcome").expect("approved");
    assert_eq!(approval.user, wallet.address());
    let days = (approval.expires - Utc::now()).num_hours();
    assert!((30 * 24 - 1..=30 * 24).contains(&days), "expires in about 30 days, got {days} hours");

    // The exchange received exactly the message the wallet signed.
    let requests = mock.received_requests().await.expect("recorded");
    let sent = requests.iter().find(|r| r.url.path() == "/fapi/v3/registerAndApproveAgent").expect("sent");
    assert_eq!(String::from_utf8_lossy(&sent.body), format!("{message}&signature={signature}"));
    // The page is gone once it has done its job.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(reqwest::get(&pending.url).await.is_err());
}

#[tokio::test]
async fn a_signature_from_another_account_or_a_refusal_from_the_exchange_changes_nothing() {
    let (mock, client) = stand_in(false).await;
    let (wallet, other, agent) = (
        AgentKey::generate().expect("wallet"),
        AgentKey::generate().expect("other"),
        AgentKey::generate().expect("agent").address(),
    );
    let pending = start(client, agent, 7).await.expect("page");
    let prepare = format!("{}/prepare", pending.url);
    let submit = format!("{}/submit", pending.url);

    assert_eq!(
        post(&submit, json!({"signature": "0x00"})).await.1["error"],
        "Start again: the approval was not prepared."
    );
    assert!(
        post(&prepare, json!({"account": "not an address"})).await.1["error"]
            .as_str()
            .is_some_and(|e| e.contains("wallet address"))
    );
    assert!(
        post(&prepare, json!({"account": agent.to_string()})).await.1["error"]
            .as_str()
            .is_some_and(|e| e.contains("not the trading key"))
    );

    // Signed by a different key than the account that connected.
    let prepared = post(&prepare, json!({"account": wallet.address().to_string()})).await.1;
    let message = prepared["typedData"]["message"]["msg"].as_str().expect("message").to_string();
    let (status, wrong) = post(&submit, json!({"signature": other.sign(56, &message)})).await;
    assert_eq!(status, 400);
    assert!(wrong["error"].as_str().is_some_and(|e| e.contains("different account")), "{wrong}");
    assert!(
        mock.received_requests()
            .await
            .expect("recorded")
            .iter()
            .all(|r| r.url.path() != "/fapi/v3/registerAndApproveAgent"),
        "nothing reached the exchange"
    );

    // A correct signature that exchange turns down: the reason is shown and the trader can try again.
    let prepared = post(&prepare, json!({"account": wallet.address().to_string()})).await.1;
    let message = prepared["typedData"]["message"]["msg"].as_str().expect("message").to_string();
    let refused = post(&submit, json!({"signature": wallet.sign(56, &message)})).await.1;
    assert_eq!(refused["error"], "The exchange did not accept the wallet's approval: nonce expired");
    assert_eq!(reqwest::get(&pending.url).await.expect("still serving").status(), 200);

    pending.cancel.cancel();
    assert_eq!(
        pending.outcome.await.expect("outcome").expect_err("cancelled").to_string(),
        "The wallet approval was cancelled."
    );
}

#[tokio::test]
async fn an_idle_connection_does_not_hold_up_the_approval() {
    let (_mock, client) = stand_in(true).await;
    let (wallet, agent) =
        (AgentKey::generate().expect("wallet"), AgentKey::generate().expect("agent").address());
    let pending = start(client, agent, 30).await.expect("page");
    // Browsers open spare connections and leave them silent. The exchange accepts the approval for only a few
    // seconds, so the request that carries the signature must not queue behind them.
    let address = pending.url.trim_start_matches("http://").split('/').next().expect("address").to_string();
    let mut idle = Vec::new();
    for _ in 0..4 {
        idle.push(tokio::net::TcpStream::connect(&address).await.expect("idle connection"));
    }

    let started = std::time::Instant::now();
    let prepared =
        post(&format!("{}/prepare", pending.url), json!({"account": wallet.address().to_string()})).await.1;
    let message = prepared["typedData"]["message"]["msg"].as_str().expect("message").to_string();
    let (status, _) =
        post(&format!("{}/submit", pending.url), json!({"signature": wallet.sign(56, &message)})).await;
    assert_eq!(status, 200);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "served without waiting for the idle connections: {:?}",
        started.elapsed()
    );
    assert_eq!(pending.outcome.await.expect("outcome").expect("approved").user, wallet.address());
    drop(idle);
}

#[tokio::test]
async fn the_page_answers_only_its_own_secret_path_on_this_computer() {
    let (_mock, client) = stand_in(true).await;
    let pending = start(client, AgentKey::generate().expect("agent").address(), 30).await.expect("page");
    let origin = pending.url.rsplit_once('/').expect("path").0.to_string();
    let http = reqwest::Client::new();

    for wrong in [
        format!("{origin}/"),
        format!("{origin}/guess"),
        format!("{}x", pending.url),
        format!("{}/other", pending.url),
    ] {
        assert_eq!(http.get(&wrong).send().await.expect("request").status(), 404, "{wrong}");
    }
    // A request that arrives under another site's name is refused even with the right path.
    let spoofed = http.get(&pending.url).header("Host", "evil.example").send().await.expect("request");
    assert_eq!(spoofed.status(), 404);
    assert_eq!(http.get(&pending.url).send().await.expect("request").status(), 200);

    assert!(
        start(
            Arc::new(ExchangeClient::new(Network::Testnet, http_client().expect("client"))),
            AgentKey::generate().expect("agent").address(),
            0
        )
        .await
        .is_err()
    );
    pending.cancel.cancel();
}
