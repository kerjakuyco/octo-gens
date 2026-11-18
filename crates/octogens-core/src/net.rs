//! The one HTTP client the core uses, and the rules every request follows.

use std::time::Duration;

use reqwest::{Client, Response};
use serde_json::Value;

use crate::desk_err;
use crate::error::{DeskError, Result};

/// Largest JSON body the desk will read from a venue.
pub const JSON_LIMIT: usize = 2_000_000;

/// Builds the shared client. Redirects are never followed: a signed request
/// must not be replayed to a host the venue points at.
pub fn http_client() -> Result<Client> {
    Client::builder()
        .user_agent(concat!("OctoGens/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| desk_err!("The network client could not start: {error}."))
}

pub fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "the server".to_string())
}

/// A connection-level failure, without the URL (it may carry a signature).
///
/// The innermost cause is what tells a blocked network from a typo, so it is
/// included. A certificate failure almost always means the network intercepts
/// the connection, which is common for exchange domains in some countries.
pub fn unreachable(host: &str, error: reqwest::Error) -> DeskError {
    let error = error.without_url();
    if error.is_timeout() {
        return desk_err!("{host} did not answer in time. Check your connection and try again.");
    }
    let mut cause: &dyn std::error::Error = &error;
    while let Some(inner) = cause.source() {
        cause = inner;
    }
    let cause = cause.to_string();
    let lowered = cause.to_ascii_lowercase();
    if lowered.contains("certificate") || lowered.contains("unknownissuer") || lowered.contains("handshake") {
        return desk_err!(
            "Could not open a secure connection to {host}. Your network may be blocking or intercepting this exchange; try another network or a VPN."
        );
    }
    desk_err!("Could not reach {host}: {cause}.")
}

/// The most specific message a JSON error body offers.
pub fn error_detail(data: &Value) -> Option<String> {
    let nested = match data.get("error") {
        Some(Value::Object(error)) => error.get("message").or_else(|| error.get("code")),
        other => other,
    };
    [data.get("message"), data.get("msg"), data.get("retMsg"), nested]
        .into_iter()
        .flatten()
        .find_map(|v| match v {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .map(|text| text.chars().take(240).collect())
}

/// Why an HTTP exchange failed. `status` is `None` when no response arrived at all.
#[derive(Debug)]
pub struct HttpFailure {
    pub status: Option<u16>,
    pub error: DeskError,
}

impl HttpFailure {
    /// No response arrived, so repeating a read is safe and may help.
    pub fn is_transport(&self) -> bool {
        self.status.is_none()
    }

    /// The host answered but refuses this client or region.
    pub fn is_refusal(&self) -> bool {
        matches!(self.status, Some(403 | 451))
    }
}

impl From<HttpFailure> for DeskError {
    fn from(failure: HttpFailure) -> Self {
        failure.error
    }
}

/// Sends a request and reads a JSON body of at most `limit` bytes.
///
/// HTTP errors become a message naming the host, the status and the server's own
/// explanation. A 2xx body that is not JSON is reported with `status` set.
pub async fn send_json(
    host: &str,
    request: reqwest::RequestBuilder,
    limit: usize,
) -> std::result::Result<Value, HttpFailure> {
    let transport = |error: reqwest::Error| HttpFailure { status: None, error: unreachable(host, error) };
    let response: Response = request.send().await.map_err(transport)?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(transport)?;
    let fail = |error: DeskError| HttpFailure { status: Some(status.as_u16()), error };
    if bytes.len() > limit {
        return Err(fail(desk_err!("{host} returned an unexpectedly large response.")));
    }
    let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
    if !status.is_success() {
        let detail = parsed
            .as_ref()
            .and_then(error_detail)
            .filter(|text| text.parse::<u16>().is_err())
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed").to_string());
        return Err(fail(desk_err!("{host} ({}): {detail}", status.as_u16())));
    }
    parsed.ok_or_else(|| fail(desk_err!("{host} returned invalid JSON.")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn error_bodies_from_every_venue_yield_their_own_message() {
        assert_eq!(
            error_detail(&json!({"code": -1121, "msg": "Invalid symbol."})).as_deref(),
            Some("Invalid symbol.")
        );
        assert_eq!(
            error_detail(&json!({"retCode": 10001, "retMsg": "params error"})).as_deref(),
            Some("params error")
        );
        assert_eq!(
            error_detail(&json!({"error": {"code": 402, "message": "Insufficient credits"}})).as_deref(),
            Some("Insufficient credits")
        );
        assert_eq!(error_detail(&json!({"error": "model not found"})).as_deref(), Some("model not found"));
        assert_eq!(error_detail(&json!({"ok": false})), None);
        assert_eq!(host_of("https://api.binance.com/api/v3/order?signature=abc"), "api.binance.com");
    }
}
