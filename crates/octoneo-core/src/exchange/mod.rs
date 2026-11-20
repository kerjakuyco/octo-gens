//! The exchange's perpetual futures: market data, the account, and orders.
//!
//! One [`ExchangeClient`] talks to one network. Market data is public. Everything
//! about an account is signed by an API wallet (see [`signing`]) that the
//! trader's main wallet approved for trading; the app never holds the main
//! wallet's key and never asks for withdrawal permission. Funds move only by
//! what that main wallet signs itself (see [`funding`]).
//!
//! Requests that change something are sent exactly once. If the answer is lost,
//! the caller is told to check the exchange before trying again; only public reads are
//! retried.

pub mod funding;
pub mod signing;

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, TimeZone, Utc};
use reqwest::{Client, Method};
use rust_decimal::Decimal;
use serde_json::Value;

use crate::error::{DeskError, Result};
use crate::model::{
    Account, AssetBalance, Candle, DayStats, Market, Network, OpenOrder, OrderAck, OrderBook, Position,
    Quote, Side, Timeframe, decimal_text, non_negative, positive, signed,
};
use crate::net::unreachable;
use crate::{bail, desk_err};
use funding::{Chain, DailyLimit, DepositAsset, Withdrawable};
use signing::{APPROVAL_CHAIN_ID, Address, AgentKey, Nonces, encode_params};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// The market list is large and changes rarely.
const MARKETS_TTL: Duration = Duration::from_secs(900);
/// How long a measured clock offset is trusted.
const CLOCK_TTL: Duration = Duration::from_secs(1800);
const BODY_LIMIT: usize = 24_000_000;
/// Most candles asked for in one call.
pub const MAX_CANDLES: usize = 500;
/// The name an API wallet approved from this app carries on the exchange.
pub const AGENT_NAME: &str = "OctoNeo";

impl Network {
    /// The exchange's futures API origin for this network.
    pub fn api(self) -> &'static str {
        match self {
            Network::Mainnet => "https://fapi.asterdex.com",
            Network::Testnet => "https://fapi.asterdex-testnet.com",
        }
    }

    /// Chain id in the EIP-712 domain of requests signed by an API wallet.
    pub fn chain_id(self) -> u64 {
        match self {
            Network::Mainnet => 1666,
            Network::Testnet => 714,
        }
    }

    /// The exchange's site. Its public API says what can be deposited and
    /// withdrawn, and its pages are where a trader manages API wallets.
    pub fn site(self) -> &'static str {
        match self {
            Network::Mainnet => "https://www.asterdex.com",
            Network::Testnet => "https://www.asterdex-testnet.com",
        }
    }
}

/// The trading identity for one network.
#[derive(Clone, Debug)]
pub struct Wallet {
    /// The trader's main wallet. Only its address is known here.
    pub user: Address,
    /// The API wallet the app signs with.
    pub agent: AgentKey,
    /// When the approval ends, if the app made it and so knows.
    pub expires: Option<DateTime<Utc>>,
}

/// Why a request to the exchange failed.
#[derive(Debug)]
pub struct Failure {
    /// HTTP status, or `None` when no response arrived.
    pub status: Option<u16>,
    /// The exchange's own error code, e.g. `-2019`.
    pub code: Option<i64>,
    pub message: String,
}

impl Failure {
    fn transport(&self) -> bool {
        self.status.is_none()
    }

    /// The request may have been carried out even though no success came back:
    /// no answer arrived, the exchange's own side failed (its documentation says a 5xx
    /// leaves the execution status unknown), the exchange says it does not know, or it
    /// answered a success that cannot be read.
    fn outcome_unknown(&self) -> bool {
        match (self.status, self.code) {
            (None, _) | (_, Some(-1006 | -1007)) => true,
            (Some(status), _) if status >= 500 => true,
            (Some(status), None) => (200..300).contains(&status),
            _ => false,
        }
    }

    /// The exchange answers every account call this way until the main wallet has deposited.
    pub fn needs_deposit(&self) -> bool {
        self.code == Some(-5050)
    }
}

/// The quotes a bare asset name prefers, the deepest first: `BTC` is `BTCUSDT`.
const BARE_QUOTES: [&str; 3] = ["USDT", "USD1", "USDC"];

/// The markets of a network, in the venue's order.
#[derive(Debug, Default)]
pub struct Markets {
    list: Vec<Market>,
    index: HashMap<String, usize>,
    /// What the financial news calls the markets that are not coins, by base
    /// asset or company name in capitals: `NVDA` and `NVIDIA` are `NVDA`, `XAU` is `GC=F`.
    news: HashMap<String, String>,
}

impl Markets {
    pub fn new(list: Vec<Market>) -> Self {
        let index = list.iter().enumerate().map(|(i, m)| (m.symbol.clone(), i)).collect();
        Self { list, index, news: HashMap::new() }
    }

    fn with_news(mut self, news: HashMap<String, String>) -> Self {
        self.news = news;
        self
    }

    /// The ticker the financial news uses for a share, a fund or a commodity
    /// this network lists, given its market (`NVDAUSDT`), its base asset
    /// (`NVDA`) or the company's name (`nvidia`). `None` for a coin and for
    /// anything not listed: the news about coins is not filed by ticker.
    pub fn news_symbol(&self, word: &str) -> Option<&str> {
        let word = word.trim().trim_start_matches('$').to_uppercase();
        let base = self.get(&word).map_or(word.as_str(), |market| market.base.as_str());
        self.news.get(base).map(String::as_str)
    }

    /// The other words that mean the same to the news as a ticker does: the
    /// company's name, in lower case. A newsroom writes "Nvidia", not `NVDA`.
    pub fn news_names(&self, symbol: &str) -> Vec<String> {
        let mut names: Vec<String> = self
            .news
            .iter()
            .filter(|(name, filed)| filed.as_str() == symbol && name.as_str() != symbol)
            .map(|(name, _)| name.to_lowercase())
            .collect();
        names.sort_unstable();
        names
    }

    pub fn all(&self) -> &[Market] {
        &self.list
    }

    pub fn get(&self, symbol: &str) -> Option<&Market> {
        self.index.get(symbol).map(|i| &self.list[*i])
    }

