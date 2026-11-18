//! The assistant: a model that researches with tools and drafts tickets.
//!
//! [`run`] is the agent loop. It is deliberately small: ask the model, run the
//! tools it asks for, hand the results back, repeat until it answers in words.
//! What the tools are and what they may do is decided by the [`ToolHost`]; the
//! loop itself can neither read an account nor touch an order.

pub mod builtin;
pub mod prompt;
pub mod tools;

use std::future::Future;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::bail;
use crate::error::Result;
use crate::llm::openrouter::{ChatReply, ChatRequest, ChatSink, ModelInfo, OpenRouter, ToolCall, Usage};

/// Model rounds that may call tools. One more round is allowed for the answer.
pub const MAX_TOOL_ROUNDS: usize = 8;
/// Output budget per round. Thinking counts toward it on reasoning models.
const MAX_TOKENS: u64 = 4096;
/// Largest tool result handed back to the model, in bytes.
const RESULT_LIMIT: usize = 12_000;

/// Runs the tools a model asks for.
pub trait ToolHost: Sync {
    /// Tool definitions to offer this turn.
    fn tools(&self) -> Vec<Value>;
    /// Executes one call and returns its result as JSON text. Failures are
    /// returned as `{"error": "..."}` so the model can react to them.
    fn call(&self, call: &ToolCall) -> impl Future<Output = String> + Send;
}

/// Hears about a turn as it unfolds, for the live trace and the streamed answer.
pub trait TurnEvents: Sync {
    /// A model round is starting. `round` counts from zero.
    fn round_started(&self, round: usize);
    fn round_finished(&self, round: usize, reply: &Result<ChatReply>);
    fn text(&self, delta: &str);
    fn reasoning(&self, delta: &str);
}

struct Forward<'a, E: TurnEvents>(&'a E);

impl<E: TurnEvents> ChatSink for Forward<'_, E> {
    fn text(&mut self, delta: &str) {
        self.0.text(delta);
    }
    fn reasoning(&mut self, delta: &str) {
        self.0.reasoning(delta);
    }
}

/// Everything one turn needs.
pub struct Turn<'a> {
    pub llm: &'a OpenRouter,
    pub key: &'a str,
    pub model: &'a ModelInfo,
    /// `low`, `medium` or `high`; `None` leaves the model's default.
    pub effort: Option<&'a str>,
    pub system: &'a str,
    /// Earlier user and assistant messages, oldest first.
    pub history: Vec<Value>,
    /// The trader's message, already wrapped with the desk block.
    pub user: String,
    pub cancel: &'a CancellationToken,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TurnResult {
    pub text: String,
    pub reasoning: String,
    pub usage: Usage,
    /// Model rounds used.
    pub rounds: usize,
    /// The trader stopped the turn; `text` holds whatever had arrived.
    pub stopped: bool,
}

/// Runs one turn to its answer.
pub async fn run<H: ToolHost, E: TurnEvents>(turn: Turn<'_>, host: &H, events: &E) -> Result<TurnResult> {
    let tools = host.tools();
    let mut messages = vec![json!({"role": "system", "content": turn.system})];
    messages.extend(turn.history);
    messages.push(json!({"role": "user", "content": turn.user}));
    let mut result = TurnResult::default();

    for round in 0..=MAX_TOOL_ROUNDS {
        let allow_tools = round < MAX_TOOL_ROUNDS;
        let request = ChatRequest {
            model: turn.model,
            messages: &messages,
            // Tool definitions are re-sent every round; the router validates them each time.
            tools: &tools,
            allow_tools,
            effort: turn.effort,
            max_tokens: MAX_TOKENS,
        };
        events.round_started(round);
        let reply = turn.llm.chat(turn.key, &request, &mut Forward(events), turn.cancel).await;
        events.round_finished(round, &reply);
        let reply = reply?;

        result.rounds = round + 1;
        result.usage.add(&reply.usage);
        if !reply.reasoning.is_empty() {
            if !result.reasoning.is_empty() {
                result.reasoning.push_str("\n\n");
            }
            result.reasoning.push_str(&reply.reasoning);
        }
        if reply.cancelled {
            result.text = reply.text;
            result.stopped = true;
            return Ok(result);
        }
        if reply.tool_calls.is_empty() {
            result.text = reply.text;
            return Ok(result);
        }
        if !allow_tools {
            // The model asked for tools after being told to answer. Use its words if it gave any.
            if reply.text.trim().is_empty() {
                bail!(
                    "The model kept calling tools without answering. Ask a narrower question, or pick another model in Settings."
                );
            }
            result.text = reply.text;
            return Ok(result);
        }

        messages.push(reply.assistant_message());
        for call in &reply.tool_calls {
            let output = if turn.cancel.is_cancelled() {
                json!({"error": "The trader stopped this turn."}).to_string()
            } else {
                tools::truncate(host.call(call).await, RESULT_LIMIT)
            };
            // Every call needs a result, or the next request is rejected.
            messages.push(json!({"role": "tool", "tool_call_id": call.id, "content": output}));
        }
        if turn.cancel.is_cancelled() {
            result.text = reply.text;
            result.stopped = true;
            return Ok(result);
        }
    }
    bail!("The turn ended without an answer.")
}

#[cfg(test)]
mod tests;
