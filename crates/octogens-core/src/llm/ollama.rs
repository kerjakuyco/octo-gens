//! Ollama: models that run on this computer.
//!
//! Ollama's own chat API is used rather than its OpenAI-format one, because
//! only the former lets a request say how much context it needs. Ollama's
//! default is too small for the assistant's instructions, tools and readings,
//! and a model that silently loses the start of its prompt gives bad answers.
//!
//! Only models installed locally are accepted: nothing typed here leaves the
//! machine.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::join_all;
use reqwest::Client;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::chat::{
    ChatReply, ChatRequest, ChatSink, ModelInfo, ToolCall, Usage, Whole, read_whole, valid_model_id,
};
use super::sse::EVENT_LIMIT;
use super::{CONTEXT, MIN_CONTEXT};
use crate::error::{DeskError, Result};
use crate::net::send_json;
use crate::{bail, desk_err};

pub const DEFAULT_URL: &str = "http://127.0.0.1:11434";
pub const NAME: &str = "Ollama";
/// A local model may have to be read from disk before its first word.
const IDLE: Duration = Duration::from_secs(300);
/// Models asked about when listing. Each costs one local request.
const LISTED: usize = 60;

#[derive(Clone)]
pub struct Ollama {
    http: Client,
}

/// Cloud-backed tags (`model:cloud`, `model-cloud`) run remotely even though Ollama serves them.
fn cloud_tag(model: &str) -> bool {
    let lowered = model.to_ascii_lowercase();
    lowered.split(':').any(|part| part == "cloud" || part.ends_with("-cloud"))
}

fn down() -> DeskError {
    desk_err!("Ollama is not running. Start it, then try again.")
}

/// What `/api/show` says about a model, as the assistant needs it.
fn model_from(model: &str, info: &Value) -> Result<ModelInfo> {
    let remote = ["remote_model", "remote_host"]
        .iter()
        .any(|key| info.get(key).is_some_and(|v| !v.is_null() && v != ""));
    if remote || cloud_tag(model) {
        bail!("Choose a model installed on this computer; cloud models are not used here.");
    }
    let Some(details) = info.get("model_info").filter(|v| v.is_object()) else {
        bail!("Ollama did not report {model} as installed. Run `ollama pull {model}` first.");
    };
    // The context length is filed under the model's architecture, e.g. `qwen3.context_length`.
    let context = details
        .as_object()
        .and_then(|fields| fields.iter().find(|(key, _)| key.ends_with(".context_length")))
        .and_then(|(_, value)| value.as_u64())
        .unwrap_or(0);
    // Older versions do not report capabilities; such a model is given the benefit of the doubt.
    let tools = info
        .get("capabilities")
        .and_then(Value::as_array)
        .is_none_or(|capabilities| capabilities.iter().any(|c| c == "tools"));
    Ok(ModelInfo {
        id: model.to_string(),
        name: model.to_string(),
        context,
        tools,
        free: true,
        ..ModelInfo::default()
    })
}

/// The context to ask Ollama for: enough for the assistant, never more than the model has.
pub fn context_for(model: &ModelInfo) -> u64 {
    if model.context == 0 { CONTEXT } else { model.context.clamp(MIN_CONTEXT.min(model.context), CONTEXT) }
}

