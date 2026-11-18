//! Ollama: a model on this computer that explains desk readings in plain words.
//!
//! It receives text and returns text. It is given no tools, so it cannot read
//! an account or draft an order, and only models installed locally are accepted:
//! nothing typed here leaves the machine.

use std::time::Duration;

use reqwest::Client;
use serde_json::{Value, json};

use super::openrouter::valid_model_id;
use crate::error::Result;
use crate::net::send_json;
use crate::{bail, desk_err};

pub const DEFAULT_BASE: &str = "http://127.0.0.1:11434/api";
const HOST: &str = "Ollama";

pub struct Ollama {
    http: Client,
    base: String,
}

/// Cloud-backed tags (`model:cloud`, `model-cloud`) run remotely even though Ollama serves them.
fn cloud_tag(model: &str) -> bool {
    let lowered = model.to_ascii_lowercase();
    lowered.split(':').any(|part| part == "cloud" || part.ends_with("-cloud"))
}

impl Ollama {
    /// Local traffic must never be sent through a system proxy.
    pub fn new() -> Result<Self> {
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| desk_err!("The local model client could not start: {error}."))?;
        Ok(Self { http, base: DEFAULT_BASE.to_string() })
    }

    /// Points the client at another origin. Used by tests.
    pub fn with_base(mut self, base: &str) -> Self {
        self.base = base.trim_end_matches('/').to_string();
        self
    }

    async fn post(&self, path: &str, body: Value, timeout: Duration) -> Result<Value> {
        let request = self.http.post(format!("{}{path}", self.base)).timeout(timeout).json(&body);
        send_json(HOST, request, 2_000_000).await.map_err(|failure| {
            if failure.is_transport() {
                desk_err!("Ollama is not running on this computer. Start it, then try again.")
            } else {
                failure.error
            }
        })
    }

    /// Confirms `model` is installed locally and not a remote alias.
    pub async fn verify(&self, model: &str) -> Result<()> {
        if !valid_model_id(model) {
            bail!("Enter a locally installed Ollama model tag, for example qwen3:4b.");
        }
        let info = self.post("/show", json!({"model": model}), Duration::from_secs(12)).await?;
        let remote = ["remote_model", "remote_host"]
            .iter()
            .any(|key| info.get(key).is_some_and(|v| !v.is_null() && v != ""));
        if remote || cloud_tag(model) {
            bail!("Choose a model installed on this computer; cloud models are not used here.");
        }
        if !info.get("model_info").is_some_and(Value::is_object) {
            bail!("Ollama did not report {model} as installed. Run `ollama pull {model}` first.");
        }
        Ok(())
    }

    /// One non-streamed reply to `user` under `system`.
    pub async fn explain(&self, model: &str, system: &str, user: &str) -> Result<String> {
        self.verify(model).await?;
        let body = json!({
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "stream": false,
            "options": {"num_predict": 600, "temperature": 0.3},
        });
        let reply = self.post("/chat", body, Duration::from_secs(120)).await?;
        let text =
            reply.get("message").and_then(|m| m.get("content")).and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            bail!("The local model returned an empty reply.");
        }
        Ok(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    async fn local(show: Value) -> (MockServer, Ollama) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/show"))
            .respond_with(ResponseTemplate::new(200).set_body_json(show))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/chat"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"message": {"content": " Explanation \n"}})),
            )
            .mount(&server)
            .await;
        let ollama = Ollama::new().expect("client").with_base(&server.uri());
        (server, ollama)
    }

    #[tokio::test]
    async fn a_local_model_gets_the_readings_and_no_tools() {
        let (server, ollama) = local(json!({"model_info": {"family": "mock"}})).await;
        assert_eq!(
            ollama
                .explain("test:1b", "system rules", "Sample tape: 100 USDT. Compare them")
                .await
                .expect("reply"),
            "Explanation"
        );
        let requests = server.received_requests().await.expect("recorded");
        let chat: Value = serde_json::from_slice(&requests[1].body).expect("json");
        assert_eq!(
            (&chat["stream"], &chat["messages"][0]["content"]),
            (&json!(false), &json!("system rules"))
        );
        assert!(chat["messages"][1]["content"].as_str().is_some_and(|text| text.contains("Compare them")));
        assert!(chat.get("tools").is_none(), "the local model must not be offered tools");
    }

    #[tokio::test]
    async fn remote_and_missing_models_are_refused() {
        let (_server, ollama) = local(json!({"remote_host": "https://ollama.com", "model_info": {}})).await;
        assert!(
            ollama
                .explain("remote", "s", "u")
                .await
                .expect_err("remote")
                .to_string()
                .contains("installed on this computer")
        );

        let (_server, ollama) = local(json!({"model_info": {"family": "mock"}})).await;
        for cloud in ["qwen3:cloud", "gpt-oss:120b-cloud"] {
            assert!(ollama.verify(cloud).await.expect_err(cloud).to_string().contains("cloud"));
        }
        assert!(ollama.verify("not a tag").await.is_err());

        let (_server, ollama) = local(json!({"error": "model not found"})).await;
        assert!(
            ollama
                .verify("missing:1b")
                .await
                .expect_err("missing")
                .to_string()
                .contains("ollama pull missing:1b")
        );

        let down = Ollama::new().expect("client").with_base("http://127.0.0.1:9");
        assert!(down.verify("test:1b").await.expect_err("down").to_string().contains("not running"));
    }
}
