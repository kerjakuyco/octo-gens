//! The trader's browser wallet, reached from a desktop app.
//!
//! A desktop app cannot talk to a wallet extension: those live in the browser.
//! So the app serves one small page on this computer, the trader opens it in
//! the browser where their wallet is, and the wallet does one of three things
//! there:
//!
//! - **approves** the app's API wallet for perpetual trading, with one signed message;
//! - **deposits**, by sending a transaction to the exchange's vault;
//! - **withdraws**, by signing the withdrawal and the request that carries it.
//!
//! What crosses this bridge: the wallet's address, signatures, and the hash of
//! a transaction the wallet sent. The main wallet's key never leaves the
//! wallet, and the API wallet's key never leaves the app. The approval never
//! grants withdrawal: a withdrawal is signed by the main wallet each time, and
//! only ever goes back to that wallet.
//!
//! The server listens on the loopback interface only, on a random port, behind
//! a random path, for a few minutes, and shuts down when its one task is done.
//! Each connection is served on its own, so an idle one cannot delay the others.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::error::{DeskError, Result};
use crate::exchange::funding::{self, Chain, DepositAsset, Withdrawal};
use crate::exchange::signing::{APPROVAL_CHAIN_ID, Address, recover, typed_data};
use crate::exchange::{AGENT_NAME, ExchangeClient, approval_message};
use crate::model::Network;
use crate::{bail, desk_err};

const PAGE: &str = include_str!("page.html");
/// How long an approval page waits for the trader before the offer lapses.
const APPROVAL_LIFETIME: Duration = Duration::from_secs(600);
/// A deposit waits on the network between its steps, so its page stays longer.
const FUNDING_LIFETIME: Duration = Duration::from_secs(1200);
const MAX_REQUEST: usize = 64 * 1024;
/// How long a connection may take to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections served at the same time.
const MAX_CONNECTIONS: usize = 16;
/// How long the page tells the trader they have to sign an approval. The exchange
/// takes it for about this long after the message is made.
const APPROVAL_SECONDS: u64 = 10;
/// How long the page tells the trader they have for the signature that proves
/// who asks for a withdrawal. The exchange stops accepting it a little later.
const REQUEST_SECONDS: u64 = 45;
/// The finest amount a withdrawal may name.
const WITHDRAW_DECIMALS: u32 = 8;

/// What a page is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Task {
    /// Approve `agent` as the API wallet, for `days` days.
    Connect { agent: Address, days: u32 },
    /// Deposit from the trading wallet `account` to its trading account.
    Deposit { account: Address },
    /// Withdraw from the trading account back to the wallet `account`.
    Withdraw { account: Address },
}

/// A wallet's approval of an API wallet, accepted by the exchange.
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub user: Address,
    pub expires: DateTime<Utc>,
}

/// A deposit the trader's wallet sent.
#[derive(Clone, Debug, PartialEq)]
pub struct Deposit {
    pub chain: &'static Chain,
    pub asset: String,
    pub amount: String,
    /// The transaction, as the wallet named it.
    pub hash: String,
    /// What the network made of it, as far as the page saw: `None` when the page closed first.
    pub confirmed: Option<bool>,
}

/// A withdrawal the exchange accepted.
#[derive(Clone, Debug, PartialEq)]
pub struct Withdrawn {
    pub chain: &'static Chain,
    pub asset: String,
    pub amount: String,
    pub fee: String,
    /// The exchange's id for the request.
    pub id: String,
}

/// How a page's task ended well.
#[derive(Clone, Debug, PartialEq)]
pub enum Done {
    Approved(Approval),
    Deposited(Deposit),
    Withdrawn(Withdrawn),
}

/// A page that is being served.
pub struct Pending {
    /// The page to open in the browser.
    pub url: String,
    /// Resolves once the task is done, or with the reason the page ended.
    pub outcome: oneshot::Receiver<Result<Done>>,
    /// Stops the server early.
    pub cancel: CancellationToken,
}

/// The approval the trader's wallet has been asked to sign.
struct Prepared {
    user: Address,
    nonce: u64,
    expires_ms: i64,
    message: String,
}