    /// One market per base asset, in the venue's order: the one a bare asset name
    /// resolves to. Several markets trade bitcoin; news about bitcoin is about `BTCUSDT`.
    pub fn one_per_asset(&self) -> Vec<&Market> {
        let rank = |market: &Market| {
            BARE_QUOTES.iter().position(|quote| *quote == market.quote).unwrap_or(BARE_QUOTES.len())
        };
        let mut best: HashMap<&str, &Market> = HashMap::new();
        for market in &self.list {
            let chosen = best.entry(market.base.as_str()).or_insert(market);
            if rank(market) < rank(chosen) {
                *chosen = market;
            }
        }
        self.list
            .iter()
            .filter(|market| best.get(market.base.as_str()).is_some_and(|b| std::ptr::eq(*b, *market)))
            .collect()
    }

    /// Resolves what a person or a model typed (`btc`, `$BTC`, `BTCUSDT`,
    /// `BTC/USDT`, `BTC-PERP`) to a market. A bare asset name prefers its USDT
    /// market. Nothing is guessed: an unknown name is an error.
    pub fn resolve(&self, raw: &str) -> Result<&Market> {
        let text = raw.trim().trim_start_matches('$').to_uppercase();
        if text.is_empty() {
            bail!("Name a market, for example BTC or BTCUSDT.");
        }
        let compact = text.replace('/', "");
        let stripped = compact
            .strip_suffix("-PERP")
            .or_else(|| compact.strip_suffix("PERP"))
            .unwrap_or(&compact)
            .to_string();
        for candidate in [&text, &compact, &stripped] {
            if let Some(market) = self.get(candidate) {
                return Ok(market);
            }
        }
        // A bare asset: prefer the deepest quote first.
        for quote in BARE_QUOTES {
            if let Some(market) = self.list.iter().find(|m| m.base == stripped && m.quote == quote) {
                return Ok(market);
            }
        }
        match self.list.iter().find(|m| m.base == stripped) {
            Some(market) => Ok(market),
            None => bail!(
                "There is no perpetual market for {}. Search the market list for the exact symbol.",
                raw.trim()
            ),
        }
    }
}

/// A 24-hour ticker reading.
#[derive(Clone, Debug, PartialEq)]
pub struct Tick {
    pub price: Decimal,
    pub as_of: DateTime<Utc>,
    pub stats: DayStats,
}

/// Mark price and funding of a market.
#[derive(Clone, Debug, PartialEq)]
pub struct Premium {
    pub mark: Decimal,
    pub index: Option<Decimal>,
    pub funding_rate: Option<Decimal>,
    pub next_funding: Option<DateTime<Utc>>,
}

/// One print from the tape.
#[derive(Clone, Debug, PartialEq)]
pub struct Trade {
    pub time: DateTime<Utc>,
    pub price: Decimal,
    pub qty: Decimal,
    /// The side that took liquidity: a buy lifted the ask.
    pub taker: Side,
}

/// What to send as an order. Quantities and prices must already fit the market's rules.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderRequest {
    pub symbol: String,
    pub side: Side,
    pub kind: OrderKind,
    pub qty: Decimal,
    pub reduce_only: bool,
    /// Our id for the order, so a lost answer can be looked up instead of guessed at.
    pub client_id: String,
}

