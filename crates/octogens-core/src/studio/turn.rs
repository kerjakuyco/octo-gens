//! One chat turn, from the trader's message to a journaled run.
//!
//! Every message is answered by the connected model. It reads the desk through
//! tools and may draft a ticket for the trader to confirm; nothing here can
//! place an order. With no model connected there is nobody to answer, and the
//! turn is refused before it starts.

use std::future::Future;
use std::sync::Mutex;
use std::time::Instant;

use chrono::Utc;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::tools::DeskTools;
use super::view::{
    CardView, RunStatus, RunView, Snapshot, StepStatus, StepView, TicketView, TurnEvent, TurnSink,
};
use super::{Chosen, Studio, links_in, new_id, now_stamp};
use crate::assistant::prompt::{DeskContext, PositionLine, SYSTEM_PROMPT, WalletState};
use crate::assistant::tools::Offered;
use crate::assistant::{self, Limits, Turn, TurnEvents};
use crate::bail;
use crate::error::{DeskError, Result};
use crate::llm::{ChatReply, Usage};
use crate::model::Network;
use crate::store::Provider;

const MAX_PROMPT: usize = 4000;
const PREVIEW_CHARS: usize = 600;
/// Cards kept with one answer. More than this is a report, not an answer.
const MAX_CARDS: usize = 12;

/// The live record of a run: steps are added as they happen and mirrored to the interface.
pub(super) struct Trace<'a> {
    run: Mutex<RunView>,
    sink: &'a dyn TurnSink,
    started: Instant,
}

impl<'a> Trace<'a> {
    fn new(run: RunView, sink: &'a dyn TurnSink) -> Self {
        sink.emit(TurnEvent::Started { run: run.clone() });
        Self { run: Mutex::new(run), sink, started: Instant::now() }
    }

    fn run(&self) -> std::sync::MutexGuard<'_, RunView> {
        self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn emit(&self, event: TurnEvent) {
        self.sink.emit(event);
    }

    /// Opens a step and returns its handle for [`Self::end`].
    pub(super) fn begin(&self, name: &str, detail: &str) -> (usize, Instant) {
        let step = StepView {
            name: name.to_string(),
            detail: detail.to_string(),
            status: StepStatus::Running,
            ms: 0,
            preview: String::new(),
        };
        let index = {
            let mut run = self.run();
            run.steps.push(step.clone());
            run.steps.len() - 1
        };
        self.sink.emit(TurnEvent::Step { index, step });
        (index, Instant::now())
    }

    /// Closes a step with a result preview or an error.
    pub(super) fn end(&self, handle: (usize, Instant), outcome: std::result::Result<String, String>) {
        let (index, started) = handle;
        let step = {
            let mut run = self.run();
            let Some(step) = run.steps.get_mut(index) else {
                return;
            };
            step.ms = started.elapsed().as_millis() as u64;
            step.status = if outcome.is_ok() { StepStatus::Ok } else { StepStatus::Error };
            let text = outcome.unwrap_or_else(|error| error);
            step.preview = crate::assistant::tools::truncate(text, PREVIEW_CHARS);
            step.clone()
        };
        self.sink.emit(TurnEvent::Step { index, step });
    }

    /// Runs `work` as a traced step.
    pub(super) async fn step<T>(
        &self,
        name: &str,
        detail: &str,
        preview: impl FnOnce(&T) -> String,
        work: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let handle = self.begin(name, detail);
        let result = work.await;
        self.end(handle, result.as_ref().map(preview).map_err(|error| error.0.clone()));
        result
    }

    /// Shows something the assistant looked at. A second look at the same thing
    /// in one turn adds nothing and is not shown again.
    pub(super) fn card(&self, card: CardView) {
        {
            let mut run = self.run();
            let subject = card.subject();
            if run.cards.len() >= MAX_CARDS || run.cards.iter().any(|shown| shown.subject() == subject) {
                return;
            }
            run.cards.push(card.clone());
        }
        self.sink.emit(TurnEvent::Card { card });
    }

    pub(super) fn ticket(&self, ticket: TicketView) {
        self.run().ticket = Some(ticket.clone());
        self.sink.emit(TurnEvent::Ticket { ticket });
    }

