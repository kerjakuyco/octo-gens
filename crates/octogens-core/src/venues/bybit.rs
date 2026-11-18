//! Bybit v5 spot REST. Every response is wrapped in `{retCode, retMsg, result}`.

use chrono::{TimeZone, Utc};
use reqwest::Method;
use serde_json::{Value, json};

use super::{Call, Credentials, Dialect, Signed, Tick, amount, field, hmac_sha256, quantity};
use crate::error::Result;
use crate::instruments::Instrument;
use crate::model::{DayStats, Side, Ticket, Timeframe, VenueId, positive};

pub(crate) struct Bybit;

const RECV_WINDOW: &str = "5000";

fn spot(code: &str) -> Vec<(&'static str, String)> {
    vec![("category", "spot".to_string()), ("symbol", code.to_string())]
}

impl Dialect for Bybit {
    fn id(&self) -> VenueId {
        VenueId::Bybit
    }

    fn host(&self) -> &'static str {
        "https://api.bybit.com"
    }

    fn code(&self, instrument: &Instrument) -> String {
        format!("{}USDT", instrument.base())
    }

    /// Signs timestamp + key + window + (query for GET, body for POST); sent in headers.
    fn sign(
        &self,
        credentials: &Credentials,
        method: &Method,
        _: &str,
        query: &str,
        body: &str,
        now_ms: i64,
    ) -> Signed {
        let signed_part = if method == Method::POST { body } else { query };
        let payload = format!("{now_ms}{}{RECV_WINDOW}{signed_part}", credentials.key);
        Signed {
            query: query.to_string(),
            headers: vec![
                ("X-BAPI-API-KEY", credentials.key.clone()),
                ("X-BAPI-SIGN", hex::encode(hmac_sha256(&credentials.secret, &payload))),
                ("X-BAPI-TIMESTAMP", now_ms.to_string()),
                ("X-BAPI-RECV-WINDOW", RECV_WINDOW.to_string()),
            ],
        }
    }

    fn check(&self, data: &Value) -> Result<()> {
        if data.get("retCode").and_then(Value::as_i64) == Some(0) {
            return Ok(());
        }
        let code = data.get("retCode").map(Value::to_string).unwrap_or_else(|| "?".to_string());
        crate::bail!(
            "Bybit {code}: {}",
            field(data, "retMsg").unwrap_or_else(|| "request failed".to_string())
        )
    }

    fn listing(&self, code: &str) -> Call {
        Call::get("/v5/market/instruments-info", spot(code))
    }

    fn parse_listing(&self, instrument: &Instrument, code: &str, data: &Value) -> Option<bool> {
        let result = data.get("result")?;
        let rows = result.get("list")?.as_array()?;
        Some(
            result["category"] == "spot"
                && rows.iter().any(|row| {
                    // A tokenized stock must be flagged as one, so a look-alike symbol cannot stand in.
                    let xstock =
                        field(row, "symbolType").is_some_and(|kind| kind.eq_ignore_ascii_case("xstocks"));
                    row["symbol"] == code
                        && row["baseCoin"] == instrument.base()
                        && row["quoteCoin"] == "USDT"
                        && row["status"] == "Trading"
                        && (!instrument.is_xstock() || xstock)
                }),
        )
    }

    fn ticker(&self, code: &str) -> Call {
        Call::get("/v5/market/tickers", spot(code))
    }

    fn parse_ticker(&self, code: &str, data: &Value) -> Option<Tick> {
        let row = data.get("result")?.get("list")?.as_array()?.iter().find(|row| row["symbol"] == code)?;
        let stamp = field(data, "time")?.parse::<i64>().ok()?;
        Some(Tick {
            price: positive(&field(row, "lastPrice")?).ok()?,
            as_of: Utc.timestamp_millis_opt(stamp).single()?,
            stats: DayStats {
                // Bybit reports a fraction: 0.0123 means 1.23%.
                change_pct: field(row, "price24hPcnt")
                    .and_then(|raw| raw.parse::<f64>().ok())
                    .map(|f| f * 100.0),
                high: amount(row, "highPrice24h").filter(|v| !v.is_zero()),
                low: amount(row, "lowPrice24h").filter(|v| !v.is_zero()),
                volume: amount(row, "volume24h"),
                quote_volume: amount(row, "turnover24h"),
                bid: amount(row, "bid1Price").filter(|v| !v.is_zero()),
                ask: amount(row, "ask1Price").filter(|v| !v.is_zero()),
            },
        })
    }

    fn candles(&self, code: &str, timeframe: Timeframe, limit: usize) -> Call {
        let interval = match timeframe {
            Timeframe::M15 => "15",
            Timeframe::H1 => "60",
            Timeframe::H4 => "240",
            Timeframe::D1 => "D",
        };
        let mut query = spot(code);
        query.extend([("interval", interval.to_string()), ("limit", limit.to_string())]);
        Call::get("/v5/market/kline", query)
    }

    fn candle_rows<'a>(&self, data: &'a Value) -> Option<&'a Vec<Value>> {
        data.get("result")?.get("list")?.as_array()
    }

    fn depth(&self, code: &str, limit: usize) -> Call {
        let mut query = spot(code);
        query.push(("limit", limit.to_string()));
        Call::get("/v5/market/orderbook", query)
    }

    fn parse_depth<'a>(&self, data: &'a Value) -> Option<(&'a Vec<Value>, &'a Vec<Value>, Option<i64>)> {
        let result = data.get("result")?;
        Some((
            result.get("b")?.as_array()?,
            result.get("a")?.as_array()?,
            result.get("ts").and_then(Value::as_i64),
        ))
    }

    fn balances(&self) -> Call {
        Call::get("/v5/account/wallet-balance", vec![("accountType", "UNIFIED".to_string())]).private()
    }

    fn parse_balances(&self, data: &Value) -> Option<Vec<(String, String)>> {
        let accounts = data.get("result")?.get("list")?.as_array()?;
        let mut rows = Vec::new();
        for account in accounts {
            for coin in account.get("coin")?.as_array()? {
                rows.push((field(coin, "coin")?, field(coin, "walletBalance")?));
            }
        }
        Some(rows)
    }

    fn order(&self, code: &str, ticket: &Ticket) -> Call {
        Call {
            method: Method::POST,
            path: "/v5/order/create",
            query: Vec::new(),
            body: Some(json!({
                "category": "spot",
                "symbol": code,
                "side": match ticket.side { Side::Buy => "Buy", Side::Sell => "Sell" },
                "orderType": "Market",
                // Without this a market buy is sized in USDT, not in tokens.
                "marketUnit": "baseCoin",
                "isLeverage": 0,
                "qty": quantity(ticket),
                "orderLinkId": ticket.client_id,
            })),
            private: true,
        }
    }

    fn parse_order(&self, data: &Value) -> Result<(String, String)> {
        match data.get("result").and_then(|result| field(result, "orderId")) {
            Some(id) => Ok((id, "acknowledged".to_string())),
            None => crate::bail!(
                "Bybit accepted the request but returned no order ID. Check your open orders before retrying."
            ),
        }
    }
}
