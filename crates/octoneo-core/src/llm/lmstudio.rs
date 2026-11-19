//! LM Studio: models that run on this computer, behind its local server.
//!
//! Chats use the server's OpenAI-format endpoint. Its own REST API says which
//! models are installed and what they can do, and lets a model be loaded with
//! enough context for the assistant's instructions, tools and readings.

use std::time::Duration;

use reqwest::Client;
use serde_json::{Value, json};

use super::chat::{Endpoint, Flavor, ModelInfo};
use super::{CONTEXT, MIN_CONTEXT};
use crate::error::Result;
use crate::net::send_json;
use crate::{bail, desk_err};

pub const DEFAULT_URL: &str = "http://127.0.0.1:1234";
pub const NAME: &str = "LM Studio";

#[derive(Clone)]
pub struct LmStudio {
    http: Client,
}

/// What the server said, or why it could not be asked.
enum Listing {
    Rows(Vec<Value>),
    /// An older LM Studio without the REST API: only model ids are known.
    Ids(Vec<String>),
}

impl LmStudio {
    /// `http` must not go through a system proxy: this talks to the local machine.
    pub fn new(http: Client) -> Self {
        Self { http }
    }

    pub fn endpoint(&self, url: &str) -> Endpoint {
        Endpoint {
            name: NAME,
            url: format!("{url}/v1/chat/completions"),
            headers: Vec::new(),
            secrets: Vec::new(),
            flavor: Flavor::Local,
        }
    }

    async fn get(&self, url: &str, path: &str) -> std::result::Result<Value, crate::net::HttpFailure> {
        let request = self.http.get(format!("{url}{path}")).timeout(Duration::from_secs(8));
        send_json(NAME, request, 4_000_000).await
    }

    async fn listing(&self, url: &str) -> Result<Listing> {
        let down = || desk_err!("LM Studio is not running. Start its local server, then try again.");
        match self.get(url, "/api/v1/models").await {
            Ok(data) => {
                Ok(Listing::Rows(data.get("models").and_then(Value::as_array).cloned().unwrap_or_default()))
            }
            Err(failure) if failure.is_transport() => Err(down()),
            // No REST API on this version: fall back to the OpenAI-format list.
            Err(_) => match self.get(url, "/v1/models").await {
                Ok(data) => {
                    let rows = data.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
                    Ok(Listing::Ids(
                        rows.iter().filter_map(|row| row.get("id")?.as_str().map(str::to_string)).collect(),
                    ))
                }
                Err(failure) if failure.is_transport() => Err(down()),
                Err(failure) => Err(failure.error),
            },
        }
    }

    /// The language models installed in LM Studio, those trained for tool use first.
    pub async fn models(&self, url: &str) -> Result<Vec<ModelInfo>> {
        let mut models: Vec<ModelInfo> = match self.listing(url).await? {
            Listing::Rows(rows) => rows.iter().filter_map(model_from).collect(),
            Listing::Ids(ids) => ids.into_iter().map(|id| unknown(&id)).collect(),
        };
        models.sort_by(|a, b| b.tools.cmp(&a.tools).then_with(|| a.name.cmp(&b.name)));
        Ok(models)
    }

    /// Checks the model is installed and can use tools, and makes sure it is
    /// loaded with enough context, loading it if it is not loaded at all.
    pub async fn prepare(&self, url: &str, model: &str) -> Result<ModelInfo> {
        let rows = match self.listing(url).await? {
            Listing::Rows(rows) => rows,
            Listing::Ids(ids) if ids.iter().any(|id| id == model) => return Ok(unknown(model)),
            Listing::Ids(_) => bail!("LM Studio has no model named {model}."),
        };
        let Some(row) = rows.iter().find(|row| row.get("key").and_then(Value::as_str) == Some(model)) else {
            bail!("LM Studio has no model named {model}.");
        };
        let Some(info) = model_from(row) else {
            bail!("{model} is not a chat model.");
        };
        if !info.tools {
            bail!("{} cannot use tools. Pick a model that can.", info.name);
        }
        let loaded =
            row.get("loaded_instances").and_then(Value::as_array).and_then(|instances| instances.first());
        match loaded.and_then(|instance| instance.get("config")?.get("context_length")?.as_u64()) {
            Some(context) if context < MIN_CONTEXT => bail!(
                "{} is loaded with a context of {context} tokens. Reload it in LM Studio with {CONTEXT} or more.",
                info.name
            ),
            Some(_) => {}
            // Loaded but its settings are not reported: use it as it is.
            None if loaded.is_some() => {}
            None => {
                let wanted = if info.context == 0 { CONTEXT } else { info.context.min(CONTEXT) };
                let request = self
                    .http
                    .post(format!("{url}/api/v1/models/load"))
                    // Reading a large model from disk takes a while.
                    .timeout(Duration::from_secs(180))
                    .json(&json!({"model": model, "context_length": wanted}));
                send_json(NAME, request, 1_000_000).await.map_err(|failure| {
                    if failure.is_transport() {
                        desk_err!(
                            "LM Studio did not finish loading {}. Load it in LM Studio, then try again.",
                            info.name
                        )
                    } else {
                        failure.error
                    }
                })?;
            }
        }
        Ok(info)
    }
}

/// A model about which only its id is known. It is offered as it is.
fn unknown(id: &str) -> ModelInfo {
    ModelInfo { id: id.to_string(), name: id.to_string(), tools: true, free: true, ..ModelInfo::default() }
}

