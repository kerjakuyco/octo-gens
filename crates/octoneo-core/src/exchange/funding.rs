//! Moving funds between the trader's own wallet and their trading account.
//!
//! A deposit is a transaction the trader's wallet sends to the exchange's vault
//! contract, on the network the funds are on. A withdrawal is a request the
//! exchange carries out only when the trader's own wallet has signed it twice:
//! once for the withdrawal itself and once to prove who is asking. The API
//! wallet this app holds can do neither, and the app never sees the main
//! wallet's key.
//!
//! This module holds what both need: the networks funds move on, the vault on
//! each, the transactions and the messages, and the checks on what a wallet
//! returns. Nothing here sends anything.

use rust_decimal::Decimal;
use serde_json::{Value, json};

use super::signing::{Address, domain_separator, encode_params, keccak, recover_digest, word};
use crate::error::Result;
use crate::model::Network;
use crate::{bail, desk_err};

/// A network funds are deposited from and withdrawn to.
#[derive(Debug, PartialEq, Eq)]
pub struct Chain {
    pub id: u64,
    pub name: &'static str,
    /// What the exchange calls this network in a withdrawal.
    pub short: &'static str,
    /// The coin that pays for transactions here.
    pub coin: &'static str,
    /// Public nodes, for a wallet that does not know this network yet.
    pub nodes: &'static [&'static str],
    pub explorer: &'static str,
    /// The exchange's vault contract here. A deposit goes to this address and to no other.
    vault: &'static str,
}

const MAINNET: [Chain; 3] = [
    Chain {
        id: 56,
        name: "BNB Smart Chain",
        short: "BSC",
        coin: "BNB",
        nodes: &["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.bnbchain.org"],
        explorer: "https://bscscan.com",
        vault: "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974",
    },
    Chain {
        id: 1,
        name: "Ethereum",
        short: "ETH",
        coin: "ETH",
        nodes: &["https://ethereum-rpc.publicnode.com"],
        explorer: "https://etherscan.io",
        vault: "0x604DD02d620633Ae427888d41bfd15e38483736E",
    },
    Chain {
        id: 42161,
        name: "Arbitrum One",
        short: "Arbitrum",
        coin: "ETH",
        nodes: &["https://arb1.arbitrum.io/rpc"],
        explorer: "https://arbiscan.io",
        vault: "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5",
    },
];

const TESTNET: [Chain; 2] = [
    Chain {
        id: 97,
        name: "BNB Smart Chain Testnet",
        short: "BSC testnet",
        coin: "tBNB",
        nodes: &["https://data-seed-prebsc-1-s1.bnbchain.org:8545", "https://bsc-testnet-rpc.publicnode.com"],
        explorer: "https://testnet.bscscan.com",
        vault: "0x62904590b575ea1C3F4aC411EB6A5A3140d6956e",
    },
    Chain {
        id: 11_155_111,
        name: "Sepolia",
        short: "Sepolia",
        coin: "ETH",
        nodes: &["https://ethereum-sepolia-rpc.publicnode.com"],
        explorer: "https://sepolia.etherscan.io",
        vault: "0x58D1E4C7b75450EfB2f437CE969aB8552F38371D",
    },
];

/// The address the exchange's vault takes for a network's own coin, in place of a token contract.
const COIN_PLACEHOLDER: &str = "0xfdAE1bA7C826aBDc4c99903c8056f82a1A04a615";
/// The account a deposit is credited to: this value means the futures account.
const FUTURES_BROKER: u128 = 1;
/// EIP-712 domain of a withdrawal the main wallet signs.
const WITHDRAW_DOMAIN: &str = "Aster";
const WITHDRAW_VERSION: &str = "1";
/// The exchange's own ledger named in a withdrawal. Its testnet uses the same word.
const WITHDRAW_LEDGER: &str = "Mainnet";
const ACTION_TYPE: &str = "Action(string type,address destination,string destination Chain,string token,string amount,string fee,uint256 nonce,string aster chain)";

