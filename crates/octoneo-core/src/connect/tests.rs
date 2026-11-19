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
    let pending = start(client, Task::Connect { agent, days: 30 }).await.expect("page");
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
    assert!(
        html.contains("\"task\":\"connect\"")
            && html.contains("\"signingChain\":{")
            && html.contains("eth_signTypedData_v4")
    );
    assert!(
        html.contains("default-src 'none'") && !html.contains("__NONCE__") && !html.contains("__CONFIG__")
    );
    // Nothing is fetched from elsewhere: the policy forbids it, and nothing in the page asks for it.
    assert!(
        html.contains("connect-src 'self'")
            && html.contains("base-uri 'none'")
            && html.contains("form-action 'none'")
    );
    for loaded in ["src=\"http", "href=\"http", "url(http", "@import", "<link rel=\"stylesheet\"", "<iframe"]
    {
        assert!(!html.contains(loaded), "the page must not load {loaded}");
    }

    // What the page does after the wallet connects: ask for the message, have the wallet sign it, hand it back.
    let (status, prepared) = post(
        &format!("{}/prepare", pending.url),
        json!({"account": wallet.address().to_string().to_lowercase()}),
    )
    .await;
    assert_eq!(status, 200, "{prepared}");
    let typed = &prepared["typedData"];
    assert_eq!((&typed["domain"]["chainId"], &typed["primaryType"]), (&json!(56), &json!("Message")));
    assert_eq!(prepared["seconds"], 10, "the page is told how long the wallet's prompt may take");
    let message = typed["message"]["msg"].as_str().expect("message");
    assert!(message.starts_with(&format!("user={}&nonce=", wallet.address())), "{message}");
    assert!(
        message.contains(&format!("&agentAddress={agent}&"))
            && message.ends_with("&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=")
    );
    let signature = wallet.sign(56, message);
    let (status, submitted) = post(&format!("{}/submit", pending.url), json!({"signature": signature})).await;
    assert_eq!((status, &submitted["ok"]), (200, &json!(true)), "{submitted}");

    let Done::Approved(approval) = pending.outcome.await.expect("outcome").expect("approved") else {
        panic!("an approval page ends with an approval");
    };
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
    let pending = start(client, Task::Connect { agent, days: 7 }).await.expect("page");
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
    let pending = start(client, Task::Connect { agent, days: 30 }).await.expect("page");
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
    let approved = pending.outcome.await.expect("outcome").expect("approved");
    assert!(matches!(approved, Done::Approved(approval) if approval.user == wallet.address()));
    drop(idle);
}

#[tokio::test]
async fn the_page_answers_only_its_own_secret_path_on_this_computer() {
    let (_mock, client) = stand_in(true).await;
    let agent = AgentKey::generate().expect("agent").address();
    let pending = start(client, Task::Connect { agent, days: 30 }).await.expect("page");
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

    // A page answers the requests of its own task and no other's.
    for other in ["/deposit/options", "/deposit/prepare", "/withdraw/options", "/withdraw/submit"] {
        let (status, _) = post(&format!("{}{other}", pending.url), json!({})).await;
        assert_eq!(status, 404, "{other}");
    }

    let offline = Arc::new(ExchangeClient::new(Network::Testnet, http_client().expect("client")));
    assert!(start(offline, Task::Connect { agent, days: 0 }).await.is_err());
    pending.cancel.cancel();
}

const TEST_USDT: &str = "0x7037bf0500e9f5e277c6562ff593f0f9ab432bf7";
const TEST_VAULT: &str = "0x62904590b575ea1C3F4aC411EB6A5A3140d6956e";

fn envelope(data: Value) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .set_body_json(json!({"code": "000000", "message": null, "data": data, "success": true}))
}