/// What came of sending an order.
#[derive(Debug)]
pub enum Placement {
    /// The exchange took the order.
    Accepted(OrderAck),
    /// The exchange turned the order down. Nothing was placed.
    Rejected(DeskError),
    /// No usable answer arrived, so the order may or may not exist. The text says what happened.
    Unknown(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum OrderKind {
    Market,
    /// Resting limit order used by grid bots. `post_only` uses `GTX` so it never crosses the spread as a taker.
    Limit {
        price: Decimal,
        post_only: bool,
    },
    /// Closes at market once the mark price reaches the trigger, limiting a loss.
    StopMarket {
        trigger: Decimal,
    },
    /// Closes at market once the mark price reaches the trigger, taking a profit.
    TakeProfitMarket {
        trigger: Decimal,
    },
}

/// Why the exchange could not be reached, said without its host name.
fn unreached(error: reqwest::Error) -> DeskError {
    let text = unreachable("the exchange", error).0;
    // The shared wording may open a sentence with the host.
    let mut letters = text.chars();
    match letters.next() {
        Some(first) => DeskError::new(format!("{}{}", first.to_uppercase(), letters.as_str())),
        None => DeskError::new(text),
    }
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn field(data: &Value, key: &str) -> Option<String> {
    data.get(key).and_then(text)
}

fn amount(data: &Value, key: &str) -> Option<Decimal> {
    field(data, key).and_then(|raw| non_negative(&raw).ok())
}

fn signed_amount(data: &Value, key: &str) -> Option<Decimal> {
    field(data, key).and_then(|raw| signed(&raw).ok())
}

fn price(data: &Value, key: &str) -> Option<Decimal> {
    field(data, key).and_then(|raw| positive(&raw).ok())
}

fn millis(data: &Value, key: &str) -> Option<DateTime<Utc>> {
    let stamp = field(data, key)?.parse::<i64>().ok()?;
    Utc.timestamp_millis_opt(stamp).single().filter(|_| stamp > 0)
}

fn filter<'a>(symbol: &'a Value, kind: &str) -> Option<&'a Value> {
    symbol.get("filters")?.as_array()?.iter().find(|f| f["filterType"] == kind)
}

fn market_from(symbol: &Value) -> Option<Market> {
    if symbol["status"] != "TRADING" || symbol["contractType"] != "PERPETUAL" {
        return None;
    }
    // Market orders have their own lot rules; fall back to the general ones.
    let lot = filter(symbol, "MARKET_LOT_SIZE").or_else(|| filter(symbol, "LOT_SIZE"))?;
    Some(Market {
        symbol: field(symbol, "symbol")?,
        base: field(symbol, "baseAsset")?,
        quote: field(symbol, "quoteAsset")?,
        tick: filter(symbol, "PRICE_FILTER").and_then(|f| price(f, "tickSize")).unwrap_or_default(),
        step: price(lot, "stepSize")?,
        min_qty: price(lot, "minQty")?,
        max_qty: price(lot, "maxQty")?,
        min_notional: filter(symbol, "MIN_NOTIONAL").and_then(|f| amount(f, "notional")).unwrap_or_default(),
        maint_margin: amount(symbol, "maintMarginPercent")
            .map(|pct| pct / Decimal::from(100))
            .unwrap_or(Decimal::new(25, 3)),
    })
}

/// Futures the news files a commodity under.
const COMMODITIES: [(&str, &str); 8] = [
    ("XAU", "GC=F"),
    ("XAG", "SI=F"),
    ("XPT", "PL=F"),
    ("XPD", "PA=F"),
    ("XCU", "HG=F"),
    ("CL", "CL=F"),
    ("BZ", "BZ=F"),
    ("NATGAS", "NG=F"),
];

/// What the news calls each listed share, fund and commodity. The exchange
/// says what a market tracks and, for most shares, the company's name.
fn news_symbols(rows: &[Value]) -> HashMap<String, String> {
    let words = |row: &Value, key: &str| -> Vec<String> {
        let listed = row.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        listed.iter().filter_map(Value::as_str).map(str::to_string).collect()
    };
    let mut symbols = HashMap::new();
    let mut names: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows.iter().filter(|row| row["status"] == "TRADING" && row["contractType"] == "PERPETUAL") {
        let Some(base) = field(row, "baseAsset") else {
            continue;
        };
        let kinds = words(row, "underlyingSubType");
        let is = |kind: &str| kinds.iter().any(|listed| listed.eq_ignore_ascii_case(kind));
        // A company that is not listed anywhere yet has no ticker, and whoever does trade under these letters is someone else.
        if is("pre-launch") {
            continue;
        }
        if is("Commodities") {
            if let Some((_, future)) = COMMODITIES.iter().find(|(asset, _)| *asset == base) {
                symbols.insert(base, (*future).to_string());
            }
            continue;
        }
        if !is("STOCK") && !is("ETF") {
            continue;
        }
        for tag in words(row, "tags") {
            // A one-word name such as "Nvidia". "Stock" and "ETF" say what it is, not who.
            let name = tag.len() >= 3 && tag.chars().all(|c| c.is_ascii_alphabetic());
            if name && !tag.eq_ignore_ascii_case("stock") && !tag.eq_ignore_ascii_case("etf") {
                names.entry(tag.to_uppercase()).or_default().push(base.clone());
            }
        }
        symbols.insert(base.clone(), base);
    }
    for (name, mut bases) in names {
        bases.sort_unstable();
        bases.dedup();
        // A name two markets share ("Strategy") does not say which one is meant.
        if let [only] = bases.as_slice() {
            symbols.entry(name).or_insert_with(|| only.clone());
        }
    }
    symbols
}

fn tick_from(row: &Value) -> Option<Tick> {
    Some(Tick {
        price: price(row, "lastPrice")?,
        as_of: millis(row, "closeTime").unwrap_or_else(Utc::now),
        stats: DayStats {
            change_pct: field(row, "priceChangePercent").and_then(|raw| raw.parse().ok()),
            high: price(row, "highPrice"),
            low: price(row, "lowPrice"),
            volume: amount(row, "volume"),
            quote_volume: amount(row, "quoteVolume"),
        },
    })
}

fn premium_from(row: &Value) -> Option<Premium> {
    Some(Premium {
        mark: price(row, "markPrice")?,
        index: price(row, "indexPrice"),
        funding_rate: signed_amount(row, "lastFundingRate"),
        next_funding: millis(row, "nextFundingTime"),
    })
}

fn position_from(row: &Value) -> Option<Position> {
    Some(Position {
        symbol: field(row, "symbol")?,
        amount: signed_amount(row, "positionAmt")?,
        entry_price: amount(row, "entryPrice").unwrap_or_default(),
        mark_price: amount(row, "markPrice").unwrap_or_default(),
        liquidation_price: price(row, "liquidationPrice"),
        leverage: field(row, "leverage")
            .and_then(|raw| raw.parse::<f64>().ok())
            .map_or(1, |l| l.max(1.0) as u32),
        isolated: field(row, "marginType").is_some_and(|kind| kind.eq_ignore_ascii_case("isolated")),
        unrealized_pnl: signed_amount(row, "unRealizedProfit").unwrap_or_default(),
        notional: signed_amount(row, "notional").unwrap_or_default(),
        isolated_margin: amount(row, "isolatedMargin").unwrap_or_default(),
    })
}

fn ack_from(data: &Value, symbol: &str, client_id: &str) -> Option<OrderAck> {
    Some(OrderAck {
        order_id: field(data, "orderId")?,
        client_id: field(data, "clientOrderId").unwrap_or_else(|| client_id.to_string()),
        symbol: symbol.to_string(),
        status: field(data, "status").unwrap_or_else(|| "NEW".to_string()),
        executed_qty: amount(data, "executedQty").unwrap_or_default(),
        avg_price: amount(data, "avgPrice").unwrap_or_default(),
    })
}

fn order_from(row: &Value) -> Option<OpenOrder> {
    Some(OpenOrder {
        id: field(row, "orderId")?,
        client_id: field(row, "clientOrderId").unwrap_or_default(),
        symbol: field(row, "symbol")?,
        side: Side::parse(&field(row, "side")?).ok()?,
        kind: field(row, "type").unwrap_or_default(),
        price: price(row, "price"),
        stop_price: price(row, "stopPrice"),
        qty: amount(row, "origQty").unwrap_or_default(),
        filled: amount(row, "executedQty").unwrap_or_default(),
        reduce_only: row["reduceOnly"] == true || row["closePosition"] == true,
        status: field(row, "status").unwrap_or_default(),
        time: millis(row, "time").or_else(|| millis(row, "updateTime")).unwrap_or_else(Utc::now),
    })
}

/// The message a main wallet signs to approve an API wallet for perpetual
/// trading only. The field order is fixed by the exchange; `canWithdraw` is always false.
pub fn approval_message(user: &Address, nonce: u64, agent: &Address, expires_ms: i64) -> String {
    format!(
        "user={user}&nonce={nonce}&agentName={AGENT_NAME}&agentAddress={agent}&expired={expires_ms}&signatureChainId={APPROVAL_CHAIN_ID}&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist="
    )
}

pub struct ExchangeClient {
    network: Network,
    base: String,
    /// Origin of the site's public API.
    site: String,
    http: Client,
    wallet: RwLock<Option<Arc<Wallet>>>,
    nonces: Nonces,
    /// Server time minus local time, in microseconds.
    clock_offset: AtomicI64,
    clock_checked: Mutex<Option<Instant>>,
    markets: Mutex<Option<(Instant, Arc<Markets>)>>,
}

impl ExchangeClient {
    pub fn new(network: Network, http: Client) -> Self {
        Self {
            network,
            base: network.api().to_string(),
            site: network.site().to_string(),
            http,
            wallet: RwLock::new(None),
            nonces: Nonces::default(),
            clock_offset: AtomicI64::new(0),
            clock_checked: Mutex::new(None),
            markets: Mutex::new(None),
        }
    }

