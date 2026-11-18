use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use super::*;
use crate::net::http_client;

const KEY: &str = "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaa";

/// Replies with each scripted response in turn, then with a 500.
struct Script(Mutex<VecDeque<ResponseTemplate>>);

impl Respond for Script {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        self.0.lock().expect("script").pop_front().unwrap_or_else(|| ResponseTemplate::new(500))
    }
}

fn sse(chunks: &[Value]) -> ResponseTemplate {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str(&format!("data: {chunk}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    ResponseTemplate::new(200).set_body_raw(body, "text/event-stream")
}

fn says(text: &str) -> ResponseTemplate {
    sse(&[
        json!({"choices": [{"delta": {"content": text}, "finish_reason": null}]}),
        json!({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.001}}),
    ])
}

fn calls(tool_calls: Value, extra: Value) -> ResponseTemplate {
    let mut delta = json!({"tool_calls": tool_calls});
    for (key, value) in extra.as_object().into_iter().flatten() {
        delta[key] = value.clone();
    }
    sse(&[
        json!({"choices": [{"delta": delta, "finish_reason": null}]}),
        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 80, "completion_tokens": 10, "cost": 0.0005}}),
    ])
}

fn quote_call(id: &str) -> Value {
    json!({"index": 0, "id": id, "type": "function", "function": {"name": "get_quote", "arguments": "{\"pairs\":[\"BTC\"]}"}})
}

async fn scripted(responses: Vec<ResponseTemplate>) -> (MockServer, OpenRouter) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(Script(Mutex::new(responses.into())))
        .mount(&server)
        .await;
    let llm = OpenRouter::new(http_client().expect("client")).with_base(&server.uri());
    (server, llm)
}

#[derive(Default)]
struct Desk {
    calls: Mutex<Vec<(String, String)>>,
    /// Cancelled when the first tool runs, to simulate the trader pressing Stop mid-turn.
    stop_on_call: Option<CancellationToken>,
}

impl ToolHost for Desk {
    fn tools(&self) -> Vec<Value> {
        vec![json!({"type": "function", "function": {"name": "get_quote", "parameters": {"type": "object"}}})]
    }

    async fn call(&self, call: &ToolCall) -> String {
        self.calls.lock().expect("calls").push((call.name.clone(), call.arguments.clone()));
        if let Some(token) = &self.stop_on_call {
            token.cancel();
        }
        json!({"pair": "BTC/USDT", "price_usdt": 62452.01}).to_string()
    }
}

#[derive(Default)]
struct Log(Mutex<Vec<String>>);

impl TurnEvents for Log {
    fn round_started(&self, round: usize) {
        self.0.lock().expect("log").push(format!("start {round}"));
    }
    fn round_finished(&self, round: usize, reply: &Result<ChatReply>) {
        self.0
            .lock()
            .expect("log")
            .push(format!("finish {round} {}", if reply.is_ok() { "ok" } else { "error" }));
    }
    fn text(&self, delta: &str) {
        self.0.lock().expect("log").push(format!("text {delta}"));
    }
    fn reasoning(&self, delta: &str) {
        self.0.lock().expect("log").push(format!("think {delta}"));
    }
}

fn model() -> ModelInfo {
    ModelInfo { id: "openai/gpt-test".into(), tools: true, reasoning: true, ..ModelInfo::default() }
}

fn turn<'a>(llm: &'a OpenRouter, model: &'a ModelInfo, cancel: &'a CancellationToken) -> Turn<'a> {
    Turn {
        llm,
        key: KEY,
        model,
        effort: None,
        system: "You are Octo.",
        history: vec![
            json!({"role": "user", "content": "earlier question"}),
            json!({"role": "assistant", "content": "earlier answer"}),
        ],
        user: "What is BTC doing?\n\n<desk>\nfeed: sample\n</desk>".to_string(),
        cancel,
    }
}

fn bodies(requests: &[Request]) -> Vec<Value> {
    requests.iter().map(|r| serde_json::from_slice(&r.body).expect("json")).collect()
}

