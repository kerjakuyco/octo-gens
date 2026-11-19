//! Cloudflare AI Gateway: one Cloudflare token, models from many providers.
//!
//! Chats go to Cloudflare's OpenAI-format endpoint for an account. The gateway
//! named in `cf-aig-gateway-id` routes and logs them, and Cloudflare bills
//! them, so no provider key is handled here. The token needs the account's
//! *Workers AI: Read* permission.

use std::time::Duration;

use reqwest::Client;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::chat::{ChatRequest, Endpoint, Flavor, ModelInfo, NoSink, scrub, stream};
use crate::error::{DeskError, Result};
use crate::net::send_json;
use crate::{bail, desk_err};

pub const DEFAULT_BASE: &str = "https://api.cloudflare.com/client/v4";
/// The gateway Cloudflare creates on an account's first request.
pub const DEFAULT_GATEWAY: &str = "default";
pub const NAME: &str = "Cloudflare AI Gateway";
const HOST: &str = "api.cloudflare.com";

/// An account id is 32 hexadecimal characters.
pub fn valid_account(raw: &str) -> Result<String> {
    let account = raw.trim().to_ascii_lowercase();
    if account.len() != 32 || !account.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!(
            "Enter the Cloudflare account ID: 32 letters and digits, shown on the account's overview page."
        );
    }
    Ok(account)
}

pub fn valid_token(raw: &str) -> Result<String> {
    let token = raw.trim();
    let shaped = (20..=400).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\\'));
    if !shaped {
        bail!("Paste a Cloudflare API token with the Workers AI Read permission.");
    }
    Ok(token.to_string())
}

/// A gateway id as Cloudflare accepts it; empty means the default gateway.
pub fn valid_gateway(raw: &str) -> Result<String> {
    let gateway = raw.trim();
    if gateway.is_empty() {
        return Ok(DEFAULT_GATEWAY.to_string());
    }
    if gateway.len() > 64 || !gateway.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        bail!("A gateway ID uses letters, digits, dashes and underscores.");
    }
    Ok(gateway.to_string())
}

/// `provider/model` for another provider's model, or `@cf/author/model` for one of Cloudflare's own.
pub fn valid_model(raw: &str) -> Result<String> {
    let model = raw.trim();
    let shaped = (3..=160).contains(&model.len())
        && model.contains('/')
        && model.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'@' | b'+' | b'-')
        });
    if !shaped {
        bail!("Enter the model as provider/model, for example openai/gpt-4.1.");
    }
    Ok(model.to_string())
}

#[derive(Clone)]
pub struct Cloudflare {
    http: Client,
    base: String,
}

impl Cloudflare {
    pub fn new(http: Client) -> Self {
        Self { http, base: DEFAULT_BASE.to_string() }
    }

    /// Points the client at another origin. Used by tests.
    pub fn with_base(mut self, base: &str) -> Self {
        self.base = base.trim_end_matches('/').to_string();
        self
    }

    /// Where chats go, and how they are signed.
    pub fn endpoint(&self, account: &str, gateway: &str, token: &str) -> Result<Endpoint> {
        let (account, gateway, token) =
            (valid_account(account)?, valid_gateway(gateway)?, valid_token(token)?);
        Ok(Endpoint {
            name: NAME,
            url: format!("{}/accounts/{account}/ai/v1/chat/completions", self.base),
            headers: vec![("Authorization", format!("Bearer {token}")), ("cf-aig-gateway-id", gateway)],
            secrets: vec![token],
            flavor: Flavor::Gateway,
        })
    }

    /// Cloudflare's own text models (Workers AI). Models from other providers are
    /// not listed anywhere by Cloudflare; the trader types those in by id. A
    /// listing this code cannot read is an empty list, not an error.
    pub async fn models(&self, account: &str, token: &str) -> Result<Vec<ModelInfo>> {
        let (account, token) = (valid_account(account)?, valid_token(token)?);
        let request = self
            .http
            .get(format!(
                "{}/accounts/{account}/ai/models/search?task=Text%20Generation&per_page=100",
                self.base
            ))
            .bearer_auth(&token)
            .timeout(Duration::from_secs(20));
        let data = send_json(HOST, request, 4_000_000).await.map_err(|failure| match failure.status {
            Some(401 | 403) => {
                desk_err!("Cloudflare rejected the token. It needs the Workers AI Read permission.")
            }
            Some(404) => desk_err!("Cloudflare has no account with that ID."),
            // Whatever Cloudflare says, the token is not repeated on screen.
            _ => DeskError::new(scrub(&failure.error.0, &token)),
        })?;
        let rows = data.get("result").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut models: Vec<ModelInfo> = rows.iter().filter_map(model_from).collect();
        models.sort_by(|a, b| b.tools.cmp(&a.tools).then_with(|| a.name.cmp(&b.name)));
        Ok(models)
    }