    /// Points the client at another origin, for the futures API and the site's
    /// public API alike. Used by tests and by `OCTONEO_*_URL`.
    pub fn with_base(mut self, base: &str) -> Self {
        self.base = base.trim_end_matches('/').to_string();
        self.site = self.base.clone();
        self
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn set_wallet(&self, wallet: Option<Wallet>) {
        *self.wallet.write().unwrap_or_else(|p| p.into_inner()) = wallet.map(Arc::new);
    }

    pub fn wallet(&self) -> Option<Arc<Wallet>> {
        self.wallet.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn malformed(&self) -> DeskError {
        desk_err!("The exchange returned a response this desk does not understand.")
    }

    fn deposit_notice(&self) -> String {
        "Trading and account data start after this wallet's first deposit. Make a deposit, then try again."
            .to_string()
    }

    /// Whether an error from this client says the wallet has not deposited yet.
    /// That is a state to show, not a fault.
    pub fn is_deposit_notice(&self, error: &DeskError) -> bool {
        error.0 == self.deposit_notice()
    }

    /// Turns a failure into something the trader can act on.
    pub fn explain(&self, failure: Failure) -> DeskError {
        match (failure.status, failure.code) {
            (None, _) => DeskError::new(failure.message),
            (_, Some(-5050)) => DeskError::new(self.deposit_notice()),
            (_, Some(-1022)) => desk_err!(
                "The exchange rejected the API wallet's signature. Its approval may have expired or been revoked; reconnect the wallet."
            ),
            (_, Some(-4168)) => desk_err!(
                "Your account is in Multi-Assets mode, which allows only cross margin. Draft the ticket again and it will use cross margin."
            ),
            (_, Some(-1021 | -4225 | -4226)) => desk_err!(
                "The exchange rejected the request's timing ({}). Check this computer's clock, then try again.",
                failure.message
            ),
            (Some(403), None) => desk_err!(
                "The exchange refused the request (403). Your network or region may be blocked; try another network or a VPN."
            ),
            (Some(418 | 429), _) => {
                desk_err!("The exchange is rate limiting this app. Wait a minute, then try again.")
            }
            (_, Some(code)) => desk_err!("Exchange: {} (code {code})", failure.message.trim_end_matches('.')),
            (Some(status), None) => desk_err!("Exchange ({status}): {}", failure.message),
        }
    }

    async fn send(&self, method: Method, path: &str, query: &str) -> std::result::Result<Value, Failure> {
        let separator = if query.is_empty() { "" } else { "?" };
        let url = format!("{}{path}{separator}{query}", self.base);
        let request = self
            .http
            .request(method, &url)
            .timeout(REQUEST_TIMEOUT)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded");
        let transport =
            |error: reqwest::Error| Failure { status: None, code: None, message: unreached(error).0 };
        let response = request.send().await.map_err(transport)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(transport)?;
        if bytes.len() > BODY_LIMIT {
            return Err(Failure {
                status: Some(status.as_u16()),
                code: None,
                message: "the response was unexpectedly large".into(),
            });
        }
        let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
        // The exchange reports errors as {"code": -1121, "msg": "..."}; success may carry {"code": 200}.
        let code =
            parsed.as_ref().and_then(|v| v.get("code")).and_then(Value::as_i64).filter(|code| *code < 0);
        if !status.is_success() || code.is_some() {
            let message = parsed
                .as_ref()
                .and_then(|v| field(v, "msg"))
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed").to_string());
            return Err(Failure {
                status: Some(status.as_u16()),
                code,
                message: message.chars().take(240).collect(),
            });
        }
        parsed.ok_or(Failure {
            status: Some(status.as_u16()),
            code: None,
            message: "the response was not JSON".into(),
        })
    }

    /// A public read. Repeated once if no answer arrives.
    async fn public(&self, path: &str, pairs: &[(&str, String)]) -> std::result::Result<Value, Failure> {
        let query = encode_params(pairs);
        match self.send(Method::GET, path, &query).await {
            Err(failure) if failure.transport() => {
                tokio::time::sleep(Duration::from_millis(300)).await;
                self.send(Method::GET, path, &query).await
            }
            other => other,
        }
    }

    /// Measures how far this computer's clock is from the exchange's, so nonces land in its window.
    async fn sync_clock(&self) {
        let fresh = self
            .clock_checked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some_and(|at| at.elapsed() < CLOCK_TTL);
        if fresh {
            return;
        }
        if let Ok(data) = self.public("/fapi/v3/time", &[]).await
            && let Some(server_ms) = data.get("serverTime").and_then(Value::as_i64)
        {
            let local = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_micros() as i64)
                .unwrap_or(0);
            self.clock_offset.store(server_ms * 1000 - local, Ordering::SeqCst);
            *self.clock_checked.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        }
    }

    /// A nonce in the exchange's time.
    pub async fn nonce(&self) -> u64 {
        self.sync_clock().await;
        self.nonces.next(self.clock_offset.load(Ordering::SeqCst))
    }

    /// The connected wallet, or a message telling the trader how to get one.
    fn require_wallet(&self) -> Result<Arc<Wallet>> {
        match self.wallet() {
            Some(wallet) => Ok(wallet),
            None => bail!("Connect a wallet on {} first. You can do that in Settings.", self.network.name()),
        }
    }

    /// A request signed by the API wallet. Sent once.
    async fn signed(
        &self,
        wallet: &Wallet,
        method: Method,
        path: &str,
        mut pairs: Vec<(&str, String)>,
    ) -> std::result::Result<Value, Failure> {
        pairs.push(("nonce", self.nonce().await.to_string()));
        pairs.push(("signer", wallet.agent.address().to_string()));
        // The string that is signed is the string that is sent, byte for byte.
        let params = encode_params(&pairs);
        let signature = wallet.agent.sign(self.network.chain_id(), &params);
        self.send(method, path, &format!("{params}&signature={signature}")).await
    }

    async fn signed_or_explain(
        &self,
        method: Method,
        path: &str,
        pairs: Vec<(&str, String)>,
    ) -> Result<Value> {
        let wallet = self.require_wallet()?;
        self.signed(&wallet, method, path, pairs).await.map_err(|failure| self.explain(failure))
    }

    /// Every perpetual market that is trading now. Cached for a while.
    pub async fn markets(&self) -> Result<Arc<Markets>> {
        if let Some((at, markets)) = self.markets.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
            && at.elapsed() < MARKETS_TTL
        {
            return Ok(Arc::clone(markets));
        }
        let data = self.public("/fapi/v3/exchangeInfo", &[]).await.map_err(|f| self.explain(f))?;
        let rows = data.get("symbols").and_then(Value::as_array).ok_or_else(|| self.malformed())?;
        let list: Vec<Market> = rows.iter().filter_map(market_from).collect();
        if list.is_empty() {
            bail!("No perpetual markets are listed right now.");
        }
        let markets = Arc::new(Markets::new(list).with_news(news_symbols(rows)));
        *self.markets.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((Instant::now(), Arc::clone(&markets)));
        Ok(markets)
    }

    /// Resolves user or model input to a market on this network.
    pub async fn market(&self, raw: &str) -> Result<Market> {
        Ok(self.markets().await?.resolve(raw)?.clone())
    }

    pub async fn ticker(&self, symbol: &str) -> Result<Tick> {
        let data = self
            .public("/fapi/v3/ticker/24hr", &[("symbol", symbol.to_string())])
            .await
            .map_err(|f| self.explain(f))?;
        tick_from(&data).ok_or_else(|| self.malformed())
    }

    /// Tickers of every market in one call, for refreshing a watchlist cheaply.
    pub async fn tickers(&self) -> Result<HashMap<String, Tick>> {
        let data = self.public("/fapi/v3/ticker/24hr", &[]).await.map_err(|f| self.explain(f))?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        Ok(rows.iter().filter_map(|row| Some((field(row, "symbol")?, tick_from(row)?))).collect())
    }

    pub async fn premium(&self, symbol: &str) -> Result<Premium> {
        let data = self
            .public("/fapi/v3/premiumIndex", &[("symbol", symbol.to_string())])
            .await
            .map_err(|f| self.explain(f))?;
        premium_from(&data).ok_or_else(|| self.malformed())
    }

    /// Mark price and funding of every market in one call.
    pub async fn premiums(&self) -> Result<HashMap<String, Premium>> {
        let data = self.public("/fapi/v3/premiumIndex", &[]).await.map_err(|f| self.explain(f))?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        Ok(rows.iter().filter_map(|row| Some((field(row, "symbol")?, premium_from(row)?))).collect())
    }

    /// Up to `limit` candles, oldest first. The newest is still forming.
    pub async fn candles(&self, symbol: &str, timeframe: Timeframe, limit: usize) -> Result<Vec<Candle>> {
        let limit = limit.clamp(1, MAX_CANDLES);
        let pairs = [
            ("symbol", symbol.to_string()),
            ("interval", timeframe.as_str().to_string()),
            ("limit", limit.to_string()),
        ];
        let data = self.public("/fapi/v3/klines", &pairs).await.map_err(|f| self.explain(f))?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        let mut candles = Vec::with_capacity(rows.len());
        for row in rows {
            let cell = |index: usize| row.get(index).and_then(text).ok_or_else(|| self.malformed());
            let value = |index: usize| cell(index).and_then(|raw| positive(&raw));
            candles.push(Candle {
                t: cell(0)?.parse::<i64>().map_err(|_| self.malformed())?,
                o: value(1)?,
                h: value(2)?,
                l: value(3)?,
                c: value(4)?,
                v: cell(5).and_then(|raw| non_negative(&raw))?,
            });
        }
        candles.sort_by_key(|c| c.t);
        candles.dedup_by_key(|c| c.t);
        if candles.len() > limit {
            candles.drain(..candles.len() - limit);
        }
        Ok(candles)
    }

    /// The order book near the top. `limit` is rounded to a size the exchange offers.
    pub async fn depth(&self, symbol: &str, limit: usize) -> Result<OrderBook> {
        let limit = [5, 10, 20, 50, 100, 500, 1000].into_iter().find(|size| *size >= limit).unwrap_or(1000);
        let pairs = [("symbol", symbol.to_string()), ("limit", limit.to_string())];
        let data = self.public("/fapi/v3/depth", &pairs).await.map_err(|f| self.explain(f))?;
        let levels = |key: &str| -> Result<Vec<(Decimal, Decimal)>> {
            let rows = data.get(key).and_then(Value::as_array).ok_or_else(|| self.malformed())?;
            rows.iter()
                .map(|row| {
                    let cell = |index: usize| row.get(index).and_then(text).ok_or_else(|| self.malformed());
                    Ok((positive(&cell(0)?)?, non_negative(&cell(1)?)?))
                })
                .collect()
        };
        Ok(OrderBook {
            bids: levels("bids")?,
            asks: levels("asks")?,
            as_of: millis(&data, "E").unwrap_or_else(Utc::now),
        })
    }

    /// Contracts open in a market, in base units.
    pub async fn open_interest(&self, symbol: &str) -> Result<Decimal> {
        let pairs = [("symbol", symbol.to_string())];
        let data = self.public("/fapi/v3/openInterest", &pairs).await.map_err(|f| self.explain(f))?;
        amount(&data, "openInterest").ok_or_else(|| self.malformed())
    }

    /// Settled funding rates as fractions per interval, oldest first.
    pub async fn funding_history(&self, symbol: &str, limit: usize) -> Result<Vec<(DateTime<Utc>, Decimal)>> {
        let pairs = [("symbol", symbol.to_string()), ("limit", limit.clamp(1, 1000).to_string())];
        let data = self.public("/fapi/v3/fundingRate", &pairs).await.map_err(|f| self.explain(f))?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        let mut history: Vec<(DateTime<Utc>, Decimal)> = rows
            .iter()
            .filter_map(|row| Some((millis(row, "fundingTime")?, signed_amount(row, "fundingRate")?)))
            .collect();
        history.sort_by_key(|(time, _)| *time);
        Ok(history)
    }

    /// Hours between a market's funding payments, when the exchange publishes them.
    pub async fn funding_interval(&self, symbol: &str) -> Result<Option<u32>> {
        let pairs = [("symbol", symbol.to_string())];
        let data = self.public("/fapi/v3/fundingInfo", &pairs).await.map_err(|f| self.explain(f))?;
        // A list today; other endpoints answer with one object when a symbol is named, so both are read.
        let rows = data.as_array().cloned().unwrap_or_else(|| vec![data.clone()]);
        let row = rows.iter().find(|row| row["symbol"] == symbol);
        Ok(row
            .and_then(|row| row.get("fundingIntervalHours")?.as_u64())
            .and_then(|hours| u32::try_from(hours).ok())
            .filter(|hours| *hours > 0))
    }

    /// The latest trades, newest first.
    pub async fn trades(&self, symbol: &str, limit: usize) -> Result<Vec<Trade>> {
        let pairs = [("symbol", symbol.to_string()), ("limit", limit.clamp(1, 1000).to_string())];
        let data = self.public("/fapi/v3/trades", &pairs).await.map_err(|f| self.explain(f))?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        let mut trades: Vec<Trade> = rows
            .iter()
            .filter_map(|row| {
                Some(Trade {
                    time: millis(row, "time")?,
                    price: price(row, "price")?,
                    qty: amount(row, "qty")?,
                    // When the buyer was resting in the book, it was a seller who crossed the spread.
                    taker: if row["isBuyerMaker"] == true { Side::Sell } else { Side::Buy },
                })
            })
            .collect();
        trades.sort_by_key(|trade| std::cmp::Reverse(trade.time));
        Ok(trades)
    }

    /// Price, mark, funding, 24h statistics and the completed daily closes before today (UTC).
    pub async fn quote(&self, symbol: &str) -> Result<Quote> {
        let (tick, premium, daily) = tokio::try_join!(
            self.ticker(symbol),
            self.premium(symbol),
            self.candles(symbol, Timeframe::D1, 91)
        )?;
        Ok(self.assemble(symbol, tick, Some(premium), &daily))
    }

    /// Builds a quote from its parts; daily candles on or after the quote's UTC day are still forming.
    pub fn assemble(&self, symbol: &str, tick: Tick, premium: Option<Premium>, daily: &[Candle]) -> Quote {
        let today = tick.as_of.timestamp_millis().div_euclid(86_400_000);
        let mut closes: Vec<Decimal> =
            daily.iter().filter(|c| c.t.div_euclid(86_400_000) < today).map(|c| c.c).collect();
        if closes.len() > 90 {
            closes.drain(..closes.len() - 90);
        }
        Quote {
            symbol: symbol.to_string(),
            price: tick.price,
            mark: premium.as_ref().map(|p| p.mark),
            index: premium.as_ref().and_then(|p| p.index),
            funding_rate: premium.as_ref().and_then(|p| p.funding_rate),
            next_funding: premium.as_ref().and_then(|p| p.next_funding),
            as_of: tick.as_of,
            source: self.network.source().to_string(),
            closes,
            stats: tick.stats,
        }
    }

    /// Submits a main wallet's approval of an API wallet. `signature` is the
    /// wallet's EIP-712 signature over [`approval_message`] with the same values.
    pub async fn register_agent(
        &self,
        user: &Address,
        nonce: u64,
        agent: &Address,
        expires_ms: i64,
        signature: &str,
    ) -> Result<()> {
        let message = approval_message(user, nonce, agent, expires_ms);
        let url = format!("{}/fapi/v3/registerAndApproveAgent", self.base);
        let response = self
            .http
            .post(&url)
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!("{message}&signature={signature}"))
            .send()
            .await
            .map_err(unreached)?;
        let status = response.status();
        let data: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() && data.get("code").and_then(Value::as_i64) == Some(200) {
            return Ok(());
        }
        let reason = field(&data, "msg")
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed").to_string());
        bail!("The exchange did not accept the wallet's approval: {reason}")
    }

