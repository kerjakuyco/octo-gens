//! Serves the wallet page against a stand-in for the exchange, to look at it in a browser.
//!
//!     cargo run -p octoneo-core --example wallet_page -- connect
//!     cargo run -p octoneo-core --example wallet_page -- deposit 0xYourWalletAddress
//!     cargo run -p octoneo-core --example wallet_page -- withdraw 0xYourWalletAddress
//!
//! It prints the page's address and then how the page ended. The exchange is a
//! stand-in on this computer: an approval and a withdrawal reach nothing real.
//! A deposit is different. Its page builds the same transaction the app builds
//! for the testnet vault, so a wallet that confirms it really sends test funds
//! there. Decline the wallet's prompt unless that is what you mean to do.

use std::sync::Arc;

use octoneo_core::connect::{Done, Task, start};
use octoneo_core::exchange::funding::{chain, chains};
use octoneo_core::exchange::signing::{Address, AgentKey};
use octoneo_core::exchange::{ExchangeClient, Wallet};
use octoneo_core::model::Network;
use octoneo_core::net::http_client;
use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NETWORK: Network = Network::Testnet;
const TEST_USDT: &str = "0x7037bf0500e9f5e277c6562ff593f0f9ab432bf7";

fn site(data: Value) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .set_body_json(json!({"code": "000000", "message": null, "data": data, "success": true}))
}

/// What the exchange would answer, served from this computer.
async fn stand_in() -> MockServer {
    let server = MockServer::start().await;
    let funds = &chains(NETWORK)[0];
    let now = chrono::Utc::now().timestamp_millis();
    let answers = [
        ("GET", "/fapi/v3/time", ResponseTemplate::new(200).set_body_json(json!({"serverTime": now}))),
        (
            "POST",
            "/fapi/v3/registerAndApproveAgent",
            ResponseTemplate::new(200).set_body_json(json!({"code": 200, "msg": "success"})),
        ),
        (
            "GET",
            "/bapi/futures/v1/public/future/aster/deposit/assets",
            site(json!([
                {"name": "USDT", "contractAddress": TEST_USDT, "decimals": 18, "network": "EVM", "chainId": funds.id,
                 "depositType": "normal", "isNative": false, "isStock": false},
                {"name": funds.coin, "contractAddress": "0xfdae1ba7c826abdc4c99903c8056f82a1a04a615", "decimals": 18,
                 "network": "EVM", "chainId": funds.id, "depositType": "normal", "isNative": true, "isStock": false},
            ])),
        ),
        (
            "GET",
            "/bapi/futures/v1/public/future/web3/ae/deposit-address",
            site(json!(funds.vault().to_string())),
        ),
        (
            "GET",
            "/bapi/futures/v1/public/future/aster/withdraw/assets",
            site(json!([{"name": "USDT", "network": "EVM", "chainId": funds.id, "withdrawType": "autoWithdraw"}])),
        ),
        (
            "GET",
            "/bapi/futures/v1/public/future/aster/estimate-withdraw-fee",
            site(json!({"gasLimit": 200_000, "gasCost": 0.5, "gasUsdValue": 0.1})),
        ),
        (
            "POST",
            "/fapi/v3/aster/user-withdraw-info",
            ResponseTemplate::new(200).set_body_json(json!({
                "userDailyLimit": "10000", "userRemainingDailyLimit": "9000",
                "balances": {"USDT": {"currency": "USDT", "chainBalances": {
                    funds.id.to_string(): {"chainId": funds.id, "perpMaxWithdrawAmount": "1250.75", "withdrawFee": "0.5"},
                }}},
            })),
        ),
        (
            "POST",
            "/fapi/v3/aster/user-withdraw",
            ResponseTemplate::new(200).set_body_json(json!({"withdrawId": "9001", "hash": "0xfeed"})),
        ),
    ];
    for (verb, route, answer) in answers {
        Mock::given(method(verb)).and(path(route)).respond_with(answer).mount(&server).await;
    }
    server
}

#[tokio::main]
async fn main() {
    let mut words = std::env::args().skip(1);
    let what = words.next().unwrap_or_default();
    let account = words.next().map(|raw| Address::parse(&raw));
    let agent = AgentKey::generate().expect("a random key");
    let task = match (what.as_str(), account) {
        ("connect", _) => Task::Connect { agent: agent.address(), days: 30 },
        ("deposit", Some(Ok(account))) => Task::Deposit { account },
        ("withdraw", Some(Ok(account))) => Task::Withdraw { account },
        _ => {
            return println!(
                "Say which page: connect, or deposit or withdraw followed by the address of the wallet in your browser."
            );
        }
    };
    let server = stand_in().await;
    let client =
        ExchangeClient::new(NETWORK, http_client().expect("an HTTP client")).with_base(&server.uri());
    if let Task::Deposit { account } | Task::Withdraw { account } = task {
        client.set_wallet(Some(Wallet { user: account, agent, expires: None }));
    }
    let pending = start(Arc::new(client), task).await.expect("the page starts");
    println!("page: {}", pending.url);
    if matches!(task, Task::Deposit { .. }) {
        let vault = chain(NETWORK, chains(NETWORK)[0].id).expect("the first chain").vault();
        println!("A deposit confirmed in the wallet is a real testnet transaction to {vault}.");
    }
    match pending.outcome.await {
        Ok(Ok(Done::Approved(approval))) => {
            println!("approved by {} until {}", approval.user, approval.expires)
        }
        Ok(Ok(Done::Deposited(deposit))) => println!(
            "deposited {} {} on {}: {} (confirmed: {:?})",
            deposit.amount, deposit.asset, deposit.chain.name, deposit.hash, deposit.confirmed
        ),
        Ok(Ok(Done::Withdrawn(withdrawn))) => println!(
            "withdrawal {} accepted: {} {} to {}, fee {}",
            withdrawn.id, withdrawn.amount, withdrawn.asset, withdrawn.chain.name, withdrawn.fee
        ),
        Ok(Err(error)) => println!("ended: {error}"),
        Err(_) => println!("ended without a word"),
    }
}
