//! OpenRouter: the model catalog and streamed chat completions with tool calls.
//!
//! The wire format is the OpenAI-compatible Chat Completions API. Three things
//! need care across the hundreds of models behind it, and are handled here:
//!
//! - **Tool calls arrive in fragments.** Each call is assembled by index, and a
//!   provider that re-sends a whole call is not double-counted.
//! - **Reasoning must be handed back.** Models that think before a tool call
//!   expect their `reasoning_details` returned unchanged on the next request.
//!   Streamed text fragments are merged into the blocks the model produced.
//! - **Not every model takes every parameter.** `temperature`, `tools` and
//!   `reasoning` are only sent when the catalog says the model supports them.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::sse::SseDecoder;
use crate::error::{DeskError, Result};
use crate::net::{error_detail, send_json, unreachable};
use crate::{bail, desk_err};

pub const DEFAULT_BASE: &str = "https://openrouter.ai/api/v1";
const HOST: &str = "openrouter.ai";
/// Sent as attribution headers, as OpenRouter asks of apps.
const APP_URL: &str = "https://github.com/kerjakuyco/octo-gens";
const APP_TITLE: &str = "Octo Gens";
/// A stream that sends nothing for this long is treated as dead. OpenRouter
/// sends keep-alive comments while a model is thinking, so this is generous.
const IDLE: Duration = Duration::from_secs(120);
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

/// Model ids look like `vendor/model:variant`; aliases start with `~`.
pub fn valid_model_id(id: &str) -> bool {
    let body = id.strip_prefix('~').unwrap_or(id);
    (1..=160).contains(&body.len())
        && body.as_bytes()[0].is_ascii_alphanumeric()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'@' | b'+' | b'-'))
}

/// Replaces every occurrence of a secret so it cannot reach the screen or the journal.
pub fn scrub(text: &str, secret: &str) -> String {
    if secret.is_empty() { text.to_string() } else { text.replace(secret, "••••") }
}

/// What the catalog says about one chat model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    /// Context window in tokens.
    pub context: u64,
    /// USD per million prompt tokens; `None` when pricing varies per request.
    pub prompt_price: Option<f64>,
    pub completion_price: Option<f64>,
    pub tools: bool,
    pub reasoning: bool,
    pub temperature: bool,
    pub max_output: Option<u64>,
    pub free: bool,
    /// Unix seconds the model was listed.
    pub created: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// USD, as reported by OpenRouter.
    pub cost: Option<f64>,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        if let Some(cost) = other.cost {
            self.cost = Some(self.cost.unwrap_or(0.0) + cost);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.prompt_tokens == 0 && self.completion_tokens == 0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON text exactly as the model produced it.
    pub arguments: String,
}

/// One complete model reply.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatReply {
    pub text: String,
    /// Human-readable thinking, for display only.
    pub reasoning: String,
    /// Opaque reasoning blocks to send back with tool results.
    pub reasoning_details: Vec<Value>,
    pub tool_calls: Vec<ToolCall>,
    pub finish: String,
    pub usage: Usage,
    /// The caller cancelled; whatever arrived before that is kept.
    pub cancelled: bool,
}

impl ChatReply {
    /// The assistant message to append to the conversation before tool results.
    pub fn assistant_message(&self) -> Value {
        let mut message = json!({
            "role": "assistant",
            "content": if self.text.is_empty() { Value::Null } else { Value::String(self.text.clone()) },
        });
        if !self.tool_calls.is_empty() {
            message["tool_calls"] = self
                .tool_calls
                .iter()
                .map(|call| json!({"id": call.id, "type": "function", "function": {"name": call.name, "arguments": call.arguments}}))
                .collect();
        }
        if !self.reasoning_details.is_empty() {
            message["reasoning_details"] = Value::Array(self.reasoning_details.clone());
        } else if !self.reasoning.is_empty() {
            message["reasoning"] = Value::String(self.reasoning.clone());
        }
        message
    }
}

/// Receives the reply as it streams.
pub trait ChatSink: Send {
    fn text(&mut self, delta: &str);
    fn reasoning(&mut self, delta: &str);
}