    /// A public read from the site's API, which wraps what it returns in an envelope.
    async fn site_read(&self, path: &str, pairs: &[(&str, String)]) -> Result<Value> {
        let url = format!("{}{path}?{}", self.site, encode_params(pairs));
        let response = self
            .http
            .get(&url)
            .timeout(REQUEST_TIMEOUT)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(unreached)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(unreached)?;
        let parsed: Value = if bytes.len() > BODY_LIMIT {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        if status.is_success() && parsed.get("success").and_then(Value::as_bool) == Some(true) {
            return Ok(parsed.get("data").cloned().unwrap_or(Value::Null));
        }
        if status.as_u16() == 403 {
            bail!(
                "The exchange refused the request (403). Your network or region may be blocked; try another network or a VPN."
            );
        }
        let reason = field(&parsed, "message")
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("no usable answer").to_string());
        bail!("The exchange could not say what can be deposited or withdrawn right now: {reason}")
    }

    fn funding_chains(&self) -> String {
        let ids: Vec<String> =
            funding::chains(self.network).iter().map(|chain| chain.id.to_string()).collect();
        ids.join(",")
    }

    /// What the exchange accepts as a deposit, on each network funds move on.
    pub async fn deposit_assets(&self) -> Result<Vec<DepositAsset>> {
        let pairs = [
            ("chainIds", self.funding_chains()),
            ("networks", "EVM".to_string()),
            ("accountType", "perp".to_string()),
        ];
        let rows = self.site_read("/bapi/futures/v1/public/future/aster/deposit/assets", &pairs).await?;
        Ok(funding::deposit_assets(self.network, &rows))
    }

