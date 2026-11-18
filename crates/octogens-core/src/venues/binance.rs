//! Binance spot REST. Errors arrive as HTTP statuses, so there is no in-band envelope.

use chrono::{TimeZone, Utc};
use reqwest::Method;
use serde_json::Value;

use super::{Call, Credentials, Dialect, Signed, Tick, amount, field, hmac_sha256, quantity};
use crate::error::Result;
use crate::instruments::Instrument;
use crate::model::{DayStats, Ticket, Timeframe, VenueId, positive};

pub(crate) struct Binance;

impl Dialect for Binance {
    fn id(&self) -> VenueId {
        VenueId::Binance
    }

    fn host(&self) -> &'static str {
        "https://api.binance.com"
    }

    /// Binance's own market-data host. It has no account or trading endpoints.
    fn public_mirror(&self) -> Option<&'static str> {
        Some("https://data-api.binance.vision")
    }

    fn code(&self, instrument: &Instrument) -> String {
        format!("{}USDT", instrument.base())
    }

    /// The signature covers the whole query string and travels in it.
    fn sign(
        &self,
        credentials: &Credentials,
        _: &Method,
        _: &str,
        query: &str,
        _: &str,
        now_ms: i64,
    ) -> Signed {
        let separator = if query.is_empty() { "" } else { "&" };
        let payload = format!("{query}{separator}timestamp={now_ms}&recvWindow=5000");
        let signature = hex::encode(hmac_sha256(&credentials.secret, &payload));
        Signed {
            query: format!("{payload}&signature={signature}"),
            headers: vec![("X-MBX-APIKEY", credentials.key.clone())],
        }
    }

    fn check(&self, _: &Value) -> Result<()> {
        Ok(())
    }

    fn listing(&self, code: &str) -> Call {
        Call::get("/api/v3/exchangeInfo", vec![("symbol", code.to_string())])
    }

    fn parse_listing(&self, instrument: &Instrument, code: &str, data: &Value) -> Option<bool> {
        let rows = data.get("symbols")?.as_array()?;
        Some(rows.iter().any(|row| {
            row["symbol"] == code
                && row["baseAsset"] == instrument.base()
                && row["quoteAsset"] == "USDT"
                && row["status"] == "TRADING"
                && row["isSpotTradingAllowed"] == true
        }))
    }

    fn ticker(&self, code: &str) -> Call {
        Call::get("/api/v3/ticker/24hr", vec![("symbol", code.to_string())])
    }

    fn parse_ticker(&self, code: &str, data: &Value) -> Option<Tick> {
        if data.get("symbol")? != code {
            return None;
        }
        let stamp = field(data, "closeTime")?.parse::<i64>().ok()?;
        Some(Tick {
            price: positive(&field(data, "lastPrice")?).ok()?,
            as_of: Utc.timestamp_millis_opt(stamp).single()?,
            stats: DayStats {
                change_pct: field(data, "priceChangePercent").and_then(|raw| raw.parse().ok()),
                high: amount(data, "highPrice").filter(|v| !v.is_zero()),
                low: amount(data, "lowPrice").filter(|v| !v.is_zero()),
                volume: amount(data, "volume"),
                quote_volume: amount(data, "quoteVolume"),
                bid: amount(data, "bidPrice").filter(|v| !v.is_zero()),
                ask: amount(data, "askPrice").filter(|v| !v.is_zero()),
            },
        })
    }

    fn candles(&self, code: &str, timeframe: Timeframe, limit: usize) -> Call {
        Call::get(
            "/api/v3/klines",
            vec![
                ("symbol", code.to_string()),
                ("interval", timeframe.as_str().to_string()),
                ("limit", limit.to_string()),
            ],
        )
    }

    fn candle_rows<'a>(&self, data: &'a Value) -> Option<&'a Vec<Value>> {
        data.as_array()
    }

    fn depth(&self, code: &str, limit: usize) -> Call {
        Call::get("/api/v3/depth", vec![("symbol", code.to_string()), ("limit", limit.to_string())])
    }

    fn parse_depth<'a>(&self, data: &'a Value) -> Option<(&'a Vec<Value>, &'a Vec<Value>, Option<i64>)> {
        Some((data.get("bids")?.as_array()?, data.get("asks")?.as_array()?, None))
    }

    fn balances(&self) -> Call {
        Call::get("/api/v3/account", vec![("omitZeroBalances", "true".to_string())]).private()
    }

    fn parse_balances(&self, data: &Value) -> Option<Vec<(String, String)>> {
        data.get("balances")?
            .as_array()?
            .iter()
            .map(|row| {
                let total = amount(row, "free")? + amount(row, "locked")?;
                Some((field(row, "asset")?, total.to_string()))
            })
            .collect()
    }

    fn order(&self, code: &str, ticket: &Ticket) -> Call {
        Call {
            method: Method::POST,
            path: "/api/v3/order",
            query: vec![
                ("symbol", code.to_string()),
                ("side", ticket.side.as_str().to_ascii_uppercase()),
                ("type", "MARKET".to_string()),
                ("quantity", quantity(ticket)),
                ("newClientOrderId", ticket.client_id.clone()),
            ],
            body: None,
            private: true,
        }
    }

    fn parse_order(&self, data: &Value) -> Result<(String, String)> {
        match field(data, "orderId") {
            Some(id) => Ok((id, field(data, "status").unwrap_or_else(|| "acknowledged".to_string()))),
            None => crate::bail!(
                "Binance accepted the request but returned no order ID. Check your open orders before retrying."
            ),
        }
    }
}