/// A sink that ignores everything, for callers that only want the final reply.
pub struct NoSink;

impl ChatSink for NoSink {
    fn text(&mut self, _: &str) {}
    fn reasoning(&mut self, _: &str) {}
}

pub struct ChatRequest<'a> {
    pub model: &'a ModelInfo,
    pub messages: &'a [Value],
    /// Function tool definitions; empty for a plain chat.
    pub tools: &'a [Value],
    /// False forces a text answer even though tools are defined.
    pub allow_tools: bool,
    /// `low`, `medium` or `high`; `None` leaves the model's default.
    pub effort: Option<&'a str>,
    pub max_tokens: u64,
}

impl ChatRequest<'_> {
    fn body(&self) -> Value {
        // Never ask for more output than the model can produce.
        let max_tokens = self.model.max_output.map_or(self.max_tokens, |cap| self.max_tokens.min(cap));
        let mut body = json!({
            "model": self.model.id,
            "messages": self.messages,
            "stream": true,
            "max_tokens": max_tokens,
            "usage": {"include": true},
        });
        if self.model.temperature {
            body["temperature"] = json!(0.3);
        }
        if !self.tools.is_empty() && self.model.tools {
            body["tools"] = Value::Array(self.tools.to_vec());
            body["tool_choice"] = json!(if self.allow_tools { "auto" } else { "none" });
        }
        if let Some(effort) = self.effort.filter(|_| self.model.reasoning) {
            body["reasoning"] = json!({"effort": effort});
        }
        body
    }
}

#[derive(Default)]
struct Slot {
    index: Option<i64>,
    id: String,
    name: String,
    arguments: String,
}

/// Rebuilds a reply from stream chunks. Free of I/O so it can be tested exactly.
#[derive(Default)]
pub(crate) struct Assembly {
    text: String,
    reasoning: String,
    details: Vec<Value>,
    slots: Vec<Slot>,
    finish: String,
    usage: Usage,
}

fn is_json(text: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok()
}

