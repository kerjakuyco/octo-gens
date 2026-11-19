//! Streamed chat completions with tool calls, for every provider that speaks
//! the OpenAI Chat Completions format.
//!
//! Three things need care across the many models behind these providers, and
//! are handled here:
//!
//! - **Tool calls arrive in fragments.** Each call is assembled by index, and a
//!   provider that re-sends a whole call is not double-counted.
//! - **Reasoning must be handed back.** Models that think before a tool call
//!   expect their `reasoning_details` returned unchanged on the next request.
//!   Streamed text fragments are merged into the blocks the model produced.
//! - **Not every provider takes every parameter.** A [`Flavor`] decides what is
//!   sent, so one loop can drive a router, a gateway and a server on this computer.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::sse::SseDecoder;
use crate::error::{DeskError, Result};
use crate::net::{error_detail, unreachable};
use crate::{bail, desk_err};

/// A stream that sends nothing for this long is treated as dead. Providers send
/// keep-alive comments while a model is thinking, and a model on this computer
/// may need a while to load, so this is generous.
const IDLE: Duration = Duration::from_secs(180);

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

/// How a provider wants a request written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    /// OpenRouter: parameters follow its catalog, usage is asked for its way,
    /// and reasoning effort is an object.
    OpenRouter,
    /// A gateway that forwards plain OpenAI-format requests to many providers.
    /// Only what every one of them accepts is sent.
    Gateway,
    /// A server on this computer.
    Local,
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

/// An earlier assistant message without its thinking. Only OpenRouter defines
/// how thinking is handed back; other providers ignore the fields at best and
/// refuse the request at worst.
fn without_reasoning(message: &Value) -> Value {
    let mut plain = message.clone();
    if let Some(fields) = plain.as_object_mut() {
        fields.remove("reasoning");
        fields.remove("reasoning_details");
    }
    plain
}

impl ChatRequest<'_> {
    pub(crate) fn body(&self, flavor: Flavor, usage: bool) -> Value {
        let messages: Value = match flavor {
            Flavor::OpenRouter => json!(self.messages),
            _ => self.messages.iter().map(without_reasoning).collect(),
        };
        let mut body = json!({"model": self.model.id, "messages": messages, "stream": true});
        let offer = !self.tools.is_empty() && self.model.tools;
        match flavor {
            Flavor::OpenRouter => {
                // Never ask for more output than the model can produce.
                body["max_tokens"] =
                    json!(self.model.max_output.map_or(self.max_tokens, |cap| self.max_tokens.min(cap)));
                body["usage"] = json!({"include": true});
                if self.model.temperature {
                    body["temperature"] = json!(0.3);
                }
                if offer {
                    body["tools"] = Value::Array(self.tools.to_vec());
                    body["tool_choice"] = json!(if self.allow_tools { "auto" } else { "none" });
                }
                if let Some(effort) = self.effort.filter(|_| self.model.reasoning) {
                    body["reasoning"] = json!({"effort": effort});
                }
            }
            Flavor::Gateway => {
                // No temperature, and no output cap for other providers' models: the models behind a
                // gateway disagree on both. Cloudflare's own models take the cap, and without it they
                // stop after a few sentences.
                if self.model.id.starts_with("@cf/") {
                    body["max_tokens"] = json!(self.max_tokens);
                }
                if offer {
                    body["tools"] = Value::Array(self.tools.to_vec());
                    body["tool_choice"] = json!(if self.allow_tools { "auto" } else { "none" });
                }
            }
            Flavor::Local => {
                body["temperature"] = json!(0.3);
                // A model that loops must stop somewhere short of filling its context.
                body["max_tokens"] = json!(self.max_tokens);
                // Local servers do not all honour `tool_choice`, so the round that must
                // answer in words is simply not offered tools.
                if offer && self.allow_tools {
                    body["tools"] = Value::Array(self.tools.to_vec());
                }
            }
        }
        if usage && flavor != Flavor::OpenRouter {
            body["stream_options"] = json!({"include_usage": true});
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

/// Where a provider's Chat Completions endpoint is and how to speak to it.
/// `Debug` is written by hand below: the headers carry the key.
#[derive(Clone)]
pub struct Endpoint {
    /// The provider as the trader knows it, for messages: `OpenRouter`, `LM Studio`.
    pub name: &'static str,
    /// The full URL of the chat completions endpoint.
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    /// Values that must never appear in a message, a trace or the journal.
    pub secrets: Vec<String>,
    pub flavor: Flavor,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("flavor", &self.flavor)
            .finish_non_exhaustive()
    }
}

/// The largest reply read whole: an error body, or a completion that was not streamed.
const WHOLE_LIMIT: usize = 4_000_000;

/// How reading a whole reply ended.
pub(crate) enum Whole {
    Bytes(Vec<u8>),
    /// The trader pressed Stop.
    Cancelled,
    /// Nothing arrived for too long.
    Stalled,
    Lost(reqwest::Error),
}

/// Reads a reply that is not a stream. A server that sends headers and then
/// stalls must not hold the turn forever, and Stop must still work, so the
/// body is read piece by piece under the same watch as a stream. A body larger
/// than any reply could be is cut short and then fails to parse.
pub(crate) async fn read_whole(
    response: reqwest::Response,
    idle: Duration,
    cancel: &CancellationToken,
) -> Whole {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            () = cancel.cancelled() => return Whole::Cancelled,
            next = tokio::time::timeout(idle, stream.next()) => next,
        };
        match next {
            Err(_) => return Whole::Stalled,
            Ok(None) => return Whole::Bytes(body),
            Ok(Some(Err(error))) => return Whole::Lost(error),
            Ok(Some(Ok(bytes))) => {
                let room = WHOLE_LIMIT - body.len();
                if bytes.len() > room {
                    body.extend_from_slice(&bytes[..room]);
                    return Whole::Bytes(body);
                }
                body.extend_from_slice(&bytes);
            }
        }
    }
}