/// Rewrites OpenAI-format messages the way Ollama's chat API wants them: tool
/// arguments as objects, and each tool result labelled with the tool's name.
fn native_messages(messages: &[Value]) -> Vec<Value> {
    let mut names: HashMap<String, String> = HashMap::new();
    messages
        .iter()
        .map(|message| {
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            match message.get("role").and_then(Value::as_str).unwrap_or("user") {
                "assistant" => {
                    let mut out = json!({"role": "assistant", "content": content});
                    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                        let calls: Vec<Value> = calls
                            .iter()
                            .map(|call| {
                                let function = &call["function"];
                                let name = function["name"].as_str().unwrap_or("");
                                if let Some(id) = call["id"].as_str() {
                                    names.insert(id.to_string(), name.to_string());
                                }
                                let arguments = function["arguments"]
                                    .as_str()
                                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                                    .filter(Value::is_object)
                                    .unwrap_or_else(|| json!({}));
                                json!({"function": {"name": name, "arguments": arguments}})
                            })
                            .collect();
                        out["tool_calls"] = Value::Array(calls);
                    }
                    if let Some(thinking) = message.get("reasoning").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                        out["thinking"] = Value::String(thinking.to_string());
                    }
                    out
                }
                "tool" => {
                    let name = message.get("tool_call_id").and_then(Value::as_str).and_then(|id| names.get(id));
                    json!({"role": "tool", "content": content, "tool_name": name.cloned().unwrap_or_default()})
                }
                role => json!({"role": role, "content": content}),
            }
        })
        .collect()
}

/// Rebuilds a reply from the lines Ollama streams. Free of I/O so it can be tested exactly.
#[derive(Default)]
struct Reply {
    text: String,
    reasoning: String,
    calls: Vec<ToolCall>,
    finish: String,
    usage: Usage,
}

impl Reply {
    fn absorb(&mut self, line: &Value, sink: &mut dyn ChatSink) -> Result<()> {
        if let Some(error) = line.get("error").and_then(Value::as_str) {
            bail!("The model stopped with an error: {}", error.chars().take(240).collect::<String>());
        }
        if let Some(message) = line.get("message") {
            if let Some(text) = message.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                self.text.push_str(text);
                sink.text(text);
            }
            if let Some(text) = message.get("thinking").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                self.reasoning.push_str(text);
                sink.reasoning(text);
            }
            // Ollama sends each tool call whole, with its arguments as an object.
            for call in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let function = &call["function"];
                let Some(name) = function["name"].as_str().filter(|name| !name.is_empty()) else {
                    continue;
                };
                let arguments = match &function["arguments"] {
                    Value::String(text) => text.clone(),
                    Value::Null => "{}".to_string(),
                    other => other.to_string(),
                };
                let id =
                    call["id"].as_str().map_or_else(|| format!("call_{}", self.calls.len()), str::to_string);
                self.calls.push(ToolCall { id, name: name.to_string(), arguments });
            }
        }
        if line.get("done").and_then(Value::as_bool) == Some(true) {
            self.finish = line.get("done_reason").and_then(Value::as_str).unwrap_or("stop").to_string();
            self.usage = Usage {
                prompt_tokens: line.get("prompt_eval_count").and_then(Value::as_u64).unwrap_or(0),
                completion_tokens: line.get("eval_count").and_then(Value::as_u64).unwrap_or(0),
                cost: None,
            };
        }
        Ok(())
    }

    fn finish(self, cancelled: bool) -> Result<ChatReply> {
        if !cancelled && self.text.trim().is_empty() && self.calls.is_empty() {
            if self.finish == "length" {
                bail!(
                    "The model ran out of room before answering. Ask a shorter question, or pick a model with a longer context."
                );
            }
            bail!("The model returned an empty reply. Try again, or pick another model in Settings.");
        }
        Ok(ChatReply {
            text: self.text,
            reasoning: self.reasoning,
            reasoning_details: Vec::new(),
            tool_calls: self.calls,
            finish: self.finish,
            usage: self.usage,
            cancelled,
        })
    }
}

impl Ollama {
    /// `http` must not go through a system proxy: this talks to the local machine.
    pub fn new(http: Client) -> Self {
        Self { http }
    }

    async fn show(&self, url: &str, model: &str) -> Result<Value> {
        let request = self
            .http
            .post(format!("{url}/api/show"))
            .timeout(Duration::from_secs(12))
            .json(&json!({"model": model}));
        send_json(NAME, request, 4_000_000)
            .await
            .map_err(|failure| if failure.is_transport() { down() } else { failure.error })
    }