    fn finish(self, outcome: Result<Answer>) -> RunView {
        let mut run = self.run.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
        run.ms = self.started.elapsed().as_millis() as u64;
        // A step still marked running was cut short by an error or by Stop.
        for step in run.steps.iter_mut().filter(|s| s.status == StepStatus::Running) {
            step.status = StepStatus::Error;
        }
        match outcome {
            Ok(answer) => {
                run.status = if answer.stopped { RunStatus::Stopped } else { RunStatus::Complete };
                run.output = if answer.stopped && answer.text.trim().is_empty() {
                    "Stopped before an answer.".to_string()
                } else {
                    answer.text
                };
                run.reasoning = answer.reasoning.chars().take(6000).collect();
                run.usage = answer.usage.filter(|usage| !usage.is_empty());
            }
            Err(error) => {
                run.status = RunStatus::Failed;
                run.output = error.0;
            }
        }
        self.sink.emit(TurnEvent::Finished { run: run.clone() });
        run
    }
}

#[derive(Default)]
struct Answer {
    text: String,
    reasoning: String,
    usage: Option<Usage>,
    stopped: bool,
}

/// Mirrors model rounds into the trace and the streamed answer.
struct Live<'a> {
    trace: &'a Trace<'a>,
    label: String,
    open: Mutex<Option<(usize, Instant)>>,
}

impl TurnEvents for Live<'_> {
    fn round_started(&self, round: usize) {
        if round > 0 {
            self.trace.emit(TurnEvent::Round);
        }
        let handle = self.trace.begin("model", &format!("{}, round {}", self.label, round + 1));
        *self.open.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
    }

    fn round_finished(&self, _: usize, reply: &Result<ChatReply>) {
        let Some(handle) = self.open.lock().unwrap_or_else(|p| p.into_inner()).take() else {
            return;
        };
        let summary = match reply {
            Ok(reply) if reply.cancelled => Ok("stopped".to_string()),
            Ok(reply) if !reply.tool_calls.is_empty() => Ok(format!(
                "asked for {}",
                reply.tool_calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")
            )),
            Ok(reply) => Ok(format!("answered ({} tokens out)", reply.usage.completion_tokens)),
            Err(error) => Err(error.0.clone()),
        };
        self.trace.end(handle, summary);
    }

    fn text(&self, delta: &str) {
        self.trace.emit(TurnEvent::Text { delta: delta.to_string() });
    }

    fn reasoning(&self, delta: &str) {
        self.trace.emit(TurnEvent::Reasoning { delta: delta.to_string() });
    }
}

/// What a ticket says in a sentence, for the model's context.
fn ticket_line(ticket: &TicketView) -> String {
    let mut line = format!("{} {} {}", ticket.side, ticket.qty, ticket.symbol);
    if ticket.reduce_only {
        line.push_str(" (reduce-only)");
    } else {
        line.push_str(&format!(" at {}x", ticket.leverage));
    }
    if let Some(stop) = &ticket.stop_loss {
        line.push_str(&format!(" with a stop at {stop}"));
    }
    line
}

impl Studio {
    /// Runs one turn and streams it to `sink`. An unusable message, or having
    /// no model to answer it, is an error; a turn that fails still returns a
    /// snapshot, with the failure recorded in the run.
    pub async fn ask(&self, prompt: &str, sink: &dyn TurnSink) -> Result<Snapshot> {
        let prompt = prompt.trim();
        let length = prompt.chars().count();
        if length == 0 || length > MAX_PROMPT {
            bail!("Enter a message of up to 4,000 characters.");
        }
        // Held until the run is recorded: nothing may change the desk under a turn.
        let hold = self.begin_turn()?;
        let chosen = self.chosen()?;
        let cancel = CancellationToken::new();
        *self.cancel.lock().unwrap_or_else(|p| p.into_inner()) = cancel.clone();

        let (network, thread) = {
            let state = self.state();
            (state.network, state.thread.clone())
        };
        let trace = Trace::new(
            RunView {
                id: new_id()[..10].to_string(),
                thread,
                agent: "Assistant".to_string(),
                title: prompt.to_string(),
                network,
                time: now_stamp(),
                status: RunStatus::Running,
                steps: Vec::new(),
                output: String::new(),
                reasoning: String::new(),
                ms: 0,
                ticket: None,
                cards: Vec::new(),
                usage: None,
                model: chosen.model.id.clone(),
            },
            sink,
        );
        let outcome = self.agent_turn(prompt, &trace, &chosen, &cancel).await;
        // Whatever a provider says in an error, its key does not reach the screen or the journal.
        let outcome = outcome.map_err(|error| DeskError::new(chosen.connection.clean(&error.0)));
        let run = trace.finish(outcome);
        self.record(run, false);
        // Release the desk first, so the snapshot does not report a turn that has ended.
        drop(hold);
        Ok(self.snapshot())
    }