impl Endpoint {
    fn clean(&self, text: &str) -> String {
        self.secrets.iter().fold(text.to_string(), |text, secret| scrub(&text, secret))
    }

    fn host(&self) -> String {
        crate::net::host_of(&self.url)
    }

    /// No answer at all. For a server on this computer that means it is not running.
    fn unreached(&self, error: reqwest::Error) -> DeskError {
        if self.flavor == Flavor::Local {
            return desk_err!("{} is not running on this computer. Start it, then try again.", self.name);
        }
        unreachable(&self.host(), error)
    }

    /// Turns an HTTP failure into something the trader can act on.
    fn explain(&self, status: u16, detail: &str, model: &str) -> DeskError {
        let name = self.name;
        match status {
            401 => desk_err!("{name} rejected the API key. Check it in Settings."),
            402 => desk_err!(
                "Your {name} balance is too low for this request. Add credit, or pick another model."
            ),
            403 => desk_err!("{name} blocked this request: {detail}"),
            404 => desk_err!(
                "{name} cannot run {model} for this request ({detail}). Pick another model in Settings."
            ),
            408 => desk_err!("The model took too long to start. Try again or pick a faster model."),
            429 => {
                desk_err!(
                    "The model is rate limited right now ({detail}). Wait a moment or pick another model."
                )
            }
            500..=599 => {
                desk_err!("The model's provider is unavailable ({detail}). Try again or pick another model.")
            }
            _ => desk_err!("{name} refused the request ({status}): {detail}"),
        }
    }
}

/// Streams one chat completion. Text and reasoning reach `sink` as they
/// arrive; the assembled reply is returned at the end. Cancelling drops the
/// connection, which also stops billing on providers that support it.
pub async fn stream(
    http: &Client,
    endpoint: &Endpoint,
    request: &ChatRequest<'_>,
    sink: &mut dyn ChatSink,
    cancel: &CancellationToken,
) -> Result<ChatReply> {
    let mut usage = true;
    loop {
        let mut sending = http.post(&endpoint.url).json(&request.body(endpoint.flavor, usage));
        for (name, value) in &endpoint.headers {
            sending = sending.header(*name, value);
        }
        let response = tokio::select! {
            () = cancel.cancelled() => return Assembly::default().finish(true),
            response = tokio::time::timeout(IDLE, sending.send()) => match response {
                Ok(response) => response.map_err(|error| endpoint.unreached(error))?,
                Err(_) => bail!("{} did not answer in time. Check your connection and try again.", endpoint.name),
            },
        };
        let status = response.status();
        let streaming = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|kind| kind.starts_with("text/event-stream"));
        let fail = |error: DeskError| DeskError::new(endpoint.clean(&error.0));

        let mut assembly = Assembly::default();
        if !status.is_success() || !streaming {
            let bytes = match read_whole(response, IDLE, cancel).await {
                Whole::Bytes(bytes) => bytes,
                Whole::Cancelled => return Assembly::default().finish(true),
                Whole::Stalled => {
                    bail!("{} did not answer in time. Check your connection and try again.", endpoint.name)
                }
                Whole::Lost(error) => return Err(endpoint.unreached(error)),
            };
            let data: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            if !status.is_success() {
                let detail = error_detail(&data)
                    .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed").to_string());
                // A few servers do not know `stream_options`. Usage is a nicety; ask again without it.
                if usage
                    && endpoint.flavor != Flavor::OpenRouter
                    && status.as_u16() == 400
                    && detail.contains("stream_options")
                {
                    usage = false;
                    continue;
                }
                return Err(fail(endpoint.explain(status.as_u16(), &detail, &request.model.id)));
            }
            if data.is_null() {
                bail!("{} returned a reply this desk does not understand.", endpoint.name);
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
                Ok(Some(Err(error))) => return Err(endpoint.unreached(error)),
                Ok(Some(Ok(bytes))) => decoder.feed(&bytes),
            };
            if decoder.overflowed() {
                bail!(
                    "{} sent a reply this desk cannot read. Try again or pick another model.",
                    endpoint.name
                );
            }
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
        return assembly.finish(cancelled).map_err(fail);
    }
}