    /// Sends one short chat that asks the model to call a tool. It proves the
    /// account, the token and the model together, and that a tool call really
    /// comes back through this gateway: the assistant reads the market and
    /// drafts tickets through tools, so a model that only talks is no use to it.
    pub async fn verify(&self, endpoint: &Endpoint, model: &str) -> Result<ModelInfo> {
        let id = valid_model(model)?;
        let info = ModelInfo {
            // `openai/gpt-4.1` reads `gpt-4.1` on screen.
            name: id.rsplit('/').next().unwrap_or(&id).to_string(),
            id,
            tools: true,
            ..ModelInfo::default()
        };
        let messages =
            [json!({"role": "user", "content": "Call the ping tool now. Do not answer in words."})];
        let tools = [json!({"type": "function", "function": {
            "name": "ping",
            "description": "Checks that tools can be called. Takes no arguments.",
            "parameters": {"type": "object", "properties": {}},
        }})];
        let request = ChatRequest {
            model: &info,
            messages: &messages,
            tools: &tools,
            allow_tools: true,
            effort: None,
            // Room for a model that thinks before it acts.
            max_tokens: 512,
        };
        let reply = stream(&self.http, endpoint, &request, &mut NoSink, &CancellationToken::new()).await?;
        if reply.tool_calls.is_empty() {
            bail!("{} did not call the tool it was offered. Pick a model that can use tools.", info.id);
        }
        Ok(info)
    }
}