    /// What the model needs to know about the desk right now.
    async fn desk_context(&self) -> DeskContext {
        let network = self.network();
        let client = self.client(network);
        let wallet = if client.wallet().is_none() {
            WalletState::NotConnected
        } else {
            match self.account(network).await {
                Ok(account) => WalletState::Connected {
                    equity: account.equity,
                    available: account.available,
                    positions: account
                        .positions
                        .iter()
                        .map(|p| PositionLine {
                            symbol: p.symbol.clone(),
                            long: p.is_long(),
                            qty: p.amount.abs(),
                            entry: p.entry_price,
                            unrealized_pnl: p.unrealized_pnl,
                            liquidation: p.liquidation_price,
                            leverage: p.leverage,
                        })
                        .collect(),
                    open_orders: account.orders.len(),
                },
                Err(error) if client.is_deposit_notice(&error) => WalletState::NeedsDeposit,
                Err(error) => WalletState::Unreadable(error.0.trim_end_matches('.').to_string()),
            }
        };
        let state = self.state();
        // What a new position will really get: the exchange's Multi-Assets mode allows only cross margin.
        let cross_only = state.account.as_ref().is_some_and(|account| account.multi_assets);
        DeskContext {
            now: Utc::now(),
            network,
            focus: state.focus.clone(),
            watchlist: state.watchlist.iter().map(|i| i.symbol.clone()).collect(),
            wallet,
            max_leverage: state.prefs.max_leverage,
            isolated: state.prefs.isolated && !cross_only,
            may_draft: network == Network::Testnet || state.prefs.live_tickets,
            pending: state.draft.as_ref().map(|draft| ticket_line(&draft.view)),
            servers: state
                .servers
                .iter()
                .map(|server| (server.id.clone(), server.name.clone(), server.tools))
                .collect(),
            web_search: state.prefs.web_search,
        }
    }

    /// Earlier turns of the open conversation, oldest first, as chat messages.
    fn history(&self, limits: &Limits) -> Vec<Value> {
        let state = self.state();
        let mut turns: Vec<&RunView> = state
            .turns
            .iter()
            .rev()
            .filter(|run| !run.output.trim().is_empty())
            .filter(|run| matches!(run.status, RunStatus::Complete | RunStatus::Stopped))
            .take(limits.history_turns)
            .collect();
        turns.reverse();
        turns
            .into_iter()
            .flat_map(|run| {
                let answer: String = run.output.chars().take(limits.history_chars).collect();
                [
                    json!({"role": "user", "content": run.title}),
                    json!({"role": "assistant", "content": answer}),
                ]
            })
            .collect()
    }

    /// The assistant: a tool-calling model working the desk.
    async fn agent_turn(
        &self,
        prompt: &str,
        trace: &Trace<'_>,
        chosen: &Chosen,
        cancel: &CancellationToken,
    ) -> Result<Answer> {
        if chosen.provider == Provider::LmStudio {
            // A model that is not loaded yet is loaded here, with room for the assistant.
            // Reading a large model from disk takes a while, so Stop must work meanwhile.
            let ready = |_: &()| "ready".to_string();
            let loading = trace.step("load_model", &chosen.model.name, ready, self.prepare_model(chosen));
            tokio::select! {
                () = cancel.cancelled() => return Ok(Answer { stopped: true, ..Answer::default() }),
                loaded = loading => loaded?,
            }
        }
        let context = self.desk_context().await;
        let limits = Limits::of(&chosen.connection);
        let effort = self.state().prefs.effort.as_param();
        let offered = Offered { web: context.web_search, servers: !context.servers.is_empty() };
        let tools = DeskTools::new(self, trace, offered, limits, links_in(prompt));
        let live = Live { trace, label: chosen.model.name.clone(), open: Mutex::new(None) };
        let turn = Turn {
            llm: &chosen.connection,
            model: &chosen.model,
            effort,
            system: SYSTEM_PROMPT,
            history: self.history(&limits),
            user: context.wrap(prompt),
            cancel,
            limits,
        };
        let result = assistant::run(turn, &tools, &live).await?;
        Ok(Answer {
            text: chosen.connection.clean(&result.text),
            reasoning: chosen.connection.clean(&result.reasoning),
            usage: Some(result.usage),
            stopped: result.stopped,
        })
    }
}