    /// Confirms `model` is installed locally, is not a remote alias, and can use tools.
    pub async fn verify(&self, url: &str, model: &str) -> Result<ModelInfo> {
        let model = model.trim();
        if !valid_model_id(model) {
            bail!("Enter a locally installed Ollama model tag, for example qwen3:8b.");
        }
        let info = model_from(model, &self.show(url, model).await?)?;
        if !info.tools {
            bail!("{model} cannot use tools. Pick a model that can.");
        }
        Ok(info)
    }

    /// The models installed on this computer, those that can use tools first.
    pub async fn models(&self, url: &str) -> Result<Vec<ModelInfo>> {
        let request = self.http.get(format!("{url}/api/tags")).timeout(Duration::from_secs(8));
        let data = send_json(NAME, request, 4_000_000)
            .await
            .map_err(|failure| if failure.is_transport() { down() } else { failure.error })?;
        let names: Vec<String> = data
            .get("models")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(|row| row.get("name")?.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let shown = join_all(names.iter().take(LISTED).map(|name| async move {
            let info = self.show(url, name).await.ok()?;
            // Cloud aliases and anything else that is not a local model are left out.
            model_from(name, &info).ok()
        }))
        .await;
        let mut models: Vec<ModelInfo> = shown.into_iter().flatten().collect();
        models.sort_by(|a, b| b.tools.cmp(&a.tools).then_with(|| a.name.cmp(&b.name)));
        Ok(models)
    }

    /// Streams one chat. `context` is how many tokens of context Ollama is asked to give the model.
    pub async fn chat(
        &self,
        url: &str,
        context: u64,
        request: &ChatRequest<'_>,
        sink: &mut dyn ChatSink,
        cancel: &CancellationToken,
    ) -> Result<ChatReply> {
        let mut body = json!({
            "model": request.model.id,
            "messages": native_messages(request.messages),
            "stream": true,
            // `num_predict` is the output cap: a model that loops must stop short of filling its context.
            "options": {"num_ctx": context, "temperature": 0.3, "num_predict": request.max_tokens},
        });
        // The round that must answer in words is simply not offered tools.
        if !request.tools.is_empty() && request.model.tools && request.allow_tools {
            body["tools"] = Value::Array(request.tools.to_vec());
        }
        let sending = self.http.post(format!("{url}/api/chat")).json(&body).send();
        let response = tokio::select! {
            () = cancel.cancelled() => return Reply::default().finish(true),
            response = tokio::time::timeout(IDLE, sending) => match response {
                Ok(response) => response.map_err(|_| down())?,
                Err(_) => bail!("Ollama did not answer in time. Check that the model fits in this computer's memory."),
            },
        };
        let status = response.status();
        if !status.is_success() {
            let bytes = match read_whole(response, IDLE, cancel).await {
                Whole::Bytes(bytes) => bytes,
                Whole::Cancelled => return Reply::default().finish(true),
                Whole::Stalled => bail!("Ollama did not answer in time. Try again."),
                Whole::Lost(_) => return Err(down()),
            };
            let detail = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|data| data.get("error")?.as_str().map(str::to_string))
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed").to_string());
            let detail: String = detail.chars().take(240).collect();
            if detail.contains("does not support tools") {
                bail!("{} cannot use tools. Pick a model that can.", request.model.id);
            }
            bail!("Ollama could not run {}: {detail}", request.model.id);
        }

        let mut reply = Reply::default();
        let mut pending: Vec<u8> = Vec::new();
        let mut stream = response.bytes_stream();
        let mut cancelled = false;
        'read: loop {
            let next = tokio::select! {
                () = cancel.cancelled() => { cancelled = true; break 'read; }
                next = tokio::time::timeout(IDLE, stream.next()) => next,
            };
            // What is held has no newline in it, so only the new bytes are searched.
            let mut from = pending.len();
            match next {
                Err(_) => bail!("The model stopped responding. Try again or pick another model."),
                Ok(None) => break 'read,
                Ok(Some(Err(_))) => bail!("The connection to Ollama was lost mid-reply. Try again."),
                Ok(Some(Ok(bytes))) => pending.extend_from_slice(&bytes),
            }
            // One JSON object per line; a line may arrive in pieces.
            while let Some(offset) = pending[from..].iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = pending.drain(..=from + offset).collect();
                from = 0;
                if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                    reply.absorb(&value, sink)?;
                }
            }
            if pending.len() > EVENT_LIMIT {
                bail!("Ollama sent a reply this desk cannot read. Try again or pick another model.");
            }
        }
        if !cancelled && let Ok(value) = serde_json::from_slice::<Value>(&pending) {
            reply.absorb(&value, sink)?;
        }
        reply.finish(cancelled)
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use super::*;
    use crate::llm::chat::NoSink;
    use crate::llm::local_client;

    #[derive(Default)]
    struct Recorder {
        text: Vec<String>,
        reasoning: Vec<String>,
    }

    impl ChatSink for Recorder {
        fn text(&mut self, delta: &str) {
            self.text.push(delta.to_string());
        }
        fn reasoning(&mut self, delta: &str) {
            self.reasoning.push(delta.to_string());
        }
    }

    fn show(capabilities: Value) -> Value {
        json!({"model_info": {"general.architecture": "qwen3", "qwen3.context_length": 40960}, "capabilities": capabilities})
    }

    async fn local(show_reply: Value, chat_lines: &[Value]) -> (MockServer, Ollama) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/show"))
            .respond_with(ResponseTemplate::new(200).set_body_json(show_reply))
            .mount(&server)
            .await;
        let body: String = chat_lines.iter().map(|line| format!("{line}\n")).collect();
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/x-ndjson"))
            .mount(&server)
            .await;
        (server, Ollama::new(local_client().expect("client")))
    }

    fn body(request: &Request) -> Value {
        serde_json::from_slice(&request.body).expect("json")
    }

    #[tokio::test]
    async fn a_local_model_streams_words_thinking_and_tool_calls() {
        let (server, ollama) = local(
            show(json!(["completion", "tools", "thinking"])),
            &[
                json!({"message": {"role": "assistant", "content": "", "thinking": "Need the price."}, "done": false}),
                json!({"message": {"role": "assistant", "content": "Checking "}, "done": false}),
                json!({"message": {"role": "assistant", "content": "BTC.", "tool_calls": [
                    {"function": {"name": "get_quote", "arguments": {"symbols": ["BTC"]}}},
                    {"id": "call_abc", "function": {"name": "get_account", "arguments": {}}},
                ]}, "done": false}),
                json!({"message": {"role": "assistant", "content": ""}, "done": true, "done_reason": "stop", "prompt_eval_count": 812, "eval_count": 40}),
            ],
        )
        .await;
        let url = server.uri();
        let model = ollama.verify(&url, " qwen3:8b ").await.expect("verified");
        assert_eq!(
            (model.id.as_str(), model.tools, model.context, model.free),
            ("qwen3:8b", true, 40960, true)
        );
        assert_eq!(context_for(&model), 16_384, "enough for the assistant, not the model's whole window");

        // A turn already under way: an earlier tool call and its result are handed back.
        let messages = [
            json!({"role": "system", "content": "rules"}),
            json!({"role": "user", "content": "price?"}),
            json!({"role": "assistant", "content": null, "reasoning": "First the price.",
                "tool_calls": [{"id": "call_0", "type": "function", "function": {"name": "get_quote", "arguments": "{\"symbols\":[\"ETH\"]}"}}]}),
            json!({"role": "tool", "tool_call_id": "call_0", "content": "{\"last_price\":1800}"}),
        ];
        let tools = [
            json!({"type": "function", "function": {"name": "get_quote", "parameters": {"type": "object"}}}),
        ];
        let request = ChatRequest {
            model: &model,
            messages: &messages,
            tools: &tools,
            allow_tools: true,
            effort: None,
            max_tokens: 4096,
        };
        let mut sink = Recorder::default();
        let reply = ollama
            .chat(&url, context_for(&model), &request, &mut sink, &CancellationToken::new())
            .await
            .expect("reply");
        assert_eq!(
            (reply.text.as_str(), reply.reasoning.as_str(), reply.finish.as_str()),
            ("Checking BTC.", "Need the price.", "stop")
        );
        assert_eq!(
            (sink.text, sink.reasoning),
            (vec!["Checking ".to_string(), "BTC.".to_string()], vec!["Need the price.".to_string()])
        );
        assert_eq!(
            reply.tool_calls,
            [
                ToolCall {
                    id: "call_0".into(),
                    name: "get_quote".into(),
                    arguments: "{\"symbols\":[\"BTC\"]}".into()
                },
                ToolCall { id: "call_abc".into(), name: "get_account".into(), arguments: "{}".into() },
            ]
        );
        assert_eq!(
            (reply.usage.prompt_tokens, reply.usage.completion_tokens, reply.usage.cost),
            (812, 40, None)
        );

        let requests = server.received_requests().await.expect("recorded");
        let sent = body(requests.iter().find(|r| r.url.path() == "/api/chat").expect("chat"));
        assert_eq!(
            (&sent["model"], &sent["stream"], &sent["options"]["num_ctx"]),
            (&json!("qwen3:8b"), &json!(true), &json!(16384))
        );
        assert_eq!(sent["tools"][0]["function"]["name"], "get_quote");
        // Ollama's own format: arguments as an object, the result labelled with the tool's name.
        assert_eq!(
            sent["messages"][2],
            json!({"role": "assistant", "content": "", "thinking": "First the price.",
            "tool_calls": [{"function": {"name": "get_quote", "arguments": {"symbols": ["ETH"]}}}]})
        );
        assert_eq!(
            sent["messages"][3],
            json!({"role": "tool", "content": "{\"last_price\":1800}", "tool_name": "get_quote"})
        );

        // The round that must answer in words is not offered tools.
        let last = ChatRequest { allow_tools: false, ..request };
        ollama.chat(&url, 16_384, &last, &mut NoSink, &CancellationToken::new()).await.expect("reply");
        let requests = server.received_requests().await.expect("recorded");
        assert!(body(requests.last().expect("chat")).get("tools").is_none());
    }

    #[tokio::test]
    async fn only_installed_tool_capable_models_are_accepted() {
        let (server, ollama) =
            local(json!({"remote_host": "https://ollama.com", "model_info": {}}), &[]).await;
        assert!(
            ollama
                .verify(&server.uri(), "remote")
                .await
                .expect_err("remote")
                .to_string()
                .contains("installed on this computer")
        );

        let (server, ollama) = local(show(json!(["completion", "tools"])), &[]).await;
        for cloud in ["qwen3:cloud", "gpt-oss:120b-cloud"] {
            assert!(
                ollama.verify(&server.uri(), cloud).await.expect_err(cloud).to_string().contains("cloud")
            );
        }
        assert!(ollama.verify(&server.uri(), "not a tag").await.is_err());

        let (server, ollama) = local(show(json!(["completion", "vision"])), &[]).await;
        assert_eq!(
            ollama.verify(&server.uri(), "gemma:2b").await.expect_err("no tools").to_string(),
            "gemma:2b cannot use tools. Pick a model that can."
        );
        // A version that reports no capabilities at all is given the benefit of the doubt.
        let (server, ollama) = local(json!({"model_info": {"family": "old"}}), &[]).await;
        let old = ollama.verify(&server.uri(), "old:1b").await.expect("accepted");
        assert_eq!((old.tools, old.context, context_for(&old)), (true, 0, 16_384));

        let (server, ollama) = local(json!({"error": "model not found"}), &[]).await;
        assert!(
            ollama
                .verify(&server.uri(), "missing:1b")
                .await
                .expect_err("missing")
                .to_string()
                .contains("ollama pull missing:1b")
        );

        let down = Ollama::new(local_client().expect("client"));
        assert_eq!(
            down.verify("http://127.0.0.1:9", "test:1b").await.expect_err("down").to_string(),
            "Ollama is not running. Start it, then try again."
        );
        assert!(
            down.models("http://127.0.0.1:9").await.expect_err("down").to_string().contains("not running")
        );
        // A small model keeps its own, smaller window.
        assert_eq!(context_for(&ModelInfo { context: 4096, ..ModelInfo::default() }), 4096);
        assert_eq!(context_for(&ModelInfo { context: 12_000, ..ModelInfo::default() }), 12_000);
    }

    #[tokio::test]
    async fn installed_models_are_listed_with_what_they_can_do() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"models": [{"name": "qwen3:8b"}, {"name": "gemma:2b"}, {"name": "gpt-oss:120b-cloud"}]})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/show"))
            .respond_with(|request: &Request| {
                let model = body(request)["model"].as_str().unwrap_or_default().to_string();
                let capabilities = if model.starts_with("qwen") {
                    json!(["completion", "tools"])
                } else {
                    json!(["completion"])
                };
                ResponseTemplate::new(200).set_body_json(show(capabilities))
            })
            .mount(&server)
            .await;
        let models =
            Ollama::new(local_client().expect("client")).models(&server.uri()).await.expect("models");
        assert_eq!(
            models.iter().map(|m| (m.id.as_str(), m.tools)).collect::<Vec<_>>(),
            [("qwen3:8b", true), ("gemma:2b", false)],
            "tool-capable first; the cloud alias is not a local model"
        );
    }

    #[tokio::test]
    async fn failures_and_stops_are_reported_plainly() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(400).set_body_json(
                json!({"error": "registry.ollama.ai/library/gemma:2b does not support tools"}),
            ))
            .mount(&server)
            .await;
        let ollama = Ollama::new(local_client().expect("client"));
        let model = ModelInfo { id: "gemma:2b".into(), tools: true, ..ModelInfo::default() };
        let messages = [json!({"role": "user", "content": "hi"})];
        let request = ChatRequest {
            model: &model,
            messages: &messages,
            tools: &[],
            allow_tools: true,
            effort: None,
            max_tokens: 64,
        };
        let error = ollama
            .chat(&server.uri(), 8192, &request, &mut NoSink, &CancellationToken::new())
            .await
            .expect_err("no tools")
            .to_string();
        assert_eq!(error, "gemma:2b cannot use tools. Pick a model that can.");

        let (server, ollama) = local(show(json!(["tools"])), &[json!({"error": "out of memory"})]).await;
        let error = ollama
            .chat(&server.uri(), 8192, &request, &mut NoSink, &CancellationToken::new())
            .await
            .expect_err("mid-reply")
            .to_string();
        assert_eq!(error, "The model stopped with an error: out of memory");

        let (server, ollama) = local(
            show(json!(["tools"])),
            &[json!({"message": {"content": ""}, "done": true, "done_reason": "length"})],
        )
        .await;
        let error = ollama
            .chat(&server.uri(), 8192, &request, &mut NoSink, &CancellationToken::new())
            .await
            .expect_err("empty")
            .to_string();
        assert!(error.contains("ran out of room"), "{error}");

        // Stop is honoured before the model says anything.
        let cancel = CancellationToken::new();
        cancel.cancel();
        let reply = ollama.chat(&server.uri(), 8192, &request, &mut NoSink, &cancel).await.expect("stopped");
        assert!(reply.cancelled && reply.text.is_empty());
        let down = ollama
            .chat("http://127.0.0.1:9", 8192, &request, &mut NoSink, &CancellationToken::new())
            .await
            .expect_err("down")
            .to_string();
        assert_eq!(down, "Ollama is not running. Start it, then try again.");
    }
}
