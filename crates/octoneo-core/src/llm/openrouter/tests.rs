use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::llm::chat::Assembly;
use crate::net::http_client;

const KEY: &str = "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa";

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

fn model(tools: bool) -> ModelInfo {
    ModelInfo {
        id: "openai/gpt-test".into(),
        name: "GPT Test".into(),
        tools,
        temperature: tools,
        reasoning: tools,
        max_output: Some(2000),
        ..ModelInfo::default()
    }
}

fn sse(chunks: &[Value]) -> ResponseTemplate {
    let mut body = String::from(": OPENROUTER PROCESSING\n\n");
    for chunk in chunks {
        body.push_str(&format!("data: {chunk}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    ResponseTemplate::new(200).set_body_raw(body, "text/event-stream")
}

fn delta(delta: Value) -> Value {
    json!({"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": null}]})
}

async fn router(response: ResponseTemplate) -> (MockServer, OpenRouter) {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/chat/completions")).respond_with(response).mount(&server).await;
    let client = OpenRouter::new(http_client().expect("client")).with_base(&server.uri());
    (server, client)
}

fn request<'a>(model: &'a ModelInfo, messages: &'a [Value], tools: &'a [Value]) -> ChatRequest<'a> {
    ChatRequest { model, messages, tools, allow_tools: true, effort: Some("low"), max_tokens: 4096 }
}

#[test]
fn keys_and_model_ids_are_shape_checked() {
    assert_eq!(valid_key(&format!("  {KEY}\n")).expect("valid"), KEY);
    for bad in ["", "not-a-key", "sk-or-short", "sk-or-v1-has spaces in the middle of it"] {
        assert!(valid_key(bad).expect_err(bad).to_string().contains("sk-or-"));
    }
    for good in ["openai/gpt-test", "anthropic/claude-x:free", "~openai/gpt-latest", "meta/llama-4@fp8"] {
        assert!(valid_model_id(good), "{good}");
    }
    for bad in ["", "~", "/leading", "has space", "semi;colon", &"x".repeat(200)] {
        assert!(!valid_model_id(bad), "{bad}");
    }
    assert_eq!(scrub(&format!("bad key {KEY} sent"), KEY), "bad key •••• sent");
}

#[tokio::test]
async fn the_catalog_keeps_text_chat_models_and_reads_their_capabilities() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [
            {"id": "openai/gpt-test", "name": "GPT Test", "context_length": 8000, "created": 10,
             "pricing": {"prompt": "0.000002", "completion": "0.00001"}, "endpoints": ["/api/v1/chat/completions"],
             "architecture": {"output_modalities": ["text"]}, "top_provider": {"max_completion_tokens": 4096},
             "supported_parameters": ["tools", "tool_choice", "temperature", "reasoning"]},
            {"id": "tiny/free:free", "name": "Tiny", "created": 30, "pricing": {"prompt": "0", "completion": "0"},
             "endpoints": ["/api/v1/chat/completions"], "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["max_tokens"]},
            {"id": "openrouter/auto", "name": "Auto Router", "created": 20, "pricing": {"prompt": "-1", "completion": "-1"},
             "endpoints": ["/api/v1/chat/completions"], "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["tools"]},
            {"id": "video/clip", "name": "Clip", "endpoints": ["/api/v1/chat/completions"], "architecture": {"output_modalities": ["text", "video"]}},
            {"id": "openai/gpt-test:batch", "name": "Batch", "endpoints": ["/api/v1/batches"], "architecture": {"output_modalities": ["text"]}},
            {"id": "bad id", "name": "Bad", "endpoints": ["/api/v1/chat/completions"], "architecture": {"output_modalities": ["text"]}}
        ]})))
        .mount(&server)
        .await;
    let client = OpenRouter::new(http_client().expect("client")).with_base(&server.uri());

    let models = client.models(None).await.expect("catalog");
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["tiny/free:free", "openrouter/auto", "openai/gpt-test"],
        "newest first"
    );
    let gpt = &models[2];
    assert_eq!(
        (gpt.prompt_price, gpt.completion_price, gpt.context, gpt.max_output),
        (Some(2.0), Some(10.0), 8000, Some(4096))
    );
    assert!(gpt.tools && gpt.temperature && gpt.reasoning && !gpt.free);
    assert!(models[0].free && !models[0].tools);
    assert_eq!((models[1].prompt_price, models[1].free), (None, false), "router pricing varies");

    client.models(Some(KEY)).await.expect("catalog with key");
    assert!(client.models(Some("not-a-key")).await.is_err());
    let requests = server.received_requests().await.expect("recorded");
    assert!(requests[0].headers.get("authorization").is_none());
    assert_eq!(
        requests[1].headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some(format!("Bearer {KEY}").as_str())
    );
    assert_eq!(
        requests[0].headers.get("x-openrouter-title").and_then(|v| v.to_str().ok()),
        Some("OctoNeo")
    );
}

