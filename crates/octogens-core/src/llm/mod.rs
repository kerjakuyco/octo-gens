//! Language-model providers.
//!
//! The assistant is always a model that can call tools. Four providers can
//! serve one: OpenRouter and Cloudflare AI Gateway in the cloud, Ollama and
//! LM Studio on this computer. A [`Connection`] hides which one it is from the
//! agent loop.

pub mod chat;
pub mod cloudflare;
pub mod lmstudio;
pub mod ollama;
pub mod openrouter;
pub mod sse;

use reqwest::Client;
use tokio_util::sync::CancellationToken;

pub use chat::{
    ChatReply, ChatRequest, ChatSink, Endpoint, Flavor, ModelInfo, NoSink, ToolCall, Usage, scrub,
};

use crate::error::Result;
use crate::{bail, desk_err};

/// Context a local model is given: room for the assistant's instructions, its
/// tool definitions, a few turns of conversation and the readings it gathers.
pub const CONTEXT: u64 = 16_384;
/// Below this the assistant's own instructions would not fit beside a reading.
pub const MIN_CONTEXT: u64 = 8_192;

/// A client for servers on this computer. Local traffic must never be sent
/// through a system proxy, and is never redirected elsewhere.
pub fn local_client() -> Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|error| desk_err!("The local model client could not start: {error}."))
}

/// Checks the address of a local model server and returns its origin, e.g.
/// `http://127.0.0.1:11434`. Empty input means `default`.
pub fn local_url(raw: &str, default: &str) -> Result<String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(default.to_string());
    }
    // People type `localhost:1234`; the scheme is implied.
    let text = if text.contains("://") { text.to_string() } else { format!("http://{text}") };
    let parsed = url::Url::parse(&text).ok().filter(|url| matches!(url.scheme(), "http" | "https"));
    let Some(parsed) = parsed
        .filter(|url| url.host_str().is_some() && url.username().is_empty() && url.password().is_none())
    else {
        bail!("Enter the server's address, for example {default}.");
    };
    Ok(parsed.origin().ascii_serialization())
}

/// A connected model, ready to chat.
pub enum Connection {
    /// OpenAI-format Chat Completions: OpenRouter, Cloudflare AI Gateway, LM Studio.
    Compatible { http: Client, endpoint: Endpoint },
    /// Ollama's own chat API, which lets each request say how much context it needs.
    Ollama { client: ollama::Ollama, url: String, context: u64 },
}

impl Connection {
    /// The provider as the trader knows it.
    pub fn name(&self) -> &'static str {
        match self {
            Connection::Compatible { endpoint, .. } => endpoint.name,
            Connection::Ollama { .. } => ollama::NAME,
        }
    }

    /// The model runs on this computer, so its context is small and precious.
    pub fn local(&self) -> bool {
        match self {
            Connection::Compatible { endpoint, .. } => endpoint.flavor == Flavor::Local,
            Connection::Ollama { .. } => true,
        }
    }

    /// Removes this connection's secrets from text bound for the screen or the journal.
    pub fn clean(&self, text: &str) -> String {
        match self {
            Connection::Compatible { endpoint, .. } => {
                endpoint.secrets.iter().fold(text.to_string(), |text, secret| scrub(&text, secret))
            }
            Connection::Ollama { .. } => text.to_string(),
        }
    }

    pub async fn chat(
        &self,
        request: &ChatRequest<'_>,
        sink: &mut dyn ChatSink,
        cancel: &CancellationToken,
    ) -> Result<ChatReply> {
        match self {
            Connection::Compatible { http, endpoint } => {
                chat::stream(http, endpoint, request, sink, cancel).await
            }
            Connection::Ollama { client, url, context } => {
                client.chat(url, *context, request, sink, cancel).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_server_addresses_are_reduced_to_an_origin() {
        let default = "http://127.0.0.1:11434";
        for (typed, expected) in [
            ("", default),
            ("  ", default),
            ("localhost:1234", "http://localhost:1234"),
            // The address as OpenAI-style clients show it, with its `/v1` path.
            ("http://localhost:1235/v1", "http://localhost:1235"),
            ("http://localhost:1235/v1/", "http://localhost:1235"),
            ("http://127.0.0.1:11434/", default),
            ("http://192.168.1.20:11434/api/chat?x=1", "http://192.168.1.20:11434"),
            ("https://models.home.arpa", "https://models.home.arpa"),
        ] {
            assert_eq!(local_url(typed, default).expect(typed), expected, "{typed}");
        }
        for bad in ["ftp://host", "http://user:pass@host:1", "http://", "not a url at all"] {
            assert!(local_url(bad, default).expect_err(bad).to_string().contains(default), "{bad}");
        }
    }
}