/// A deposit the wallet was given the transactions for.
struct Planned {
    chain: &'static Chain,
    asset: String,
    amount: String,
    /// The deposit's transaction, once the wallet has sent it.
    hash: Option<String>,
}

/// How far a withdrawal has come.
enum Stage {
    /// The wallet was asked to sign the withdrawal.
    Asked(Withdrawal),
    /// The wallet signed it, and was asked to sign the request that carries it.
    Signed { withdrawal: Withdrawal, request: String },
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer)
        .map_err(|error| desk_err!("The system could not produce a random value: {error}."))?;
    Ok(hex::encode(buffer))
}

fn reply(status: &str, kind: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn json_reply(status: &str, body: &Value) -> Vec<u8> {
    reply(status, "application/json", &body.to_string())
}

struct Request {
    method: String,
    path: String,
    host: String,
    body: Vec<u8>,
}

/// Reads one small HTTP request. Anything oversized or malformed is dropped.
async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(position) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break position + 4;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 || buffer.len() + read > MAX_REQUEST {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let header = |name: &str| {
        head.split("\r\n").skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim().to_string())
        })
    };
    let length = header("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    if length > MAX_REQUEST {
        return None;
    }
    while buffer.len() < header_end + length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some(Request {
        method,
        path,
        host: header("host").unwrap_or_default(),
        body: buffer[header_end..header_end + length].to_vec(),
    })
}

/// `0x` and 64 hexadecimal digits: how a wallet names a transaction.
fn transaction_hash(body: &Value) -> Result<String> {
    let raw = body.get("hash").and_then(Value::as_str).unwrap_or("").trim();
    let digits = raw.strip_prefix("0x").unwrap_or("");
    if digits.len() != 64 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("The wallet did not return a transaction this app can read.");
    }
    Ok(format!("0x{}", digits.to_ascii_lowercase()))
}

struct Server {
    client: Arc<ExchangeClient>,
    task: Task,
    token: String,
    port: u16,
    prepared: tokio::sync::Mutex<Option<Prepared>>,
    /// What can be deposited, as last read, so a deposit is built from the list the trader chose from.
    offered: tokio::sync::Mutex<Vec<DepositAsset>>,
    planned: tokio::sync::Mutex<Option<Planned>>,
    stage: tokio::sync::Mutex<Option<Stage>>,
}

impl Server {
    fn network(&self) -> Network {
        self.client.network()
    }

    fn page(&self) -> Result<String> {
        let nonce = random_hex(16)?;
        let network = self.network();
        let mut config = json!({
            "app": AGENT_NAME,
            "network": network.name(),
            "real": network == Network::Mainnet,
        });
        match self.task {
            Task::Connect { agent, days } => {
                config["task"] = json!("connect");
                config["agent"] = json!(agent.to_string());
                config["days"] = json!(days);
                config["signingChain"] = funding::approval_chain().for_wallet();
            }
            Task::Deposit { account } => {
                config["task"] = json!("deposit");
                config["account"] = json!(account.to_string());
            }
            Task::Withdraw { account } => {
                config["task"] = json!("withdraw");
                config["account"] = json!(account.to_string());
            }
        }
        // `<` is escaped so that nothing in the data can end the script it sits in.
        let config = config.to_string().replace('<', "\\u003c");
        Ok(PAGE.replace("__NONCE__", &nonce).replace("__CONFIG__", &config))
    }

    /// Builds the message for the wallet that just connected. The nonce is taken
    /// now, in the exchange's time, because the exchange only accepts it for a few seconds.
    async fn prepare(&self, agent: Address, days: u32, body: &Value) -> Result<Value> {
        let user = Address::parse(body.get("account").and_then(Value::as_str).unwrap_or(""))?;
        if user == agent {
            bail!("Connect your own wallet, not the trading key.");
        }
        let nonce = self.client.nonce().await;
        let expires_ms = (nonce / 1000) as i64 + i64::from(days) * 86_400_000;
        let message = approval_message(&user, nonce, &agent, expires_ms);
        let typed = typed_data(APPROVAL_CHAIN_ID, &message);
        *self.prepared.lock().await = Some(Prepared { user, nonce, expires_ms, message });
        Ok(json!({"typedData": typed, "seconds": APPROVAL_SECONDS}))
    }