#[test]
fn fragmented_parallel_tool_calls_are_assembled_by_index() {
    let mut assembly = Assembly::default();
    let mut sink = Recorder::default();
    let chunks = [
        delta(json!({"role": "assistant", "content": "Checking "})),
        delta(json!({"content": "prices."})),
        delta(
            json!({"tool_calls": [{"index": 0, "id": "call_a", "type": "function", "function": {"name": "get_quote", "arguments": ""}}]}),
        ),
        delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"pairs\":"}}]})),
        delta(
            json!({"tool_calls": [{"index": 1, "id": "call_b", "type": "function", "function": {"name": "get_portfolio", "arguments": "{}"}}]}),
        ),
        delta(json!({"tool_calls": [{"index": 0, "function": {"arguments": "[\"BTC\"]}"}}]})),
        // Some providers repeat the finished arguments; that must not double them.
        delta(json!({"tool_calls": [{"index": 1, "function": {"arguments": "{}"}}]})),
        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        json!({"choices": [{"delta": {"content": ""}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 120, "completion_tokens": 30, "cost": 0.0004}}),
    ];
    for chunk in &chunks {
        assembly.absorb(chunk, &mut sink).expect("chunk");
    }
    let reply = assembly.finish(false).expect("reply");
    assert_eq!(sink.text, ["Checking ", "prices."]);
    assert_eq!(reply.text, "Checking prices.");
    assert_eq!(
        reply.tool_calls,
        [
            ToolCall {
                id: "call_a".into(),
                name: "get_quote".into(),
                arguments: "{\"pairs\":[\"BTC\"]}".into()
            },
            ToolCall { id: "call_b".into(), name: "get_portfolio".into(), arguments: "{}".into() },
        ]
    );
    assert_eq!(
        (reply.finish.as_str(), &reply.usage),
        ("tool_calls", &Usage { prompt_tokens: 120, completion_tokens: 30, cost: Some(0.0004) })
    );
}

#[test]
fn whole_tool_calls_object_arguments_and_missing_ids_are_tolerated() {
    let mut assembly = Assembly::default();
    let mut sink = NoSink;
    // A non-streamed completion: whole calls, one with object arguments and no id, one with no arguments.
    let completion = json!({"choices": [{"finish_reason": "tool_calls", "message": {"role": "assistant", "content": null, "tool_calls": [
        {"type": "function", "function": {"name": "analyze_market", "arguments": {"pair": "ETH", "timeframe": "4h"}}},
        {"id": "x2", "type": "function", "function": {"name": "scan_watchlist"}}
    ]}}]});
    assembly.absorb(&completion, &mut sink).expect("completion");
    let reply = assembly.finish(false).expect("reply");
    assert_eq!(reply.tool_calls.len(), 2);
    assert_eq!((reply.tool_calls[0].id.as_str(), reply.tool_calls[1].id.as_str()), ("call_0", "x2"));
    assert_eq!(
        serde_json::from_str::<Value>(&reply.tool_calls[0].arguments).expect("json"),
        json!({"pair": "ETH", "timeframe": "4h"})
    );
    assert_eq!(reply.tool_calls[1].arguments, "{}");
    let message = reply.assistant_message();
    assert!(message["content"].is_null());
    assert_eq!(message["tool_calls"][0]["function"]["name"], "analyze_market");
    assert!(message.get("reasoning_details").is_none() && message.get("reasoning").is_none());
}