#[tokio::test]
async fn tools_run_and_their_results_go_back_with_the_models_reasoning() {
    let thinking = json!({"reasoning": "Need the price.", "reasoning_details": [{"type": "reasoning.text", "text": "Need the price.", "signature": "sig"}]});
    let (server, llm) = scripted(vec![
        calls(json!([quote_call("call_1")]), thinking),
        says("BTC trades at **62,452.01 USDT**."),
    ])
    .await;
    let (desk, log, cancel, model) = (Desk::default(), Log::default(), CancellationToken::new(), model());

    let result = run(turn(&llm, &model, &cancel), &desk, &log).await.expect("turn");

    assert_eq!(
        (result.text.as_str(), result.rounds, result.stopped),
        ("BTC trades at **62,452.01 USDT**.", 2, false)
    );
    assert_eq!(result.reasoning, "Need the price.");
    assert_eq!((result.usage.prompt_tokens, result.usage.completion_tokens), (180, 30));
    assert!((result.usage.cost.expect("cost") - 0.0015).abs() < 1e-12);
    assert_eq!(
        *desk.calls.lock().expect("calls"),
        [("get_quote".to_string(), "{\"pairs\":[\"BTC\"]}".to_string())]
    );
    assert_eq!(
        *log.0.lock().expect("log"),
        [
            "start 0",
            "think Need the price.",
            "finish 0 ok",
            "start 1",
            "text BTC trades at **62,452.01 USDT**.",
            "finish 1 ok"
        ]
    );

    let sent = bodies(&server.received_requests().await.expect("recorded"));
    let first: Vec<&str> =
        sent[0]["messages"].as_array().expect("messages").iter().filter_map(|m| m["role"].as_str()).collect();
    assert_eq!(first, ["system", "user", "assistant", "user"]);
    assert_eq!(sent[0]["messages"][0]["content"], "You are Octo.");
    let second = sent[1]["messages"].as_array().expect("messages");
    assert_eq!(second.len(), 6);
    // The assistant turn is replayed with its tool call and its reasoning, untouched.
    assert_eq!(
        second[4]["tool_calls"][0],
        json!({"id": "call_1", "type": "function", "function": {"name": "get_quote", "arguments": "{\"pairs\":[\"BTC\"]}"}})
    );
    assert_eq!(
        second[4]["reasoning_details"],
        json!([{"type": "reasoning.text", "text": "Need the price.", "signature": "sig"}])
    );
    assert!(second[4]["content"].is_null());
    assert_eq!((&second[5]["role"], &second[5]["tool_call_id"]), (&json!("tool"), &json!("call_1")));
    assert!(second[5]["content"].as_str().is_some_and(|c| c.contains("62452.01")));
    assert!(
        sent.iter()
            .all(|body| body["tools"].as_array().is_some_and(|t| t.len() == 1)
                && body["tool_choice"] == "auto")
    );
}

#[tokio::test]
async fn the_tool_budget_ends_with_a_forced_answer() {
    let mut script: Vec<ResponseTemplate> =
        (0..MAX_TOOL_ROUNDS).map(|i| calls(json!([quote_call(&format!("call_{i}"))]), json!({}))).collect();
    script.push(says("Here is what I found."));
    let (server, llm) = scripted(script).await;
    let (desk, log, cancel, model) = (Desk::default(), Log::default(), CancellationToken::new(), model());

    let result = run(turn(&llm, &model, &cancel), &desk, &log).await.expect("turn");
    assert_eq!((result.text.as_str(), result.rounds), ("Here is what I found.", MAX_TOOL_ROUNDS + 1));
    assert_eq!(desk.calls.lock().expect("calls").len(), MAX_TOOL_ROUNDS);
    let sent = bodies(&server.received_requests().await.expect("recorded"));
    assert_eq!(sent.len(), MAX_TOOL_ROUNDS + 1);
    assert!(sent[..MAX_TOOL_ROUNDS].iter().all(|body| body["tool_choice"] == "auto"));
    assert_eq!(sent[MAX_TOOL_ROUNDS]["tool_choice"], "none", "the last round may only answer");

    // A model that ignores the instruction and still only calls tools is reported, not looped on.
    let script: Vec<ResponseTemplate> =
        (0..=MAX_TOOL_ROUNDS).map(|i| calls(json!([quote_call(&format!("call_{i}"))]), json!({}))).collect();
    let (_server, llm) = scripted(script).await;
    let desk = Desk::default();
    let error = run(turn(&llm, &model, &cancel), &desk, &log).await.expect_err("no answer").to_string();
    assert!(error.contains("kept calling tools"), "{error}");
    assert_eq!(
        desk.calls.lock().expect("calls").len(),
        MAX_TOOL_ROUNDS,
        "tools from the forced round are not run"
    );
}

#[tokio::test]
async fn stopping_mid_turn_skips_remaining_tools_and_keeps_what_arrived() {
    let two_calls = json!([
        quote_call("call_1"),
        {"index": 1, "id": "call_2", "type": "function", "function": {"name": "get_quote", "arguments": "{\"pairs\":[\"ETH\"]}"}}
    ]);
    let (server, llm) =
        scripted(vec![calls(two_calls, json!({"content": "Let me check."})), says("unreachable")]).await;
    let cancel = CancellationToken::new();
    let desk = Desk { stop_on_call: Some(cancel.clone()), ..Desk::default() };
    let (log, model) = (Log::default(), model());

    let result = run(turn(&llm, &model, &cancel), &desk, &log).await.expect("turn");
    assert!(result.stopped);
    assert_eq!((result.text.as_str(), result.rounds), ("Let me check.", 1));
    assert_eq!(desk.calls.lock().expect("calls").len(), 1, "the second tool is not run after Stop");
    assert_eq!(server.received_requests().await.expect("recorded").len(), 1, "no further model round");

    // Stopped before the model answers at all.
    let (_server, llm) = scripted(vec![says("never read")]).await;
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let result = run(turn(&llm, &model, &cancelled), &Desk::default(), &log).await.expect("turn");
    assert!(result.stopped && result.text.is_empty());
}

#[tokio::test]
async fn provider_failures_end_the_turn_with_an_actionable_error() {
    let (_server, llm) = scripted(vec![
        ResponseTemplate::new(402)
            .set_body_json(json!({"error": {"code": 402, "message": "Insufficient credits"}})),
    ])
    .await;
    let (desk, log, cancel, model) = (Desk::default(), Log::default(), CancellationToken::new(), model());
    let error = run(turn(&llm, &model, &cancel), &desk, &log).await.expect_err("failure").to_string();
    assert!(error.contains("balance is too low"), "{error}");
    assert_eq!(*log.0.lock().expect("log"), ["start 0", "finish 0 error"]);
}