    /// Checks the signature really is the connected wallet's, then hands it to the exchange.
    async fn submit(&self, agent: Address, body: &Value) -> Result<Approval> {
        let signature = body.get("signature").and_then(Value::as_str).unwrap_or("");
        let Some(prepared) = self.prepared.lock().await.take() else {
            bail!("Start again: the approval was not prepared.");
        };
        let signer = recover(APPROVAL_CHAIN_ID, &prepared.message, signature)?;
        if signer != prepared.user {
            bail!(
                "The signature came from a different account than the one that connected. Try again with the same account."
            );
        }
        self.client
            .register_agent(&prepared.user, prepared.nonce, &agent, prepared.expires_ms, signature)
            .await?;
        let expires = Utc.timestamp_millis_opt(prepared.expires_ms).single().unwrap_or_else(Utc::now);
        Ok(Approval { user: prepared.user, expires })
    }

    /// The wallet in the browser must be the wallet this app trades with: a
    /// deposit is credited to it and a withdrawal is paid out to it.
    fn same_account(account: Address, body: &Value, why: &str) -> Result<()> {
        let connected = Address::parse(body.get("account").and_then(Value::as_str).unwrap_or(""))?;
        if connected != account {
            bail!("Switch your wallet to {account}. That is the wallet this app trades with, and {why}.");
        }
        Ok(())
    }

