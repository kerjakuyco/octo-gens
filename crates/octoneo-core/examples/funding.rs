//! Checks deposits against the exchange and the chains, without sending anything.
//!
//!     cargo run -p octoneo-core --example funding
//!
//! For every network funds move on, it asks the exchange which vault it uses and
//! what it accepts, and asks a public node to simulate (`eth_call`) the deposit
//! this app would build. Nothing is signed and nothing is sent: a simulation
//! changes no state. A coin deposit is simulated with a pretend balance and
//! should succeed. A token deposit is simulated from a wallet that holds none,
//! so it should fail inside the token, which shows the vault accepted the call
//! and went to collect the tokens.

use octoneo_core::exchange::ExchangeClient;
use octoneo_core::exchange::funding::{Chain, DepositAsset, chains, deposit_plan, units};
use octoneo_core::exchange::signing::Address;
use octoneo_core::model::Network;
use octoneo_core::net::http_client;
use serde_json::{Value, json};

/// The example wallet from the exchange's documentation. It is public and holds nothing.
const WALLET: &str = "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";

async fn rpc(http: &reqwest::Client, node: &str, method: &str, params: Value) -> Result<Value, String> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let response = http
        .post(node)
        .timeout(std::time::Duration::from_secs(20))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let answer: Value = response.json().await.map_err(|error| error.without_url().to_string())?;
    match answer.get("error") {
        Some(error) => Err(reason(error)),
        None => Ok(answer.get("result").cloned().unwrap_or(Value::Null)),
    }
}

/// A node's reason for a failed call, with the contract's own words when it gave any.
fn reason(error: &Value) -> String {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("failed");
    // Some nodes repeat the raw answer in their message; the words are enough.
    let message = message.split(": 0x").next().unwrap_or(message).to_string();
    let Some(bytes) = error
        .get("data")
        .and_then(Value::as_str)
        .and_then(|data| hex::decode(data.trim_start_matches("0x")).ok())
        .filter(|bytes| bytes.len() >= 4)
    else {
        return message;
    };
    let said = match &bytes[..4] {
        // `Error(string)`: the offset, the length, then the text.
        [0x08, 0xc3, 0x79, 0xa0] => (|| {
            let length = usize::try_from(u64::from_be_bytes(bytes.get(60..68)?.try_into().ok()?)).ok()?;
            String::from_utf8(bytes.get(68..68 + length)?.to_vec()).ok()
        })(),
        // The errors newer tokens raise in place of text.
        [0xfb, 0x8f, 0x41, 0xb2] => Some("the token says the vault's allowance is too small".to_string()),
        [0xe4, 0x50, 0xd3, 0x8c] => Some("the token says the wallet's balance is too small".to_string()),
        other => Some(format!("error 0x{}", hex::encode(other))),
    };
    match said {
        Some(said) if !message.contains(&said) => format!("{message}: {said}"),
        _ => message,
    }
}

async fn simulate(http: &reqwest::Client, chain: &Chain, asset: &DepositAsset, wallet: &Address) -> String {
    let amount = match units("0.01", asset.decimals) {
        Ok(amount) => amount,
        Err(error) => return format!("could not size a deposit: {error}"),
    };
    let plan = deposit_plan(chain, asset, wallet, amount);
    let call = json!({
        "from": wallet.to_string(),
        "to": plan.deposit.to.to_string(),
        "data": plan.deposit.data,
        "value": format!("0x{:x}", plan.deposit.value),
    });
    // A pretend balance, so a coin deposit is not refused for lack of coin.
    let pretend = json!({wallet.to_string(): {"balance": "0x3635c9adc5dea00000"}});
    let node = chain.nodes[0];
    match rpc(http, node, "eth_call", json!([call, "latest", pretend])).await {
        Ok(_) => "accepted".to_string(),
        Err(why) => format!("refused: {why}"),
    }
}

#[tokio::main]
async fn main() {
    let http = match http_client() {
        Ok(http) => http,
        Err(error) => return println!("{error}"),
    };
    let wallet = Address::parse(WALLET).expect("the example address is valid");
    for network in [Network::Mainnet, Network::Testnet] {
        println!("\n== {} ==", network.name());
        let client = ExchangeClient::new(network, http.clone());
        let assets = match client.deposit_assets().await {
            Ok(assets) => assets,
            Err(error) => {
                println!("deposit assets: {error}");
                continue;
            }
        };
        for chain in chains(network) {
            let vault = match client.confirm_vault(chain).await {
                Ok(vault) => format!("{vault} (the exchange reports the same)"),
                Err(error) => format!("NOT CONFIRMED: {error}"),
            };
            let code =
                rpc(&http, chain.nodes[0], "eth_getCode", json!([chain.vault().to_string(), "latest"])).await;
            let code = match code {
                Ok(Value::String(code)) if code.len() > 2 => {
                    format!("{} bytes of code", (code.len() - 2) / 2)
                }
                Ok(_) => "NO CODE AT THIS ADDRESS".to_string(),
                Err(why) => format!("node: {why}"),
            };
            println!("{} ({}): vault {vault}; {code}", chain.name, chain.id);
            let here: Vec<&DepositAsset> = assets.iter().filter(|asset| asset.chain_id == chain.id).collect();
            println!(
                "  accepts: {}",
                here.iter().map(|asset| asset.name.as_str()).collect::<Vec<_>>().join(", ")
            );
            // The coin, then the first few tokens: enough to see both kinds of deposit answered.
            let coin = here.iter().find(|asset| asset.token.is_none());
            for asset in coin.into_iter().chain(here.iter().filter(|asset| asset.token.is_some()).take(3)) {
                let kind = if asset.token.is_none() { "coin" } else { "token" };
                println!(
                    "  deposit 0.01 {} ({kind}): {}",
                    asset.name,
                    simulate(&http, chain, asset, &wallet).await
                );
            }
        }
    }
}