/// A mock of what the exchange says about funds on testnet, a client pointed at it
/// with an API wallet connected, and the key of the trader's own wallet.
/// `vault` is the deposit contract the exchange reports; `withdrawal` its answer to a withdrawal.
async fn funding(vault: &str, withdrawal: ResponseTemplate) -> (MockServer, Arc<ExchangeClient>, AgentKey) {
    let server = MockServer::start().await;
    let routes = [
        ("GET", "/fapi/v3/time", ResponseTemplate::new(200).set_body_json(json!({"serverTime": Utc::now().timestamp_millis()}))),
        (
            "GET",
            "/bapi/futures/v1/public/future/aster/deposit/assets",
            envelope(json!([
                {"name": "USDT", "contractAddress": TEST_USDT, "decimals": 18, "network": "EVM", "chainId": 97, "depositType": "normal", "isNative": false, "isStock": false},
                {"name": "TBNB", "contractAddress": "0xfdae1ba7c826abdc4c99903c8056f82a1a04a615", "decimals": 18, "network": "EVM", "chainId": 97, "depositType": "normal", "isNative": true, "isStock": false},
                {"name": "USDT", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": false, "isStock": false},
            ])),
        ),
        ("GET", "/bapi/futures/v1/public/future/web3/ae/deposit-address", envelope(json!(vault))),
        (
            "GET",
            "/bapi/futures/v1/public/future/aster/withdraw/assets",
            envelope(json!([{"name": "USDT", "network": "EVM", "chainId": 97, "withdrawType": "autoWithdraw", "isStock": false}])),
        ),
        ("GET", "/bapi/futures/v1/public/future/aster/estimate-withdraw-fee", envelope(json!({"gasLimit": 200000, "gasCost": 0.5, "gasUsdValue": 0.1}))),
        (
            "POST",
            "/fapi/v3/aster/user-withdraw-info",
            ResponseTemplate::new(200).set_body_json(json!({
                "userDailyLimit": "10000", "userRemainingDailyLimit": "9000",
                "balances": {"USDT": {"currency": "USDT", "chainBalances": {
                    "97": {"chainId": 97, "perpMaxWithdrawAmount": "120.50", "chainLimit": "800", "withdrawFee": "0.5"},
                }}},
            })),
        ),
        ("POST", "/fapi/v3/aster/user-withdraw", withdrawal),
    ];
    for (verb, route, response) in routes {
        Mock::given(method(verb)).and(path(route)).respond_with(response).mount(&server).await;
    }
    let trader = AgentKey::generate().expect("the trader's own wallet");
    let client =
        ExchangeClient::new(Network::Testnet, http_client().expect("client")).with_base(&server.uri());
    client.set_wallet(Some(crate::exchange::Wallet {
        user: trader.address(),
        agent: AgentKey::generate().expect("the API wallet"),
        expires: None,
    }));
    (server, Arc::new(client), trader)
}

fn accepted() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"withdrawId": "9001", "hash": "0xfeed"}))
}

async fn sent_to(server: &MockServer, route: &str) -> Vec<wiremock::Request> {
    server
        .received_requests()
        .await
        .expect("recorded")
        .into_iter()
        .filter(|r| r.url.path() == route)
        .collect()
}