fn model_from(row: &Value) -> Option<ModelInfo> {
    if row.get("type").and_then(Value::as_str) != Some("llm") {
        return None;
    }
    let id = row.get("key").and_then(Value::as_str)?;
    let capabilities = row.get("capabilities").filter(|c| c.is_object());
    Some(ModelInfo {
        id: id.to_string(),
        name: row.get("display_name").and_then(Value::as_str).unwrap_or(id).chars().take(120).collect(),
        context: row.get("max_context_length").and_then(Value::as_u64).unwrap_or(0),
        // A version that reports no capabilities is given the benefit of the doubt.
        tools: capabilities
            .is_none_or(|c| c.get("trained_for_tool_use").and_then(Value::as_bool).unwrap_or(false)),
        reasoning: false,
        free: true,
        ..ModelInfo::default()
    })
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::llm::local_client;

    fn installed() -> Value {
        json!({"models": [
            {"type": "llm", "key": "qwen/qwen3-8b", "display_name": "Qwen3 8B", "max_context_length": 40960,
             "capabilities": {"vision": false, "trained_for_tool_use": true}, "loaded_instances": []},
            {"type": "llm", "key": "google/gemma-chat", "display_name": "Gemma Chat", "max_context_length": 8192,
             "capabilities": {"vision": true, "trained_for_tool_use": false}, "loaded_instances": []},
            {"type": "llm", "key": "local/small", "display_name": "Small", "max_context_length": 131072,
             "capabilities": {"trained_for_tool_use": true},
             "loaded_instances": [{"id": "local/small", "config": {"context_length": 4096}}]},
            {"type": "llm", "key": "local/ready", "display_name": "Ready", "max_context_length": 32768,
             "capabilities": {"trained_for_tool_use": true},
             "loaded_instances": [{"id": "local/ready", "config": {"context_length": 16384}}]},
            {"type": "embedding", "key": "text-embedding-nomic", "display_name": "Nomic Embed"},
        ]})
    }

    async fn studio(models: Value) -> (MockServer, LmStudio) {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(models))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v1/models/load"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"type": "llm", "instance_id": "x", "status": "loaded"})),
            )
            .mount(&server)
            .await;
        (server, LmStudio::new(local_client().expect("client")))
    }

    #[tokio::test]
    async fn installed_chat_models_are_listed_with_what_they_can_do() {
        let (server, lm) = studio(installed()).await;
        let models = lm.models(&server.uri()).await.expect("models");
        assert_eq!(
            models.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.tools, m.context)).collect::<Vec<_>>(),
            [
                ("qwen/qwen3-8b", "Qwen3 8B", true, 40960),
                ("local/ready", "Ready", true, 32768),
                ("local/small", "Small", true, 131072),
                ("google/gemma-chat", "Gemma Chat", false, 8192),
            ],
            "tool-capable models first, embeddings left out"
        );
        assert!(models.iter().all(|m| m.free && m.prompt_price.is_none()));
        let endpoint = lm.endpoint(&server.uri());
        assert_eq!(
            (endpoint.url, endpoint.flavor, endpoint.headers.len()),
            (format!("{}/v1/chat/completions", server.uri()), Flavor::Local, 0)
        );
    }

    #[tokio::test]
    async fn a_model_is_loaded_with_room_for_the_assistant_before_it_is_used() {
        let (server, lm) = studio(installed()).await;
        let url = server.uri();
        // Not loaded: loaded here, with as much context as the assistant needs and the model allows.
        assert_eq!(lm.prepare(&url, "qwen/qwen3-8b").await.expect("prepared").name, "Qwen3 8B");
        let requests = server.received_requests().await.expect("recorded");
        let load = requests.iter().find(|r| r.url.path() == "/api/v1/models/load").expect("load");
        assert_eq!(
            serde_json::from_slice::<Value>(&load.body).expect("json"),
            json!({"model": "qwen/qwen3-8b", "context_length": 16384})
        );

        // Already loaded with enough room: left alone.
        lm.prepare(&url, "local/ready").await.expect("prepared");
        let loads = server
            .received_requests()
            .await
            .expect("recorded")
            .iter()
            .filter(|r| r.url.path() == "/api/v1/models/load")
            .count();
        assert_eq!(loads, 1);

        // Loaded too small: said plainly, and not reloaded behind the trader's back.
        let small = lm.prepare(&url, "local/small").await.expect_err("too small").to_string();
        assert_eq!(
            small,
            "Small is loaded with a context of 4096 tokens. Reload it in LM Studio with 16384 or more."
        );
        assert_eq!(
            lm.prepare(&url, "google/gemma-chat").await.expect_err("no tools").to_string(),
            "Gemma Chat cannot use tools. Pick a model that can."
        );
        assert!(
            lm.prepare(&url, "missing/model")
                .await
                .expect_err("missing")
                .to_string()
                .contains("no model named missing/model")
        );
        assert!(lm.prepare(&url, "text-embedding-nomic").await.is_err());
    }

    #[tokio::test]
    async fn an_older_server_and_a_stopped_one_are_both_handled() {
        // No REST API: the OpenAI-format list still names the models.
        let old = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/models"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&old)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"data": [{"id": "qwen3-8b"}, {"id": "llama-3.2"}]})),
            )
            .mount(&old)
            .await;
        let lm = LmStudio::new(local_client().expect("client"));
        let models = lm.models(&old.uri()).await.expect("models");
        assert_eq!(
            models.iter().map(|m| (m.id.as_str(), m.tools)).collect::<Vec<_>>(),
            [("llama-3.2", true), ("qwen3-8b", true)]
        );
        assert_eq!(lm.prepare(&old.uri(), "qwen3-8b").await.expect("prepared").id, "qwen3-8b");
        assert!(lm.prepare(&old.uri(), "other").await.is_err());

        let down = lm.models("http://127.0.0.1:9").await.expect_err("down").to_string();
        assert_eq!(down, "LM Studio is not running. Start its local server, then try again.");
    }
}