/// The networks a trading network's funds move on, the usual one first.
pub fn chains(network: Network) -> &'static [Chain] {
    match network {
        Network::Mainnet => &MAINNET,
        Network::Testnet => &TESTNET,
    }
}

pub fn chain(network: Network, id: u64) -> Option<&'static Chain> {
    chains(network).iter().find(|chain| chain.id == id)
}

/// The network a wallet signs an API wallet's approval on, whatever the trading network.
pub fn approval_chain() -> &'static Chain {
    &MAINNET[0]
}

impl Chain {
    /// The vault a deposit on this network goes to.
    pub fn vault(&self) -> Address {
        Address::parse(self.vault).unwrap_or_else(|_| unreachable!("the vault addresses are valid"))
    }

    /// What a wallet needs to switch to this network, or to learn it.
    pub fn for_wallet(&self) -> Value {
        json!({
            "id": self.id,
            "hex": format!("0x{:x}", self.id),
            "name": self.name,
            "currency": {"name": self.coin, "symbol": self.coin, "decimals": 18},
            "rpcUrls": self.nodes,
            "explorer": self.explorer,
        })
    }
}

/// Something the exchange accepts as a deposit on one network.
#[derive(Clone, Debug, PartialEq)]
pub struct DepositAsset {
    pub chain_id: u64,
    pub name: String,
    /// The token contract. `None` for the network's own coin.
    pub token: Option<Address>,
    pub decimals: u32,
}

/// What can be withdrawn of one asset to one network now.
#[derive(Clone, Debug, PartialEq)]
pub struct Withdrawable {
    pub chain_id: u64,
    pub asset: String,
    pub max: Decimal,
    /// What the exchange charges, in the asset.
    pub fee: Decimal,
}

/// How much may still be withdrawn today, in dollars, when the exchange says.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DailyLimit {
    pub limit: Option<Decimal>,
    pub left: Option<Decimal>,
}

/// Reads the exchange's list of deposit assets, keeping what this app can deposit:
/// ordinary tokens and coins on a network it knows. Tokenised shares are left
/// out: their amounts are scaled by a figure only their contract knows.
pub fn deposit_assets(network: Network, rows: &Value) -> Vec<DepositAsset> {
    let Some(rows) = rows.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let chain_id = row.get("chainId").and_then(Value::as_u64)?;
            chain(network, chain_id)?;
            let ordinary = row.get("network").and_then(Value::as_str) == Some("EVM")
                && row.get("depositType").and_then(Value::as_str) == Some("normal")
                && row.get("isStock").and_then(Value::as_bool) != Some(true);
            if !ordinary {
                return None;
            }
            let name = row.get("name").and_then(Value::as_str).filter(|name| listed_name(name))?;
            let decimals = row.get("decimals").and_then(Value::as_u64).filter(|d| *d <= 18)? as u32;
            let contract = Address::parse(row.get("contractAddress").and_then(Value::as_str)?).ok()?;
            let native = row.get("isNative").and_then(Value::as_bool) == Some(true);
            // The vault names a network's own coin by one fixed address. Anything else under that flag is not understood.
            if native != (contract == coin_placeholder()) {
                return None;
            }
            Some(DepositAsset {
                chain_id,
                name: name.to_string(),
                token: (!native).then_some(contract),
                decimals,
            })
        })
        .collect()
}

/// The assets a withdrawal can name on each network: those the exchange sends out itself.
pub fn withdraw_assets(network: Network, rows: &Value) -> Vec<(u64, String)> {
    let Some(rows) = rows.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let chain_id = row.get("chainId").and_then(Value::as_u64)?;
            chain(network, chain_id)?;
            let ordinary = row.get("network").and_then(Value::as_str) == Some("EVM")
                && row.get("withdrawType").and_then(Value::as_str) == Some("autoWithdraw")
                && row.get("isStock").and_then(Value::as_bool) != Some(true);
            let name = row.get("name").and_then(Value::as_str).filter(|name| listed_name(name))?;
            ordinary.then(|| (chain_id, name.to_string()))
        })
        .collect()
}

