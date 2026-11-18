//! One chat turn, from the trader's message to a journaled run.
//!
//! A message is routed before any model sees it. Exact commands (`buy 0.5 BTC`,
//! `@bybit tool {...}`) are carried out directly: they are instant, free and
//! cannot be misread. Everything else goes to the configured model, or to the
//! built-in agents when there is none.

use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use chrono::Utc;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::tools::DeskTools;
use super::view::{
    Destination, RunStatus, RunView, Snapshot, StepStatus, StepView, TicketView, TurnEvent, TurnSink,
};
use super::{Studio, new_id, now_stamp};
use crate::assistant::builtin::{self, Command};
use crate::assistant::prompt::{DeskContext, EXPLAINER_PROMPT, LiveTrading, SYSTEM_PROMPT};
use crate::assistant::{self, Turn, TurnEvents};
use crate::error::{DeskError, Result};
use crate::indicators::{MIN_BARS, analyze};
use crate::instruments::{in_prompt, resolve};
use crate::llm::openrouter::{ChatReply, ChatRequest, ChatSink, ModelInfo, Usage, scrub};
use crate::model::{Feed, Timeframe, decimal_text, money, price_text};
use crate::store::Provider;
use crate::{bail, desk_err};

const MAX_PROMPT: usize = 4000;
/// Earlier turns replayed to the model, and how much of each answer.
const HISTORY_TURNS: usize = 6;
const HISTORY_CHARS: usize = 2000;
const PREVIEW_CHARS: usize = 600;

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

impl From<String> for Answer {
    fn from(text: String) -> Self {
        Self { text, ..Self::default() }
    }
}

/// Clears the busy flag however the turn ends.
struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
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

/// Streams a plain (tool-less) reply into the trace.
struct Speak<'a>(&'a Trace<'a>);

impl ChatSink for Speak<'_> {
    fn text(&mut self, delta: &str) {
        self.0.emit(TurnEvent::Text { delta: delta.to_string() });
    }
    fn reasoning(&mut self, delta: &str) {
        self.0.emit(TurnEvent::Reasoning { delta: delta.to_string() });
    }
}

/// How a message will be handled, decided before any work starts.
enum Route {
    Order { side: crate::model::Side, quantity: String, symbol: String },
    ExchangeTool { venue: crate::model::VenueId, name: String, arguments: Value },
    Agent { key: String, model: ModelInfo },
    Explain { key: String, model: ModelInfo, portfolio: bool },
    Local { model: String, portfolio: bool },
    Portfolio,
    Help,
    Research,
    Refuse(DeskError),
}

impl Studio {
    fn route(&self, prompt: &str) -> Route {
        let command = builtin::parse(prompt);
        match command {
            Ok(Command::Order { side, quantity, symbol }) => return Route::Order { side, quantity, symbol },
            Ok(Command::ExchangeTool { venue, name, arguments }) => {
                return Route::ExchangeTool { venue, name, arguments };
            }
            // An `@venue` command is explicit syntax: report what is wrong with it.
            Err(error) if prompt.trim_start().starts_with('@') => return Route::Refuse(error),
            _ => {}
        }
        let portfolio = matches!(command, Ok(Command::Portfolio));
        let (provider, model, info, key) = {
            let state = self.state();
            (
                state.prefs.provider,
                state.prefs.model.clone(),
                state.prefs.model_info.clone(),
                state.openrouter_key.clone(),
            )
        };
        match (provider, info, key) {
            (Provider::OpenRouter, Some(model), Some(key)) if model.tools => Route::Agent { key, model },
            (Provider::OpenRouter, Some(model), Some(key)) => Route::Explain { key, model, portfolio },
            (Provider::OpenRouter, _, _) => Route::Refuse(desk_err!(
                "Add your OpenRouter key and pick a model in Settings to use the assistant."
            )),
            (Provider::Ollama, _, _) => Route::Local { model, portfolio },
            (Provider::Builtin, _, _) => match command {
                Ok(Command::Portfolio) => Route::Portfolio,
                Ok(Command::Help) => Route::Help,
                // A vague order has no model to interpret it, so show the exact form.
                Err(error) => Route::Refuse(error),
                Ok(_) => Route::Research,
            },
        }
    }

