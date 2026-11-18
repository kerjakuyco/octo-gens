//! The studio: the one object that owns the desk and offers every action the
//! user interface can take.
//!
//! State lives behind short-lived locks that are never held across a network
//! call, so the interface stays responsive while the assistant works. Actions
//! that would pull the desk out from under a running turn (switching feed,
//! changing keys) are refused until the turn ends.

mod pattern;
mod tools;
mod turn;
pub mod view;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use futures_util::future::join_all;
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::error::{DeskError, Result};
use crate::instruments::{DEFAULT_PAIR, Instrument, resolve, universe};
use crate::ledger::PaperBook;
use crate::llm::ollama::Ollama;
use crate::llm::openrouter::{ModelInfo, OpenRouter, valid_key, valid_model_id};
use crate::mcp::{McpConnectRequest, McpLink, ToolInfo, node_runtime, official_package};
use crate::model::{
    Feed, Quote, Side, Ticket, Timeframe, VenueId, decimal_text, money, parse_quantity, price_text,
};
use crate::net::http_client;
use crate::sample::{SAMPLE_SOURCE, sample_candles, sample_quote};
use crate::store::{Journal, OPENROUTER_SECRET, Prefs, Provider, SecretStore, Theme, venue_secret};
use crate::venues::{Credentials, VenueClient};
use crate::{bail, desk_err};
use view::{
    AccountView, AssistantRequest, AssistantView, BalanceRow, CandleSeries, CredentialsRequest, Destination,
    InstrumentView, McpView, QuoteView, RunStatus, RunView, Snapshot, StepStatus, StepView, TicketRequest,
    TicketView, VenueView, WatchView,
};

/// Runs kept in memory and sent to the interface.
const RUNS_SHOWN: usize = 60;
/// Daily history is re-read this often; in between, only the ticker is refreshed.
const HISTORY_TTL: Duration = Duration::from_secs(600);
/// Candles sent to the chart.
const CHART_CANDLES: usize = 200;
/// How long a launch waits for last session's live feed before settling on the sample tape.
const RESTORE_TIMEOUT: Duration = Duration::from_secs(10);
const PRIVATE_NOTE: &str = "Private tool result was shown for this session only.";

/// Where the studio keeps its files and which servers it talks to.
pub struct StudioConfig {
    pub dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
    /// Alternative origins per venue. Used by tests.
    pub venue_bases: HashMap<VenueId, String>,
    pub openrouter_base: Option<String>,
    pub ollama_base: Option<String>,
}

impl StudioConfig {
    pub fn new(dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self { dir, secrets, venue_bases: HashMap::new(), openrouter_base: None, ollama_base: None }
    }
}

/// A ticket waiting for the trader's confirmation.
struct Draft {
    feed: Feed,
    ticket: Ticket,
    view: TicketView,
}

struct State {
    prefs: Prefs,
    feed: Feed,
    focus: String,
    feed_error: String,
    watchlist: Vec<Instrument>,
    quotes: HashMap<String, Quote>,
    /// When each pair's daily history was last read from a live venue.
    history_at: HashMap<String, Instant>,
    thread: String,
    runs: VecDeque<RunView>,
    draft: Option<Draft>,
    receipts: HashMap<String, String>,
    watch: Option<WatchView>,
    servers: HashMap<VenueId, McpView>,
    /// Held in memory after one read so the keychain is not asked on every turn.
    openrouter_key: Option<String>,
    catalog: Vec<ModelInfo>,
}

type Notifier = Arc<dyn Fn(Snapshot) + Send + Sync>;