fn model_from(row: &Value) -> Option<ModelInfo> {
    let id = row.get("name").and_then(Value::as_str).filter(|name| name.starts_with("@cf/"))?;
    let task = row.get("task").and_then(|task| task.get("name")).and_then(Value::as_str);
    if task.is_some_and(|task| task != "Text Generation") {
        return None;
    }
    // Properties arrive as `[{"property_id": "function_calling", "value": "true"}, …]`.
    let property = |wanted: &str| {
        row.get("properties")?
            .as_array()?
            .iter()
            .find(|p| p.get("property_id").and_then(Value::as_str) == Some(wanted))?
            .get("value")
    };
    let flag = |wanted: &str| property(wanted).is_some_and(|value| value == true || value == "true");
    let context =
        property("context_window").and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()));
    Some(ModelInfo {
        id: id.to_string(),
        name: id.rsplit('/').next().unwrap_or(id).to_string(),
        context: context.unwrap_or(0),
        tools: flag("function_calling"),
        reasoning: false,
        ..ModelInfo::default()
    })
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::net::http_client;

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "cf-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn account_token_gateway_and_model_are_shape_checked() {
        assert_eq!(valid_account(&format!(" {} ", ACCOUNT.to_uppercase())).expect("account"), ACCOUNT);
        for bad in ["", "0123", "0123456789abcdef0123456789abcdeg", "0123456789abcdef0123456789abcdef0"] {
            assert!(valid_account(bad).is_err(), "{bad}");
        }
        assert_eq!(valid_token(&format!("{TOKEN}\n")).expect("token"), TOKEN);
        assert!(valid_token("short").is_err() && valid_token("has a space in the middle of it").is_err());
        assert_eq!(
            (valid_gateway("  ").expect("default"), valid_gateway("desk-1").expect("named")),
            ("default".into(), "desk-1".into())
        );
        assert!(valid_gateway("no/slash").is_err());
        for good in
            ["openai/gpt-4.1", "anthropic/claude-sonnet-4", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]
        {
            assert_eq!(valid_model(good).expect(good), good);
        }
        for bad in ["", "gpt", "has space/model", "a/b;c"] {
            assert!(valid_model(bad).expect_err(bad).to_string().contains("provider/model"));
        }
    }

    #[tokio::test]
    async fn chats_go_to_the_accounts_endpoint_through_the_named_gateway() {
        let server = MockServer::start().await;
        let reply = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"ping\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path(format!("/accounts/{ACCOUNT}/ai/v1/chat/completions")))
            .respond_with(ResponseTemplate::new(200).set_body_raw(reply, "text/event-stream"))
            .mount(&server)
            .await;
        let cloudflare = Cloudflare::new(http_client().expect("client")).with_base(&server.uri());
        let endpoint = cloudflare.endpoint(ACCOUNT, "", TOKEN).expect("endpoint");
        let info = cloudflare.verify(&endpoint, " openai/gpt-4.1 ").await.expect("verified");
        assert_eq!((info.id.as_str(), info.tools), ("openai/gpt-4.1", true));

        let requests = server.received_requests().await.expect("recorded");
        let header =
            |name: &str| requests[0].headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        assert_eq!(header("authorization"), Some(format!("Bearer {TOKEN}")));
        assert_eq!(header("cf-aig-gateway-id").as_deref(), Some("default"));
        let body: Value = serde_json::from_slice(&requests[0].body).expect("json");
        assert_eq!(
            (&body["model"], &body["stream"], &body["tool_choice"]),
            (&json!("openai/gpt-4.1"), &json!(true), &json!("auto"))
        );
        assert_eq!(body["stream_options"], json!({"include_usage": true}));
        // Models behind a gateway disagree about these, so they are left to each model's default.
        for absent in ["max_tokens", "temperature", "reasoning", "usage"] {
            assert!(body.get(absent).is_none(), "{absent} must not be sent through a gateway");
        }
        assert!(!String::from_utf8_lossy(&requests[0].body).contains(TOKEN));
    }

    #[tokio::test]
    async fn a_rejected_token_or_model_is_explained_without_echoing_the_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_json(
                json!({"errors": [{"code": 10000, "message": format!("Authentication error for {TOKEN}")}]}),
            ))
            .mount(&server)
            .await;
        let cloudflare = Cloudflare::new(http_client().expect("client")).with_base(&server.uri());
        let endpoint = cloudflare.endpoint(ACCOUNT, "desk", TOKEN).expect("endpoint");
        let error = cloudflare.verify(&endpoint, "openai/gpt-4.1").await.expect_err("rejected").to_string();
        assert_eq!(error, "Cloudflare AI Gateway rejected the API key. Check it in Settings.");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"error": {"message": format!("unknown model, token {TOKEN}")}})),
            )
            .mount(&server)
            .await;
        let cloudflare = Cloudflare::new(http_client().expect("client")).with_base(&server.uri());
        let endpoint = cloudflare.endpoint(ACCOUNT, "desk", TOKEN).expect("endpoint");
        let error = cloudflare.verify(&endpoint, "openai/nope").await.expect_err("unknown").to_string();
        assert!(error.contains("cannot run openai/nope") && !error.contains(TOKEN), "{error}");
        assert!(
            cloudflare.endpoint("bad", "desk", TOKEN).is_err()
                && cloudflare.verify(&endpoint, "nope").await.is_err()
        );
    }

    #[tokio::test]
    async fn workers_ai_text_models_are_listed_with_their_tool_support() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/accounts/{ACCOUNT}/ai/models/search")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "result": [
                {"name": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "task": {"name": "Text Generation"},
                 "properties": [{"property_id": "function_calling", "value": "true"}, {"property_id": "context_window", "value": "24000"}]},
                {"name": "@cf/tiny/chat-1b", "task": {"name": "Text Generation"}, "properties": []},
                {"name": "@cf/baai/bge-m3", "task": {"name": "Text Embeddings"}, "properties": []},
                {"name": "not-a-workers-model"},
            ]})))
            .mount(&server)
            .await;
        let cloudflare = Cloudflare::new(http_client().expect("client")).with_base(&server.uri());
        let models = cloudflare.models(ACCOUNT, TOKEN).await.expect("models");
        assert_eq!(
            models.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.tools, m.context)).collect::<Vec<_>>(),
            [
                ("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "llama-3.3-70b-instruct-fp8-fast", true, 24000),
                ("@cf/tiny/chat-1b", "chat-1b", false, 0)
            ],
            "tool-capable models first; other tasks are left out"
        );
        let requests = server.received_requests().await.expect("recorded");
        assert_eq!(requests[0].url.query(), Some("task=Text%20Generation&per_page=100"));

        // A listing in a shape this code does not know is simply empty; a bad token is said plainly.
        let odd = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
            .mount(&odd)
            .await;
        assert!(
            Cloudflare::new(http_client().expect("client"))
                .with_base(&odd.uri())
                .models(ACCOUNT, TOKEN)
                .await
                .expect("empty")
                .is_empty()
        );
        let denied = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(403).set_body_json(json!({"errors": [{"message": "denied"}]})),
            )
            .mount(&denied)
            .await;
        let error = Cloudflare::new(http_client().expect("client"))
            .with_base(&denied.uri())
            .models(ACCOUNT, TOKEN)
            .await
            .expect_err("denied")
            .to_string();
        assert!(error.contains("Workers AI Read"), "{error}");
    }
}