/// Reads what the account may withdraw now: per asset and network, with the fee.
pub fn withdrawables(
    network: Network,
    info: &Value,
    allowed: &[(u64, String)],
) -> (Vec<Withdrawable>, DailyLimit) {
    let figure = |value: &Value, key: &str| -> Option<Decimal> {
        let raw = value.get(key)?;
        let text = raw.as_str().map(str::to_string).or_else(|| raw.is_number().then(|| raw.to_string()))?;
        text.parse::<Decimal>().ok().filter(|amount| !amount.is_sign_negative())
    };
    let daily =
        DailyLimit { limit: figure(info, "userDailyLimit"), left: figure(info, "userRemainingDailyLimit") };
    let mut list = Vec::new();
    let balances = info.get("balances").and_then(Value::as_object);
    for (asset, balance) in balances.into_iter().flatten() {
        let per_chain = balance.get("chainBalances").and_then(Value::as_object);
        for row in per_chain.into_iter().flatten().map(|(_, row)| row) {
            let Some(chain_id) = row.get("chainId").and_then(Value::as_u64) else {
                continue;
            };
            if chain(network, chain_id).is_none()
                || !allowed.iter().any(|(id, name)| *id == chain_id && name == asset)
            {
                continue;
            }
            let Some(mut max) = figure(row, "perpMaxWithdrawAmount") else {
                continue;
            };
            if let Some(limit) = figure(row, "chainLimit") {
                max = max.min(limit);
            }
            let fee = figure(row, "withdrawFee").unwrap_or_default();
            if max > fee {
                list.push(Withdrawable {
                    chain_id,
                    asset: asset.clone(),
                    max: max.normalize(),
                    fee: fee.normalize(),
                });
            }
        }
    }
    // The usual network first, then by name, so the list does not reshuffle between reads.
    let rank = |id: u64| chains(network).iter().position(|chain| chain.id == id).unwrap_or(usize::MAX);
    list.sort_by(|a, b| (rank(a.chain_id), &a.asset).cmp(&(rank(b.chain_id), &b.asset)));
    (list, daily)
}

/// An asset name as the exchange lists them: short, and nothing that could be mistaken for markup or a parameter.
fn listed_name(name: &str) -> bool {
    (1..=24).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn coin_placeholder() -> Address {
    Address::parse(COIN_PLACEHOLDER).unwrap_or_else(|_| unreachable!("the placeholder address is valid"))
}

/// An amount as typed, in the asset's smallest unit. Refuses anything that is not
/// a plain positive number with no more decimals than the asset has.
pub fn units(amount: &str, decimals: u32) -> Result<u128> {
    let text = amount.trim();
    let invalid = || desk_err!("Enter an amount as a number, for example 25 or 25.5.");
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty()) || !digits(whole) || !digits(fraction) {
        return Err(invalid());
    }
    let fraction = fraction.trim_end_matches('0');
    if fraction.len() > decimals as usize {
        bail!("This asset has {decimals} decimal places at most.");
    }
    let too_large = || desk_err!("That amount is too large.");
    let mut value: u128 = 0;
    let padded = fraction.bytes().chain(std::iter::repeat_n(b'0', decimals as usize - fraction.len()));
    for digit in whole.bytes().chain(padded) {
        value = value
            .checked_mul(10)
            .and_then(|value| value.checked_add(u128::from(digit - b'0')))
            .ok_or_else(too_large)?;
    }
    if value == 0 {
        bail!("Enter an amount above zero.");
    }
    Ok(value)
}

/// An amount as the exchange is told it: no sign, no exponent, no trailing zeros.
pub fn plain(amount: Decimal) -> String {
    amount.normalize().to_string()
}

fn address_word(address: &Address) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address.bytes());
    out
}

/// Call data: the first four bytes of the signature's hash, then the arguments as words.
fn call(signature: &str, words: &[[u8; 32]]) -> String {
    let mut data = keccak(signature.as_bytes())[..4].to_vec();
    for word in words {
        data.extend_from_slice(word);
    }
    format!("0x{}", hex::encode(data))
}