impl Assembly {
    /// Applies one stream chunk (or a whole non-streamed completion).
    pub(crate) fn absorb(&mut self, chunk: &Value, sink: &mut dyn ChatSink) -> Result<()> {
        if chunk.get("error").is_some_and(|e| !e.is_null()) {
            let detail = error_detail(chunk).unwrap_or_else(|| "the provider failed mid-reply".to_string());
            bail!("The model stopped with an error: {detail}");
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Usage {
                prompt_tokens: usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                completion_tokens: usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                cost: usage.get("cost").and_then(Value::as_f64),
            };
        }
        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            return Ok(());
        };
        if let Some(error) = choice.get("error").filter(|e| !e.is_null()) {
            let detail =
                error.get("message").and_then(Value::as_str).unwrap_or("the provider failed mid-reply");
            bail!("The model stopped with an error: {detail}");
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish = reason.to_string();
        }
        // Streamed chunks carry `delta`; a non-streamed completion carries `message`.
        let Some(delta) = choice.get("delta").or_else(|| choice.get("message")).filter(|d| d.is_object())
        else {
            return Ok(());
        };
        if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            self.text.push_str(text);
            sink.text(text);
        }
        let spoken = delta
            .get("reasoning")
            .or_else(|| delta.get("reasoning_content"))
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty());
        if let Some(text) = spoken {
            self.reasoning.push_str(text);
            sink.reasoning(text);
        }
        for detail in delta.get("reasoning_details").and_then(Value::as_array).into_iter().flatten() {
            if spoken.is_none() {
                let shown = detail
                    .get("text")
                    .or_else(|| detail.get("summary"))
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty());
                if let Some(text) = shown {
                    self.reasoning.push_str(text);
                    sink.reasoning(text);
                }
            }
            self.reasoning_detail(detail);
        }
        for call in delta.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            self.tool_delta(call);
        }
        Ok(())
    }

    /// Merges streamed fragments back into the blocks the model produced: text
    /// fragments join until a signature closes the block, summaries join, and
    /// encrypted blocks are kept one by one. Anything else is passed through.
    fn reasoning_detail(&mut self, detail: &Value) {
        let kind = detail.get("type").and_then(Value::as_str).unwrap_or("");
        let field = match kind {
            "reasoning.text" => "text",
            "reasoning.summary" => "summary",
            _ => {
                self.details.push(detail.clone());
                return;
            }
        };
        let piece = detail.get(field).and_then(Value::as_str).unwrap_or("");
        let open = self.details.last_mut().filter(|last| {
            last.get("type").and_then(Value::as_str) == Some(kind)
                && last.get("signature").is_none_or(Value::is_null)
        });
        match open {
            Some(last) => {
                let joined = format!("{}{piece}", last.get(field).and_then(Value::as_str).unwrap_or(""));
                last[field] = Value::String(joined);
                for key in ["signature", "format", "id"] {
                    if last.get(key).is_none_or(Value::is_null)
                        && let Some(value) = detail.get(key).filter(|v| !v.is_null())
                    {
                        last[key] = value.clone();
                    }
                }
            }
            None => self.details.push(detail.clone()),
        }
    }

    fn tool_delta(&mut self, call: &Value) {
        let index = call.get("index").and_then(Value::as_i64);
        let id = call.get("id").and_then(Value::as_str).unwrap_or("");
        let function = call.get("function");
        let name = function.and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
        let arguments = match function.and_then(|f| f.get("arguments")) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) | None => String::new(),
            // A few providers send the arguments as an object instead of JSON text.
            Some(other) => other.to_string(),
        };
        let position = match index {
            // A different id at a known index is a new call, not a continuation.
            Some(_) => self
                .slots
                .iter()
                .rposition(|s| s.index == index && (id.is_empty() || s.id.is_empty() || s.id == id)),
            None if id.is_empty() => self.slots.len().checked_sub(1),
            None => self.slots.iter().rposition(|s| s.id == id),
        };
        let slot = match position {
            Some(position) => &mut self.slots[position],
            None => {
                self.slots.push(Slot { index, ..Slot::default() });
                let last = self.slots.len() - 1;
                &mut self.slots[last]
            }
        };
        if slot.id.is_empty() {
            slot.id = id.to_string();
        }
        if slot.name.is_empty() {
            slot.name = name.to_string();
        }
        // Skip a provider re-sending the complete arguments it already streamed.
        let resent = !slot.arguments.is_empty() && arguments == slot.arguments && is_json(&arguments);
        if !resent {
            slot.arguments.push_str(&arguments);
        }
    }

    pub(crate) fn finish(self, cancelled: bool) -> Result<ChatReply> {
        let tool_calls: Vec<ToolCall> = self
            .slots
            .into_iter()
            .filter(|slot| !slot.name.is_empty())
            .enumerate()
            .map(|(n, slot)| ToolCall {
                id: if slot.id.is_empty() { format!("call_{n}") } else { slot.id },
                name: slot.name,
                arguments: if slot.arguments.trim().is_empty() { "{}".to_string() } else { slot.arguments },
            })
            .collect();
        if !cancelled && self.text.trim().is_empty() && tool_calls.is_empty() {
            if self.finish == "length" {
                bail!(
                    "The model used its whole output budget before answering (thinking counts toward it). Lower the reasoning effort in Settings or pick another model."
                );
            }
            if self.finish == "content_filter" {
                bail!(
                    "The model's provider filtered this reply. Rephrase the request or pick another model."
                );
            }
            bail!("The model returned an empty reply. Try again, or pick another model in Settings.");
        }
        Ok(ChatReply {
            text: self.text,
            reasoning: self.reasoning,
            reasoning_details: self.details,
            tool_calls,
            finish: self.finish,
            usage: self.usage,
            cancelled,
        })
    }
}