    fn chain_of(&self, body: &Value) -> Result<&'static Chain> {
        let id = body.get("chainId").and_then(Value::as_u64).unwrap_or(0);
        match funding::chain(self.network(), id) {
            Some(chain) => Ok(chain),
            None => bail!("Choose one of the networks listed."),
        }
    }

    /// The chains that have something listed, in the usual order.
    fn chains_with(&self, has: impl Fn(u64) -> bool) -> Vec<Value> {
        funding::chains(self.network()).iter().filter(|c| has(c.id)).map(Chain::for_wallet).collect()
    }

    async fn deposit_options(&self) -> Result<Value> {
        let assets = self.client.deposit_assets().await?;
        let chains = self.chains_with(|id| assets.iter().any(|asset| asset.chain_id == id));
        let listed: Vec<Value> = assets
            .iter()
            .map(|asset| {
                json!({
                    "chainId": asset.chain_id,
                    "name": asset.name,
                    "token": asset.token.map(|token| token.to_string()),
                    "decimals": asset.decimals,
                    "native": asset.token.is_none(),
                })
            })
            .collect();
        *self.offered.lock().await = assets;
        Ok(json!({"chains": chains, "assets": listed}))
    }

    /// Builds the transactions of one deposit. The vault they pay into is the one
    /// this app knows, and only when the exchange reports the same one now.
    async fn deposit_prepare(&self, account: Address, body: &Value) -> Result<Value> {
        Self::same_account(account, body, "a deposit is credited to it")?;
        let chain = self.chain_of(body)?;
        let name = body.get("asset").and_then(Value::as_str).unwrap_or("");
        let typed = body.get("amount").and_then(Value::as_str).unwrap_or("");
        let mut offered = self.offered.lock().await.clone();
        if offered.is_empty() {
            offered = self.client.deposit_assets().await?;
        }
        let Some(asset) = offered.iter().find(|asset| asset.chain_id == chain.id && asset.name == name)
        else {
            bail!("The exchange does not list that asset for deposits on {}.", chain.name);
        };
        let amount = funding::units(typed, asset.decimals)?;
        self.client.confirm_vault(chain).await?;
        let plan = funding::deposit_plan(chain, asset, &account, amount);
        // The amount as it will be shown and recorded: the number typed, tidied.
        let shown = typed.trim().parse::<Decimal>().map_or_else(|_| typed.trim().to_string(), funding::plain);
        *self.planned.lock().await =
            Some(Planned { chain, asset: asset.name.clone(), amount: shown.clone(), hash: None });
        let read = |call: &Option<funding::Call>| {
            call.as_ref().map(|c| json!({"to": c.to.to_string(), "data": c.data}))
        };
        Ok(json!({
            "chain": chain.for_wallet(),
            "asset": asset.name,
            "amount": shown,
            "vault": chain.vault().to_string(),
            "needed": format!("0x{:x}", plan.amount),
            "balance": read(&plan.balance),
            "allowance": read(&plan.allowance),
            "reset": read(&plan.reset),
            "approve": read(&plan.approve),
            "deposit": plan.deposit.to_json(),
        }))
    }

    /// Notes the transaction the wallet sent, so the deposit is known even if the page closes now.
    async fn deposit_sent(&self, body: &Value) -> Result<Value> {
        let hash = transaction_hash(body)?;
        match self.planned.lock().await.as_mut() {
            Some(planned) => planned.hash = Some(hash),
            None => bail!("Start again: the deposit was not prepared."),
        }
        Ok(json!({"ok": true}))
    }

    /// What the network made of the deposit, as the page saw it. This ends the page.
    async fn deposit_confirmed(&self, body: &Value) -> Result<Deposit> {
        let hash = transaction_hash(body)?;
        let Some(planned) = self.planned.lock().await.take() else {
            bail!("Start again: the deposit was not prepared.");
        };
        Ok(Deposit {
            chain: planned.chain,
            asset: planned.asset,
            amount: planned.amount,
            hash,
            confirmed: Some(body.get("ok").and_then(Value::as_bool) == Some(true)),
        })
    }

    /// A deposit the wallet sent but the page never saw confirmed, when the page ends.
    async fn deposit_left_open(&self) -> Option<Deposit> {
        let planned = self.planned.lock().await.take()?;
        Some(Deposit {
            chain: planned.chain,
            asset: planned.asset,
            amount: planned.amount,
            hash: planned.hash?,
            confirmed: None,
        })
    }

    async fn withdraw_options(&self) -> Result<Value> {
        let (list, daily) = self.client.withdrawables().await?;
        let chains = self.chains_with(|id| list.iter().any(|entry| entry.chain_id == id));
        let assets: Vec<Value> = list
            .iter()
            .map(|entry| {
                json!({
                    "chainId": entry.chain_id,
                    "name": entry.asset,
                    "max": funding::plain(entry.max),
                    "fee": funding::plain(entry.fee),
                })
            })
            .collect();
        let daily = (daily.limit.is_some() || daily.left.is_some()).then(
            || json!({"limit": daily.limit.map(funding::plain), "left": daily.left.map(funding::plain)}),
        );
        Ok(json!({"chains": chains, "assets": assets, "daily": daily}))
    }

    /// Builds the withdrawal for the wallet to sign. It names the wallet itself as
    /// the destination: there is no way to name another.
    async fn withdraw_prepare(&self, account: Address, body: &Value) -> Result<Value> {
        Self::same_account(account, body, "a withdrawal is paid out to it")?;
        let chain = self.chain_of(body)?;
        let name = body.get("asset").and_then(Value::as_str).unwrap_or("");
        let typed = body.get("amount").and_then(Value::as_str).unwrap_or("").trim();
        // Checked as a plain number first, so a sign or an exponent never reaches the exchange.
        funding::units(typed, 18)?;
        let Ok(amount) = typed.parse::<Decimal>() else {
            bail!("Enter an amount as a number, for example 25 or 25.5.");
        };
        if amount.normalize().scale() > WITHDRAW_DECIMALS {
            bail!("Use at most {WITHDRAW_DECIMALS} decimal places.");
        }
        let (list, _) = self.client.withdrawables().await?;
        let Some(entry) = list.iter().find(|entry| entry.chain_id == chain.id && entry.asset == name) else {
            bail!("There is no {name} to withdraw to {} right now.", chain.name);
        };
        if amount > entry.max {
            bail!("At most {} {name} can be withdrawn to {} now.", funding::plain(entry.max), chain.name);
        }
        let fee = self.client.withdraw_fee(chain, name).await?;
        if amount <= fee {
            bail!(
                "The exchange's fee of {} {name} is as much as this withdrawal. Enter more.",
                funding::plain(fee)
            );
        }
        let withdrawal = Withdrawal {
            chain,
            receiver: account,
            asset: entry.asset.clone(),
            amount: funding::plain(amount),
            fee: funding::plain(fee),
            nonce: self.client.nonce().await,
        };
        let answer = json!({
            "typedData": withdrawal.typed_data(),
            "chain": chain.for_wallet(),
            "asset": withdrawal.asset,
            "amount": withdrawal.amount,
            "fee": withdrawal.fee,
            "receiver": withdrawal.receiver.to_string(),
        });
        *self.stage.lock().await = Some(Stage::Asked(withdrawal));
        Ok(answer)
    }

    /// Takes the wallet's signature of the withdrawal and builds the request that
    /// carries it, for the wallet to sign next. Its nonce is taken now: the
    /// exchange accepts the request for about a minute.
    async fn withdraw_signed(&self, account: Address, body: &Value) -> Result<Value> {
        let signature = body.get("signature").and_then(Value::as_str).unwrap_or("").trim();
        let Some(Stage::Asked(withdrawal)) = self.stage.lock().await.take() else {
            bail!("Start again: the withdrawal was not prepared.");
        };
        if withdrawal.signer(signature)? != account {
            bail!(
                "The signature came from a different account than the wallet this app trades with. Nothing was sent."
            );
        }
        let request = withdrawal.request(signature, self.client.nonce().await);
        let typed = typed_data(self.network().chain_id(), &request);
        *self.stage.lock().await = Some(Stage::Signed { withdrawal, request });
        Ok(json!({"typedData": typed, "seconds": REQUEST_SECONDS}))
    }

    /// Checks the second signature is the same wallet's, then asks the exchange.
    async fn withdraw_submit(&self, account: Address, body: &Value) -> Result<Withdrawn> {
        let signature = body.get("signature").and_then(Value::as_str).unwrap_or("").trim();
        let Some(Stage::Signed { withdrawal, request }) = self.stage.lock().await.take() else {
            bail!("Start again: the withdrawal was not signed.");
        };
        if recover(self.network().chain_id(), &request, signature)? != account {
            bail!(
                "The signature came from a different account than the wallet this app trades with. Nothing was sent."
            );
        }
        let id = self.client.withdraw(&request, signature).await?;
        Ok(Withdrawn {
            chain: withdrawal.chain,
            asset: withdrawal.asset,
            amount: withdrawal.amount,
            fee: withdrawal.fee,
            id,
        })
    }

    /// Serves one request. Returns how the task ended when this request completed it.
    async fn handle(&self, request: Request) -> (Vec<u8>, Option<Done>) {
        // The Host check stops another site from reaching this page through a DNS name it controls.
        let local = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        let base = format!("/{}", self.token);
        let not_found = || (reply("404 Not Found", "text/plain; charset=utf-8", "Not found."), None);
        if !local.contains(&request.host)
            || !(request.path == base || request.path.starts_with(&format!("{base}/")))
        {
            return not_found();
        }
        let route = &request.path[base.len()..];
        if request.method == "GET" && matches!(route, "" | "/") {
            return match self.page() {
                Ok(page) => (reply("200 OK", "text/html; charset=utf-8", &page), None),
                Err(error) => {
                    (reply("500 Internal Server Error", "text/plain; charset=utf-8", &error.0), None)
                }
            };
        }
        if request.method != "POST" {
            return not_found();
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let ok = || json!({"ok": true});
        // A page answers only the requests of its own task.
        let outcome: Result<(Value, Option<Done>)> = match (self.task, route) {
            (Task::Connect { agent, days }, "/prepare") => {
                self.prepare(agent, days, &body).await.map(|data| (data, None))
            }
            (Task::Connect { agent, .. }, "/submit") => {
                self.submit(agent, &body).await.map(|approval| (ok(), Some(Done::Approved(approval))))
            }
            (Task::Deposit { .. }, "/deposit/options") => {
                self.deposit_options().await.map(|data| (data, None))
            }
            (Task::Deposit { account }, "/deposit/prepare") => {
                self.deposit_prepare(account, &body).await.map(|data| (data, None))
            }
            (Task::Deposit { .. }, "/deposit/sent") => {
                self.deposit_sent(&body).await.map(|data| (data, None))
            }
            (Task::Deposit { .. }, "/deposit/confirmed") => {
                self.deposit_confirmed(&body).await.map(|deposit| (ok(), Some(Done::Deposited(deposit))))
            }
            (Task::Withdraw { .. }, "/withdraw/options") => {
                self.withdraw_options().await.map(|data| (data, None))
            }
            (Task::Withdraw { account }, "/withdraw/prepare") => {
                self.withdraw_prepare(account, &body).await.map(|data| (data, None))
            }
            (Task::Withdraw { account }, "/withdraw/signed") => {
                self.withdraw_signed(account, &body).await.map(|data| (data, None))
            }
            (Task::Withdraw { account }, "/withdraw/submit") => {
                self.withdraw_submit(account, &body).await.map(|withdrawn| {
                    let id = withdrawn.id.clone();
                    (json!({"ok": true, "id": id}), Some(Done::Withdrawn(withdrawn)))
                })
            }
            _ => return not_found(),
        };
        match outcome {
            Ok((data, done)) => (json_reply("200 OK", &data), done),
            Err(error) => (json_reply("400 Bad Request", &json!({"error": error.0})), None),
        }
    }
}

