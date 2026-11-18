//! Native spot adapters for the supported exchanges.
//!
//! A [`VenueClient`] does the HTTP work once. Everything exchange-specific
//! (paths, field names, signing) lives behind the [`Dialect`] trait, one file
//! per exchange. Adding an exchange means adding a dialect.
//!
//! All sizes are base units, all pairs are `TOKEN/USDT` spot. A pair is checked
//! against the venue's own listing before it is priced or traded; a missing
//! listing is reported, never replaced by another market.

mod binance;
mod bybit;
mod okx;

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, TimeZone, Utc};
use hmac::{Hmac, KeyInit, Mac};
use reqwest::{Client, Method};
use rust_decimal::Decimal;
use serde_json::Value;
use sha2::Sha256;

use crate::error::{DeskError, Result};
use crate::instruments::Instrument;
use crate::model::{
    Balance, Candle, DayStats, OrderAck, OrderBook, Quote, Ticket, Timeframe, VenueId, decimal_text,
};
use crate::net::{HttpFailure, JSON_LIMIT, host_of, send_json};
use crate::{bail, desk_err};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// How long a listing answer is trusted for market data. Orders always re-check.
const LISTING_TTL: Duration = Duration::from_secs(600);
/// Most candles any venue returns in one call.
pub const MAX_CANDLES: usize = 300;

/// API credentials for one venue. They live in memory, are sent only to that
/// venue, and never appear in errors or logs.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub key: String,
    pub secret: String,
    /// OKX only.
    pub passphrase: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials(redacted)")
    }
}

impl Credentials {
    pub fn new(venue: VenueId, key: &str, secret: &str, passphrase: &str) -> Result<Self> {
        let (key, secret, passphrase) = (key.trim(), secret.trim(), passphrase.trim());
        if key.is_empty() || secret.is_empty() {
            bail!("Enter both the API key and the API secret.");
        }
        if venue == VenueId::Okx && passphrase.is_empty() {
            bail!("OKX also needs the API passphrase you set when creating the key.");
        }
        Ok(Self { key: key.to_string(), secret: secret.to_string(), passphrase: passphrase.to_string() })
    }
}

/// One HTTP call, described by a dialect and executed by the client.
pub(crate) struct Call {
    pub method: Method,
    pub path: &'static str,
    pub query: Vec<(&'static str, String)>,
    /// JSON body for venues that sign a body instead of a query.
    pub body: Option<Value>,
    pub private: bool,
}

impl Call {
    pub fn get(path: &'static str, query: Vec<(&'static str, String)>) -> Self {
        Self { method: Method::GET, path, query, body: None, private: false }
    }

    pub fn private(mut self) -> Self {
        self.private = true;
        self
    }
}

/// What signing adds to a request.
pub(crate) struct Signed {
    pub query: String,
    pub headers: Vec<(&'static str, String)>,
}

/// A ticker reading.
#[derive(Clone, Debug, PartialEq)]
pub struct Tick {
    pub price: Decimal,
    pub as_of: DateTime<Utc>,
    pub stats: DayStats,
}

/// Exchange-specific request shapes and response parsing. Implementations do no I/O.
pub(crate) trait Dialect: Send + Sync {
    fn id(&self) -> VenueId;
    fn host(&self) -> &'static str;
    /// An official host that serves the same public market data, for networks
    /// where the main one is blocked. It never receives signed requests.
    fn public_mirror(&self) -> Option<&'static str> {
        None
    }
    /// The venue's own symbol for an instrument, e.g. `BTCUSDT` or `BTC-USDT`.
    fn code(&self, instrument: &Instrument) -> String;
    fn sign(
        &self,
        credentials: &Credentials,
        method: &Method,
        path: &str,
        query: &str,
        body: &str,
        now_ms: i64,
    ) -> Signed;
    /// Rejects the venue's in-band error envelope.
    fn check(&self, data: &Value) -> Result<()>;

    fn listing(&self, code: &str) -> Call;
    fn parse_listing(&self, instrument: &Instrument, code: &str, data: &Value) -> Option<bool>;
    fn ticker(&self, code: &str) -> Call;
    fn parse_ticker(&self, code: &str, data: &Value) -> Option<Tick>;
    fn candles(&self, code: &str, timeframe: Timeframe, limit: usize) -> Call;
    /// Rows of `[open time, open, high, low, close, volume, ..]` in any order.
    fn candle_rows<'a>(&self, data: &'a Value) -> Option<&'a Vec<Value>>;
    fn depth(&self, code: &str, limit: usize) -> Call;
    /// `(bids, asks, timestamp ms)`; each level is `[price, size, ..]`.
    fn parse_depth<'a>(&self, data: &'a Value) -> Option<(&'a Vec<Value>, &'a Vec<Value>, Option<i64>)>;
    fn balances(&self) -> Call;
    fn parse_balances(&self, data: &Value) -> Option<Vec<(String, String)>>;
    fn order(&self, code: &str, ticket: &Ticket) -> Call;
    /// `(order id, status)`.
    fn parse_order(&self, data: &Value) -> Result<(String, String)>;
}