#[tokio::test]
async fn a_deposit_is_built_for_the_vault_and_reported_when_the_wallet_has_sent_it() {
    let (_mock, client, trader) = funding(TEST_VAULT, accepted()).await;
    let account = trader.address();
    let pending = start(client, Task::Deposit { account }).await.expect("page");
    let html = reqwest::get(&pending.url).await.expect("page").text().await.expect("html");
    assert!(html.contains("\"task\":\"deposit\"") && html.contains(&format!("\"account\":\"{account}\"")));
    assert!(html.contains("\"real\":false") && !html.contains("\"agent\""), "a deposit page knows no key");

    let options = post(&format!("{}/deposit/options", pending.url), json!({})).await.1;
    // Only what can be deposited on this network's own chains is offered.
    let chains: Vec<u64> =
        options["chains"].as_array().expect("chains").iter().filter_map(|c| c["id"].as_u64()).collect();
    assert_eq!(chains, [97]);
    assert_eq!(
        options["assets"],
        json!([
            {"chainId": 97, "name": "USDT", "token": "0x7037bf0500E9F5e277C6562ff593F0F9ab432bF7", "decimals": 18, "native": false},
            {"chainId": 97, "name": "TBNB", "token": null, "decimals": 18, "native": true},
        ])
    );

    let prepare = format!("{}/deposit/prepare", pending.url);
    let ask = |asset: &str, amount: &str| json!({"account": account.to_string().to_lowercase(), "chainId": 97, "asset": asset, "amount": amount});
    let (status, plan) = post(&prepare, ask("USDT", "25.50")).await;
    assert_eq!(status, 200, "{plan}");
    let owner = hex::encode(account.bytes());
    let vault = TEST_VAULT[2..].to_lowercase();
    let amount = format!("{:064x}", 25_500_000_000_000_000_000_u128);
    assert_eq!(
        (&plan["asset"], &plan["amount"], &plan["vault"]),
        (&json!("USDT"), &json!("25.5"), &json!(TEST_VAULT))
    );
    assert_eq!(plan["needed"], "0x161e232e52c760000");
    assert_eq!(plan["chain"]["hex"], "0x61");
    assert_eq!(plan["balance"]["data"], format!("0x70a08231{:0>64}", owner));
    assert_eq!(plan["allowance"]["data"], format!("0xdd62ed3e{:0>64}{:0>64}", owner, vault));
    // The vault is allowed exactly the amount, and the deposit names the trader's own account.
    assert_eq!(plan["approve"]["data"], format!("0x095ea7b3{:0>64}{amount}", vault));
    assert_eq!(plan["approve"]["to"], "0x7037bf0500E9F5e277C6562ff593F0F9ab432bF7");
    assert_eq!(
        plan["deposit"],
        json!({
            "to": TEST_VAULT,
            "data": format!("0xcf4a0c5e{:0>64}{:0>64}{amount}{:0>64}", &TEST_USDT[2..], owner, "1"),
            "value": "0x0",
        })
    );
    // The network's own coin needs no allowance and travels with the transaction.
    let coin = post(&prepare, ask("TBNB", "0.25")).await.1;
    assert!(coin["balance"].is_null() && coin["allowance"].is_null() && coin["approve"].is_null(), "{coin}");
    assert_eq!(coin["deposit"]["value"], "0x3782dace9d90000");

    // The wallet sends the transaction; the page says so at once, and again when the network has confirmed it.
    let plan = post(&prepare, ask("USDT", "25.50")).await.1;
    assert_eq!(plan["amount"], "25.5");
    let hash = format!("0x{}", "ab".repeat(32));
    assert_eq!(post(&format!("{}/deposit/sent", pending.url), json!({"hash": hash})).await.1["ok"], true);
    let (status, confirmed) =
        post(&format!("{}/deposit/confirmed", pending.url), json!({"hash": hash, "ok": true})).await;
    assert_eq!((status, &confirmed["ok"]), (200, &json!(true)));
    let Done::Deposited(deposit) = pending.outcome.await.expect("outcome").expect("deposited") else {
        panic!("a deposit page ends with a deposit");
    };
    assert_eq!(
        (
            deposit.chain.id,
            deposit.asset.as_str(),
            deposit.amount.as_str(),
            deposit.hash.as_str(),
            deposit.confirmed
        ),
        (97, "USDT", "25.5", hash.as_str(), Some(true))
    );
}

