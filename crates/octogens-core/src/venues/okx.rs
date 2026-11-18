//! OKX v5 spot REST. Every response is wrapped in `{code, msg, data}`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{SecondsFormat, TimeZone, Utc};
use reqwest::Method;
use serde_json::{Value, json};

use super::{Call, Credentials, Dialect, Signed, Tick, amount, field, hmac_sha256, quantity};
use crate::error::Result;
use crate::instruments::Instrument;
use crate::model::{DayStats, Ticket, Timeframe, VenueId, pct, positive};

pub(crate) struct Okx;

impl Dialect for Okx {
    fn id(&self) -> VenueId {
        VenueId::Okx
    }

    fn host(&self) -> &'static str {
        "https://www.okx.com"
    }

    fn code(&self, instrument: &Instrument) -> String {
        format!("{}-USDT", instrument.base())
    }

    /// Signs ISO timestamp + method + path-with-query + body, base64-encoded, sent in headers.
    fn sign(
        &self,
        credentials: &Credentials,
        method: &Method,
        path: &str,
        query: &str,
        body: &str,
        now_ms: i64,
    ) -> Signed {
        let stamp = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_default()
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let separator = if query.is_empty() { "" } else { "?" };
        let payload = format!("{stamp}{}{path}{separator}{query}{body}", method.as_str());
        Signed {
            query: query.to_string(),
            headers: vec![
                ("OK-ACCESS-KEY", credentials.key.clone()),
                ("OK-ACCESS-SIGN", STANDARD.encode(hmac_sha256(&credentials.secret, &payload))),
                ("OK-ACCESS-TIMESTAMP", stamp),
                ("OK-ACCESS-PASSPHRASE", credentials.passphrase.clone()),
            ],
        }
    }

    fn check(&self, data: &Value) -> Result<()> {
        let code = field(data, "code").unwrap_or_else(|| "?".to_string());
        if code == "0" {
            return Ok(());
        }
        // Order rejections put the useful text on the first data row.
        let detail = data
            .get("data")
            .and_then(|rows| rows.get(0))
            .and_then(|row| field(row, "sMsg"))
            .filter(|text| !text.is_empty())
            .or_else(|| field(data, "msg"))
            .unwrap_or_else(|| "request failed".to_string());
        crate::bail!("OKX {code}: {detail}")
    }

    fn listing(&self, code: &str) -> Call {
        Call::get(
            "/api/v5/public/instruments",
            vec![("instType", "SPOT".to_string()), ("instId", code.to_string())],
        )
    }

    fn parse_listing(&self, instrument: &Instrument, code: &str, data: &Value) -> Option<bool> {
        let rows = data.get("data")?.as_array()?;
        Some(rows.iter().any(|row| {
            row["instId"] == code
                && row["baseCcy"] == instrument.base()
                && row["quoteCcy"] == "USDT"
                && row["instType"] == "SPOT"
                && row["state"] == "live"
        }))
    }

    fn ticker(&self, code: &str) -> Call {
        Call::get("/api/v5/market/ticker", vec![("instId", code.to_string())])
    }

    fn parse_ticker(&self, code: &str, data: &Value) -> Option<Tick> {
        let row = data.get("data")?.get(0)?;
        if row["instId"] != code || row["instType"] != "SPOT" {
            return None;
        }
        let price = positive(&field(row, "last")?).ok()?;
        let stamp = field(row, "ts")?.parse::<i64>().ok()?;
        Some(Tick {
            price,
            as_of: Utc.timestamp_millis_opt(stamp).single()?,
            stats: DayStats {
                change_pct: amount(row, "open24h").and_then(|open| pct(price, open)),
                high: amount(row, "high24h").filter(|v| !v.is_zero()),
                low: amount(row, "low24h").filter(|v| !v.is_zero()),
                volume: amount(row, "vol24h"),
                quote_volume: amount(row, "volCcy24h"),
                bid: amount(row, "bidPx").filter(|v| !v.is_zero()),
                ask: amount(row, "askPx").filter(|v| !v.is_zero()),
            },
        })
    }

    fn candles(&self, code: &str, timeframe: Timeframe, limit: usize) -> Call {
        // The `utc` suffix aligns daily bars to 00:00 UTC like the other venues.
        let bar = match timeframe {
            Timeframe::M15 => "15m",
            Timeframe::H1 => "1H",
            Timeframe::H4 => "4H",
            Timeframe::D1 => "1Dutc",
        };
        Call::get(
            "/api/v5/market/candles",
            vec![("instId", code.to_string()), ("bar", bar.to_string()), ("limit", limit.to_string())],
        )
    }

    fn candle_rows<'a>(&self, data: &'a Value) -> Option<&'a Vec<Value>> {
        data.get("data")?.as_array()
    }

    fn depth(&self, code: &str, limit: usize) -> Call {
        Call::get("/api/v5/market/books", vec![("instId", code.to_string()), ("sz", limit.to_string())])
    }

    fn parse_depth<'a>(&self, data: &'a Value) -> Option<(&'a Vec<Value>, &'a Vec<Value>, Option<i64>)> {
        let book = data.get("data")?.get(0)?;
        let stamp = field(book, "ts").and_then(|raw| raw.parse().ok());
        Some((book.get("bids")?.as_array()?, book.get("asks")?.as_array()?, stamp))
    }

    fn balances(&self) -> Call {
        Call::get("/api/v5/account/balance", Vec::new()).private()
    }

    fn parse_balances(&self, data: &Value) -> Option<Vec<(String, String)>> {
        data.get("data")?
            .get(0)?
            .get("details")?
            .as_array()?
            .iter()
            .map(|row| Some((field(row, "ccy")?, field(row, "cashBal")?)))
            .collect()
    }

    fn order(&self, code: &str, ticket: &Ticket) -> Call {
        Call {
            method: Method::POST,
            path: "/api/v5/trade/order",
            query: Vec::new(),
            body: Some(json!({
                "instId": code,
                "tdMode": "cash",
                "side": ticket.side.as_str(),
                "ordType": "market",
                // Without this a market buy is sized in USDT, not in tokens.
                "tgtCcy": "base_ccy",
                "sz": quantity(ticket),
                "clOrdId": ticket.client_id,
            })),
            private: true,
        }
    }

    fn parse_order(&self, data: &Value) -> Result<(String, String)> {
        let row = data.get("data").and_then(|rows| rows.get(0));
        match row.and_then(|row| field(row, "ordId")).filter(|id| !id.is_empty()) {
            Some(id) if row.and_then(|row| field(row, "sCode")).as_deref() == Some("0") => {
                Ok((id, "acknowledged".to_string()))
            }
            _ => {
                let reason = row.and_then(|row| field(row, "sMsg")).filter(|text| !text.is_empty());
                crate::bail!("{}", reason.unwrap_or_else(|| "OKX rejected the order.".to_string()))
            }
        }
    }
}