/// Starts serving the page for `task` on `client`'s network.
pub async fn start(client: Arc<ExchangeClient>, task: Task) -> Result<Pending> {
    let (lifetime, what) = match task {
        Task::Connect { days, .. } => {
            if !(1..=365).contains(&days) {
                bail!("Choose how long the approval lasts: between 1 and 365 days.");
            }
            (APPROVAL_LIFETIME, "wallet approval")
        }
        Task::Deposit { .. } => (FUNDING_LIFETIME, "deposit"),
        Task::Withdraw { .. } => (FUNDING_LIFETIME, "withdrawal"),
    };
    let failed = |error: std::io::Error| desk_err!("The wallet page could not start: {error}.");
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(failed)?;
    let port = listener.local_addr().map_err(failed)?.port();
    let server = Arc::new(Server {
        client,
        task,
        token: random_hex(16)?,
        port,
        prepared: tokio::sync::Mutex::new(None),
        offered: tokio::sync::Mutex::new(Vec::new()),
        planned: tokio::sync::Mutex::new(None),
        stage: tokio::sync::Mutex::new(None),
    });
    let url = format!("http://127.0.0.1:{port}/{}", server.token);
    let (sender, outcome) = oneshot::channel();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();

    tokio::spawn(async move {
        let deadline = tokio::time::sleep(lifetime);
        tokio::pin!(deadline);
        // The connection that completes the task reports it here.
        let (done, mut finished) = tokio::sync::mpsc::channel::<Done>(1);
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
        let ended: DeskError = loop {
            tokio::select! {
                () = stop.cancelled() => break desk_err!("The {what} was cancelled."),
                () = &mut deadline => break desk_err!("The {what} page expired. Start it again when you are ready."),
                Some(result) = finished.recv() => {
                    let _ = sender.send(Ok(result));
                    return;
                }
                accepted = listener.accept() => {
                    let Ok((mut stream, _)) = accepted else {
                        continue;
                    };
                    // More at once than one person and one page can need: let it go.
                    let Ok(slot) = Arc::clone(&slots).try_acquire_owned() else {
                        continue;
                    };
                    // Each connection is served on its own. A browser may open one and send nothing for a
                    // while, and that must not hold up the request that carries the signature: the exchange only
                    // accepts the approval for a few seconds.
                    let (server, done) = (Arc::clone(&server), done.clone());
                    tokio::spawn(async move {
                        let _slot = slot;
                        let Ok(Some(request)) = tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await else {
                            return;
                        };
                        let (response, result) = server.handle(request).await;
                        let _ = stream.write_all(&response).await;
                        let _ = stream.shutdown().await;
                        if let Some(result) = result {
                            let _ = done.send(result).await;
                        }
                    });
                }
            }
        };
        // A deposit the wallet already sent is a fact, however the page ended.
        let outcome = match server.deposit_left_open().await {
            Some(deposit) => Ok(Done::Deposited(deposit)),
            None => Err(ended),
        };
        let _ = sender.send(outcome);
    });
    Ok(Pending { url, outcome, cancel })
}

#[cfg(test)]
mod tests;