pub struct Studio {
    dir: PathBuf,
    venues: HashMap<VenueId, VenueClient>,
    openrouter: OpenRouter,
    ollama: Ollama,
    secrets: Arc<dyn SecretStore>,
    journal: Journal,
    books: Mutex<HashMap<&'static str, Arc<PaperBook>>>,
    links: tokio::sync::RwLock<HashMap<VenueId, Arc<McpLink>>>,
    state: Mutex<State>,
    busy: AtomicBool,
    cancel: Mutex<CancellationToken>,
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
    notifier: Mutex<Option<Notifier>>,
    node: bool,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn now_stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl Studio {
    /// Opens the data folder, restores preferences and stored credentials, and
    /// starts on the sample tape. Nothing here touches the network.
    pub fn open(config: StudioConfig) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&config.dir)?;
        let http = http_client()?;
        let venues = VenueId::ALL
            .into_iter()
            .map(|id| {
                let client = VenueClient::new(id, http.clone());
                (
                    id,
                    match config.venue_bases.get(&id) {
                        Some(base) => client.with_base(base),
                        None => client,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let mut openrouter = OpenRouter::new(http);
        if let Some(base) = &config.openrouter_base {
            openrouter = openrouter.with_base(base);
        }
        let mut ollama = Ollama::new()?;
        if let Some(base) = &config.ollama_base {
            ollama = ollama.with_base(base);
        }

        let prefs_path = config.dir.join("preferences.json");
        let mut prefs = Prefs::load(&prefs_path);
        if let Some(legacy) = prefs.legacy_key.take() {
            // Move a key left in the old plain-text file into the secret store.
            if let Ok(key) = valid_key(&legacy) {
                config.secrets.set(OPENROUTER_SECRET, &key)?;
            }
            prefs.save(&prefs_path)?;
        }
        for venue in prefs.remembered.clone() {
            let stored = config.secrets.get(&venue_secret(venue)).ok().flatten();
            let parsed = stored.and_then(|text| serde_json::from_str::<Value>(&text).ok());
            let credentials = parsed.and_then(|v| {
                Credentials::new(
                    venue,
                    v["key"].as_str()?,
                    v["secret"].as_str()?,
                    v["passphrase"].as_str().unwrap_or(""),
                )
                .ok()
            });
            match credentials {
                Some(credentials) => venues[&venue].set_credentials(Some(credentials)),
                None => prefs.remembered.retain(|v| *v != venue),
            }
        }

        let mut watchlist = universe();
        for pair in &prefs.custom {
            if let Ok(instrument) = resolve(pair)
                && !watchlist.iter().any(|i| i.pair() == instrument.pair())
            {
                watchlist.push(instrument);
            }
        }
        let journal = Journal::open(&config.dir.join("journal.sqlite3"))?;
        let runs: VecDeque<RunView> = journal.recent(RUNS_SHOWN)?.into();
        // Reopen the last conversation so the trader can pick up where they left off.
        let thread = runs
            .iter()
            .find(|run| !run.thread.is_empty())
            .map(|run| run.thread.clone())
            .unwrap_or_else(new_id);
        let focus =
            resolve(&prefs.focus).map(|i| i.pair()).ok().filter(|p| watchlist.iter().any(|i| i.pair() == *p));
        let openrouter_key =
            config.secrets.get(OPENROUTER_SECRET).ok().flatten().and_then(|k| valid_key(&k).ok());

        Ok(Arc::new(Self {
            dir: config.dir,
            venues,
            openrouter,
            ollama,
            secrets: config.secrets,
            journal,
            books: Mutex::new(HashMap::new()),
            links: tokio::sync::RwLock::new(HashMap::new()),
            state: Mutex::new(State {
                prefs,
                feed: Feed::Sample,
                focus: focus.unwrap_or_else(|| DEFAULT_PAIR.to_string()),
                feed_error: String::new(),
                watchlist,
                quotes: HashMap::new(),
                history_at: HashMap::new(),
                thread,
                runs,
                draft: None,
                receipts: HashMap::new(),
                watch: None,
                servers: HashMap::new(),
                openrouter_key,
                catalog: Vec::new(),
            }),
            busy: AtomicBool::new(false),
            cancel: Mutex::new(CancellationToken::new()),
            watcher: Mutex::new(None),
            notifier: Mutex::new(None),
            node: node_runtime().is_some(),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn venue(&self, id: VenueId) -> &VenueClient {
        &self.venues[&id]
    }

    fn feed(&self) -> Feed {
        self.state().feed
    }

    fn save_prefs(&self) -> Result<()> {
        let prefs = self.state().prefs.clone();
        prefs.save(&self.dir.join("preferences.json"))
    }

    /// The paper book of a feed. Each feed has its own file and its own cash.
    fn book(&self, feed: Feed) -> Result<Arc<PaperBook>> {
        let mut books = self.books.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(book) = books.get(feed.as_str()) {
            return Ok(Arc::clone(book));
        }
        let path = self.dir.join(format!("spot-usdt-{}.sqlite3", feed.as_str()));
        let book = Arc::new(PaperBook::open(&path, feed == Feed::Sample)?);
        books.insert(feed.as_str(), Arc::clone(&book));
        Ok(book)
    }

    /// Refuses an action that would change the desk under a running turn.
    fn require_idle(&self, action: &str) -> Result<()> {
        if self.busy.load(Ordering::SeqCst) {
            bail!("Stop the assistant or wait for it to finish before {action}.");
        }
        Ok(())
    }

    /// Registers a callback for snapshots produced by background work.
    pub fn set_notifier(&self, notifier: impl Fn(Snapshot) + Send + Sync + 'static) {
        *self.notifier.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(notifier));
    }

    fn notify(&self) {
        let notifier = self.notifier.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(notifier) = notifier {
            notifier(self.snapshot());
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let feed = self.feed();
        let account =
            self.book(feed).and_then(|book| book.snapshot()).map(|a| AccountView::from(&a)).unwrap_or_else(
                |_| AccountView {
                    cash: "0".to_string(),
                    equity: "0".to_string(),
                    holdings: Vec::new(),
                    orders: Vec::new(),
                },
            );
        let state = self.state();
        let info = state.prefs.model_info.as_ref();
        let label = match state.prefs.provider {
            Provider::Builtin => "Built-in agents".to_string(),
            Provider::OpenRouter => info
                .map(|i| i.name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| state.prefs.model.clone()),
            Provider::Ollama => format!("{} (local)", state.prefs.model),
        };
        Snapshot {
            version: env!("CARGO_PKG_VERSION"),
            feed,
            focus: state.focus.clone(),
            feed_error: state.feed_error.clone(),
            instruments: state.watchlist.iter().map(InstrumentView::from).collect(),
            quotes: state.quotes.iter().map(|(pair, quote)| (pair.clone(), QuoteView::from(quote))).collect(),
            account,
            venues: VenueId::ALL
                .into_iter()
                .map(|id| VenueView {
                    id,
                    name: id.name(),
                    credentials: self.venue(id).has_credentials(),
                    remembered: state.prefs.remembered.contains(&id),
                    mcp: state.servers.get(&id).cloned(),
                    official_package: official_package(id),
                })
                .collect(),
            assistant: AssistantView {
                provider: state.prefs.provider,
                model: state.prefs.model.clone(),
                label,
                has_key: state.openrouter_key.is_some(),
                tools: state.prefs.provider == Provider::OpenRouter && info.is_some_and(|i| i.tools),
                reasoning: state.prefs.provider == Provider::OpenRouter && info.is_some_and(|i| i.reasoning),
                effort: state.prefs.effort,
                live_tickets: state.prefs.live_tickets,
            },
            theme: state.prefs.theme,
            thread: state.thread.clone(),
            runs: state.runs.iter().cloned().collect(),
            draft: state.draft.as_ref().map(|d| d.view.clone()),
            receipts: state.receipts.clone(),
            watch: state.watch.clone(),
            node_runtime: self.node,
            busy: self.busy.load(Ordering::SeqCst),
        }
    }

    /// Reads a quote from a feed without touching the desk's state.
    async fn fetch_quote(&self, feed: Feed, instrument: &Instrument) -> Result<Quote> {
        match feed {
            Feed::Sample => sample_quote(instrument),
            Feed::Venue(venue) => self.venue(venue).quote(instrument).await,
        }
    }

    /// Keeps a quote for display and marks the paper book with it.
    fn keep_quote(&self, feed: Feed, quote: &Quote, full_history: bool) -> Result<()> {
        self.book(feed)?.remember(quote)?;
        let mut state = self.state();
        if state.feed == feed {
            if full_history {
                state.history_at.insert(quote.pair.clone(), Instant::now());
            }
            state.quotes.insert(quote.pair.clone(), quote.clone());
        }
        Ok(())
    }

    /// A fresh, verified quote on the active feed.
    pub(crate) async fn quote(&self, instrument: &Instrument) -> Result<Quote> {
        let feed = self.feed();
        let quote = self.fetch_quote(feed, instrument).await?;
        self.keep_quote(feed, &quote, true)?;
        Ok(quote)
    }

    /// Refreshes one pair cheaply: the ticker alone while its daily history is recent.
    async fn refresh_one(&self, feed: Feed, instrument: &Instrument) -> Result<Quote> {
        let Feed::Venue(venue) = feed else {
            return sample_quote(instrument);
        };
        let pair = instrument.pair();
        let known = {
            let state = self.state();
            let recent = state.history_at.get(&pair).is_some_and(|at| at.elapsed() < HISTORY_TTL);
            state.quotes.get(&pair).filter(|_| recent).cloned()
        };
        match known {
            Some(mut quote) => {
                let tick = self.venue(venue).ticker(instrument).await?;
                quote.price = tick.price;
                quote.as_of = tick.as_of;
                quote.stats = tick.stats;
                self.keep_quote(feed, &quote, false)?;
                Ok(quote)
            }
            None => {
                let quote = self.fetch_quote(feed, instrument).await?;
                self.keep_quote(feed, &quote, true)?;
                Ok(quote)
            }
        }
    }

    /// Fills the sample tape so the desk has something to show at once.
    pub async fn boot(&self) -> Result<Snapshot> {
        let watchlist = self.state().watchlist.clone();
        for instrument in watchlist.iter().filter(|i| i.sample.is_some()) {
            let quote = sample_quote(instrument)?;
            self.keep_quote(Feed::Sample, &quote, true)?;
        }
        Ok(self.snapshot())
    }

    /// Returns to the live feed used last time, if there was one. This can take a
    /// few seconds on a slow network, so the shell runs it after the window is up.
    /// On failure the desk stays on the sample tape and says why.
    pub async fn restore_feed(&self) -> Snapshot {
        let wanted = Feed::parse(&self.state().prefs.feed).ok().filter(|feed| *feed != Feed::Sample);
        if let Some(feed) = wanted {
            let note = match tokio::time::timeout(RESTORE_TIMEOUT, self.set_feed(feed)).await {
                Ok(Ok(snapshot)) => return snapshot,
                Ok(Err(error)) => {
                    format!("Could not return to {}: {} Showing the sample tape.", feed.name(), error.0)
                }
                Err(_) => format!("{} did not answer in time. Showing the sample tape.", feed.name()),
            };
            self.state().feed_error = note;
        }
        self.snapshot()
    }

    /// Switches the price source. A live venue needs no setup: public market data
    /// is read directly. The switch only happens if the venue answers.
    pub async fn set_feed(&self, feed: Feed) -> Result<Snapshot> {
        self.require_idle("switching the price feed")?;
        let watchlist = self.state().watchlist.clone();
        let fetched = join_all(watchlist.iter().map(|instrument| self.fetch_quote(feed, instrument))).await;
        if let (Feed::Venue(venue), true) = (feed, fetched.iter().all(|r| r.is_err())) {
            // Listings differ per venue, so some misses are normal. All of them means the venue is unreachable.
            let reason = fetched
                .into_iter()
                .find_map(|r| r.err().filter(|e| !e.0.starts_with("No active spot listing")));
            return Err(
                reason.unwrap_or_else(|| desk_err!("{} lists none of the watchlist pairs.", venue.name()))
            );
        }
        self.stop_watch();
        {
            let mut state = self.state();
            state.feed = feed;
            state.quotes.clear();
            state.history_at.clear();
            state.draft = None;
            state.feed_error.clear();
            state.prefs.feed = feed.as_str().to_string();
        }
        let focus = self.state().focus.clone();
        for (instrument, result) in watchlist.iter().zip(fetched) {
            match result {
                Ok(quote) => self.keep_quote(feed, &quote, true)?,
                Err(error) if instrument.pair() == focus => self.state().feed_error = error.0,
                Err(_) => {}
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Focuses a pair and refreshes its quote. A quote failure is reported in the
    /// snapshot (`feedError`) rather than as an error, so the panel can show it in place.
    pub async fn select_pair(&self, raw: &str) -> Result<Snapshot> {
        let instrument = resolve(raw)?;
        let pair = instrument.pair();
        {
            let mut state = self.state();
            state.focus = pair.clone();
            state.feed_error.clear();
            state.prefs.focus = pair.clone();
        }
        if let Err(error) = self.quote(&instrument).await {
            let mut state = self.state();
            state.quotes.remove(&pair);
            state.feed_error = error.0;
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Refreshes every watchlist quote on a live feed. Pairs that fail keep their last quote.
    pub async fn refresh_quotes(&self) -> Result<Snapshot> {
        let (feed, watchlist, focus) = {
            let state = self.state();
            (state.feed, state.watchlist.clone(), state.focus.clone())
        };
        if feed == Feed::Sample {
            return Ok(self.snapshot());
        }
        let results = join_all(watchlist.iter().map(|instrument| self.refresh_one(feed, instrument))).await;
        for (instrument, result) in watchlist.iter().zip(results) {
            if instrument.pair() == focus && self.feed() == feed {
                self.state().feed_error = result.err().map(|e| e.0).unwrap_or_default();
            }
        }
        Ok(self.snapshot())
    }

    /// Candles for the chart on the active feed.
    pub async fn candles(&self, raw: &str, timeframe: &str) -> Result<CandleSeries> {
        let instrument = resolve(raw)?;
        let timeframe = Timeframe::parse(timeframe)?;
        let (candles, source, sample) = self.read_candles(&instrument, timeframe, CHART_CANDLES).await?;
        Ok(CandleSeries::new(&instrument.pair(), timeframe.as_str(), &source, sample, &candles))
    }

    /// `(candles, source, is sample)` on the active feed.
    pub(crate) async fn read_candles(
        &self,
        instrument: &Instrument,
        timeframe: Timeframe,
        limit: usize,
    ) -> Result<(Vec<crate::model::Candle>, String, bool)> {
        match self.feed() {
            Feed::Sample => {
                Ok((sample_candles(instrument, timeframe, limit)?, SAMPLE_SOURCE.to_string(), true))
            }
            Feed::Venue(venue) => Ok((
                self.venue(venue).candles(instrument, timeframe, limit).await?,
                format!("{} spot", venue.name()),
                false,
            )),
        }
    }

    /// Adds a token to the watchlist once the active feed confirms it can price it.
    pub async fn watch_add(&self, symbol: &str) -> Result<Snapshot> {
        let instrument = resolve(symbol)?;
        let pair = instrument.pair();
        let known = self.state().watchlist.iter().any(|i| i.pair() == pair);
        if !known {
            // Pricing it proves the listing; an unlisted or mistyped token never reaches the list.
            self.quote(&instrument).await?;
            let mut state = self.state();
            state.watchlist.push(instrument);
            state.prefs.custom.push(pair.clone());
        }
        self.select_pair(&pair).await
    }

    /// Removes a token the trader added. Built-in instruments stay.
    pub fn watch_remove(&self, pair: &str) -> Result<Snapshot> {
        {
            let mut state = self.state();
            let Some(position) = state.watchlist.iter().position(|i| i.pair() == pair && i.custom) else {
                bail!("Only tokens you added can be removed from the watchlist.");
            };
            state.watchlist.remove(position);
            state.prefs.custom.retain(|p| p != pair);
            state.quotes.remove(pair);
            if state.focus == pair {
                state.focus = DEFAULT_PAIR.to_string();
                state.prefs.focus = DEFAULT_PAIR.to_string();
                state.feed_error.clear();
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Starts a new conversation. Earlier ones stay in the journal.
    pub fn new_thread(&self) -> Snapshot {
        self.state().thread = new_id();
        self.snapshot()
    }

    pub fn set_theme(&self, theme: Theme) -> Result<Snapshot> {
        self.state().prefs.theme = theme;
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Asks a running turn to stop. Safe to call at any time.
    pub fn stop_turn(&self) {
        self.cancel.lock().unwrap_or_else(|p| p.into_inner()).cancel();
    }

    /// Adds a finished run to the journal. Private output stays in memory only.
    fn record(&self, run: RunView, private: bool) {
        let stored =
            if private { RunView { output: PRIVATE_NOTE.to_string(), ..run.clone() } } else { run.clone() };
        // A journal failure must not undo the work the run describes.
        let _ = self.journal.append(&stored);
        let mut state = self.state();
        state.runs.push_front(run);
        state.runs.truncate(RUNS_SHOWN);
    }

    /// A finished run that had no live audience: orders, pattern checks, tool calls.
    fn quick_run(
        &self,
        agent: &str,
        title: &str,
        feed: Feed,
        started: Instant,
        steps: Vec<StepView>,
        outcome: &Result<String>,
    ) -> RunView {
        RunView {
            id: new_id()[..10].to_string(),
            thread: String::new(),
            agent: agent.to_string(),
            title: title.chars().take(250).collect(),
            feed,
            time: now_stamp(),
            status: if outcome.is_ok() { RunStatus::Complete } else { RunStatus::Failed },
            steps,
            output: match outcome {
                Ok(text) => text.clone(),
                Err(error) => error.0.clone(),
            },
            reasoning: String::new(),
            ms: started.elapsed().as_millis() as u64,
            ticket: None,
            usage: None,
            model: String::new(),
        }
    }

    /// Prices and drafts a ticket. Nothing is sent anywhere until [`Self::submit_ticket`].
    pub(crate) async fn draft_ticket(
        &self,
        pair: &str,
        side: Side,
        quantity: Option<&str>,
        quote_amount: Option<&str>,
        destination: Destination,
        rationale: &str,
    ) -> Result<TicketView> {
        let instrument = resolve(pair)?;
        let feed = self.feed();
        if destination == Destination::Exchange {
            let Feed::Venue(venue) = feed else {
                bail!("Live orders need a live feed. Switch the feed to Binance, Bybit or OKX first.");
            };
            if !self.venue(venue).has_credentials() {
                bail!("Add {} API keys in Connections to send live orders.", venue.name());
            }
        }
        let quote = self.quote(&instrument).await?;
        let qty = match (
            quantity.filter(|q| !q.trim().is_empty()),
            quote_amount.filter(|q| !q.trim().is_empty()),
        ) {
            (Some(quantity), None) => parse_quantity(quantity)?,
            (None, Some(amount)) => {
                let amount =
                    parse_quantity(amount).map_err(|_| desk_err!("Enter a positive USDT amount."))?;
                (amount / quote.price).round_dp_with_strategy(8, RoundingStrategy::ToZero)
            }
            _ => bail!("Give either a quantity in tokens or an amount in USDT, not both."),
        };
        if qty.is_zero() {
            bail!("That amount buys less than the smallest tradable unit of {}.", instrument.ticker);
        }
        let ticket = Ticket::new(&instrument.pair(), side, qty)?;
        let value = ticket.value(quote.price);
        if destination == Destination::Paper {
            // Catch what the ledger would reject, so the trader hears it before confirming.
            let account = self.book(feed)?.snapshot()?;
            let held =
                account.holdings.iter().find(|h| h.pair == ticket.pair).map_or(Decimal::ZERO, |h| h.qty);
            match side {
                Side::Buy if value > account.cash => {
                    bail!(
                        "This order costs about {} USDT but the paper account has {} USDT in cash.",
                        money(value),
                        money(account.cash)
                    )
                }
                Side::Sell if qty > held => {
                    bail!(
                        "The paper account holds {} {}, which is less than the {} you want to sell.",
                        decimal_text(held),
                        instrument.ticker,
                        decimal_text(qty)
                    )
                }
                _ => {}
            }
        }
        let view = TicketView {
            id: ticket.client_id.clone(),
            pair: ticket.pair.clone(),
            side,
            qty: decimal_text(qty),
            price: decimal_text(quote.price),
            value: crate::model::cents(value).to_string(),
            feed,
            destination,
            rationale: rationale.trim().chars().take(400).collect(),
        };
        let mut state = self.state();
        if state.feed != feed {
            bail!("The price feed changed while this ticket was being priced. Draft it again.");
        }
        state.draft = Some(Draft { feed, ticket, view: view.clone() });
        Ok(view)
    }

    /// Drafts a ticket from the manual order form.
    pub async fn prepare_ticket(&self, request: TicketRequest) -> Result<Snapshot> {
        self.draft_ticket(
            &request.pair,
            request.side,
            request.qty.as_deref(),
            request.quote_amount.as_deref(),
            request.destination,
            "",
        )
        .await?;
        Ok(self.snapshot())
    }

    pub fn dismiss_ticket(&self) -> Snapshot {
        self.state().draft = None;
        self.snapshot()
    }

    /// Carries out the drafted ticket: a paper fill, or a real market order.
    ///
    /// The draft is consumed before anything is sent, so a second click cannot
    /// send a second order. If a live order fails after it may have reached the
    /// venue, the error says how to check before trying again.
    pub async fn submit_ticket(&self, id: &str) -> Result<Snapshot> {
        let draft = {
            let mut state = self.state();
            match state.draft.take() {
                Some(draft) if draft.ticket.client_id == id && draft.feed == state.feed => draft,
                other => {
                    state.draft = other.filter(|d| d.ticket.client_id != id);
                    bail!("This ticket has expired. Draft a new one on the current feed.");
                }
            }
        };
        let started = Instant::now();
        let ticket = &draft.ticket;
        let instrument = resolve(&ticket.pair)?;
        let outcome: Result<String> = match (draft.view.destination, draft.feed) {
            (Destination::Exchange, Feed::Venue(venue)) => {
                self.venue(venue).market_order(ticket).await.map_or_else(
                    |error| {
                        Err(desk_err!(
                            "{} Check {} for client ID {} before sending it again.",
                            error.0,
                            venue.name(),
                            ticket.client_id
                        ))
                    },
                    |ack| {
                        Ok(format!(
                            "Sent to {}: {} {} {}, order {}, status {}.",
                            venue.name(),
                            ticket.side,
                            decimal_text(ticket.qty),
                            ticket.pair,
                            ack.id,
                            ack.status
                        ))
                    },
                )
            }
            (Destination::Exchange, Feed::Sample) => Err(DeskError::new("Live orders need a live feed.")),
            (Destination::Paper, feed) => match self.quote(&instrument).await {
                Ok(quote) => self.book(feed).and_then(|book| book.submit(ticket, &quote)).map(|fill| {
                    format!(
                        "Paper fill: {} {} {} at {} USDT.",
                        fill.side,
                        decimal_text(fill.qty),
                        fill.pair,
                        price_text(fill.price)
                    )
                }),
                Err(error) => Err(error),
            },
        };
        let step = StepView {
            name: if draft.view.destination == Destination::Paper {
                "paper.fill".to_string()
            } else {
                "exchange.market_order".to_string()
            },
            detail: format!("{} {} {}", ticket.side, decimal_text(ticket.qty), ticket.pair),
            status: if outcome.is_ok() { StepStatus::Ok } else { StepStatus::Error },
            ms: started.elapsed().as_millis() as u64,
            preview: String::new(),
        };
        let run = self.quick_run(
            "Execution",
            &format!("Confirm {} {} {}", ticket.side, decimal_text(ticket.qty), ticket.pair),
            draft.feed,
            started,
            vec![step],
            &outcome,
        );
        self.record(run, false);
        let text = outcome?;
        self.state().receipts.insert(ticket.client_id.clone(), text);
        Ok(self.snapshot())
    }

    /// Loads API keys for a venue after proving they work with a balance read.
    pub async fn set_credentials(&self, request: CredentialsRequest) -> Result<Snapshot> {
        self.require_idle("changing API keys")?;
        let venue = request.venue;
        let credentials = Credentials::new(
            venue,
            &request.key,
            &request.secret,
            request.passphrase.as_deref().unwrap_or(""),
        )?;
        let client = self.venue(venue);
        client.set_credentials(Some(credentials.clone()));
        if let Err(error) = client.balances().await {
            client.set_credentials(None);
            bail!("{} did not accept these keys: {}", venue.name(), error.0);
        }
        if request.remember {
            let stored = json!({"key": credentials.key, "secret": credentials.secret, "passphrase": credentials.passphrase});
            self.secrets.set(&venue_secret(venue), &stored.to_string())?;
        } else {
            self.secrets.delete(&venue_secret(venue))?;
        }
        {
            let mut state = self.state();
            state.prefs.remembered.retain(|v| *v != venue);
            if request.remember {
                state.prefs.remembered.push(venue);
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    pub fn clear_credentials(&self, venue: VenueId) -> Result<Snapshot> {
        self.require_idle("changing API keys")?;
        self.venue(venue).set_credentials(None);
        self.secrets.delete(&venue_secret(venue))?;
        {
            let mut state = self.state();
            state.prefs.remembered.retain(|v| *v != venue);
            // A live ticket for this venue can no longer be sent.
            if state
                .draft
                .as_ref()
                .is_some_and(|d| d.view.destination == Destination::Exchange && d.feed == Feed::Venue(venue))
            {
                state.draft = None;
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Real balances from a venue. They are returned to the caller and not kept or journaled.
    pub async fn balances(&self, venue: VenueId) -> Result<Vec<BalanceRow>> {
        let balances = self.venue(venue).balances().await?;
        Ok(balances
            .into_iter()
            .map(|b| BalanceRow { asset: b.asset, total: decimal_text(b.total) })
            .collect())
    }

    /// Attaches an MCP server to a venue, replacing any server already attached.
    pub async fn mcp_connect(&self, request: McpConnectRequest) -> Result<Snapshot> {
        self.require_idle("changing exchange tool servers")?;
        let venue = request.venue();
        let link = Arc::new(McpLink::connect(&request).await?);
        let view = McpView {
            name: link.name.clone(),
            version: link.version.clone(),
            transport: link.transport,
            tools: link.tools().len(),
        };
        let previous = self.links.write().await.insert(venue, link);
        if let Some(previous) = previous {
            previous.close().await;
        }
        self.state().servers.insert(venue, view);
        Ok(self.snapshot())
    }

    pub async fn mcp_disconnect(&self, venue: VenueId) -> Result<Snapshot> {
        self.require_idle("changing exchange tool servers")?;
        let link = self.links.write().await.remove(&venue);
        if let Some(link) = link {
            link.close().await;
        }
        self.state().servers.remove(&venue);
        Ok(self.snapshot())
    }

    async fn link(&self, venue: VenueId) -> Result<Arc<McpLink>> {
        match self.links.read().await.get(&venue) {
            Some(link) => Ok(Arc::clone(link)),
            None => bail!("No MCP server is attached to {}. Attach one in Connections.", venue.name()),
        }
    }

    pub async fn mcp_tools(&self, venue: VenueId) -> Result<Vec<ToolInfo>> {
        Ok(self.link(venue).await?.tools().to_vec())
    }

    /// Calls a tool on an attached server. `by_trader` is true for the tool
    /// inspector, where the trader chose and ran the tool; the assistant and
    /// typed `@venue` commands are limited to tools the server marks read-only.
    pub(crate) async fn exchange_tool(
        &self,
        venue: VenueId,
        name: &str,
        arguments: &Value,
        by_trader: bool,
    ) -> Result<Value> {
        let link = self.link(venue).await?;
        let Some(tool) = link.tool(name) else {
            bail!(
                "{name} is not a tool on the {} server. Open the tool inspector to see its catalog.",
                venue.name()
            );
        };
        if !by_trader && !tool.read_only {
            bail!(
                "The {} server does not mark {name} as read-only, so it can only be run from the tool inspector in Connections.",
                venue.name()
            );
        }
        link.call(name, arguments).await
    }

    /// Runs a tool from the inspector and returns its output as text.
    pub async fn mcp_call(&self, venue: VenueId, name: &str, arguments: Value) -> Result<String> {
        let started = Instant::now();
        let outcome = self.exchange_tool(venue, name, &arguments, true).await.map(|value| match value {
            Value::String(text) => text,
            other => serde_json::to_string_pretty(&other).unwrap_or_default(),
        });
        let outcome = outcome.map(|text| text.chars().take(32_000).collect::<String>());
        let step = StepView {
            name: format!("{}.{name}", venue.as_str()),
            detail: "tool inspector".to_string(),
            status: if outcome.is_ok() { StepStatus::Ok } else { StepStatus::Error },
            ms: started.elapsed().as_millis() as u64,
            preview: String::new(),
        };
        let run = self.quick_run(
            "Tool inspector",
            &format!("{} {name}", venue.name()),
            self.feed(),
            started,
            vec![step],
            &outcome,
        );
        // Tool output may hold account details, so it is not written to disk.
        self.record(run, true);
        outcome
    }

    /// The OpenRouter catalog. With no key given, the stored one is used if there is one.
    pub async fn list_models(&self, key: Option<String>) -> Result<Vec<ModelInfo>> {
        let key = key.filter(|k| !k.trim().is_empty()).or_else(|| self.state().openrouter_key.clone());
        let models = self.openrouter.models(key.as_deref()).await?;
        self.state().catalog = models.clone();
        Ok(models)
    }

    /// Saves the assistant settings. An OpenRouter model must exist in the catalog,
    /// because its capabilities decide what is sent to it.
    pub async fn save_assistant(&self, request: AssistantRequest) -> Result<Snapshot> {
        self.require_idle("changing the model")?;
        let model = request.model.trim().to_string();
        let mut new_key = None;
        let info = match request.provider {
            Provider::Builtin => None,
            Provider::Ollama => {
                self.ollama.verify(&model).await?;
                None
            }
            Provider::OpenRouter => {
                let supplied = request.key.as_deref().map(str::trim).filter(|k| !k.is_empty());
                let key = match supplied {
                    Some(key) => {
                        new_key = Some(valid_key(key)?);
                        new_key.clone()
                    }
                    None => self.state().openrouter_key.clone(),
                };
                if key.is_none() {
                    bail!("Paste an OpenRouter key first. You can create one at openrouter.ai/keys.");
                }
                if !valid_model_id(&model) {
                    bail!("Choose a model from the list before saving.");
                }
                let cached = self.state().catalog.iter().find(|m| m.id == model).cloned();
                let info = match cached {
                    Some(info) => info,
                    None => {
                        let models = self.list_models(key).await?;
                        match models.into_iter().find(|m| m.id == model) {
                            Some(info) => info,
                            None => bail!(
                                "{model} is not in the OpenRouter catalog. Choose a model from the list."
                            ),
                        }
                    }
                };
                Some(info)
            }
        };
        if let Some(key) = &new_key {
            self.secrets.set(OPENROUTER_SECRET, key)?;
        }
        {
            let mut state = self.state();
            if new_key.is_some() {
                state.openrouter_key = new_key;
            }
            state.prefs.provider = request.provider;
            state.prefs.model = if request.provider == Provider::Builtin { String::new() } else { model };
            state.prefs.model_info = info;
            state.prefs.effort = request.effort;
            state.prefs.live_tickets = request.live_tickets;
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Stops background work and closes attached servers. Call before exit.
    pub async fn close(&self) {
        self.stop_turn();
        self.stop_watch();
        let links: Vec<Arc<McpLink>> = self.links.write().await.drain().map(|(_, link)| link).collect();
        for link in links {
            link.close().await;
        }
    }
}

#[cfg(test)]
mod tests;