/// A transaction for the trader's wallet to send, or a read for it to make.
#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    pub to: Address,
    pub data: String,
    /// Coins sent along, in the smallest unit.
    pub value: u128,
}

impl Call {
    pub fn to_json(&self) -> Value {
        json!({"to": self.to.to_string(), "data": self.data, "value": format!("0x{:x}", self.value)})
    }
}

/// Everything a wallet needs to make one deposit, in the order it is used.
#[derive(Clone, Debug, PartialEq)]
pub struct DepositPlan {
    pub amount: u128,
    /// Reads how much of the token the wallet holds. `None` for a coin: the wallet's own balance is read instead.
    pub balance: Option<Call>,
    /// Reads how much of the token the vault may already take.
    pub allowance: Option<Call>,
    /// Withdraws an earlier allowance. Some tokens refuse a new one while an old one stands.
    pub reset: Option<Call>,
    /// Lets the vault take exactly the amount, and no more.
    pub approve: Option<Call>,
    /// The deposit itself.
    pub deposit: Call,
}

/// Builds a deposit of `amount` of `asset` from `account`, credited to that same account.
pub fn deposit_plan(chain: &Chain, asset: &DepositAsset, account: &Address, amount: u128) -> DepositPlan {
    let vault = chain.vault();
    let deposit = |currency: &Address, value: u128| Call {
        to: vault,
        data: call(
            "depositFor(address,address,uint256,uint256)",
            &[address_word(currency), address_word(account), word(amount), word(FUTURES_BROKER)],
        ),
        value,
    };
    let Some(token) = asset.token else {
        return DepositPlan {
            amount,
            balance: None,
            allowance: None,
            reset: None,
            approve: None,
            deposit: deposit(&coin_placeholder(), amount),
        };
    };
    let read = |data: String| Call { to: token, data, value: 0 };
    let approve =
        |allowed: u128| read(call("approve(address,uint256)", &[address_word(&vault), word(allowed)]));
    DepositPlan {
        amount,
        balance: Some(read(call("balanceOf(address)", &[address_word(account)]))),
        allowance: Some(read(call(
            "allowance(address,address)",
            &[address_word(account), address_word(&vault)],
        ))),
        reset: Some(approve(0)),
        approve: Some(approve(amount)),
        deposit: deposit(&token, 0),
    }
}

/// A withdrawal as the trader's wallet signs it.
#[derive(Clone, Debug, PartialEq)]
pub struct Withdrawal {
    pub chain: &'static Chain,
    /// Where the funds go: always the trader's own wallet.
    pub receiver: Address,
    pub asset: String,
    pub amount: String,
    pub fee: String,
    /// Microseconds, as the exchange wants this number.
    pub nonce: u64,
}

impl Withdrawal {
    /// The hash a wallet signs for this withdrawal.
    pub(crate) fn digest(&self) -> [u8; 32] {
        let text = |value: &str| keccak(value.as_bytes());
        let mut body = Vec::with_capacity(9 * 32);
        body.extend(text(ACTION_TYPE));
        body.extend(text("Withdraw"));
        body.extend(address_word(&self.receiver));
        body.extend(text(self.chain.short));
        body.extend(text(&self.asset));
        body.extend(text(&self.amount));
        body.extend(text(&self.fee));
        body.extend(word(u128::from(self.nonce)));
        body.extend(text(WITHDRAW_LEDGER));
        let mut data = Vec::with_capacity(66);
        data.extend([0x19, 0x01]);
        data.extend(domain_separator(WITHDRAW_DOMAIN, WITHDRAW_VERSION, self.chain.id, &[0u8; 20]));
        data.extend(keccak(&body));
        keccak(&data)
    }