#[test]
fn reasoning_blocks_are_rebuilt_exactly_for_the_next_request() {
    let mut assembly = Assembly::default();
    let mut sink = Recorder::default();
    let chunks = [
        delta(
            json!({"reasoning": "Price ", "reasoning_details": [{"type": "reasoning.text", "text": "Price ", "format": "anthropic-claude-v1", "index": 0}]}),
        ),
        delta(
            json!({"reasoning": "first.", "reasoning_details": [{"type": "reasoning.text", "text": "first.", "index": 0}]}),
        ),
        delta(
            json!({"reasoning_details": [{"type": "reasoning.text", "text": "", "signature": "sig-1", "index": 0}]}),
        ),
        // A signed block is closed: the next text starts a new block.
        delta(json!({"reasoning_details": [{"type": "reasoning.text", "text": "Then size.", "index": 1}]})),
        delta(
            json!({"reasoning_details": [{"type": "reasoning.encrypted", "data": "AAA", "id": "rs_1", "format": "openai-responses-v1"}]}),
        ),
        delta(
            json!({"reasoning_details": [{"type": "reasoning.encrypted", "data": "BBB", "id": "rs_2", "format": "openai-responses-v1"}]}),
        ),
        delta(
            json!({"reasoning_details": [{"type": "reasoning.summary", "summary": "Checked "}, {"type": "reasoning.summary", "summary": "the tape."}]}),
        ),
        delta(
            json!({"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "get_quote", "arguments": "{}"}}]}),
        ),
    ];
    for chunk in &chunks {
        assembly.absorb(chunk, &mut sink).expect("chunk");
    }
    let reply = assembly.finish(false).expect("reply");
    assert_eq!(
        reply.reasoning_details,
        [
            json!({"type": "reasoning.text", "text": "Price first.", "format": "anthropic-claude-v1", "index": 0, "signature": "sig-1"}),
            json!({"type": "reasoning.text", "text": "Then size.", "index": 1}),
            json!({"type": "reasoning.encrypted", "data": "AAA", "id": "rs_1", "format": "openai-responses-v1"}),
            json!({"type": "reasoning.encrypted", "data": "BBB", "id": "rs_2", "format": "openai-responses-v1"}),
            json!({"type": "reasoning.summary", "summary": "Checked the tape."}),
        ]
    );
    // Shown once: the plain `reasoning` text when present, the block text otherwise.
    assert_eq!(sink.reasoning.concat(), "Price first.Then size.Checked the tape.");
    let message = reply.assistant_message();
    assert_eq!(message["reasoning_details"].as_array().map(Vec::len), Some(5));
    assert!(message.get("reasoning").is_none());

    // A model with plain reasoning only gets the string back instead.
    let mut plain = Assembly::default();
    plain
        .absorb(&delta(json!({"reasoning_content": "thinking", "content": "Done."})), &mut NoSink)
        .expect("chunk");
    assert_eq!(plain.finish(false).expect("reply").assistant_message()["reasoning"], "thinking");
}

#[tokio::test]
async fn a_streamed_reply_reaches_the_sink_and_the_request_respects_model_capabilities() {
    let (server, client) = router(sse(&[
        delta(json!({"role": "assistant", "content": "BTC is "})),
        delta(json!({"content": "at 62,452 USDT."})),
        json!({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 50, "completion_tokens": 9, "cost": 0.0001}}),
    ]))
    .await;
    let messages = [json!({"role": "user", "content": "price?"})];
    let tools =
        [json!({"type": "function", "function": {"name": "get_quote", "parameters": {"type": "object"}}})];
    let mut sink = Recorder::default();
    let capable = model(true);
    let reply = client
        .chat(KEY, &request(&capable, &messages, &tools), &mut sink, &CancellationToken::new())
        .await
        .expect("reply");
    assert_eq!(
        (reply.text.as_str(), reply.finish.as_str(), reply.cancelled),
        ("BTC is at 62,452 USDT.", "stop", false)
    );
    assert_eq!(sink.text, ["BTC is ", "at 62,452 USDT."]);
    assert_eq!(reply.usage.cost, Some(0.0001));

    let plain = model(false);
    let mut final_round = request(&capable, &messages, &tools);
    final_round.allow_tools = false;
    final_round.effort = None;
    client
        .chat(KEY, &request(&plain, &messages, &tools), &mut NoSink, &CancellationToken::new())
        .await
        .expect("reply");
    client.chat(KEY, &final_round, &mut NoSink, &CancellationToken::new()).await.expect("reply");

    let requests = server.received_requests().await.expect("recorded");
    let bodies: Vec<Value> =
        requests.iter().map(|r| serde_json::from_slice(&r.body).expect("json")).collect();
    assert_eq!(
        requests[0].headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some(format!("Bearer {KEY}").as_str())
    );
    assert!(
        requests.iter().all(|r| !String::from_utf8_lossy(&r.body).contains(KEY)),
        "the key travels in the header only"
    );
    assert_eq!(
        (&bodies[0]["model"], &bodies[0]["stream"], &bodies[0]["tool_choice"]),
        (&json!("openai/gpt-test"), &json!(true), &json!("auto"))
    );
    assert_eq!(
        (&bodies[0]["temperature"], &bodies[0]["reasoning"], &bodies[0]["max_tokens"]),
        (&json!(0.3), &json!({"effort": "low"}), &json!(2000))
    );
    assert_eq!(bodies[0]["usage"], json!({"include": true}));
    for absent in ["tools", "tool_choice", "temperature", "reasoning"] {
        assert!(bodies[1].get(absent).is_none(), "a model without the capability must not be sent {absent}");
    }
    assert_eq!(bodies[2]["tool_choice"], "none");
    assert!(bodies[2].get("reasoning").is_none());
}

#[tokio::test]
async fn failures_are_explained_and_never_echo_the_key() {
    let cases = [
        (
            401,
            json!({"error": {"code": 401, "message": "No auth credentials found"}}),
            "rejected the API key",
        ),
        (402, json!({"error": {"code": 402, "message": "Insufficient credits"}}), "balance is too low"),
        (
            404,
            json!({"error": {"code": 404, "message": "No endpoints found that support tool use"}}),
            "cannot run openai/gpt-test for this request (No endpoints found that support tool use)",
        ),
        (
            429,
            json!({"error": {"code": 429, "message": format!("Rate limited for key {KEY}")}}),
            "rate limited right now (Rate limited for key ••••)",
        ),
        (503, json!({"error": {"code": 503, "message": "No available provider"}}), "provider is unavailable"),
    ];
    let messages = [json!({"role": "user", "content": "hi"})];
    let capable = model(true);
    for (status, body, expected) in cases {
        let (_server, client) = router(ResponseTemplate::new(status).set_body_json(body)).await;
        let error = client
            .chat(KEY, &request(&capable, &messages, &[]), &mut NoSink, &CancellationToken::new())
            .await
            .expect_err("failure")
            .to_string();
        assert!(error.contains(expected), "{status}: {error}");
        assert!(!error.contains(KEY), "{status} leaked the key: {error}");
    }

    // An error can arrive after the 200, as the only event.
    let (_server, client) = router(sse(&[json!({"error": {"code": 502, "message": "Upstream died"}, "choices": [{"delta": {"content": ""}, "finish_reason": "error"}]})])).await;
    let error = client
        .chat(KEY, &request(&capable, &messages, &[]), &mut NoSink, &CancellationToken::new())
        .await
        .expect_err("mid-stream")
        .to_string();
    assert_eq!(error, "The model stopped with an error: Upstream died");

    // Thinking can eat the whole budget and leave nothing to say.
    let (_server, client) =
        router(sse(&[json!({"choices": [{"delta": {"reasoning": "hmm"}, "finish_reason": "length"}]})]))
            .await;
    let error = client
        .chat(KEY, &request(&capable, &messages, &[]), &mut NoSink, &CancellationToken::new())
        .await
        .expect_err("length")
        .to_string();
    assert!(error.contains("whole output budget"), "{error}");

    let (_server, client) = router(sse(&[])).await;
    let error = client
        .chat(KEY, &request(&capable, &messages, &[]), &mut NoSink, &CancellationToken::new())
        .await
        .expect_err("empty")
        .to_string();
    assert!(error.contains("empty reply"), "{error}");

    assert!(
        client
            .chat("bad-key", &request(&capable, &messages, &[]), &mut NoSink, &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_plain_json_completion_is_read_like_a_stream() {
    let (_server, client) = router(ResponseTemplate::new(200).set_body_json(json!({
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "Tokenized stock, not a share."}}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 7}
    })))
    .await;
    let messages = [json!({"role": "user", "content": "What is TSLAx?"})];
    let plain = model(false);
    let mut sink = Recorder::default();
    let reply = client
        .chat(KEY, &request(&plain, &messages, &[]), &mut sink, &CancellationToken::new())
        .await
        .expect("reply");
    assert_eq!(
        (reply.text.as_str(), reply.usage.prompt_tokens, reply.usage.cost),
        ("Tokenized stock, not a share.", 12, None)
    );
    assert_eq!(sink.text, ["Tokenized stock, not a share."]);
}

#[tokio::test]
async fn cancelling_returns_promptly_without_waiting_for_the_model() {
    let slow = sse(&[delta(json!({"content": "late"}))]).set_delay(Duration::from_secs(20));
    let (_server, client) = router(slow).await;
    let messages = [json!({"role": "user", "content": "hi"})];
    let capable = model(true);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        trigger.cancel();
    });
    let started = Instant::now();
    let reply = client
        .chat(KEY, &request(&capable, &messages, &[]), &mut NoSink, &cancel)
        .await
        .expect("cancelled reply");
    assert!(reply.cancelled && reply.text.is_empty());
    assert!(started.elapsed() < Duration::from_secs(5), "cancel took {:?}", started.elapsed());
}