    /// Checks the vault this app knows on `chain` against the one the exchange
    /// reports now. A deposit is only ever built for a vault both agree on: if the
    /// exchange moved its vault, or an answer was tampered with, nothing is built.
    pub async fn confirm_vault(&self, chain: &Chain) -> Result<Address> {
        let pairs = [("chainId", chain.id.to_string())];
        let data = self.site_read("/bapi/futures/v1/public/future/web3/ae/deposit-address", &pairs).await?;
        match data.as_str().and_then(|raw| Address::parse(raw).ok()) {
            Some(reported) if reported == chain.vault() => Ok(reported),
            _ => bail!(
                "The exchange reports a deposit contract on {} that this version of the app does not know. Nothing was prepared. Update the app before you deposit.",
                chain.name
            ),
        }
    }

    /// What the connected wallet's account may withdraw now, and what is left of today's limit.
    pub async fn withdrawables(&self) -> Result<(Vec<Withdrawable>, DailyLimit)> {
        let pairs = [
            ("chainIds", self.funding_chains()),
            ("networks", "EVM".to_string()),
            ("accountType", "perp".to_string()),
        ];
        let (listed, info) = tokio::try_join!(
            self.site_read("/bapi/futures/v1/public/future/aster/withdraw/assets", &pairs),
            self.signed_or_explain(Method::POST, "/fapi/v3/aster/user-withdraw-info", Vec::new()),
        )?;
        Ok(funding::withdrawables(self.network, &info, &funding::withdraw_assets(self.network, &listed)))
    }