#[tokio::test]
async fn a_deposit_is_refused_unless_wallet_asset_amount_and_vault_all_check_out() {
    let (_mock, client, trader) = funding(TEST_VAULT, accepted()).await;
    let account = trader.address();
    let pending = start(Arc::clone(&client), Task::Deposit { account }).await.expect("page");
    let prepare = format!("{}/deposit/prepare", pending.url);
    let ask = |who: &Address, chain: u64, asset: &str, amount: &str| json!({"account": who.to_string(), "chainId": chain, "asset": asset, "amount": amount});
    let error = async |body: Value| {
        let (status, answer) = post(&prepare, body).await;
        assert_eq!(status, 400, "{answer}");
        answer["error"].as_str().unwrap_or_default().to_string()
    };
    let stranger = AgentKey::generate().expect("another wallet").address();
    assert!(
        error(ask(&stranger, 97, "USDT", "5")).await.contains(&format!("Switch your wallet to {account}"))
    );
    assert_eq!(error(ask(&account, 56, "USDT", "5")).await, "Choose one of the networks listed.");
    assert!(error(ask(&account, 97, "DOGE", "5")).await.contains("does not list that asset"));
    for amount in ["", "0", "-5", "1e3", "five", "0.0000000000000000001"] {
        let said = error(ask(&account, 97, "USDT", amount)).await;
        assert!(said.contains("amount") || said.contains("decimal"), "{amount:?}: {said}");
    }
    // Nothing was sent, so there is nothing to report.
    let hash = format!("0x{}", "cd".repeat(32));
    let early = post(&format!("{}/deposit/sent", pending.url), json!({"hash": hash})).await.1;
    assert_eq!(early["error"], "Start again: the deposit was not prepared.");
    post(&prepare, ask(&account, 97, "USDT", "5")).await;
    for bad in [json!({}), json!({"hash": "0x1234"}), json!({"hash": format!("0x{}", "zz".repeat(32))})] {
        let said = post(&format!("{}/deposit/sent", pending.url), bad).await.1;
        assert!(said["error"].as_str().is_some_and(|e| e.contains("transaction")), "{said}");
    }
    // The trader closes the page before the wallet sent anything: nothing happened.
    pending.cancel.cancel();
    assert_eq!(
        pending.outcome.await.expect("outcome").expect_err("cancelled").to_string(),
        "The deposit was cancelled."
    );

    // The exchange reports another vault than the one this app knows: no transaction is built at all.
    let (_mock, client, trader) = funding("0x000000000000000000000000000000000000dEaD", accepted()).await;
    let account = trader.address();
    let pending = start(client, Task::Deposit { account }).await.expect("page");
    let (status, refused) =
        post(&format!("{}/deposit/prepare", pending.url), ask(&account, 97, "USDT", "5")).await;
    assert_eq!(status, 400);
    assert!(
        refused["error"]
            .as_str()
            .is_some_and(|e| e.contains("does not know") && e.contains("Nothing was prepared")),
        "{refused}"
    );
    assert!(refused.get("deposit").is_none());
    pending.cancel.cancel();
}

#[tokio::test]
async fn a_deposit_the_wallet_sent_is_reported_even_when_the_page_ends_first() {
    let (_mock, client, trader) = funding(TEST_VAULT, accepted()).await;
    let account = trader.address();
    let pending = start(client, Task::Deposit { account }).await.expect("page");
    let body = json!({"account": account.to_string(), "chainId": 97, "asset": "USDT", "amount": "40"});
    post(&format!("{}/deposit/prepare", pending.url), body).await;
    let hash = format!("0x{}", "EF".repeat(32));
    post(&format!("{}/deposit/sent", pending.url), json!({"hash": hash})).await;
    pending.cancel.cancel();
    let Done::Deposited(deposit) = pending.outcome.await.expect("outcome").expect("still reported") else {
        panic!("a deposit page ends with a deposit");
    };
    assert_eq!((deposit.amount.as_str(), deposit.confirmed), ("40", None));
    assert_eq!(deposit.hash, hash.to_lowercase());
}

/// The withdrawal a page asked the wallet to sign, read back from its typed data.
fn asked(prepared: &Value) -> Withdrawal {
    let message = &prepared["typedData"]["message"];
    let text = |key: &str| message[key].as_str().expect(key).to_string();
    Withdrawal {
        chain: funding::chain(
            Network::Testnet,
            prepared["typedData"]["domain"]["chainId"].as_u64().expect("chain"),
        )
        .expect("a testnet chain"),
        receiver: Address::parse(&text("destination")).expect("destination"),
        asset: text("token"),
        amount: text("amount"),
        fee: text("fee"),
        nonce: text("nonce").parse().expect("nonce"),
    }
}