/// Turns an HTTP failure into something the trader can act on.
fn explain(status: u16, detail: &str, model: &str) -> DeskError {
    match status {
        401 => desk_err!("OpenRouter rejected the API key. Paste a valid key in Settings."),
        402 => desk_err!(
            "Your OpenRouter balance is too low for this request. Add credits at openrouter.ai or pick a free model."
        ),
        403 => desk_err!("OpenRouter blocked this request: {detail}"),
        404 => desk_err!(
            "OpenRouter cannot run {model} for this request ({detail}). Pick another model in Settings."
        ),
        408 => desk_err!("The model took too long to start. Try again or pick a faster model."),
        429 => {
            desk_err!("The model is rate limited right now ({detail}). Wait a moment or pick another model.")
        }
        500..=599 => {
            desk_err!("The model's provider is unavailable ({detail}). Try again or pick another model.")
        }
        _ => desk_err!("OpenRouter refused the request ({status}): {detail}"),
    }
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

    fn request(&self, method: reqwest::Method, path: &str, key: Option<&str>) -> reqwest::RequestBuilder {
        let request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header("HTTP-Referer", APP_URL)
            .header("X-OpenRouter-Title", APP_TITLE);
        match key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }

    /// Text chat models, newest first. The catalog is public, so a key is optional.
    pub async fn models(&self, key: Option<&str>) -> Result<Vec<ModelInfo>> {
        let key = key.filter(|k| !k.trim().is_empty()).map(valid_key).transpose()?;
        let request =
            self.request(reqwest::Method::GET, "/models", key.as_deref()).timeout(Duration::from_secs(30));
        let data = send_json(HOST, request, CATALOG_LIMIT).await?;
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

    /// Streams one chat completion. Text and reasoning reach `sink` as they
    /// arrive; the assembled reply is returned at the end. Cancelling drops the
    /// connection, which also stops billing on providers that support it.
    pub async fn chat(
        &self,
        key: &str,
        request: &ChatRequest<'_>,
        sink: &mut dyn ChatSink,
        cancel: &CancellationToken,
    ) -> Result<ChatReply> {
        let key = valid_key(key)?;
        if !valid_model_id(&request.model.id) {
            bail!("Choose a model from the OpenRouter catalog in Settings.");
        }
        let sending =
            self.request(reqwest::Method::POST, "/chat/completions", Some(&key)).json(&request.body()).send();
        let response = tokio::select! {
            () = cancel.cancelled() => return Assembly::default().finish(true),
            response = tokio::time::timeout(IDLE, sending) => match response {
                Ok(response) => response.map_err(|error| unreachable(HOST, error))?,
                Err(_) => bail!("OpenRouter did not answer in time. Check your connection and try again."),
            },
        };
        let status = response.status();
        let streaming = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|kind| kind.starts_with("text/event-stream"));
        let fail = |error: DeskError| DeskError::new(scrub(&error.0, &key));

        let mut assembly = Assembly::default();
        if !status.is_success() || !streaming {
            let bytes = response.bytes().await.map_err(|error| unreachable(HOST, error))?;
            let data: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            if !status.is_success() {
                let detail = error_detail(&data)
                    .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed").to_string());
                return Err(fail(explain(status.as_u16(), &detail, &request.model.id)));
            }
            if data.is_null() {
                bail!("OpenRouter returned a reply this desk does not understand.");
            }
            assembly.absorb(&data, sink).map_err(fail)?;
            return assembly.finish(false).map_err(fail);
        }

        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut cancelled = false;
        'read: loop {
            let next = tokio::select! {
                () = cancel.cancelled() => { cancelled = true; break 'read; }
                next = tokio::time::timeout(IDLE, stream.next()) => next,
            };
            let payloads = match next {
                Err(_) => bail!("The model stopped responding. Try again or pick another model."),
                Ok(None) => break 'read,
                Ok(Some(Err(error))) => return Err(unreachable(HOST, error)),
                Ok(Some(Ok(bytes))) => decoder.feed(&bytes),
            };
            for payload in payloads {
                if payload == "[DONE]" {
                    break 'read;
                }
                if let Ok(chunk) = serde_json::from_str::<Value>(&payload) {
                    assembly.absorb(&chunk, sink).map_err(fail)?;
                }
            }
        }
        if !cancelled {
            for payload in decoder.finish() {
                if let Ok(chunk) = serde_json::from_str::<Value>(&payload) {
                    assembly.absorb(&chunk, sink).map_err(fail)?;
                }
            }
        }
        assembly.finish(cancelled).map_err(fail)
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