    /// What the exchange charges now for a withdrawal of `asset` to `chain`, in the asset.
    pub async fn withdraw_fee(&self, chain: &Chain, asset: &str) -> Result<Decimal> {
        let pairs = [
            ("chainId", chain.id.to_string()),
            ("network", "EVM".to_string()),
            ("currency", asset.to_string()),
            ("accountType", "perp".to_string()),
        ];
        let data =
            self.site_read("/bapi/futures/v1/public/future/aster/estimate-withdraw-fee", &pairs).await?;
        let cost = data.get("gasCost").filter(|cost| cost.is_number() || cost.is_string());
        let fee = cost
            .map(|cost| cost.as_str().map_or_else(|| cost.to_string(), str::to_string))
            .and_then(|text| text.parse::<Decimal>().ok())
            .filter(|fee| !fee.is_sign_negative());
        fee.ok_or_else(|| {
            desk_err!("The exchange did not say what this withdrawal costs. Try again in a moment.")
        })
    }

    /// Asks the exchange for a withdrawal. `request` is the request as the main
    /// wallet signed it and `signature` that signature; the withdrawal inside it
    /// carries the wallet's own signature too. Sent once. Returns the exchange's id for it.
    pub async fn withdraw(&self, request: &str, signature: &str) -> Result<String> {
        let query = format!("{request}&signature={signature}");
        match self.send(Method::POST, "/fapi/v3/aster/user-withdraw", &query).await {
            Ok(data) => Ok(field(&data, "withdrawId").unwrap_or_default()),
            Err(failure) if failure.outcome_unknown() => bail!(
                "No clear answer came back, so the withdrawal may or may not have been accepted. Check your balance before you ask again."
            ),
            Err(failure) => Err(self.explain(failure)),
        }
    }

    /// Whether the account is in hedge mode, which this desk does not trade in.
    pub async fn hedge_mode(&self) -> Result<bool> {
        let data = self.signed_or_explain(Method::GET, "/fapi/v3/positionSide/dual", Vec::new()).await?;
        Ok(data["dualSidePosition"] == true || data["dualSidePosition"] == "true")
    }

    /// Whether the account is in Multi-Assets mode, where the exchange allows only cross margin.
    pub async fn multi_assets_mode(&self) -> Result<bool> {
        let data = self.signed_or_explain(Method::GET, "/fapi/v3/multiAssetsMargin", Vec::new()).await?;
        Ok(data["multiAssetsMargin"] == true || data["multiAssetsMargin"] == "true")
    }

    /// Positions, including flat ones when `symbol` is given (they carry the leverage and margin mode).
    pub async fn positions(&self, symbol: Option<&str>) -> Result<Vec<Position>> {
        let pairs = symbol.map(|s| vec![("symbol", s.to_string())]).unwrap_or_default();
        let data = self.signed_or_explain(Method::GET, "/fapi/v3/positionRisk", pairs).await?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        if rows.iter().any(|row| row["positionSide"] == "LONG" || row["positionSide"] == "SHORT") {
            bail!(
                "This account is in hedge mode. OctoNeo trades in one-way mode; switch the account's position mode to one-way first."
            );
        }
        Ok(rows.iter().filter_map(position_from).collect())
    }

    pub async fn open_orders(&self, symbol: Option<&str>) -> Result<Vec<OpenOrder>> {
        let pairs = symbol.map(|s| vec![("symbol", s.to_string())]).unwrap_or_default();
        let data = self.signed_or_explain(Method::GET, "/fapi/v3/openOrders", pairs).await?;
        let rows = data.as_array().ok_or_else(|| self.malformed())?;
        let mut orders: Vec<OpenOrder> = rows.iter().filter_map(order_from).collect();
        orders.sort_by_key(|order| std::cmp::Reverse(order.time));
        Ok(orders)
    }

