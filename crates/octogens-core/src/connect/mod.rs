//! Connecting a browser wallet with one approval.
//!
//! A desktop app cannot talk to a wallet extension: those live in the browser.
//! So the app serves one small page on this computer, the trader opens it in
//! the browser where their wallet is, and the wallet signs a single typed
//! message that approves the app's API wallet for perpetual trading.
//!
//! What crosses this bridge: the wallet's address and one signature. The main
//! wallet's key never leaves the wallet, the API wallet's key never leaves the
//! app, and the approval never grants withdrawal.
//!
//! The server listens on the loopback interface only, on a random port, behind
//! a random path, for a few minutes, and shuts down after one approval. Each
//! connection is served on its own, so an idle one cannot delay the others.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::error::{DeskError, Result};
use crate::exchange::signing::{APPROVAL_CHAIN_ID, Address, recover, typed_data};
use crate::exchange::{ExchangeClient, approval_message};
use crate::{bail, desk_err};

const PAGE: &str = include_str!("page.html");
/// How long the page waits for the trader before the offer lapses.
const LIFETIME: Duration = Duration::from_secs(600);
const MAX_REQUEST: usize = 64 * 1024;
/// How long a connection may take to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections served at the same time.
const MAX_CONNECTIONS: usize = 16;

/// A wallet's approval of an API wallet, accepted by the exchange.
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub user: Address,
    pub expires: DateTime<Utc>,
}

/// An approval page that is being served.
pub struct Pending {
    /// The page to open in the browser.
    pub url: String,
    /// Resolves once the exchange accepts an approval, or with the reason the offer ended.
    pub outcome: oneshot::Receiver<Result<Approval>>,
    /// Stops the server early.
    pub cancel: CancellationToken,
}

/// What the trader's wallet has been asked to sign.
struct Prepared {
    user: Address,
    nonce: u64,
    expires_ms: i64,
    message: String,
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

struct Server {
    client: Arc<ExchangeClient>,
    agent: Address,
    days: u32,
    token: String,
    port: u16,
    prepared: tokio::sync::Mutex<Option<Prepared>>,
}

impl Server {
    fn page(&self) -> Result<String> {
        let nonce = random_hex(16)?;
        let config = json!({"network": self.client.network().name(), "agent": self.agent.to_string(), "days": self.days});
        Ok(PAGE.replace("__NONCE__", &nonce).replace("__CONFIG__", &config.to_string()))
    }

    /// Builds the message for the wallet that just connected. The nonce is taken
    /// now, in the exchange's time, because the exchange only accepts it for a few seconds.
    async fn prepare(&self, body: &Value) -> Result<Value> {
        let user = Address::parse(body.get("account").and_then(Value::as_str).unwrap_or(""))?;
        if user == self.agent {
            bail!("Connect your own wallet, not the trading key.");
        }
        let nonce = self.client.nonce().await;
        let expires_ms = (nonce / 1000) as i64 + i64::from(self.days) * 86_400_000;
        let message = approval_message(&user, nonce, &self.agent, expires_ms);
        let typed = typed_data(APPROVAL_CHAIN_ID, &message);
        *self.prepared.lock().await = Some(Prepared { user, nonce, expires_ms, message });
        Ok(json!({"typedData": typed}))
    }

    /// Checks the signature really is the connected wallet's, then hands it to the exchange.
    async fn submit(&self, body: &Value) -> Result<Approval> {
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
            .register_agent(&prepared.user, prepared.nonce, &self.agent, prepared.expires_ms, signature)
            .await?;
        let expires = Utc.timestamp_millis_opt(prepared.expires_ms).single().unwrap_or_else(Utc::now);
        Ok(Approval { user: prepared.user, expires })
    }

    /// Serves one request. Returns the approval when this request completed it.
    async fn handle(&self, request: Request) -> (Vec<u8>, Option<Approval>) {
        // The Host check stops another site from reaching this page through a DNS name it controls.
        let local = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        let base = format!("/{}", self.token);
        if !local.contains(&request.host)
            || !(request.path == base || request.path.starts_with(&format!("{base}/")))
        {
            return (reply("404 Not Found", "text/plain; charset=utf-8", "Not found."), None);
        }
        let route = &request.path[base.len()..];
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        match (request.method.as_str(), route) {
            ("GET", "" | "/") => match self.page() {
                Ok(page) => (reply("200 OK", "text/html; charset=utf-8", &page), None),
                Err(error) => {
                    (reply("500 Internal Server Error", "text/plain; charset=utf-8", &error.0), None)
                }
            },
            ("POST", "/prepare") => match self.prepare(&body).await {
                Ok(data) => (json_reply("200 OK", &data), None),
                Err(error) => (json_reply("400 Bad Request", &json!({"error": error.0})), None),
            },
            ("POST", "/submit") => match self.submit(&body).await {
                Ok(approval) => (json_reply("200 OK", &json!({"ok": true})), Some(approval)),
                Err(error) => (json_reply("400 Bad Request", &json!({"error": error.0})), None),
            },
            _ => (reply("404 Not Found", "text/plain; charset=utf-8", "Not found."), None),
        }
    }
}

/// Starts serving the approval page for `agent` on `client`'s network.
pub async fn start(client: Arc<ExchangeClient>, agent: Address, days: u32) -> Result<Pending> {
    if !(1..=365).contains(&days) {
        bail!("Choose how long the approval lasts: between 1 and 365 days.");
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| desk_err!("The approval page could not start: {error}."))?;
    let port = listener
        .local_addr()
        .map_err(|error| desk_err!("The approval page could not start: {error}."))?
        .port();
    let server = Arc::new(Server {
        client,
        agent,
        days,
        token: random_hex(16)?,
        port,
        prepared: tokio::sync::Mutex::new(None),
    });
    let url = format!("http://127.0.0.1:{port}/{}", server.token);
    let (sender, outcome) = oneshot::channel();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();

    tokio::spawn(async move {
        let deadline = tokio::time::sleep(LIFETIME);
        tokio::pin!(deadline);
        // The connection that completes the approval reports it here.
        let (done, mut approved) = tokio::sync::mpsc::channel::<Approval>(1);
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
        let ended: DeskError = loop {
            tokio::select! {
                () = stop.cancelled() => break DeskError::new("The wallet approval was cancelled."),
                () = &mut deadline => break DeskError::new("The wallet approval page expired. Start it again when you are ready."),
                Some(approval) = approved.recv() => {
                    let _ = sender.send(Ok(approval));
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
                        let (response, approval) = server.handle(request).await;
                        let _ = stream.write_all(&response).await;
                        let _ = stream.shutdown().await;
                        if let Some(approval) = approval {
                            let _ = done.send(approval).await;
                        }
                    });
                }
            }
        };
        let _ = sender.send(Err(ended));
    });
    Ok(Pending { url, outcome, cancel })
}

#[cfg(test)]
mod tests;