    /// The typed data for a wallet's `eth_signTypedData_v4`.
    pub fn typed_data(&self) -> Value {
        let field = |name: &str, kind: &str| json!({"name": name, "type": kind});
        json!({
            "types": {
                "EIP712Domain": [
                    field("name", "string"),
                    field("version", "string"),
                    field("chainId", "uint256"),
                    field("verifyingContract", "address"),
                ],
                "Action": [
                    field("type", "string"),
                    field("destination", "address"),
                    field("destination Chain", "string"),
                    field("token", "string"),
                    field("amount", "string"),
                    field("fee", "string"),
                    field("nonce", "uint256"),
                    field("aster chain", "string"),
                ],
            },
            "primaryType": "Action",
            "domain": {
                "name": WITHDRAW_DOMAIN,
                "version": WITHDRAW_VERSION,
                "chainId": self.chain.id,
                "verifyingContract": "0x0000000000000000000000000000000000000000",
            },
            "message": {
                "type": "Withdraw",
                "destination": self.receiver.to_string(),
                "destination Chain": self.chain.short,
                "token": self.asset,
                "amount": self.amount,
                "fee": self.fee,
                // A decimal string: wallets read it as the number, and it is too large to trust to a JSON number everywhere.
                "nonce": self.nonce.to_string(),
                "aster chain": WITHDRAW_LEDGER,
            },
        })
    }

    /// The address whose wallet signed this withdrawal.
    pub fn signer(&self, signature: &str) -> Result<Address> {
        recover_digest(&self.digest(), signature)
    }