pub(crate) fn hmac_sha256(secret: &str, payload: &str) -> Vec<u8> {
    // HMAC accepts a key of any length, so this cannot fail.
    match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mut mac) => {
            mac.update(payload.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        Err(_) => Vec::new(),
    }
}

/// A JSON string or number as text. Venues are inconsistent about which they send.
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

pub(crate) fn field(data: &Value, key: &str) -> Option<String> {
    data.get(key).and_then(text)
}

pub(crate) fn amount(data: &Value, key: &str) -> Option<Decimal> {
    field(data, key).and_then(|raw| crate::model::non_negative(&raw).ok())
}

pub(crate) fn encode_query(pairs: &[(&'static str, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter().map(|(k, v)| (*k, v.as_str())))
        .finish()
}

fn from_millis(ms: i64) -> Result<DateTime<Utc>> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .ok_or_else(|| DeskError::new("The venue returned an invalid timestamp."))
}

pub struct VenueClient {
    dialect: Box<dyn Dialect>,
    base: String,
    http: Client,
    /// Mirror for public reads; see [`Dialect::public_mirror`].
    mirror: Option<String>,
    /// The mirror answered when the main host did not, so ask it first from now on.
    prefer_mirror: AtomicBool,
    credentials: RwLock<Option<Credentials>>,
    /// When each pair's listing was last checked, and the answer.
    listed: Mutex<HashMap<String, (Instant, bool)>>,
}

impl VenueClient {
    pub fn new(venue: VenueId, http: Client) -> Self {
        let dialect: Box<dyn Dialect> = match venue {
            VenueId::Binance => Box::new(binance::Binance),
            VenueId::Bybit => Box::new(bybit::Bybit),
            VenueId::Okx => Box::new(okx::Okx),
        };
        let base = dialect.host().to_string();
        let mirror = dialect.public_mirror().map(str::to_string);
        Self {
            dialect,
            base,
            http,
            mirror,
            prefer_mirror: AtomicBool::new(false),
            credentials: RwLock::new(None),
            listed: Mutex::new(HashMap::new()),
        }
    }

    /// Points the client at another origin and drops the public mirror. Used by tests.
    pub fn with_base(mut self, base: &str) -> Self {
        self.base = base.trim_end_matches('/').to_string();
        self.mirror = None;
        self
    }

    /// Sets the mirror used for public reads when the main host fails.
    pub fn with_mirror(mut self, mirror: &str) -> Self {
        self.mirror = Some(mirror.trim_end_matches('/').to_string());
        self
    }

    pub fn id(&self) -> VenueId {
        self.dialect.id()
    }

    pub fn set_credentials(&self, credentials: Option<Credentials>) {
        *self.credentials.write().unwrap_or_else(|p| p.into_inner()) = credentials;
    }

    pub fn has_credentials(&self) -> bool {
        self.credentials.read().unwrap_or_else(|p| p.into_inner()).is_some()
    }

    fn malformed(&self) -> DeskError {
        desk_err!("{} returned a response this desk does not understand.", self.id().name())
    }

    async fn send(&self, origin: &str, call: &Call) -> std::result::Result<Value, HttpFailure> {
        let mut query = encode_query(&call.query);
        let body = call.body.as_ref().map(Value::to_string);
        let mut headers = Vec::new();
        if call.private {
            let credentials = self.credentials.read().unwrap_or_else(|p| p.into_inner()).clone();
            let Some(credentials) = credentials else {
                let error =
                    desk_err!("Add {} API keys in Connections to use account tools.", self.id().name());
                return Err(HttpFailure { status: Some(401), error });
            };
            let signed = self.dialect.sign(
                &credentials,
                &call.method,
                call.path,
                &query,
                body.as_deref().unwrap_or(""),
                Utc::now().timestamp_millis(),
            );
            query = signed.query;
            headers = signed.headers;
        }
        let separator = if query.is_empty() { "" } else { "?" };
        let url = format!("{origin}{}{separator}{query}", call.path);
        let host = host_of(&url);
        let mut request = self
            .http
            .request(call.method.clone(), &url)
            .timeout(REQUEST_TIMEOUT)
            .header("Accept", "application/json");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.header("Content-Type", "application/json").body(body);
        }
        send_json(&host, request, JSON_LIMIT).await
    }

    /// Runs a call. Public reads are repeated once when no answer arrives and fall
    /// back to the venue's public mirror; anything signed or state-changing is
    /// sent exactly once, to the main host only.
    async fn request(&self, call: Call) -> Result<Value> {
        let readable = call.method == Method::GET;
        let mirror = self.mirror.as_deref().filter(|_| readable && !call.private);
        let mut origins = vec![self.base.as_str()];
        if let Some(mirror) = mirror {
            if self.prefer_mirror.load(Ordering::Relaxed) {
                origins.insert(0, mirror);
            } else {
                origins.push(mirror);
            }
        } else if readable {
            origins.push(self.base.as_str());
        }
        let mut failure = None;
        for (attempt, origin) in origins.iter().enumerate() {
            if attempt > 0 && origins[attempt - 1] == *origin {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            match self.send(origin, &call).await {
                Ok(data) => {
                    if mirror.is_some() {
                        self.prefer_mirror.store(Some(*origin) == mirror, Ordering::Relaxed);
                    }
                    self.dialect.check(&data)?;
                    return Ok(data);
                }
                Err(error) if error.is_transport() || (mirror.is_some() && error.is_refusal()) => {
                    failure = Some(error)
                }
                Err(error) => return Err(self.explain(error)),
            }
        }
        Err(failure.map(|f| self.explain(f)).unwrap_or_else(|| self.malformed()))
    }

    fn explain(&self, failure: HttpFailure) -> DeskError {
        if failure.is_refusal() {
            return desk_err!(
                "{} refused the request ({}). The exchange may not serve your region or network; try another network or a VPN.",
                self.id().name(),
                failure.status.unwrap_or_default()
            );
        }
        failure.error
    }

    /// Whether the exact token/USDT pair trades on this venue's spot market right now.
    pub async fn listed(&self, instrument: &Instrument) -> Result<bool> {
        let code = self.dialect.code(instrument);
        match self.request(self.dialect.listing(&code)).await {
            Ok(data) => self.dialect.parse_listing(instrument, &code, &data).ok_or_else(|| self.malformed()),
            // Venues answer an unknown symbol with an error rather than an empty list.
            Err(error)
                if error.0.to_ascii_lowercase().contains("invalid symbol") || error.0.contains("51001:") =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Confirms the pair trades here and returns the venue's symbol for it.
    ///
    /// Both answers are remembered for a while: a watchlist refresh must not ask
    /// about the same unlisted token every few seconds. `fresh` skips the memory,
    /// which orders always do.
    async fn require_listing(&self, instrument: &Instrument, fresh: bool) -> Result<String> {
        let pair = instrument.pair();
        let remembered = {
            let listed = self.listed.lock().unwrap_or_else(|p| p.into_inner());
            listed.get(&pair).filter(|(at, _)| at.elapsed() < LISTING_TTL).map(|(_, listed)| *listed)
        };
        let listed = match remembered {
            Some(listed) if !fresh => listed,
            _ => {
                let listed = self.listed(instrument).await?;
                self.listed
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(pair.clone(), (Instant::now(), listed));
                listed
            }
        };
        if !listed {
            bail!("No active spot listing for {pair} on {}.", self.id().name());
        }
        Ok(self.dialect.code(instrument))
    }

    pub async fn ticker(&self, instrument: &Instrument) -> Result<Tick> {
        let code = self.require_listing(instrument, false).await?;
        let data = self.request(self.dialect.ticker(&code)).await?;
        self.dialect.parse_ticker(&code, &data).ok_or_else(|| self.malformed())
    }

    /// Up to `limit` candles, oldest first. The newest may still be forming.
    pub async fn candles(
        &self,
        instrument: &Instrument,
        timeframe: Timeframe,
        limit: usize,
    ) -> Result<Vec<Candle>> {
        let code = self.require_listing(instrument, false).await?;
        let limit = limit.clamp(1, MAX_CANDLES);
        let data = self.request(self.dialect.candles(&code, timeframe, limit)).await?;
        let rows = self.dialect.candle_rows(&data).ok_or_else(|| self.malformed())?;
        let mut candles = Vec::with_capacity(rows.len());
        for row in rows {
            let cell = |index: usize| row.get(index).and_then(text).ok_or_else(|| self.malformed());
            let price = |index: usize| cell(index).and_then(|raw| crate::model::positive(&raw));
            candles.push(Candle {
                t: cell(0)?.parse::<i64>().map_err(|_| self.malformed())?,
                o: price(1)?,
                h: price(2)?,
                l: price(3)?,
                c: price(4)?,
                v: cell(5).and_then(|raw| crate::model::non_negative(&raw))?,
            });
        }
        candles.sort_by_key(|c| c.t);
        candles.dedup_by_key(|c| c.t);
        // Keep the newest `limit` even if the venue sent more than was asked for.
        if candles.len() > limit {
            candles.drain(..candles.len() - limit);
        }
        Ok(candles)
    }

    pub async fn depth(&self, instrument: &Instrument, limit: usize) -> Result<OrderBook> {
        let code = self.require_listing(instrument, false).await?;
        let data = self.request(self.dialect.depth(&code, limit.clamp(5, 200))).await?;
        let (bids, asks, stamp) = self.dialect.parse_depth(&data).ok_or_else(|| self.malformed())?;
        let levels = |rows: &Vec<Value>| -> Result<Vec<(Decimal, Decimal)>> {
            rows.iter()
                .map(|row| {
                    let cell = |index: usize| row.get(index).and_then(text).ok_or_else(|| self.malformed());
                    Ok((crate::model::positive(&cell(0)?)?, crate::model::non_negative(&cell(1)?)?))
                })
                .collect()
        };
        let as_of = match stamp {
            Some(ms) => from_millis(ms)?,
            None => Utc::now(),
        };
        Ok(OrderBook { bids: levels(bids)?, asks: levels(asks)?, as_of })
    }

    /// A verified price with 24h statistics and the completed daily closes before today (UTC).
    pub async fn quote(&self, instrument: &Instrument) -> Result<Quote> {
        // Confirm the listing once, then read price and history side by side.
        self.require_listing(instrument, false).await?;
        let (tick, daily) =
            tokio::try_join!(self.ticker(instrument), self.candles(instrument, Timeframe::D1, 91))?;
        let today = tick.as_of.timestamp_millis().div_euclid(86_400_000);
        let mut closes: Vec<Decimal> =
            daily.iter().filter(|c| c.t.div_euclid(86_400_000) < today).map(|c| c.c).collect();
        if closes.len() > 90 {
            closes.drain(..closes.len() - 90);
        }
        Ok(Quote {
            pair: instrument.pair(),
            price: tick.price,
            as_of: tick.as_of,
            source: format!("{} spot", self.id().name()),
            closes,
            sample: false,
            stats: tick.stats,
        })
    }

    pub async fn balances(&self) -> Result<Vec<Balance>> {
        let data = self.request(self.dialect.balances()).await?;
        let rows = self.dialect.parse_balances(&data).ok_or_else(|| self.malformed())?;
        let mut balances = Vec::new();
        for (asset, total) in rows {
            let total = total.trim().parse::<Decimal>().map_err(|_| self.malformed())?;
            if !total.is_zero() {
                balances.push(Balance { asset, total });
            }
        }
        balances.sort_by(|a, b| a.asset.cmp(&b.asset));
        Ok(balances)
    }

    /// Sends a live spot market order in base units. The listing is re-verified
    /// first, and the ticket's client id is passed through so a retry cannot
    /// double-fill.
    pub async fn market_order(&self, ticket: &Ticket) -> Result<OrderAck> {
        let instrument = crate::instruments::resolve(&ticket.pair)?;
        if !self.has_credentials() {
            bail!("Add {} API keys in Connections to send live orders.", self.id().name());
        }
        if ticket.client_id.len() != 32
            || !ticket.client_id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            bail!("Invalid client order ID.");
        }
        let code = self.require_listing(&instrument, true).await?;
        let data = self.request(self.dialect.order(&code, ticket).private()).await?;
        let (id, status) = self.dialect.parse_order(&data)?;
        Ok(OrderAck {
            venue: self.id(),
            pair: ticket.pair.clone(),
            side: ticket.side,
            qty: ticket.qty,
            id,
            status,
            client_id: ticket.client_id.clone(),
        })
    }
}

/// Builds the quantity text every venue expects: plain decimal, no trailing zeros.
pub(crate) fn quantity(ticket: &Ticket) -> String {
    decimal_text(ticket.qty)
}

#[cfg(test)]
mod tests;
