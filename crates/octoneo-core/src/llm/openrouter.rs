//! OpenRouter: one key, hundreds of models. The catalog says what each model can
//! do, and only models that can call tools are offered to the assistant.

use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub use super::chat::{
    ChatReply, ChatRequest, ChatSink, ModelInfo, NoSink, ToolCall, Usage, scrub, valid_model_id,
};
use super::chat::{Endpoint, Flavor, stream};
use crate::error::{DeskError, Result};
use crate::net::send_json;
use crate::{bail, desk_err};

pub const DEFAULT_BASE: &str = "https://openrouter.ai/api/v1";
pub const NAME: &str = "OpenRouter";
const HOST: &str = "openrouter.ai";
/// Sent as attribution headers, as OpenRouter asks of apps.
const APP_URL: &str = "https://github.com/kerjakuyco/octo-gens";
const APP_TITLE: &str = "OctoNeo";
const CATALOG_LIMIT: usize = 16_000_000;

/// Checks the shape of an OpenRouter key and returns it trimmed.
pub fn valid_key(raw: &str) -> Result<String> {
    let key = raw.trim();
    let body = key.strip_prefix("sk-or-").unwrap_or("");
    let shaped = (20..=220).contains(&body.len())
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'));
    if !shaped {
        bail!("Paste an OpenRouter key that starts with sk-or-.");
    }
    Ok(key.to_string())
}

pub struct OpenRouter {
    http: Client,
    base: String,
}

impl OpenRouter {
    pub fn new(http: Client) -> Self {
        Self { http, base: DEFAULT_BASE.to_string() }
    }

    /// Points the client at another origin. Used by tests.
    pub fn with_base(mut self, base: &str) -> Self {
        self.base = base.trim_end_matches('/').to_string();
        self
    }

    /// Where chats go, and how they are signed.
    pub fn endpoint(&self, key: &str) -> Result<Endpoint> {
        let key = valid_key(key)?;
        Ok(Endpoint {
            name: NAME,
            url: format!("{}/chat/completions", self.base),
            headers: vec![
                ("Authorization", format!("Bearer {key}")),
                ("HTTP-Referer", APP_URL.to_string()),
                ("X-OpenRouter-Title", APP_TITLE.to_string()),
            ],
            secrets: vec![key],
            flavor: Flavor::OpenRouter,
        })
    }

    /// Asks OpenRouter whether it knows a key, so a mistyped one is caught when it
    /// is pasted and not at the first question. Only a plain refusal counts: when
    /// the check itself cannot be made, the key is given the benefit of the doubt.
    pub async fn check_key(&self, key: &str) -> Result<()> {
        let request =
            self.http.get(format!("{}/key", self.base)).bearer_auth(key).timeout(Duration::from_secs(15));
        match send_json(HOST, request, 200_000).await {
            Err(failure) if matches!(failure.status, Some(401 | 403)) => {
                bail!("OpenRouter does not know this key. Copy it again from openrouter.ai/keys.")
            }
            _ => Ok(()),
        }
    }

    /// Text chat models, newest first. The catalog is public, so a key is optional.
    pub async fn models(&self, key: Option<&str>) -> Result<Vec<ModelInfo>> {
        let key = key.filter(|k| !k.trim().is_empty()).map(valid_key).transpose()?;
        let mut request = self
            .http
            .get(format!("{}/models", self.base))
            .header("HTTP-Referer", APP_URL)
            .header("X-OpenRouter-Title", APP_TITLE)
            .timeout(Duration::from_secs(30));
        if let Some(key) = &key {
            request = request.bearer_auth(key);
        }
        // Whatever OpenRouter says, the key is not repeated on screen.
        let data = send_json(HOST, request, CATALOG_LIMIT)
            .await
            .map_err(|failure| DeskError::new(scrub(&failure.error.0, key.as_deref().unwrap_or_default())))?;
        let rows = data
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| desk_err!("OpenRouter did not return a model catalog."))?;
        let mut models: Vec<ModelInfo> = rows.iter().filter_map(model_from).collect();
        if models.is_empty() {
            bail!("OpenRouter returned no chat models.");
        }
        models.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.name.cmp(&b.name)));
        Ok(models)
    }

    /// Streams one chat completion from the model in `request`.
    pub async fn chat(
        &self,
        key: &str,
        request: &ChatRequest<'_>,
        sink: &mut dyn ChatSink,
        cancel: &CancellationToken,
    ) -> Result<ChatReply> {
        let endpoint = self.endpoint(key)?;
        if !valid_model_id(&request.model.id) {
            bail!("Choose a model from the OpenRouter catalog in Settings.");
        }
        stream(&self.http, &endpoint, request, sink, cancel).await
    }
}

fn model_from(row: &Value) -> Option<ModelInfo> {
    let id = row.get("id")?.as_str()?;
    let list = |key: &str| -> Vec<&str> {
        row.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    };
    let outputs: Vec<&str> = row
        .get("architecture")
        .and_then(|a| a.get("output_modalities"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !valid_model_id(id) || !list("endpoints").contains(&"/api/v1/chat/completions") || outputs != ["text"]
    {
        return None;
    }
    let supported = list("supported_parameters");
    // Prices are USD per token as text; a negative price means "varies" (routers).
    let price = |key: &str| -> Option<f64> {
        let raw = row.get("pricing")?.get(key)?;
        let per_token = raw.as_str().and_then(|t| t.parse::<f64>().ok()).or_else(|| raw.as_f64())?;
        (per_token >= 0.0).then_some(per_token * 1_000_000.0)
    };
    let (prompt_price, completion_price) = (price("prompt"), price("completion"));
    Some(ModelInfo {
        id: id.to_string(),
        name: row.get("name").and_then(Value::as_str).unwrap_or(id).chars().take(120).collect(),
        context: row.get("context_length").and_then(Value::as_u64).unwrap_or(0),
        prompt_price,
        completion_price,
        tools: supported.contains(&"tools"),
        reasoning: supported.contains(&"reasoning"),
        temperature: supported.contains(&"temperature"),
        max_output: row
            .get("top_provider")
            .and_then(|p| p.get("max_completion_tokens"))
            .and_then(Value::as_u64),
        free: prompt_price == Some(0.0) && completion_price == Some(0.0),
        created: row.get("created").and_then(Value::as_i64).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests;