#[tokio::test]
async fn a_withdrawal_needs_the_wallets_signature_twice_and_goes_back_to_that_wallet() {
    let (mock, client, trader) = funding(TEST_VAULT, accepted()).await;
    let account = trader.address();
    let pending = start(client, Task::Withdraw { account }).await.expect("page");
    let html = reqwest::get(&pending.url).await.expect("page").text().await.expect("html");
    assert!(html.contains("\"task\":\"withdraw\"") && html.contains(&format!("\"account\":\"{account}\"")));

    let options = post(&format!("{}/withdraw/options", pending.url), json!({})).await.1;
    assert_eq!(options["assets"], json!([{"chainId": 97, "name": "USDT", "max": "120.5", "fee": "0.5"}]));
    assert_eq!(options["daily"], json!({"limit": "10000", "left": "9000"}));
    assert_eq!(options["chains"][0]["name"], "BNB Smart Chain Testnet");

    let body = json!({"account": account.to_string(), "chainId": 97, "asset": "USDT", "amount": "40.00"});
    let (status, prepared) = post(&format!("{}/withdraw/prepare", pending.url), body).await;
    assert_eq!(status, 200, "{prepared}");
    // What the wallet shows: the amount, the fee, and its own address as the only destination.
    let typed = &prepared["typedData"];
    assert_eq!((&typed["primaryType"], &typed["domain"]["chainId"]), (&json!("Action"), &json!(97)));
    let message = &typed["message"];
    assert_eq!(
        (
            &message["type"],
            &message["destination"],
            &message["destination Chain"],
            &message["token"],
            &message["amount"],
            &message["fee"]
        ),
        (
            &json!("Withdraw"),
            &json!(account.to_string()),
            &json!("BSC testnet"),
            &json!("USDT"),
            &json!("40"),
            &json!("0.5")
        )
    );
    assert_eq!(
        (&prepared["receiver"], &prepared["amount"], &prepared["fee"]),
        (&json!(account.to_string()), &json!("40"), &json!("0.5"))
    );
    let withdrawal = asked(&prepared);
    let first = trader.sign_digest(&withdrawal.digest());

    // The second message is the request itself, in the exchange's own signing domain, carrying the first signature.
    let (status, signed) =
        post(&format!("{}/withdraw/signed", pending.url), json!({"signature": first})).await;
    assert_eq!(status, 200, "{signed}");
    assert_eq!((&signed["typedData"]["domain"]["chainId"], &signed["seconds"]), (&json!(714), &json!(45)));
    let request = signed["typedData"]["message"]["msg"].as_str().expect("request").to_string();
    assert!(
        request.starts_with(&format!(
            "chainId=97&asset=USDT&amount=40&fee=0.5&receiver={account}&userNonce={}&signatureType=EOA&userSignature={first}&nonce=",
            withdrawal.nonce
        )) && request.ends_with(&format!("&user={account}")),
        "{request}"
    );
    assert!(!request.contains("signer="), "the API wallet takes no part in a withdrawal");
    let second = trader.sign(714, &request);
    let (status, submitted) =
        post(&format!("{}/withdraw/submit", pending.url), json!({"signature": second})).await;
    assert_eq!(
        (status, &submitted["ok"], &submitted["id"]),
        (200, &json!(true), &json!("9001")),
        "{submitted}"
    );

    let Done::Withdrawn(withdrawn) = pending.outcome.await.expect("outcome").expect("withdrawn") else {
        panic!("a withdrawal page ends with a withdrawal");
    };
    assert_eq!(
        (
            withdrawn.chain.id,
            withdrawn.asset.as_str(),
            withdrawn.amount.as_str(),
            withdrawn.fee.as_str(),
            withdrawn.id.as_str()
        ),
        (97, "USDT", "40", "0.5", "9001")
    );
    // The exchange received exactly what the wallet signed, once.
    let sent = sent_to(&mock, "/fapi/v3/aster/user-withdraw").await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].url.query(), Some(format!("{request}&signature={second}").as_str()));
}