    /// The request the exchange is sent, without the proof of who asks: `nonce`
    /// is the request's own, `user` the wallet that asks. This exact string is
    /// what that wallet signs next, and what is sent with its signature appended.
    pub fn request(&self, signature: &str, nonce: u64) -> String {
        encode_params(&[
            ("chainId", self.chain.id.to_string()),
            ("asset", self.asset.clone()),
            ("amount", self.amount.clone()),
            ("fee", self.fee.clone()),
            ("receiver", self.receiver.to_string()),
            ("userNonce", self.nonce.to_string()),
            ("signatureType", "EOA".to_string()),
            ("userSignature", signature.to_string()),
            ("nonce", nonce.to_string()),
            ("user", self.receiver.to_string()),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exchange::signing::AgentKey;

    /// The example wallet printed in the exchange's own documentation. It is public and holds nothing.
    const KEY: &str = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1";
    const WALLET: &str = "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";

    fn wallet() -> Address {
        Address::parse(WALLET).expect("address")
    }

    #[test]
    fn each_trading_network_moves_funds_on_its_own_chains() {
        let ids = |network| chains(network).iter().map(|chain| chain.id).collect::<Vec<_>>();
        assert_eq!(ids(Network::Mainnet), [56, 1, 42161]);
        assert_eq!(ids(Network::Testnet), [97, 11_155_111]);
        // A testnet deposit can never be built for a mainnet vault, or the other way round.
        assert!(chain(Network::Testnet, 56).is_none() && chain(Network::Mainnet, 97).is_none());
        assert_eq!(chain(Network::Mainnet, 56).expect("chain").short, "BSC");
        assert_eq!(chain(Network::Testnet, 97).expect("chain").short, "BSC testnet");
        assert_eq!(approval_chain().id, 56);
        // The vaults are the ones the exchange documents for mainnet and reports for testnet.
        for (network, id, vault) in [
            (Network::Mainnet, 56, "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974"),
            (Network::Mainnet, 1, "0x604DD02d620633Ae427888d41bfd15e38483736E"),
            (Network::Mainnet, 42161, "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5"),
            (Network::Testnet, 97, "0x62904590b575ea1C3F4aC411EB6A5A3140d6956e"),
            (Network::Testnet, 11_155_111, "0x58D1E4C7b75450EfB2f437CE969aB8552F38371D"),
        ] {
            assert_eq!(chain(network, id).expect("chain").vault().to_string(), vault);
        }
        let shown = chain(Network::Testnet, 97).expect("chain").for_wallet();
        assert_eq!((&shown["hex"], &shown["currency"]["symbol"]), (&json!("0x61"), &json!("tBNB")));
        assert_eq!(chain(Network::Mainnet, 42161).expect("chain").for_wallet()["hex"], "0xa4b1");
    }

    #[test]
    fn amounts_become_whole_units_or_are_refused() {
        assert_eq!(units("1", 18).expect("one"), 1_000_000_000_000_000_000);
        assert_eq!(units("0.000001", 6).expect("smallest"), 1);
        assert_eq!(units(" 25.50 ", 6).expect("trimmed"), 25_500_000);
        assert_eq!(units(".5", 2).expect("leading dot"), 50);
        assert_eq!(units("7.", 0).expect("trailing dot"), 7);
        assert_eq!(units("1.2300000000000000000000", 2).expect("zeros past the last place"), 123);
        assert_eq!(units("340282366920938463463.374607431768211455", 18).expect("largest"), u128::MAX);
        for bad in ["", ".", "-1", "+1", "1e3", "1,5", "1.2.3", "0x10", "ten", "１"] {
            assert!(units(bad, 18).is_err(), "{bad:?} should be refused");
        }
        assert!(units("0", 18).is_err() && units("0.000", 6).is_err(), "nothing is not an amount");
        assert!(units("0.0000001", 6).is_err(), "finer than the asset");
        assert!(units("340282366920938463463.374607431768211456", 18).is_err(), "past the largest");
        assert_eq!(plain("50.00".parse().expect("decimal")), "50");
        assert_eq!(plain("0.1100".parse().expect("decimal")), "0.11");
    }

    #[test]
    fn a_token_deposit_reads_then_allows_exactly_then_deposits_to_the_account() {
        let chain = chain(Network::Mainnet, 56).expect("chain");
        let token = Address::parse("0x55d398326f99059fF775485246999027B3197955").expect("token");
        let asset = DepositAsset { chain_id: 56, name: "USDT".into(), token: Some(token), decimals: 18 };
        let amount = units("100", 18).expect("amount");
        let plan = deposit_plan(chain, &asset, &wallet(), amount);
        let account = "00000000000000000000000021cf8ae13bb72632562c6fff438652ba1a151bb0";
        let vault = "000000000000000000000000128463a60784c4d3f46c23af3f65ed859ba87974";
        let hundred = "0000000000000000000000000000000000000000000000056bc75e2d63100000";
        let zero = "0".repeat(64);
        let balance = plan.balance.expect("balance");
        assert_eq!((balance.to, balance.data), (token, format!("0x70a08231{account}")));
        let allowance = plan.allowance.expect("allowance");
        assert_eq!((allowance.to, allowance.data), (token, format!("0xdd62ed3e{account}{vault}")));
        let approve = plan.approve.expect("approve");
        assert_eq!(
            (approve.to, approve.data, approve.value),
            (token, format!("0x095ea7b3{vault}{hundred}"), 0)
        );
        assert_eq!(plan.reset.expect("reset").data, format!("0x095ea7b3{vault}{zero}"));
        // depositFor(currency, forAddress, amount, broker): the token, the trader's own account, the amount, the futures account.
        let currency = "00000000000000000000000055d398326f99059ff775485246999027b3197955";
        let broker = format!("{}1", "0".repeat(63));
        assert_eq!(plan.deposit.to, chain.vault());
        assert_eq!(plan.deposit.data, format!("0xcf4a0c5e{currency}{account}{hundred}{broker}"));
        assert_eq!(plan.deposit.value, 0, "a token deposit sends no coin");
        assert_eq!(plan.deposit.to_json()["value"], "0x0");
    }

    #[test]
    fn a_coin_deposit_sends_the_coin_and_needs_no_allowance() {
        let chain = chain(Network::Mainnet, 56).expect("chain");
        let asset = DepositAsset { chain_id: 56, name: "BNB".into(), token: None, decimals: 18 };
        let amount = units("0.25", 18).expect("amount");
        let plan = deposit_plan(chain, &asset, &wallet(), amount);
        assert!(
            plan.balance.is_none()
                && plan.allowance.is_none()
                && plan.approve.is_none()
                && plan.reset.is_none()
        );
        assert_eq!(plan.deposit.value, amount);
        assert_eq!(plan.deposit.to_json()["value"], "0x3782dace9d90000");
        assert!(
            plan.deposit.data.contains("000000000000000000000000fdae1ba7c826abdc4c99903c8056f82a1a04a615"),
            "the coin is named by the vault's placeholder: {}",
            plan.deposit.data
        );
    }

    #[test]
    fn only_ordinary_assets_on_known_chains_are_offered() {
        let rows = json!([
            {"name": "USDT", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": false, "isStock": false},
            {"name": "BNB", "contractAddress": "0xfdae1ba7c826abdc4c99903c8056f82a1a04a615", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": true, "isStock": false},
            {"name": "NVDAB", "contractAddress": "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": false, "isStock": true},
            {"name": "USDT", "contractAddress": "0x7037bf0500e9f5e277c6562ff593f0f9ab432bf7", "decimals": 18, "network": "EVM", "chainId": 97, "depositType": "normal", "isNative": false},
            {"name": "SOL", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 9, "network": "SOLANA", "chainId": 56, "depositType": "normal", "isNative": false},
            {"name": "ODD", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "special", "isNative": false},
            {"name": "FAKE", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": true},
            {"name": "<b>", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": false},
            {"name": "WIDE", "contractAddress": "0x55d398326f99059ff775485246999027b3197955", "decimals": 77, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": false},
            {"name": "BAD", "contractAddress": "0x55d3", "decimals": 18, "network": "EVM", "chainId": 56, "depositType": "normal", "isNative": false},
        ]);
        let offered = deposit_assets(Network::Mainnet, &rows);
        let names: Vec<(&str, bool)> = offered.iter().map(|a| (a.name.as_str(), a.token.is_none())).collect();
        assert_eq!(names, [("USDT", false), ("BNB", true)]);
        assert!(deposit_assets(Network::Mainnet, &json!({"not": "a list"})).is_empty());
        assert_eq!(deposit_assets(Network::Testnet, &rows).len(), 1, "testnet sees only its own chains");

        let out = json!([
            {"name": "USDT", "network": "EVM", "chainId": 56, "withdrawType": "autoWithdraw", "isStock": false},
            {"name": "OLD", "network": "EVM", "chainId": 56, "withdrawType": "manualWithdraw"},
            {"name": "NVDAB", "network": "EVM", "chainId": 56, "withdrawType": "autoWithdraw", "isStock": true},
            {"name": "USDT", "network": "EVM", "chainId": 97, "withdrawType": "autoWithdraw"},
        ]);
        assert_eq!(withdraw_assets(Network::Mainnet, &out), [(56, "USDT".to_string())]);
    }

    #[test]
    fn what_can_be_withdrawn_is_read_per_asset_and_network() {
        let info = json!({
            "userDailyLimit": "10000", "userRemainingDailyLimit": "9000",
            "balances": {
                "USDT": {"currency": "USDT", "chainBalances": {
                    "1": {"chainId": 1, "perpMaxWithdrawAmount": "300", "chainLimit": "800", "withdrawFee": "1.50"},
                    "56": {"chainId": 56, "perpMaxWithdrawAmount": "300.500", "chainLimit": "120", "withdrawFee": "0.5"},
                    "97": {"chainId": 97, "perpMaxWithdrawAmount": "300", "withdrawFee": "0.1"},
                }},
                "DUST": {"currency": "DUST", "chainBalances": {
                    "56": {"chainId": 56, "perpMaxWithdrawAmount": "0.4", "withdrawFee": "0.5"},
                }},
                "ETH": {"currency": "ETH", "chainBalances": {
                    "56": {"chainId": 56, "perpMaxWithdrawAmount": "2", "withdrawFee": "0.001"},
                }},
            },
        });
        let allowed = vec![(56, "USDT".to_string()), (1, "USDT".to_string()), (56, "DUST".to_string())];
        let (list, daily) = withdrawables(Network::Mainnet, &info, &allowed);
        let shown: Vec<(u64, &str, String, String)> = list
            .iter()
            .map(|w| (w.chain_id, w.asset.as_str(), w.max.to_string(), w.fee.to_string()))
            .collect();
        assert_eq!(
            shown,
            [
                (56, "USDT", "120".to_string(), "0.5".to_string()),
                (1, "USDT", "300".to_string(), "1.5".to_string())
            ],
            "capped by the network's limit; the fee must leave something; unlisted assets and other networks are left out"
        );
        assert_eq!(
            daily,
            DailyLimit { limit: Some(Decimal::from(10_000)), left: Some(Decimal::from(9_000)) }
        );
        let (none, unknown) = withdrawables(Network::Mainnet, &json!({}), &allowed);
        assert!(none.is_empty() && unknown == DailyLimit::default());
    }

    fn withdrawal() -> Withdrawal {
        Withdrawal {
            chain: chain(Network::Mainnet, 56).expect("chain"),
            receiver: wallet(),
            asset: "USDT".into(),
            amount: "31".into(),
            fee: "0.3".into(),
            nonce: 1_761_210_000_000_000,
        }
    }

    #[test]
    fn a_withdrawal_is_typed_data_only_its_own_wallet_can_sign() {
        let withdrawal = withdrawal();
        let data = withdrawal.typed_data();
        assert_eq!(
            (&data["primaryType"], &data["domain"]["name"], &data["domain"]["chainId"]),
            (&json!("Action"), &json!("Aster"), &json!(56))
        );
        assert_eq!(
            data["message"],
            json!({
                "type": "Withdraw", "destination": WALLET, "destination Chain": "BSC", "token": "USDT",
                "amount": "31", "fee": "0.3", "nonce": "1761210000000000", "aster chain": "Mainnet",
            })
        );
        let names: Vec<&str> = data["types"]["Action"]
            .as_array()
            .expect("fields")
            .iter()
            .filter_map(|f| f["name"].as_str())
            .collect();
        assert_eq!(
            names,
            ["type", "destination", "destination Chain", "token", "amount", "fee", "nonce", "aster chain"]
        );

        // The hash and the signature another implementation (ethers) produces for the same typed data and key.
        assert_eq!(
            hex::encode(withdrawal.digest()),
            "7694cf481c966025a2e1b564a24edbb1bd3295c54513df7d38549a5394fa3ba9"
        );
        let key = AgentKey::parse(KEY).expect("key");
        let signature = key.sign_digest(&withdrawal.digest());
        assert_eq!(
            signature,
            "0x85844df5de9a19bd3c4f12d8f3be3e97ce966bac33e44e59ed5e6ea2870b511f6efc656a3bf0919b3d09a4c8bae6ee9dd556a5775d04a891724e4eaaa8fbcec51b"
        );
        assert_eq!(withdrawal.signer(&signature).expect("signer"), wallet());
        // Any change to what was signed points at some other address, so it is caught before anything is sent.
        let mut more = withdrawal.clone();
        more.amount = "310".into();
        assert_ne!(more.signer(&signature).expect("signer"), wallet());
        let mut elsewhere = withdrawal.clone();
        elsewhere.chain = chain(Network::Mainnet, 1).expect("chain");
        assert_ne!(elsewhere.signer(&signature).expect("signer"), wallet());
        assert!(withdrawal.signer("0x1234").is_err());
    }

    #[test]
    fn the_request_names_the_wallet_and_carries_both_nonces() {
        let request = withdrawal().request("0xabc", 1_761_210_000_123_456);
        assert_eq!(
            request,
            format!(
                "chainId=56&asset=USDT&amount=31&fee=0.3&receiver={WALLET}&userNonce=1761210000000000&signatureType=EOA&userSignature=0xabc&nonce=1761210000123456&user={WALLET}"
            )
        );
    }
}