#[test]
fn thinking_is_handed_back_only_to_the_provider_that_defines_how() {
    use crate::llm::chat::Flavor;

    let info = model(true);
    let messages = [
        json!({"role": "user", "content": "price?"}),
        json!({"role": "assistant", "content": null, "reasoning": "First the price.",
            "reasoning_details": [{"type": "reasoning.text", "text": "First the price."}],
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_quote", "arguments": "{}"}}]}),
        json!({"role": "tool", "tool_call_id": "call_1", "content": "{}"}),
    ];
    let request = |model| ChatRequest {
        model,
        messages: &messages,
        tools: &[],
        allow_tools: true,
        effort: None,
        max_tokens: 3072,
    };
    let router = request(&info).body(Flavor::OpenRouter, true);
    assert_eq!(router["messages"][1]["reasoning_details"][0]["text"], "First the price.");
    for flavor in [Flavor::Gateway, Flavor::Local] {
        let body = request(&info).body(flavor, true);
        let handed_back = &body["messages"][1];
        assert!(
            handed_back.get("reasoning").is_none() && handed_back.get("reasoning_details").is_none(),
            "{flavor:?}: other providers refuse fields they do not know"
        );
        assert_eq!(handed_back["tool_calls"][0]["id"], "call_1", "the call itself is kept");
        assert_eq!(body["messages"][2], messages[2]);
    }
    // Output caps: a server on this computer always gets one; a gateway only for Cloudflare's own models.
    assert_eq!(request(&info).body(Flavor::Local, true)["max_tokens"], 3072);
    assert!(request(&info).body(Flavor::Gateway, true).get("max_tokens").is_none());
    let workers = ModelInfo { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast".into(), ..model(true) };
    assert_eq!(request(&workers).body(Flavor::Gateway, true)["max_tokens"], 3072);
}