    /// Balances, open positions and open orders of the connected wallet.
    pub async fn account(&self) -> Result<Account> {
        // The margin mode of the account is worth knowing, but an account that cannot say is still an account:
        // if this one read fails, a ticket that needs isolated margin finds out from the exchange when it is confirmed.
        let mode = async { Ok::<_, DeskError>(self.multi_assets_mode().await.unwrap_or(false)) };
        let (summary, positions, orders, multi_assets) = tokio::try_join!(
            self.signed_or_explain(Method::GET, "/fapi/v3/account", Vec::new()),
            self.positions(None),
            self.open_orders(None),
            mode,
        )?;
        let total = |key: &str| signed_amount(&summary, key).unwrap_or_default();
        let balances = summary
            .get("assets")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        Some(AssetBalance {
                            asset: field(row, "asset")?,
                            balance: signed_amount(row, "walletBalance")?,
                            available: signed_amount(row, "availableBalance").unwrap_or_default(),
                        })
                    })
                    .filter(|balance| !balance.balance.is_zero())
                    .collect()
            })
            .unwrap_or_default();
        Ok(Account {
            equity: total("totalMarginBalance"),
            wallet_balance: total("totalWalletBalance"),
            available: total("availableBalance"),
            unrealized_pnl: total("totalUnrealizedProfit"),
            margin_used: total("totalInitialMargin"),
            balances,
            positions: positions.into_iter().filter(|p| !p.amount.is_zero()).collect(),
            orders,
            multi_assets,
            as_of: Utc::now(),
        })
    }

    pub async fn set_leverage(&self, symbol: &str, leverage: u32) -> Result<()> {
        let pairs = vec![("symbol", symbol.to_string()), ("leverage", leverage.to_string())];
        self.signed_or_explain(Method::POST, "/fapi/v3/leverage", pairs).await.map(|_| ())
    }

    /// Sets isolated or cross margin for a market. Already being in that mode is not an error.
    pub async fn set_margin_type(&self, symbol: &str, isolated: bool) -> Result<()> {
        let kind = if isolated { "ISOLATED" } else { "CROSSED" };
        let pairs = vec![("symbol", symbol.to_string()), ("marginType", kind.to_string())];
        let wallet = self.require_wallet()?;
        match self.signed(&wallet, Method::POST, "/fapi/v3/marginType", pairs).await {
            Ok(_) => Ok(()),
            Err(failure) if failure.code == Some(-4046) => Ok(()),
            Err(failure) => Err(self.explain(failure)),
        }
    }

    /// Sends an order, once.
    ///
    /// A refusal is told apart from an answer that never came or cannot be
    /// trusted: after the second kind the order may exist, so the caller has to
    /// look it up (see [`Self::find_order`]) before telling the trader anything.
    pub async fn place_order(&self, order: &OrderRequest) -> Placement {
        let mut pairs = vec![("symbol", order.symbol.clone()), ("side", order.side.venue().to_string())];
        match &order.kind {
            OrderKind::Market => pairs.push(("type", "MARKET".to_string())),
            OrderKind::Limit { price, post_only } => {
                pairs.push(("type", "LIMIT".to_string()));
                pairs.push(("price", decimal_text(*price)));
                pairs.push(("timeInForce", if *post_only { "GTX" } else { "GTC" }.to_string()));
            }
            OrderKind::StopMarket { trigger } | OrderKind::TakeProfitMarket { trigger } => {
                let kind = if matches!(order.kind, OrderKind::StopMarket { .. }) {
                    "STOP_MARKET"
                } else {
                    "TAKE_PROFIT_MARKET"
                };
                pairs.push(("type", kind.to_string()));
                pairs.push(("stopPrice", decimal_text(*trigger)));
                // The mark price is harder to push around than the last trade.
                pairs.push(("workingType", "MARK_PRICE".to_string()));
            }
        }
        pairs.push(("quantity", decimal_text(order.qty)));
        if order.reduce_only {
            pairs.push(("reduceOnly", "true".to_string()));
        }
        pairs.push(("newClientOrderId", order.client_id.clone()));
        pairs.push(("newOrderRespType", "RESULT".to_string()));
        let wallet = match self.require_wallet() {
            Ok(wallet) => wallet,
            Err(error) => return Placement::Rejected(error),
        };
        match self.signed(&wallet, Method::POST, "/fapi/v3/order", pairs).await {
            Ok(data) => match ack_from(&data, &order.symbol, &order.client_id) {
                Some(ack) => Placement::Accepted(ack),
                None => Placement::Unknown(
                    "The exchange answered the order with something this desk does not understand."
                        .to_string(),
                ),
            },
            Err(failure) if failure.outcome_unknown() => Placement::Unknown(match failure.status {
                None => failure.message,
                Some(status) => {
                    format!("The exchange did not say whether it took the order (HTTP {status}).")
                }
            }),
            Err(failure) => Placement::Rejected(self.explain(failure)),
        }
    }

    /// Looks an order up by the client id it was sent with. `Ok(None)` means
    /// The exchange has no such order.
    pub async fn find_order(&self, symbol: &str, client_id: &str) -> Result<Option<OrderAck>> {
        let wallet = self.require_wallet()?;
        let pairs = vec![("symbol", symbol.to_string()), ("origClientOrderId", client_id.to_string())];
        match self.signed(&wallet, Method::GET, "/fapi/v3/order", pairs).await {
            Ok(data) => ack_from(&data, symbol, client_id).map(Some).ok_or_else(|| self.malformed()),
            Err(failure) if failure.code == Some(-2013) => Ok(None),
            Err(failure) => Err(self.explain(failure)),
        }
    }

    pub async fn cancel_order(&self, symbol: &str, order_id: &str) -> Result<()> {
        let pairs = vec![("symbol", symbol.to_string()), ("orderId", order_id.to_string())];
        self.signed_or_explain(Method::DELETE, "/fapi/v3/order", pairs).await.map(|_| ())
    }

    pub async fn cancel_all(&self, symbol: &str) -> Result<()> {
        self.signed_or_explain(Method::DELETE, "/fapi/v3/allOpenOrders", vec![("symbol", symbol.to_string())])
            .await
            .map(|_| ())
    }

    /// Reads the account once to learn whether the wallet can trade yet.
    /// `Ok(true)` means the exchange is still waiting for a first deposit.
    pub async fn needs_deposit(&self) -> Result<bool> {
        let wallet = self.require_wallet()?;
        match self.signed(&wallet, Method::GET, "/fapi/v3/balance", Vec::new()).await {
            Ok(_) => Ok(false),
            Err(failure) if failure.needs_deposit() => Ok(true),
            Err(failure) => Err(self.explain(failure)),
        }
    }
}

#[cfg(test)]
mod tests;