    /// Runs one turn and streams it to `sink`. Only an unusable message is an
    /// error; a turn that fails still returns a snapshot, with the failure
    /// recorded in the run.
    pub async fn ask(&self, prompt: &str, sink: &dyn TurnSink) -> Result<Snapshot> {
        let prompt = prompt.trim();
        let length = prompt.chars().count();
        if length == 0 || length > MAX_PROMPT {
            bail!("Enter a message of up to 4,000 characters.");
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            bail!("The assistant is still working. Stop it or wait for it to finish.");
        }
        let busy = Busy(&self.busy);
        let cancel = CancellationToken::new();
        *self.cancel.lock().unwrap_or_else(|p| p.into_inner()) = cancel.clone();

        let route = self.route(prompt);
        let (agent, model, private) = match &route {
            Route::Order { .. } => ("Order agent", String::new(), false),
            Route::ExchangeTool { .. } => ("Exchange tools", String::new(), true),
            Route::Agent { model, .. } | Route::Explain { model, .. } => {
                ("Assistant", model.id.clone(), false)
            }
            Route::Local { model, .. } => ("Assistant", model.clone(), false),
            Route::Portfolio => ("Portfolio agent", String::new(), false),
            Route::Research => ("Research agent", String::new(), false),
            Route::Help | Route::Refuse(_) => ("Desk", String::new(), false),
        };
        let (feed, thread) = {
            let state = self.state();
            (state.feed, state.thread.clone())
        };
        let trace = Trace::new(
            RunView {
                id: new_id()[..10].to_string(),
                thread,
                agent: agent.to_string(),
                title: prompt.to_string(),
                feed,
                time: now_stamp(),
                status: RunStatus::Running,
                steps: Vec::new(),
                output: String::new(),
                reasoning: String::new(),
                ms: 0,
                ticket: None,
                usage: None,
                model,
            },
            sink,
        );

        let outcome: Result<Answer> = match route {
            Route::Refuse(error) => Err(error),
            Route::Help => Ok(builtin::HELP.to_string().into()),
            Route::Order { side, quantity, symbol } => {
                self.order_turn(&trace, side, &quantity, &symbol).await
            }
            Route::ExchangeTool { venue, name, arguments } => {
                let label = format!("{}.{name}", venue.as_str());
                trace
                    .step(
                        &label,
                        "typed command",
                        |_| "Private result, not kept.".to_string(),
                        self.exchange_tool(venue, &name, &arguments, false),
                    )
                    .await
                    .map(|value| {
                        serde_json::to_string_pretty(&value)
                            .unwrap_or_default()
                            .chars()
                            .take(12_000)
                            .collect::<String>()
                            .into()
                    })
            }
            Route::Portfolio => self.portfolio_text(&trace).map(Answer::from),
            Route::Research => self.research(prompt, &trace).await.map(Answer::from),
            Route::Agent { key, model } => self.agent_turn(prompt, &trace, &key, &model, &cancel).await,
            Route::Explain { key, model, portfolio } => {
                self.explain_turn(prompt, &trace, &key, &model, portfolio, &cancel).await
            }
            Route::Local { model, portfolio } => self.local_turn(prompt, &trace, &model, portfolio).await,
        };
        let run = trace.finish(outcome);
        self.record(run, private);
        // Release the desk first, so the snapshot does not report a turn that has ended.
        drop(busy);
        Ok(self.snapshot())
    }

    async fn order_turn(
        &self,
        trace: &Trace<'_>,
        side: crate::model::Side,
        quantity: &str,
        symbol: &str,
    ) -> Result<Answer> {
        let detail = format!("{side} {quantity} {symbol}");
        let draft = self.draft_ticket(symbol, side, Some(quantity), None, Destination::Paper, "");
        let ticket = trace
            .step(
                "draft_ticket",
                &detail,
                |t: &TicketView| format!("{} {} {} at {} USDT", t.side, t.qty, t.pair, t.price),
                draft,
            )
            .await?;
        let sample = if ticket.feed == Feed::Sample { " Prices are from the sample tape." } else { "" };
        let text = format!(
            "Ticket ready: {} {} {} for about {} USDT on the paper account. Review it and confirm to place it.{sample}",
            ticket.side, ticket.qty, ticket.pair, ticket.value
        );
        trace.ticket(ticket);
        Ok(text.into())
    }