#[tokio::test]
async fn a_withdrawal_is_refused_before_anything_reaches_the_exchange() {
    let refusal = ResponseTemplate::new(400)
        .set_body_json(json!({"code": -2015, "msg": "Invalid API-key, IP, or permissions for action."}));
    let (mock, client, trader) = funding(TEST_VAULT, refusal).await;
    let account = trader.address();
    let stranger = AgentKey::generate().expect("another wallet");
    let pending = start(client, Task::Withdraw { account }).await.expect("page");
    let prepare = format!("{}/withdraw/prepare", pending.url);
    let signed = format!("{}/withdraw/signed", pending.url);
    let submit = format!("{}/withdraw/submit", pending.url);
    let ask = |who: &Address, amount: &str| json!({"account": who.to_string(), "chainId": 97, "asset": "USDT", "amount": amount});
    let error = async |url: &str, body: Value| {
        let (status, answer) = post(url, body).await;
        assert_eq!(status, 400, "{answer}");
        answer["error"].as_str().unwrap_or_default().to_string()
    };

    assert!(error(&prepare, ask(&stranger.address(), "40")).await.contains("a withdrawal is paid out to it"));
    assert_eq!(
        error(&prepare, ask(&account, "120.51")).await,
        "At most 120.5 USDT can be withdrawn to BNB Smart Chain Testnet now."
    );
    assert!(
        error(&prepare, ask(&account, "0.5")).await.contains("fee of 0.5 USDT is as much as this withdrawal")
    );
    assert_eq!(error(&prepare, ask(&account, "1.123456789")).await, "Use at most 8 decimal places.");
    assert!(error(&prepare, ask(&account, "-40")).await.contains("amount"));
    let other = json!({"account": account.to_string(), "chainId": 97, "asset": "DOGE", "amount": "40"});
    assert_eq!(
        error(&prepare, other).await,
        "There is no DOGE to withdraw to BNB Smart Chain Testnet right now."
    );
    assert_eq!(
        error(&signed, json!({"signature": "0x00"})).await,
        "Start again: the withdrawal was not prepared."
    );
    assert_eq!(
        error(&submit, json!({"signature": "0x00"})).await,
        "Start again: the withdrawal was not signed."
    );

    // The withdrawal signed by some other wallet.
    let prepared = post(&prepare, ask(&account, "40")).await.1;
    let forged = stranger.sign_digest(&asked(&prepared).digest());
    assert!(error(&signed, json!({"signature": forged})).await.contains("different account"));
    // The request signed by some other wallet.
    let prepared = post(&prepare, ask(&account, "40")).await.1;
    let first = trader.sign_digest(&asked(&prepared).digest());
    let request = post(&signed, json!({"signature": first})).await.1["typedData"]["message"]["msg"]
        .as_str()
        .expect("request")
        .to_string();
    assert!(
        error(&submit, json!({"signature": stranger.sign(714, &request)}))
            .await
            .contains("different account")
    );
    assert!(sent_to(&mock, "/fapi/v3/aster/user-withdraw").await.is_empty(), "nothing reached the exchange");

    // Both signatures right, and the exchange says no: its reason is shown and the page stays for another try.
    let prepared = post(&prepare, ask(&account, "40")).await.1;
    let first = trader.sign_digest(&asked(&prepared).digest());
    let request = post(&signed, json!({"signature": first})).await.1["typedData"]["message"]["msg"]
        .as_str()
        .expect("request")
        .to_string();
    let said = error(&submit, json!({"signature": trader.sign(714, &request)})).await;
    assert_eq!(said, "Exchange: Invalid API-key, IP, or permissions for action (code -2015)");
    assert_eq!(reqwest::get(&pending.url).await.expect("still serving").status(), 200);
    pending.cancel.cancel();
    assert_eq!(
        pending.outcome.await.expect("outcome").expect_err("cancelled").to_string(),
        "The withdrawal was cancelled."
    );

    // An answer that never arrives is not read as a refusal: the trader is told to check before asking again.
    let (_mock, client, trader) =
        funding(TEST_VAULT, ResponseTemplate::new(503).set_body_string("Service Unavailable")).await;
    let account = trader.address();
    let pending = start(client, Task::Withdraw { account }).await.expect("page");
    let prepared = post(&format!("{}/withdraw/prepare", pending.url), ask(&account, "40")).await.1;
    let first = trader.sign_digest(&asked(&prepared).digest());
    let request = post(&format!("{}/withdraw/signed", pending.url), json!({"signature": first})).await.1["typedData"]["message"]["msg"]
        .as_str()
        .expect("request")
        .to_string();
    let said =
        error(&format!("{}/withdraw/submit", pending.url), json!({"signature": trader.sign(714, &request)}))
            .await;
    assert!(
        said.contains("may or may not have been accepted") && said.contains("before you ask again"),
        "{said}"
    );
    pending.cancel.cancel();
}