    fn portfolio_text(&self, trace: &Trace<'_>) -> Result<String> {
        let feed = self.feed();
        let handle = trace.begin("get_portfolio", feed.name());
        let account = self.book(feed).and_then(|book| book.snapshot());
        trace.end(
            handle,
            account.as_ref().map(|a| format!("equity {} USDT", money(a.equity))).map_err(|e| e.0.clone()),
        );
        let account = account?;
        let mut lines = vec![format!(
            "Paper equity **{} USDT**, cash {} USDT.",
            money(account.equity),
            money(account.cash)
        )];
        let mut holdings = account.holdings.clone();
        holdings.sort_by_key(|holding| std::cmp::Reverse(holding.value));
        for holding in &holdings {
            lines.push(format!(
                "- {}: {} units worth {} USDT (cost {} USDT, unrealized {} USDT)",
                holding.pair,
                decimal_text(holding.qty),
                money(holding.value),
                money(holding.cost),
                money(holding.value - holding.cost)
            ));
        }
        if holdings.is_empty() {
            lines.push("No open positions on this feed.".to_string());
        }
        if feed == Feed::Sample {
            lines.push("Positions are valued with sample tape prices, which are fictional.".to_string());
        }
        Ok(lines.join("\n"))
    }

    /// The built-in research agent: price and a daily technical reading for up to four pairs.
    async fn research(&self, prompt: &str, trace: &Trace<'_>) -> Result<String> {
        let mut pairs = in_prompt(prompt)?;
        if pairs.is_empty() {
            pairs.push(self.state().focus.clone());
        }
        if pairs.len() > 4 {
            bail!("Compare up to four instruments at a time.");
        }
        let mut sections = Vec::new();
        let mut ranking: Vec<(f64, String)> = Vec::new();
        let mut sample = false;
        for pair in &pairs {
            let instrument = resolve(pair)?;
            let quote = trace
                .step(
                    "get_quote",
                    pair,
                    |q: &crate::model::Quote| format!("{} USDT", price_text(q.price)),
                    self.quote(&instrument),
                )
                .await?;
            let candles = trace
                .step(
                    "analyze_market",
                    &format!("{pair} 1d"),
                    |c: &(Vec<_>, String, bool)| format!("{} daily candles", c.0.len()),
                    self.read_candles(&instrument, Timeframe::D1, 240),
                )
                .await?;
            let reading = analyze(pair, Timeframe::D1, &candles.0, quote.price, &quote.source, quote.sample);
            if let Some((_, change)) = reading.returns.iter().find(|(bars, _)| *bars == 5) {
                ranking.push((*change, instrument.ticker.clone()));
            }
            sample |= quote.sample;
            let summary = if candles.0.len() < MIN_BARS {
                "Too little price history for a technical reading.".to_string()
            } else {
                reading.summary()
            };
            sections.push(format!(
                "**{}** {} USDT ({}, {})\n{summary}",
                instrument.name,
                price_text(quote.price),
                quote.source,
                quote.stamp()
            ));
        }
        if ranking.len() > 1 {
            ranking.sort_by(|a, b| b.0.total_cmp(&a.0));
            let listed: Vec<String> =
                ranking.iter().map(|(change, ticker)| format!("{ticker} {change:+.2}%")).collect();
            sections.push(format!("Change over 5 daily bars, strongest first: {}.", listed.join(", ")));
        }
        if sample {
            sections
                .push("These are sample tape prices: fictional practice data, not the market.".to_string());
        }
        {
            let mut state = self.state();
            state.focus = pairs[0].clone();
            state.feed_error.clear();
        }
        Ok(sections.join("\n\n"))
    }

    /// What the model needs to know about the desk right now.
    fn desk_context(&self) -> Result<DeskContext> {
        let feed = self.feed();
        let account = self.book(feed)?.snapshot()?;
        let state = self.state();
        let live = match feed {
            Feed::Sample => LiveTrading::Unavailable("the sample feed has no exchange account".to_string()),
            Feed::Venue(venue) if !self.venue(venue).has_credentials() => {
                LiveTrading::Unavailable(format!("no {} API keys are loaded", venue.name()))
            }
            Feed::Venue(venue) if !state.prefs.live_tickets => LiveTrading::TurnedOff(venue),
            Feed::Venue(venue) => LiveTrading::Allowed(venue),
        };
        let pending = state.draft.as_ref().map(|draft| {
            let place = if draft.view.destination == Destination::Paper {
                "the paper account"
            } else {
                "the live exchange account"
            };
            format!("{} {} {} on {place}", draft.view.side, draft.view.qty, draft.view.pair)
        });
        Ok(DeskContext {
            now: Utc::now(),
            feed,
            focus: state.focus.clone(),
            watchlist: state.watchlist.iter().map(|i| i.ticker.clone()).collect(),
            equity: account.equity,
            cash: account.cash,
            positions: account.holdings.iter().map(|h| (h.pair.clone(), h.qty, h.value)).collect(),
            live,
            pending,
            servers: state
                .servers
                .iter()
                .map(|(venue, view)| (*venue, view.name.clone(), view.tools))
                .collect(),
        })
    }

    /// Earlier turns of this conversation, oldest first, as chat messages.
    fn history(&self) -> Vec<Value> {
        let state = self.state();
        let mut turns: Vec<&RunView> = state
            .runs
            .iter()
            .filter(|run| run.thread == state.thread && !run.output.trim().is_empty())
            .filter(|run| {
                matches!(run.status, RunStatus::Complete | RunStatus::Stopped)
                    && run.agent != "Exchange tools"
            })
            .take(HISTORY_TURNS)
            .collect();
        turns.reverse();
        turns
            .into_iter()
            .flat_map(|run| {
                let answer: String = run.output.chars().take(HISTORY_CHARS).collect();
                [
                    json!({"role": "user", "content": run.title}),
                    json!({"role": "assistant", "content": answer}),
                ]
            })
            .collect()
    }

    /// The full assistant: a tool-calling model working the desk.
    async fn agent_turn(
        &self,
        prompt: &str,
        trace: &Trace<'_>,
        key: &str,
        model: &ModelInfo,
        cancel: &CancellationToken,
    ) -> Result<Answer> {
        let context = self.desk_context()?;
        let effort = self.state().prefs.effort.as_param();
        let tools = DeskTools { studio: self, trace, servers: !context.servers.is_empty() };
        let live = Live { trace, label: model.name.clone(), open: Mutex::new(None) };
        let turn = Turn {
            llm: &self.openrouter,
            key,
            model,
            effort,
            system: SYSTEM_PROMPT,
            history: self.history(),
            user: context.wrap(prompt),
            cancel,
        };
        let result = assistant::run(turn, &tools, &live).await?;
        Ok(Answer {
            text: scrub(&result.text, key),
            reasoning: scrub(&result.reasoning, key),
            usage: Some(result.usage),
            stopped: result.stopped,
        })
    }

    /// Readings gathered by the built-in agents, for a model that cannot call tools.
    async fn readings(&self, prompt: &str, trace: &Trace<'_>, portfolio: bool) -> Result<String> {
        if portfolio { self.portfolio_text(trace) } else { self.research(prompt, trace).await }
    }

    /// A model without tool support explains readings the desk gathered for it.
    async fn explain_turn(
        &self,
        prompt: &str,
        trace: &Trace<'_>,
        key: &str,
        model: &ModelInfo,
        portfolio: bool,
        cancel: &CancellationToken,
    ) -> Result<Answer> {
        let facts = self.readings(prompt, trace, portfolio).await?;
        let messages = [
            json!({"role": "system", "content": EXPLAINER_PROMPT}),
            json!({"role": "user", "content": format!("{prompt}\n\n<readings>\n{facts}\n</readings>")}),
        ];
        let effort = self.state().prefs.effort.as_param();
        let request = ChatRequest {
            model,
            messages: &messages,
            tools: &[],
            allow_tools: false,
            effort,
            max_tokens: 2048,
        };
        let handle = trace.begin("model", &format!("{}, explaining the readings", model.name));
        let reply = self.openrouter.chat(key, &request, &mut Speak(trace), cancel).await;
        trace.end(
            handle,
            reply
                .as_ref()
                .map(|r| format!("answered ({} tokens out)", r.usage.completion_tokens))
                .map_err(|e| e.0.clone()),
        );
        let reply = reply?;
        Ok(Answer {
            text: format!("{}\n\n**Desk readings**\n\n{facts}", scrub(reply.text.trim(), key)),
            reasoning: scrub(&reply.reasoning, key),
            usage: Some(reply.usage),
            stopped: reply.cancelled,
        })
    }

    /// A model on this computer explains readings the desk gathered for it.
    async fn local_turn(
        &self,
        prompt: &str,
        trace: &Trace<'_>,
        model: &str,
        portfolio: bool,
    ) -> Result<Answer> {
        let facts = self.readings(prompt, trace, portfolio).await?;
        let user = format!("{prompt}\n\n<readings>\n{facts}\n</readings>");
        let explained = trace
            .step(
                "ollama.chat",
                model,
                |text: &String| format!("{} characters", text.len()),
                self.ollama.explain(model, EXPLAINER_PROMPT, &user),
            )
            .await;
        Ok(match explained {
            Ok(text) => format!("{text}\n\n**Desk readings**\n\n{facts}").into(),
            // The readings are still worth showing when the local model is down.
            Err(error) => {
                format!("{facts}\n\nThe local model could not explain these readings: {}", error.0).into()
            }
        })
    }
}
