//! The studio: the one object that owns the desk and offers every action the
//! user interface can take.
//!
//! State lives behind short-lived locks that are never held across a network
//! call, so the interface stays responsive while the assistant works. Actions
//! that would pull the desk out from under a running turn (switching network,
//! changing wallets or the model) are refused until the turn ends.
//!
//! Orders follow one path whoever asks for them: a ticket is drafted against
//! the live account, shown to the trader, and sent only when they confirm it.

mod grid;
mod tools;
mod turn;
pub mod view;

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, TimeZone, Utc};
use futures_util::future::join_all;
use rust_decimal::Decimal;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::assistant::tools::{estimate_liquidation, stop_inside_liquidation};
use crate::connect;
use crate::error::{DeskError, Result};
use crate::exchange::signing::{Address, AgentKey};
use crate::exchange::{ExchangeClient, Markets, OrderKind, OrderRequest, Placement, Wallet};
use crate::grid::{GridBot, GridStatus};
use crate::indicators::{MIN_BARS, analyze};
use crate::instruments::{DEFAULT_SYMBOL, default_watchlist};
use crate::llm::cloudflare::{self, Cloudflare};
use crate::llm::lmstudio::{self, LmStudio};
use crate::llm::ollama::{self, Ollama};
use crate::llm::openrouter::{OpenRouter, valid_key};
use crate::llm::{Connection, ModelInfo, chat::valid_model_id, local_client, local_url};
use crate::mcp::{McpConnectRequest, McpLink, ToolInfo};
use crate::model::{
    Account, Candle, Market, Network, OrderAck, Position, Quote, Side, Timeframe, cents, decimal_text, money,
    parse_quantity, price_text,
};
use crate::net::http_client;
use crate::store::{
    CLOUDFLARE_SECRET, Journal, LEVERAGE_LIMIT, ModelChoice, OPENROUTER_SECRET, Prefs, Provider, SecretStore,
    Theme, ThreadRow, WalletPref, agent_secret,
};
use crate::web::{Coins, Picture, Web};
use crate::{bail, desk_err};
use view::{
    AccountView, AssistantRequest, AssistantView, CandleSeries, CardView, FundingRequest, FundingView,
    InstrumentView, MarketRow, McpView, ModelsRequest, NewsFeedView, OrderBookView, PendingWalletView,
    ProviderView, QuoteView, RiskRequest, RiskView, RunStatus, RunView, Snapshot, StepStatus, StepView,
    TechnicalFrame, TechnicalsView, ThreadView, TicketRequest, TicketView, TradeView, WalletBrowserRequest,
    WalletKeyRequest, WalletNoticeView, WalletTask, WalletView,
};

/// Turns of the open conversation kept in memory and sent to the interface.
const TURNS_SHOWN: usize = 40;
/// Orders and cancellations kept for the activity page.
const ACTIVITY_SHOWN: usize = 60;
/// Conversations listed in the sidebar.
const THREADS_SHOWN: usize = 80;
/// Characters of the first message that make a conversation's title.
const TITLE_CHARS: usize = 60;
/// Levels a side sent to the order book panel.
const BOOK_LEVELS: usize = 20;
/// Levels a side kept on a card in an answer.
pub(crate) const CARD_LEVELS: usize = 8;
/// Trades sent to the tape.
const TAPE_TRADES: usize = 40;
/// Settled funding rates read for the funding panel: two weeks even where funding is hourly.
const FUNDING_POINTS: usize = 336;
const FUNDING_DAYS: i64 = 14;
/// Candles read for a technical reading: enough for EMA200 with room to settle.
pub(crate) const ANALYSIS_BARS: usize = 240;
/// Said whenever a chat is asked for with no model to answer it.
const NO_MODEL: &str = "Connect a model first.";
/// Said whenever the news is asked for while the trader keeps it off.
const NEWS_OFF: &str = "Web search is off. Turn it on in Settings, under Tools, to read the news.";
/// Daily history is re-read this often; in between, only prices are refreshed.
const HISTORY_TTL: Duration = Duration::from_secs(600);
/// Candles sent to the chart.
const CHART_CANDLES: usize = 300;
/// How long a launch waits for the exchange before showing the desk with an explanation.
const BOOT_TIMEOUT: Duration = Duration::from_secs(20);
const WATCHLIST_LIMIT: usize = 40;
const SERVER_LIMIT: usize = 8;
/// An account read this recently is reused for planning instead of read again.
const ACCOUNT_FRESH_SECS: i64 = 15;
/// After a failed read the last account stays on screen this long, then it is dropped as stale.
const ACCOUNT_KEEP_SECS: i64 = 120;
/// Leverage a ticket uses when none is asked for, capped by the trader's limit.
pub(crate) const DEFAULT_LEVERAGE: u32 = 3;
/// How often, and how far apart, the exchange is asked about an order whose answer was lost.
const LOOKUPS: usize = 3;
const LOOKUP_PAUSE: Duration = Duration::from_millis(500);

/// How far the mark price may move between drafting a ticket and confirming it: one percent.
/// Beyond that the ticket's figures no longer describe the order.
fn drift_limit() -> Decimal {
    Decimal::new(1, 2)
}
const PRIVATE_NOTE: &str = "Private tool result was shown for this session only.";
/// Links the assistant has been shown and may therefore read, newest last.
const SOURCES_KEPT: usize = 400;

/// Where the studio keeps its files and which servers it talks to.
pub struct StudioConfig {
    pub dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
    /// Alternative exchange origins per network. Used by tests and by `OCTONEO_*_URL`.
    pub exchange_bases: HashMap<Network, String>,
    /// Alternative origins for the cloud model providers. Used by tests.
    pub openrouter_base: Option<String>,
    pub cloudflare_base: Option<String>,
    /// Stand-in news feeds as `(publisher, address)`. Used by tests only: with
    /// stand-ins the rule that only public https pages are read is lifted, so
    /// that pages can be served from this computer.
    pub news_feeds: Option<Vec<(String, String)>>,
    /// With stand-in feeds: where the headlines filed under one ticker are asked for.
    pub news_by_ticker: Option<String>,
}

impl StudioConfig {
    pub fn new(dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            dir,
            secrets,
            exchange_bases: HashMap::new(),
            openrouter_base: None,
            cloudflare_base: None,
            news_feeds: None,
            news_by_ticker: None,
        }
    }
}

/// A model that is ready to answer, with the connection that reaches it.
pub(crate) struct Chosen {
    pub provider: Provider,
    pub model: ModelInfo,
    pub connection: Connection,
    /// Address of the server on this computer, for the providers that have one.
    pub url: String,
}

/// How large an order is, as the trader or the model gave it.
#[derive(Clone, Copy)]
pub(crate) enum Size<'a> {
    /// Base units, e.g. `0.015`.
    Qty(&'a str),
    /// Value in the quote asset, converted at the mark price.
    Notional(&'a str),
}

/// What a ticket is meant to do.
#[derive(Clone, Copy)]
pub(crate) enum Intent<'a> {
    /// Buy or sell a size. It reduces a position when it runs against one.
    Trade { side: Side, size: Size<'a>, reduce_only: bool },
    /// Open or add to a position. Refused when it would reduce one instead.
    Open { side: Side, size: Size<'a> },
    /// Shrink the position, whichever way it faces.
    Reduce { size: Size<'a> },
    /// Exit the whole position.
    Close,
}

/// Everything needed to draft a ticket.
pub(crate) struct TicketSpec<'a> {
    pub symbol: &'a str,
    pub intent: Intent<'a>,
    pub leverage: Option<u32>,
    pub stop_loss: Option<&'a str>,
    pub take_profit: Option<&'a str>,
    pub rationale: &'a str,
    /// The assistant drafted it, so an opening order must carry a stop-loss and
    /// mainnet needs the trader's standing permission.
    pub by_assistant: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DraftKind {
    /// No position yet: the margin mode and leverage are set first.
    Open,
    /// Adds to a position, keeping its leverage and margin mode.
    Add,
    /// Shrinks or closes a position.
    Reduce,
}

/// A ticket waiting for the trader's confirmation, with what is needed to carry it out.
struct Draft {
    network: Network,
    market: Market,
    side: Side,
    qty: Decimal,
    kind: DraftKind,
    /// Size of the position when the ticket was drafted; zero for a new one.
    held: Decimal,
    /// Mark price the ticket was priced at.
    price: Decimal,
    leverage: u32,
    isolated: bool,
    stop_loss: Option<Decimal>,
    take_profit: Option<Decimal>,
    /// The ticket exits the whole position, so reduce-only orders left on it are cancelled after.
    closes: bool,
    /// The assistant drafted it, under the permissions it had at the time.
    by_assistant: bool,
    view: TicketView,
}

/// A wallet page that is waiting for the trader's wallet.
struct PendingPage {
    network: Network,
    task: WalletTask,
    url: String,
    cancel: CancellationToken,
}

struct State {
    prefs: Prefs,
    network: Network,
    focus: String,
    feed_error: String,
    watchlist: Vec<InstrumentView>,
    quotes: HashMap<String, Quote>,
    /// When each symbol's daily history was last read.
    history_at: HashMap<String, Instant>,
    account: Option<Account>,
    account_error: String,
    /// Counts changes of network, wallet and risk limits. A ticket priced before
    /// such a change describes a desk that is gone, and is not kept.
    epoch: u64,
    /// Networks whose wallet the exchange will not serve until a first deposit.
    needs_deposit: HashSet<Network>,
    /// How the last wallet page ended, until the next one opens.
    wallet_notice: Option<WalletNoticeView>,
    pending: Option<PendingPage>,
    /// The open conversation.
    thread: String,
    /// Conversations, latest first.
    threads: Vec<ThreadView>,
    /// Turns of the open conversation, oldest first.
    turns: Vec<RunView>,
    /// What the app did on the exchange outside chat turns, newest first.
    activity: VecDeque<RunView>,
    draft: Option<Draft>,
    receipts: HashMap<String, String>,
    /// Why a confirmed ticket was not carried out, by ticket id.
    failures: HashMap<String, String>,
    servers: Vec<McpView>,
    /// Held in memory after one read so the keychain is not asked on every turn.
    openrouter_key: Option<String>,
    cloudflare_token: Option<String>,
    /// OpenRouter's catalog as last listed: it says what each model accepts.
    catalog: Vec<ModelInfo>,
    /// Links from this session's news searches. The assistant may read these pages, and no others.
    sources: VecDeque<String>,
    /// Perpetual futures grid bots persisted in the local journal.
    grids: Vec<GridBot>,
    /// A grid bot the assistant drafted, waiting for the trader to start it.
    grid_draft: Option<grid::GridDraft>,
}

fn instrument(market: &Market, custom: bool) -> InstrumentView {
    InstrumentView {
        symbol: market.symbol.clone(),
        base: market.base.clone(),
        quote: market.quote.clone(),
        custom,
    }
}

impl State {
    /// Fits the watchlist and the focus to what a network lists.
    fn arrange(&mut self, markets: &Markets) {
        let mut list: Vec<InstrumentView> = default_watchlist(markets)
            .iter()
            .filter_map(|symbol| markets.get(symbol))
            .map(|m| instrument(m, false))
            .collect();
        for symbol in &self.prefs.custom {
            if let Some(market) = markets.get(symbol)
                && !list.iter().any(|i| i.symbol == market.symbol)
            {
                list.push(instrument(market, true));
            }
        }
        self.watchlist = list;
        if markets.get(&self.focus).is_none() {
            let fallback = markets
                .get(DEFAULT_SYMBOL)
                .map(|m| m.symbol.clone())
                .or_else(|| self.watchlist.first().map(|i| i.symbol.clone()));
            self.focus = fallback.unwrap_or_else(|| DEFAULT_SYMBOL.to_string());
            self.prefs.focus = self.focus.clone();
        }
    }
}

type Notifier = Arc<dyn Fn(Snapshot) + Send + Sync>;

/// What the desk is doing that nothing else may interleave with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Work {
    Idle,
    /// The assistant is answering.
    Turn,
    /// Settings, a wallet, the network or the open conversation is being changed.
    Change,
}

/// A claim on the desk. Dropping it frees the desk, however the work ended.
struct Hold<'a>(&'a Mutex<Work>);

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Work::Idle;
    }
}

pub struct Studio {
    dir: PathBuf,
    clients: HashMap<Network, Arc<ExchangeClient>>,
    http: reqwest::Client,
    /// For servers on this computer: never proxied, never redirected.
    local_http: reqwest::Client,
    openrouter: OpenRouter,
    cloudflare: Cloudflare,
    ollama: Ollama,
    lmstudio: LmStudio,
    web: Web,
    secrets: Arc<dyn SecretStore>,
    journal: Journal,
    links: tokio::sync::RwLock<HashMap<String, Arc<McpLink>>>,
    state: Mutex<State>,
    work: Mutex<Work>,
    /// Held for the whole of any grid work that sends orders, so a background look at the exchange
    /// never interleaves with a start or a stop.
    grid_work: tokio::sync::Mutex<()>,
    cancel: Mutex<CancellationToken>,
    notifier: Mutex<Option<Notifier>>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn now_stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn facing(position: &Position) -> &'static str {
    if position.is_long() { "long" } else { "short" }
}

fn given(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|text| !text.is_empty())
}

/// A conversation's title: its first message on one line, shortened.
fn thread_title(first: &str) -> String {
    let line = first.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TITLE_CHARS {
        return line;
    }
    let short: String = line.chars().take(TITLE_CHARS - 1).collect();
    format!("{}…", short.trim_end())
}

fn thread_view(row: ThreadRow) -> Option<ThreadView> {
    Some(ThreadView {
        network: Network::parse(&row.network).ok()?,
        title: thread_title(&row.title),
        id: row.id,
        time: row.time,
        turns: row.turns,
    })
}

/// Conversation ids are made by [`new_id`]; anything else did not come from this app.
/// The `https` links in a message, without the punctuation that ends a sentence.
pub(crate) fn links_in(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '(' | '[' | '|'))
        .filter(|word| word.starts_with("https://"))
        .map(|word| word.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}', '\'']).to_string())
        .filter(|link| link.len() > "https://".len())
        .collect()
}

fn valid_thread(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The liquidation price a ticket shows. Only an isolated position has one that
/// can be estimated from the position alone.
fn liquidation_estimate(
    market: &Market,
    side: Side,
    entry: Decimal,
    leverage: u32,
    isolated: bool,
) -> Option<Decimal> {
    isolated
        .then(|| market.round_price(estimate_liquidation(side, entry, leverage, market.maint_margin)))
        .filter(|level| !level.is_zero())
}

/// The entry price a position has after `qty` is added to it at `price`.
fn blended_entry(held: Decimal, held_entry: Decimal, qty: Decimal, price: Decimal) -> Decimal {
    let value =
        held.checked_mul(held_entry).zip(qty.checked_mul(price)).and_then(|(old, new)| old.checked_add(new));
    value.and_then(|value| value.checked_div(held + qty)).unwrap_or(price)
}

/// Checks a stop-loss and a take-profit against the price the order would fill near,
/// and the stop against the estimated liquidation price.
fn check_guards(
    side: Side,
    price: Decimal,
    stop_loss: Option<Decimal>,
    take_profit: Option<Decimal>,
    liquidation: Option<Decimal>,
    leverage: u32,
) -> Result<()> {
    let long = side == Side::Buy;
    if let Some(stop) = stop_loss
        && (long && stop >= price || !long && stop <= price)
    {
        bail!(
            "The stop-loss of a {} must be {} the current price of {}.",
            side.direction(),
            if long { "below" } else { "above" },
            price_text(price)
        );
    }
    if let Some(target) = take_profit
        && (long && target <= price || !long && target >= price)
    {
        bail!(
            "The take-profit of a {} must be {} the current price of {}.",
            side.direction(),
            if long { "above" } else { "below" },
            price_text(price)
        );
    }
    if let (Some(stop), Some(liquidation)) = (stop_loss, liquidation)
        && !stop_inside_liquidation(side, stop, liquidation)
    {
        bail!(
            "At {leverage}x the estimated liquidation price ({}) comes before the stop-loss ({}), so the stop would not protect the position. Lower the leverage or move the stop closer.",
            price_text(liquidation),
            price_text(stop)
        );
    }
    Ok(())
}

/// Runs one network action of an execution and records it as a step.
async fn timed<T>(
    steps: &mut Vec<StepView>,
    name: &str,
    detail: &str,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    let started = Instant::now();
    let result = work.await;
    steps.push(StepView {
        name: name.to_string(),
        detail: detail.to_string(),
        status: if result.is_ok() { StepStatus::Ok } else { StepStatus::Error },
        ms: started.elapsed().as_millis() as u64,
        preview: result.as_ref().err().map(|error| error.0.clone()).unwrap_or_default(),
    });
    result
}

impl Studio {
    /// Opens the data folder and restores preferences and connected wallets.
    /// Nothing here touches the network.
    pub fn open(config: StudioConfig) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&config.dir)?;
        let http = http_client()?;
        let clients: HashMap<Network, Arc<ExchangeClient>> = Network::ALL
            .into_iter()
            .map(|network| {
                let client = ExchangeClient::new(network, http.clone());
                let client = match config.exchange_bases.get(&network) {
                    Some(base) => client.with_base(base),
                    None => client,
                };
                (network, Arc::new(client))
            })
            .collect();
        let mut openrouter = OpenRouter::new(http.clone());
        if let Some(base) = &config.openrouter_base {
            openrouter = openrouter.with_base(base);
        }
        let mut cloudflare = Cloudflare::new(http.clone());
        if let Some(base) = &config.cloudflare_base {
            cloudflare = cloudflare.with_base(base);
        }
        let local_http = local_client()?;
        let web = match config.news_feeds {
            Some(feeds) => Web::standing_in(feeds, config.news_by_ticker)?,
            None => Web::new()?,
        };

        let prefs_path = config.dir.join("preferences.json");
        let mut prefs = Prefs::load(&prefs_path);
        if let Some(legacy) = prefs.legacy_key.take() {
            // Move a key left in the old plain-text file into the secret store.
            if let Ok(key) = valid_key(&legacy) {
                config.secrets.set(OPENROUTER_SECRET, &key)?;
            }
            prefs.save(&prefs_path)?;
        }
        // Watchlist additions from before 0.4 named spot pairs such as `PEPE/USDT`; no market has that name.
        prefs.custom.retain(|symbol| !symbol.contains('/'));
        prefs.adopt_legacy_model();
        if !prefs.legacy_remembered.is_empty() {
            // API keys for the exchanges earlier releases traded on are no use here.
            // Remove them from the secret store rather than leave them behind.
            prefs.legacy_remembered.retain(|venue| {
                let known = matches!(venue.as_str(), "binance" | "bybit" | "okx");
                known && config.secrets.delete(&format!("venue-{venue}")).is_err()
            });
            prefs.save(&prefs_path)?;
        }
        for network in Network::ALL {
            let Some(remembered) = prefs.wallets.get(network.as_str()).cloned() else {
                continue;
            };
            let stored = config.secrets.get(&agent_secret(network)).ok().flatten();
            let wallet = stored.and_then(|secret| AgentKey::parse(&secret).ok()).and_then(|agent| {
                let user = Address::parse(&remembered.user).ok()?;
                // The stored key must be the one the preferences describe.
                let same = Address::parse(&remembered.agent).is_ok_and(|address| address == agent.address());
                let expires = remembered.expires_ms.and_then(|ms| Utc.timestamp_millis_opt(ms).single());
                same.then_some(Wallet { user, agent, expires })
            });
            match wallet {
                Some(wallet) => clients[&network].set_wallet(Some(wallet)),
                None => {
                    prefs.wallets.remove(network.as_str());
                }
            }
        }

        let journal = Journal::open(&config.dir.join("journal.sqlite3"))?;
        // A launch starts a new conversation; earlier ones wait in the sidebar.
        let threads: Vec<ThreadView> =
            journal.threads(THREADS_SHOWN)?.into_iter().filter_map(thread_view).collect();
        let mut activity: VecDeque<RunView> = journal.thread::<RunView>("", ACTIVITY_SHOWN)?.into();
        activity.make_contiguous().reverse();
        let grids: Vec<GridBot> = journal.load_grids()?;
        // Real prices by default. Nothing can be traded until a wallet is connected.
        let network = Network::parse(&prefs.network).unwrap_or(Network::Mainnet);
        let focus =
            if prefs.focus.trim().is_empty() { DEFAULT_SYMBOL.to_string() } else { prefs.focus.clone() };
        let openrouter_key =
            config.secrets.get(OPENROUTER_SECRET).ok().flatten().and_then(|k| valid_key(&k).ok());
        let cloudflare_token = config
            .secrets
            .get(CLOUDFLARE_SECRET)
            .ok()
            .flatten()
            .and_then(|token| cloudflare::valid_token(&token).ok());

        Ok(Arc::new(Self {
            dir: config.dir,
            clients,
            http,
            ollama: Ollama::new(local_http.clone()),
            lmstudio: LmStudio::new(local_http.clone()),
            local_http,
            web,
            openrouter,
            cloudflare,
            secrets: config.secrets,
            journal,
            links: tokio::sync::RwLock::new(HashMap::new()),
            state: Mutex::new(State {
                prefs,
                network,
                focus,
                feed_error: String::new(),
                watchlist: Vec::new(),
                quotes: HashMap::new(),
                history_at: HashMap::new(),
                account: None,
                account_error: String::new(),
                epoch: 0,
                needs_deposit: HashSet::new(),
                wallet_notice: None,
                pending: None,
                thread: new_id(),
                threads,
                turns: Vec::new(),
                activity,
                draft: None,
                receipts: HashMap::new(),
                failures: HashMap::new(),
                servers: Vec::new(),
                openrouter_key,
                cloudflare_token,
                catalog: Vec::new(),
                sources: VecDeque::new(),
                grids,
                grid_draft: None,
            }),
            work: Mutex::new(Work::Idle),
            grid_work: tokio::sync::Mutex::new(()),
            cancel: Mutex::new(CancellationToken::new()),
            notifier: Mutex::new(None),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn client(&self, network: Network) -> &Arc<ExchangeClient> {
        &self.clients[&network]
    }

    pub(crate) fn network(&self) -> Network {
        self.state().network
    }

    fn save_prefs(&self) -> Result<()> {
        let prefs = self.state().prefs.clone();
        prefs.save(&self.dir.join("preferences.json"))
    }

    /// Claims the desk for a change that must not interleave with a turn or
    /// with another change: switching network, changing wallets, the model or
    /// the conversation. Some of these wait on the network for a long time
    /// (a local model being loaded), so a check at the start is not enough:
    /// the claim is held until the returned hold is dropped.
    fn begin_change(&self, action: &str) -> Result<Hold<'_>> {
        let mut work = self.work.lock().unwrap_or_else(|p| p.into_inner());
        match *work {
            Work::Idle => {
                *work = Work::Change;
                Ok(Hold(&self.work))
            }
            Work::Turn => bail!("Stop the assistant or wait for it to finish before {action}."),
            Work::Change => bail!("Wait for the change in progress to finish before {action}."),
        }
    }

    /// Claims the desk for a chat turn.
    fn begin_turn(&self) -> Result<Hold<'_>> {
        let mut work = self.work.lock().unwrap_or_else(|p| p.into_inner());
        match *work {
            Work::Idle => {
                *work = Work::Turn;
                Ok(Hold(&self.work))
            }
            Work::Turn => bail!("The assistant is still working. Stop it or wait for it to finish."),
            Work::Change => bail!("A change is still being applied. Send your message again in a moment."),
        }
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

    /// What a chosen model is called on screen: its catalog name, else its id.
    fn model_label(choice: &ModelChoice) -> String {
        choice
            .info
            .as_ref()
            .map(|info| info.name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| choice.id.clone())
    }

    /// What the interface is told about the model providers. Never a secret.
    fn assistant_view(state: &State) -> AssistantView {
        let prefs = &state.prefs;
        let has_key = |provider: Provider| match provider {
            Provider::OpenRouter => state.openrouter_key.is_some(),
            Provider::Cloudflare => state.cloudflare_token.is_some(),
            _ => false,
        };
        let providers = Provider::CONNECTABLE
            .into_iter()
            .map(|provider| {
                let cloudflare = provider == Provider::Cloudflare;
                let url = match provider {
                    Provider::Ollama => local_url(&prefs.ollama_url, ollama::DEFAULT_URL),
                    Provider::LmStudio => local_url(&prefs.lmstudio_url, lmstudio::DEFAULT_URL),
                    _ => Ok(String::new()),
                };
                ProviderView {
                    id: provider,
                    name: provider.name(),
                    local: provider.local(),
                    has_key: has_key(provider),
                    model: prefs.choice(provider).map(|choice| choice.id.clone()).unwrap_or_default(),
                    label: prefs.choice(provider).map(Self::model_label).unwrap_or_default(),
                    account: if cloudflare { prefs.cloudflare_account.clone() } else { String::new() },
                    gateway: match (cloudflare, prefs.cloudflare_gateway.is_empty()) {
                        (false, _) => String::new(),
                        (true, true) => cloudflare::DEFAULT_GATEWAY.to_string(),
                        (true, false) => prefs.cloudflare_gateway.clone(),
                    },
                    url: url.unwrap_or_default(),
                }
            })
            .collect();
        let choice = prefs.choice(prefs.provider);
        let info = choice.and_then(|choice| choice.info.as_ref());
        let ready = choice.is_some()
            && match prefs.provider {
                Provider::None => false,
                Provider::OpenRouter => has_key(Provider::OpenRouter),
                Provider::Cloudflare => has_key(Provider::Cloudflare) && !prefs.cloudflare_account.is_empty(),
                Provider::Ollama | Provider::LmStudio => true,
            };
        AssistantView {
            provider: prefs.provider,
            model: choice.map(|choice| choice.id.clone()).unwrap_or_default(),
            label: choice.map(Self::model_label).unwrap_or_default(),
            ready,
            reasoning: prefs.provider == Provider::OpenRouter && info.is_some_and(|info| info.reasoning),
            effort: prefs.effort,
            live_tickets: prefs.live_tickets,
            web_search: prefs.web_search,
            providers,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = self.state();
        let wallets: Vec<WalletView> = Network::ALL
            .into_iter()
            .map(|network| {
                let wallet = self.client(network).wallet();
                WalletView {
                    network,
                    connected: wallet.is_some(),
                    user: wallet.as_ref().map(|w| w.user.to_string()),
                    agent: wallet.as_ref().map(|w| w.agent.address().to_string()),
                    expires: wallet
                        .as_ref()
                        .and_then(|w| w.expires)
                        .map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true)),
                    needs_deposit: wallet.is_some() && state.needs_deposit.contains(&network),
                }
            })
            .collect();
        let connected = wallets.iter().any(|w| w.network == state.network && w.connected);
        Snapshot {
            version: env!("CARGO_PKG_VERSION"),
            network: state.network,
            focus: state.focus.clone(),
            feed_error: state.feed_error.clone(),
            instruments: state.watchlist.clone(),
            quotes: state
                .quotes
                .iter()
                .map(|(symbol, quote)| (symbol.clone(), QuoteView::from(quote)))
                .collect(),
            wallets,
            account: state.account.as_ref().filter(|_| connected).map(AccountView::from),
            account_error: if connected { state.account_error.clone() } else { String::new() },
            wallet_notice: state.wallet_notice.clone(),
            assistant: Self::assistant_view(&state),
            risk: RiskView { max_leverage: state.prefs.max_leverage, isolated: state.prefs.isolated },
            theme: state.prefs.theme,
            thread: state.thread.clone(),
            threads: state.threads.clone(),
            turns: state.turns.clone(),
            activity: state.activity.iter().cloned().collect(),
            draft: state.draft.as_ref().map(|d| d.view.clone()),
            receipts: state.receipts.clone(),
            failures: state.failures.clone(),
            servers: state.servers.clone(),
            pending_wallet: state.pending.as_ref().map(|p| PendingWalletView {
                network: p.network,
                task: p.task,
                url: p.url.clone(),
            }),
            busy: *self.work.lock().unwrap_or_else(|p| p.into_inner()) == Work::Turn,
            grids: self.grid_views(&state),
            grid_draft: state.grid_draft.as_ref().map(|draft| draft.view.clone()),
        }
    }

    /// The markets of a network, with the watchlist fitted to them while it is the active one.
    async fn markets(&self, network: Network) -> Result<Arc<Markets>> {
        let markets = self.client(network).markets().await?;
        let mut state = self.state();
        if state.network == network {
            state.arrange(&markets);
        }
        Ok(markets)
    }

    /// Refreshes every watchlist quote in two calls, and re-reads daily history where it has gone stale.
    pub(crate) async fn load_quotes(&self, network: Network) -> Result<()> {
        let client = self.client(network);
        let markets = self.markets(network).await?;
        let (wanted, stale) = {
            let state = self.state();
            if state.network != network {
                return Ok(());
            }
            let mut wanted: Vec<String> = state.watchlist.iter().map(|i| i.symbol.clone()).collect();
            if !wanted.contains(&state.focus) && markets.get(&state.focus).is_some() {
                wanted.push(state.focus.clone());
            }
            let fresh =
                |symbol: &String| state.history_at.get(symbol).is_some_and(|at| at.elapsed() < HISTORY_TTL);
            let stale: Vec<String> = wanted.iter().filter(|symbol| !fresh(symbol)).cloned().collect();
            (wanted, stale)
        };
        let history = join_all(stale.iter().map(|symbol| client.candles(symbol, Timeframe::D1, 91)));
        let (ticks, premiums, history) = tokio::join!(client.tickers(), client.premiums(), history);
        let ticks = ticks?;
        // Funding and the mark price are worth having, but a price without them is still a price.
        let premiums = premiums.unwrap_or_default();
        let mut history: HashMap<&str, Vec<Candle>> = stale
            .iter()
            .map(String::as_str)
            .zip(history)
            .filter_map(|(symbol, candles)| candles.ok().map(|c| (symbol, c)))
            .collect();

        let mut state = self.state();
        if state.network != network {
            return Ok(());
        }
        for symbol in &wanted {
            let Some(tick) = ticks.get(symbol) else {
                state.quotes.remove(symbol);
                continue;
            };
            let premium = premiums.get(symbol).cloned();
            let quote = match history.remove(symbol.as_str()) {
                Some(daily) => {
                    state.history_at.insert(symbol.clone(), Instant::now());
                    client.assemble(symbol, tick.clone(), premium, &daily)
                }
                None => {
                    let closes =
                        state.quotes.get(symbol).map(|quote| quote.closes.clone()).unwrap_or_default();
                    Quote { closes, ..client.assemble(symbol, tick.clone(), premium, &[]) }
                }
            };
            state.quotes.insert(symbol.clone(), quote);
        }
        state.quotes.retain(|symbol, _| wanted.contains(symbol));
        state.feed_error = if state.quotes.contains_key(&state.focus) {
            String::new()
        } else {
            format!("There is no price for {} right now.", state.focus)
        };
        Ok(())
    }

    /// A fresh quote for one market on the active network.
    pub(crate) async fn quote(&self, symbol: &str) -> Result<Quote> {
        let network = self.network();
        let client = self.client(network);
        let known = {
            let state = self.state();
            let recent = state.history_at.get(symbol).is_some_and(|at| at.elapsed() < HISTORY_TTL);
            state.quotes.get(symbol).filter(|_| recent).map(|quote| quote.closes.clone())
        };
        let (quote, full) = match known {
            Some(closes) => {
                let (tick, premium) = tokio::try_join!(client.ticker(symbol), client.premium(symbol))?;
                (Quote { closes, ..client.assemble(symbol, tick, Some(premium), &[]) }, false)
            }
            None => (client.quote(symbol).await?, true),
        };
        let mut state = self.state();
        if state.network == network {
            if full {
                state.history_at.insert(symbol.to_string(), Instant::now());
            }
            state.quotes.insert(symbol.to_string(), quote.clone());
        }
        Ok(quote)
    }

    /// Reads the account of a network's wallet from the exchange and keeps it for display.
    /// A wallet that has not deposited yet is a state to show, not an error to report.
    pub(crate) async fn fetch_account(&self, network: Network) -> Result<Account> {
        let client = self.client(network);
        if client.wallet().is_none() {
            let mut state = self.state();
            if state.network == network {
                state.account = None;
                state.account_error.clear();
            }
            bail!("No wallet is connected on {}. Connect one in Settings.", network.name());
        }
        let outcome = client.account().await;
        let mut state = self.state();
        match outcome {
            Ok(account) => {
                state.needs_deposit.remove(&network);
                if state.network == network {
                    state.account = Some(account.clone());
                    state.account_error.clear();
                }
                Ok(account)
            }
            Err(error) => {
                let deposit = client.is_deposit_notice(&error);
                if deposit {
                    state.needs_deposit.insert(network);
                }
                if state.network == network {
                    let young = state
                        .account
                        .as_ref()
                        .is_some_and(|a| (Utc::now() - a.as_of).num_seconds() < ACCOUNT_KEEP_SECS);
                    if deposit || !young {
                        state.account = None;
                    }
                    state.account_error = if deposit { String::new() } else { error.0.clone() };
                }
                Err(error)
            }
        }
    }

    /// The account, read again unless it was read moments ago.
    pub(crate) async fn account(&self, network: Network) -> Result<Account> {
        let recent = {
            let state = self.state();
            let fresh = |account: &&Account| (Utc::now() - account.as_of).num_seconds() < ACCOUNT_FRESH_SECS;
            state.account.as_ref().filter(|_| state.network == network).filter(fresh).cloned()
        };
        match recent {
            Some(account) if self.client(network).wallet().is_some() => Ok(account),
            _ => self.fetch_account(network).await,
        }
    }

    /// Loads markets, quotes and the account of a network. Problems are kept for the interface to show in place.
    async fn load(&self, network: Network) {
        let (quotes, _) = tokio::join!(self.load_quotes(network), self.fetch_account(network));
        if let Err(error) = quotes {
            let mut state = self.state();
            if state.network == network {
                state.feed_error = error.0;
            }
        }
    }

    /// Brings the desk up on the network used last time. A network problem does
    /// not fail the launch: the desk opens and says what it could not reach.
    pub async fn boot(&self) -> Result<Snapshot> {
        let network = self.network();
        if tokio::time::timeout(BOOT_TIMEOUT, self.load(network)).await.is_err() {
            self.state().feed_error =
                "The exchange did not answer in time. Check your connection; the desk keeps trying."
                    .to_string();
        }
        Ok(self.snapshot())
    }

    /// Switches between mainnet and testnet. Market data, the wallet and the
    /// account all follow. The switch only happens if the network answers.
    pub async fn set_network(&self, network: Network) -> Result<Snapshot> {
        let _hold = self.begin_change("switching network")?;
        let markets = self.client(network).markets().await?;
        {
            let mut state = self.state();
            state.epoch += 1;
            state.network = network;
            state.quotes.clear();
            state.history_at.clear();
            state.account = None;
            state.account_error.clear();
            state.feed_error.clear();
            state.draft = None;
            state.grid_draft = None;
            state.prefs.network = network.as_str().to_string();
            state.arrange(&markets);
        }
        self.save_prefs()?;
        self.load(network).await;
        Ok(self.snapshot())
    }

    /// Focuses a market and refreshes its quote. A quote failure is reported in
    /// the snapshot (`feedError`) rather than as an error, so the panel can show it in place.
    pub async fn select_symbol(&self, raw: &str) -> Result<Snapshot> {
        let market = self.client(self.network()).market(raw).await?;
        self.focus(&market.symbol);
        if let Err(error) = self.quote(&market.symbol).await {
            let mut state = self.state();
            state.quotes.remove(&market.symbol);
            state.feed_error = error.0;
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Shows a market in the panel and remembers it for the next launch.
    pub(crate) fn focus(&self, symbol: &str) {
        let mut state = self.state();
        state.focus = symbol.to_string();
        state.prefs.focus = symbol.to_string();
        state.feed_error.clear();
    }

    /// Refreshes watchlist quotes. A failure keeps the last quotes and is reported in the snapshot.
    pub async fn refresh_quotes(&self) -> Result<Snapshot> {
        let network = self.network();
        if let Err(error) = self.load_quotes(network).await {
            let mut state = self.state();
            if state.network == network {
                state.feed_error = error.0;
            }
        }
        Ok(self.snapshot())
    }

    /// Re-reads balances, positions and open orders. A failure is reported in the snapshot.
    /// When active grid bots exist on the active network, also syncs their rungs.
    pub async fn refresh_account(&self) -> Result<Snapshot> {
        let network = self.network();
        let has_active_grids = {
            let state = self.state();
            state.grids.iter().any(|g| {
                g.network == network && matches!(g.status, GridStatus::Waiting | GridStatus::Running)
            })
        };
        if has_active_grids {
            let _ = self.sync_grids().await;
            return Ok(self.snapshot());
        }
        let _ = self.fetch_account(network).await;
        Ok(self.snapshot())
    }

    /// Candles for the chart.
    pub async fn candles(&self, raw: &str, timeframe: &str) -> Result<CandleSeries> {
        let network = self.network();
        let client = self.client(network);
        let market = client.market(raw).await?;
        let timeframe = Timeframe::parse(timeframe)?;
        let candles = client.candles(&market.symbol, timeframe, CHART_CANDLES).await?;
        Ok(CandleSeries::new(&market.symbol, timeframe.as_str(), network.source(), &candles))
    }

    /// Every market on the active network with its price, in the exchange's order: two
    /// calls, however many markets there are.
    pub async fn market_overview(&self) -> Result<Vec<MarketRow>> {
        let network = self.network();
        let client = self.client(network);
        let (markets, ticks, premiums) =
            tokio::join!(self.markets(network), client.tickers(), client.premiums());
        let (markets, ticks) = (markets?, ticks?);
        // Funding and the mark price are worth having, but a price without them is still a price.
        let premiums = premiums.unwrap_or_default();
        Ok(markets
            .all()
            .iter()
            .filter_map(|market| {
                Some(MarketRow::new(market, ticks.get(&market.symbol)?, premiums.get(&market.symbol)))
            })
            .collect())
    }

    /// The top of a market's order book.
    pub async fn order_book(&self, raw: &str) -> Result<OrderBookView> {
        let client = self.client(self.network());
        let market = client.market(raw).await?;
        let book = client.depth(&market.symbol, BOOK_LEVELS).await?;
        OrderBookView::new(&market.symbol, &book, BOOK_LEVELS)
    }

    /// The latest trades in a market, newest first.
    pub async fn recent_trades(&self, raw: &str) -> Result<Vec<TradeView>> {
        let client = self.client(self.network());
        let market = client.market(raw).await?;
        let trades = client.trades(&market.symbol, TAPE_TRADES).await?;
        Ok(trades.iter().map(TradeView::from).collect())
    }

    /// Funding now and over the last two weeks, with open interest. Only the
    /// current rate is required; the rest is shown when the exchange provides it.
    pub async fn market_funding(&self, raw: &str) -> Result<FundingView> {
        let client = self.client(self.network());
        let market = client.market(raw).await?;
        let symbol = market.symbol.as_str();
        let (premium, hours, history, open_interest) = tokio::join!(
            client.premium(symbol),
            client.funding_interval(symbol),
            client.funding_history(symbol, FUNDING_POINTS),
            client.open_interest(symbol)
        );
        let premium = premium?;
        let since = Utc::now() - chrono::Duration::days(FUNDING_DAYS);
        let mut history = history.unwrap_or_default();
        history.retain(|(time, _)| *time >= since);
        Ok(FundingView::new(symbol, &premium, hours.ok().flatten(), &history, open_interest.ok()))
    }

    /// A technical reading of one market on every timeframe, shortest first.
    pub async fn market_technicals(&self, raw: &str) -> Result<TechnicalsView> {
        let network = self.network();
        let client = self.client(network);
        let market = client.market(raw).await?;
        let symbol = market.symbol.as_str();
        let series =
            join_all(Timeframe::ALL.map(|timeframe| client.candles(symbol, timeframe, ANALYSIS_BARS)));
        let (mut price, mut frames, mut failure) = (None, Vec::new(), None);
        for (timeframe, candles) in Timeframe::ALL.into_iter().zip(series.await) {
            match candles {
                Ok(candles) => {
                    let Some(last) = candles.last() else {
                        continue;
                    };
                    // The newest candle is still forming, so its close is the latest trade.
                    price.get_or_insert(last.c);
                    if candles.len() >= MIN_BARS {
                        let reading = analyze(symbol, timeframe, &candles, last.c, network.source());
                        frames.push(TechnicalFrame::from(&reading));
                    }
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        match (price, failure) {
            (Some(price), _) if !frames.is_empty() => Ok(TechnicalsView {
                symbol: symbol.to_string(),
                price: decimal_text(price),
                frames,
                as_of: now_stamp(),
            }),
            (_, Some(error)) => Err(error),
            _ => bail!("{symbol} has too little price history for a technical reading."),
        }
    }

    /// Adds a market the exchange lists to the watchlist.
    pub async fn watch_add(&self, raw: &str) -> Result<Snapshot> {
        let market = self.client(self.network()).market(raw).await?;
        {
            let mut state = self.state();
            if !state.watchlist.iter().any(|i| i.symbol == market.symbol) {
                if state.watchlist.len() >= WATCHLIST_LIMIT {
                    bail!("The watchlist holds up to {WATCHLIST_LIMIT} markets. Remove one first.");
                }
                state.watchlist.push(instrument(&market, true));
                state.prefs.custom.retain(|symbol| *symbol != market.symbol);
                state.prefs.custom.push(market.symbol.clone());
            }
        }
        self.select_symbol(&market.symbol).await
    }

    /// Removes a market the trader added. The default markets stay, and so does the focus.
    pub fn watch_remove(&self, symbol: &str) -> Result<Snapshot> {
        {
            let mut state = self.state();
            let Some(position) = state.watchlist.iter().position(|i| i.symbol == symbol && i.custom) else {
                bail!("Only markets you added can be removed from the watchlist.");
            };
            state.watchlist.remove(position);
            state.prefs.custom.retain(|s| s != symbol);
            // The panel may be showing this very market: taking it off the list must not change
            // what is on screen, so its quote stays until another market is looked at.
            if state.focus != symbol {
                state.quotes.remove(symbol);
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Starts a new conversation. Earlier ones stay in the sidebar.
    pub fn new_thread(&self) -> Result<Snapshot> {
        let _hold = self.begin_change("starting a new chat")?;
        {
            let mut state = self.state();
            state.thread = new_id();
            state.turns.clear();
        }
        Ok(self.snapshot())
    }

    /// Opens an earlier conversation.
    pub fn open_thread(&self, id: &str) -> Result<Snapshot> {
        let _hold = self.begin_change("opening another chat")?;
        let id = id.trim();
        let turns: Vec<RunView> =
            if valid_thread(id) { self.journal.thread(id, TURNS_SHOWN)? } else { Vec::new() };
        let mut state = self.state();
        if turns.is_empty() {
            state.threads.retain(|thread| thread.id != id);
            bail!("That chat is no longer saved.");
        }
        state.thread = id.to_string();
        state.turns = turns;
        drop(state);
        Ok(self.snapshot())
    }

    /// Deletes a conversation and its turns from this computer.
    pub fn delete_thread(&self, id: &str) -> Result<Snapshot> {
        let _hold = self.begin_change("deleting a chat")?;
        let id = id.trim();
        if valid_thread(id) {
            self.journal.delete_thread(id)?;
        }
        {
            let mut state = self.state();
            state.threads.retain(|thread| thread.id != id);
            if state.thread == id {
                state.thread = new_id();
                state.turns.clear();
            }
        }
        Ok(self.snapshot())
    }

    pub fn set_theme(&self, theme: Theme) -> Result<Snapshot> {
        self.state().prefs.theme = theme;
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Lets the assistant search the news and read web pages, or stops it.
    /// A turn already running keeps the tools it started with.
    pub fn set_web_search(&self, on: bool) -> Result<Snapshot> {
        self.state().prefs.web_search = on;
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Reads the news feeds and returns what they hold about `query`. A share,
    /// a fund or a commodity this network lists is also looked up by its
    /// ticker, where the financial news files what is written about it.
    pub(crate) async fn news(&self, query: &str) -> Result<Vec<crate::web::Article>> {
        let tickers = match self.client(self.network()).markets().await {
            Ok(markets) => crate::web::tickers_in(query, |word| {
                let symbol = markets.news_symbol(word)?;
                Some((symbol.to_string(), markets.news_names(symbol)))
            }),
            // Without the list of markets there is no telling a ticker from a word. The news is still read.
            Err(_) => Vec::new(),
        };
        self.web.search(query, &tickers).await
    }

    pub(crate) async fn page(&self, url: &str) -> Result<crate::web::Page> {
        self.web.read(url).await
    }

    /// Nothing is read from publishers while the trader keeps web search off.
    fn news_on(&self) -> Result<()> {
        if !self.state().prefs.web_search {
            bail!("{NEWS_OFF}");
        }
        Ok(())
    }

    /// The News page: the newest stories from every publisher, each with the
    /// markets on the active network it is about.
    pub async fn news_feed(&self) -> Result<NewsFeedView> {
        self.news_on()?;
        let client = self.client(self.network());
        // The market list is usually held already; when it is not, it is read while the feeds are.
        let (markets, front) = tokio::join!(client.markets(), self.web.front());
        let front = front?;
        // Without the list of markets no story can be tied to one, and the news is still worth reading.
        let coins = markets
            .map(|markets| {
                Coins::new(markets.one_per_asset().into_iter().map(|m| (m.symbol.as_str(), m.base.as_str())))
            })
            .unwrap_or_default();
        Ok(NewsFeedView::new(front, &coins))
    }

    /// The picture of a story on the News page, for the interface, which has no
    /// network access of its own. Only a picture the page was given in this
    /// session is fetched, and only while web search is on.
    pub async fn news_picture(&self, address: &str) -> Result<Picture> {
        self.news_on()?;
        self.web.picture(address).await
    }

    /// Notes links the assistant was shown, so that it may read them.
    pub(crate) fn remember_sources(&self, links: impl IntoIterator<Item = String>) {
        let mut state = self.state();
        for link in links {
            if !state.sources.contains(&link) {
                state.sources.push_back(link);
            }
        }
        let extra = state.sources.len().saturating_sub(SOURCES_KEPT);
        state.sources.drain(..extra);
    }

    /// The link the assistant may read when it asks for `asked`: a search
    /// result of this session or of the open conversation, or a link the
    /// trader typed. The assistant cannot read an address it made up, which
    /// is what keeps a page from talking it into sending something away
    /// inside a link. A link tidied by the model (no query, no trailing
    /// slash) still finds its page, and the link as it was given is the one read.
    pub(crate) fn known_source(&self, asked: &str, typed: &[String]) -> Option<String> {
        let asked = asked.trim().trim_end_matches(['.', ',', ')', ']', '>', '"', '\'']);
        let state = self.state();
        let shown = state.turns.iter().flat_map(|run| &run.cards).filter_map(|card| match card {
            CardView::News { articles, .. } => Some(articles),
            _ => None,
        });
        let earlier: Vec<String> = state.turns.iter().flat_map(|run| links_in(&run.title)).collect();
        let mut known: Vec<&str> = state
            .sources
            .iter()
            .map(String::as_str)
            .chain(shown.flatten().map(|article| article.url.as_str()))
            .chain(earlier.iter().map(String::as_str))
            .chain(typed.iter().map(String::as_str))
            .collect();
        known.sort_unstable();
        known.dedup();
        if let Some(exact) = known.iter().find(|link| **link == asked) {
            return Some((*exact).to_string());
        }
        let page = |link: &str| {
            let url = url::Url::parse(link).ok()?;
            let host = url.host_str()?.trim_start_matches("www.").to_ascii_lowercase();
            Some((host, url.path().trim_end_matches('/').to_string()))
        };
        let wanted = page(asked)?;
        let mut same = known.iter().filter(|link| page(link).as_ref() == Some(&wanted));
        match (same.next(), same.next()) {
            (Some(only), None) => Some((*only).to_string()),
            // Two known links to one path differ in their query: which one was meant cannot be told.
            _ => None,
        }
    }

    /// Sets the limits every ticket is held to, whoever drafts it.
    pub fn save_risk(&self, request: RiskRequest) -> Result<Snapshot> {
        let _hold = self.begin_change("changing the risk limits")?;
        if !(1..=LEVERAGE_LIMIT).contains(&request.max_leverage) {
            bail!("Choose a leverage limit between 1x and {LEVERAGE_LIMIT}x.");
        }
        {
            let mut state = self.state();
            let mode_changed = state.prefs.isolated != request.isolated;
            state.epoch += 1;
            state.prefs.max_leverage = request.max_leverage;
            state.prefs.isolated = request.isolated;
            // A ticket drafted under the old limits no longer says what it would do.
            state.draft = None;
            // A grid bot draft still does, unless its leverage is now above the limit or its margin mode changed.
            let epoch = state.epoch;
            let fits = |draft: &grid::GridDraft| {
                draft.view.request.leverage <= request.max_leverage && !mode_changed
            };
            match state.grid_draft.take().filter(fits) {
                Some(mut draft) => {
                    draft.epoch = epoch;
                    state.grid_draft = Some(draft);
                }
                None => state.grid_draft = None,
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Asks a running turn to stop. Safe to call at any time.
    pub fn stop_turn(&self) {
        self.cancel.lock().unwrap_or_else(|p| p.into_inner()).cancel();
    }

    /// Adds a finished run to the journal, and to the conversation or the
    /// activity list it belongs to. Private output stays in memory only.
    fn record(&self, run: RunView, private: bool) {
        let stored =
            if private { RunView { output: PRIVATE_NOTE.to_string(), ..run.clone() } } else { run.clone() };
        // A journal failure must not undo the work the run describes.
        let _ = self.journal.append(&stored);
        let mut state = self.state();
        if run.thread.is_empty() {
            state.activity.push_front(run);
            state.activity.truncate(ACTIVITY_SHOWN);
            return;
        }
        match state.threads.iter().position(|thread| thread.id == run.thread) {
            Some(index) => {
                let mut thread = state.threads.remove(index);
                thread.time = run.time.clone();
                thread.turns += 1;
                state.threads.insert(0, thread);
            }
            None => {
                let thread = ThreadView {
                    id: run.thread.clone(),
                    title: thread_title(&run.title),
                    time: run.time.clone(),
                    network: run.network,
                    turns: 1,
                };
                state.threads.insert(0, thread);
                state.threads.truncate(THREADS_SHOWN);
            }
        }
        if run.thread == state.thread {
            state.turns.push(run);
            let extra = state.turns.len().saturating_sub(TURNS_SHOWN);
            state.turns.drain(..extra);
        }
    }

    /// A finished run that had no live audience: orders, cancellations, tool calls.
    fn quick_run(
        &self,
        agent: &str,
        title: &str,
        network: Network,
        started: Instant,
        steps: Vec<StepView>,
        outcome: &Result<String>,
    ) -> RunView {
        RunView {
            id: new_id()[..10].to_string(),
            thread: String::new(),
            agent: agent.to_string(),
            title: title.chars().take(250).collect(),
            network,
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
            grid: None,
            cards: Vec::new(),
            usage: None,
            model: String::new(),
        }
    }

    /// Prices and drafts a ticket against the live account. Nothing is sent
    /// anywhere until [`Self::submit_ticket`].
    pub(crate) async fn draft_ticket(&self, spec: TicketSpec<'_>) -> Result<TicketView> {
        let network = self.network();
        let client = self.client(network);
        if client.wallet().is_none() {
            bail!("Connect a wallet on {} to trade. You can do that in Settings.", network.name());
        }
        let (max_leverage, isolated_default, live_tickets, epoch) = {
            let state = self.state();
            (state.prefs.max_leverage, state.prefs.isolated, state.prefs.live_tickets, state.epoch)
        };
        if spec.by_assistant && network == Network::Mainnet && !live_tickets {
            bail!(
                "Mainnet tickets from the assistant are turned off. The trader can allow them in Settings, or switch to testnet to practise."
            );
        }
        let market = client.market(spec.symbol).await?;
        let (symbol, base) = (&market.symbol, &market.base);
        // The ticket is checked against what the account holds now, not what it held a moment ago.
        let (quote, account) = tokio::try_join!(self.quote(symbol), self.fetch_account(network))?;
        let price = quote.reference();
        let position = account.position(symbol);

        let (side, size) = match (spec.intent, position) {
            (Intent::Close | Intent::Reduce { .. } | Intent::Trade { reduce_only: true, .. }, None) => {
                bail!("There is no open {symbol} position on {} to reduce.", network.name())
            }
            (Intent::Close, Some(position)) => (position.closing_side(), None),
            (Intent::Reduce { size }, Some(position)) => (position.closing_side(), Some(size)),
            (Intent::Open { side, .. }, Some(position)) if position.closing_side() == side => bail!(
                "The account holds a {} in {symbol}, so a {side} order would reduce it rather than open a {}. Close or reduce the position first.",
                facing(position),
                side.direction()
            ),
            (Intent::Trade { side, reduce_only: true, .. }, Some(position))
                if position.closing_side() != side =>
            {
                bail!("A {side} order would add to the {symbol} {}, not reduce it.", facing(position))
            }
            (Intent::Open { side, size } | Intent::Trade { side, size, .. }, _) => (side, Some(size)),
        };
        let held = position.map_or(Decimal::ZERO, |p| p.amount.abs());
        let kind = match position {
            None => DraftKind::Open,
            Some(position) if position.closing_side() == side => DraftKind::Reduce,
            Some(_) => DraftKind::Add,
        };
        let pinned = matches!(spec.intent, Intent::Reduce { .. } | Intent::Trade { reduce_only: true, .. });
        let qty = match size {
            None => held,
            Some(size) => {
                let asked = match size {
                    Size::Qty(raw) => parse_quantity(raw)?,
                    Size::Notional(raw) => {
                        let value = parse_quantity(raw)
                            .map_err(|_| desk_err!("Enter the order value as a positive number."))?;
                        match value.checked_div(price) {
                            Some(asked) => asked,
                            None => {
                                bail!("The price of {symbol} cannot be used to size an order right now.")
                            }
                        }
                    }
                };
                let qty = market.floor_qty(asked);
                if qty.is_zero() {
                    bail!(
                        "That is less than the smallest amount {symbol} trades in ({} {base}).",
                        decimal_text(market.min_qty)
                    );
                }
                match kind {
                    // An order marked reduce-only can never do more than close.
                    DraftKind::Reduce if pinned => qty.min(held),
                    DraftKind::Reduce if qty > held => bail!(
                        "This order is larger than the {} {base} {} it runs against. Close the position first, then open the {}.",
                        decimal_text(held),
                        position.map_or("position", facing),
                        side.direction()
                    ),
                    _ => qty,
                }
            }
        };
        if qty < market.min_qty {
            bail!("The smallest {symbol} order is {} {base}.", decimal_text(market.min_qty));
        }
        if qty > market.max_qty {
            bail!(
                "One market order on {symbol} can be at most {} {base}. Split it into smaller orders.",
                decimal_text(market.max_qty)
            );
        }
        let notional = qty * price;
        if kind != DraftKind::Reduce && notional < market.min_notional {
            bail!(
                "Orders on {symbol} must be worth at least {} {}; this one is about {}.",
                decimal_text(market.min_notional),
                market.quote,
                money(notional)
            );
        }

        // A position keeps the leverage and margin mode it has; only a new one takes the ticket's.
        // In the exchange's Multi-Assets mode a new position can only be cross-margined, whatever the trader prefers.
        let (leverage, isolated) = match position {
            Some(position) => (position.leverage.max(1), position.isolated),
            None => (
                spec.leverage.unwrap_or(max_leverage.min(DEFAULT_LEVERAGE)),
                isolated_default && !account.multi_assets,
            ),
        };
        match kind {
            DraftKind::Open if leverage == 0 => bail!("Leverage must be at least 1x."),
            DraftKind::Open if leverage > max_leverage => {
                bail!("Leverage {leverage}x is above the limit of {max_leverage}x set in Settings.")
            }
            DraftKind::Add if leverage > max_leverage => bail!(
                "The open {symbol} position uses {leverage}x, above the limit of {max_leverage}x set in Settings. Lower its leverage on the exchange or raise the limit before adding to it."
            ),
            _ => {}
        }
        let margin =
            if kind == DraftKind::Reduce { Decimal::ZERO } else { notional / Decimal::from(leverage) };
        if market.quote == "USDT" && margin > account.available {
            bail!(
                "This order needs about {} USDT of margin, but {} USDT is available.",
                money(margin),
                money(account.available)
            );
        }

        let level = |raw: Option<&str>, name: &str| -> Result<Option<Decimal>> {
            match given(raw) {
                None => Ok(None),
                Some(_) if kind == DraftKind::Reduce => {
                    bail!(
                        "A {name} belongs on an order that opens or adds to a position, not on one that reduces it."
                    )
                }
                Some(text) => match parse_quantity(text) {
                    Ok(level) => Ok(Some(market.round_price(level))),
                    Err(_) => bail!("Enter the {name} as a positive price."),
                },
            }
        };
        let (stop_loss, take_profit) =
            (level(spec.stop_loss, "stop-loss")?, level(spec.take_profit, "take-profit")?);
        if spec.by_assistant && kind != DraftKind::Reduce && stop_loss.is_none() {
            bail!(
                "An order that opens or adds to a position needs a stop_loss: the price that proves the idea wrong. Choose it with plan_position, then propose the order again."
            );
        }
        let entry = match position {
            Some(position) if kind == DraftKind::Add => blended_entry(held, position.entry_price, qty, price),
            _ => price,
        };
        let est_liquidation = (kind != DraftKind::Reduce)
            .then(|| liquidation_estimate(&market, side, entry, leverage, isolated))
            .flatten();
        check_guards(side, price, stop_loss, take_profit, est_liquidation, leverage)?;

        let closes = kind == DraftKind::Reduce && qty == held;
        let leftover =
            account.orders.iter().filter(|order| order.symbol == *symbol && order.reduce_only).count();
        let amount = decimal_text(qty);
        let mode = if isolated { "isolated" } else { "cross" };
        let effect = match (kind, position) {
            (DraftKind::Reduce, Some(position)) if closes && leftover > 0 => format!(
                "Closes the {amount} {base} {} and cancels the {leftover} reduce-only order{} left on it",
                facing(position),
                if leftover == 1 { "" } else { "s" }
            ),
            (DraftKind::Reduce, Some(position)) if closes => {
                format!("Closes the {amount} {base} {}", facing(position))
            }
            (DraftKind::Reduce, Some(position)) => {
                format!(
                    "Reduces the {} from {} to {} {base}",
                    facing(position),
                    decimal_text(held),
                    decimal_text(held - qty)
                )
            }
            (DraftKind::Add, _) => format!(
                "Adds {amount} {base} to the {}, making it {} {base} at {leverage}x",
                side.direction(),
                decimal_text(held + qty)
            ),
            _ => format!("Opens a {amount} {base} {} at {leverage}x with {mode} margin", side.direction()),
        };
        let view = TicketView {
            id: new_id(),
            network,
            symbol: symbol.clone(),
            side,
            qty: amount,
            price: decimal_text(price),
            notional: decimal_text(cents(notional)),
            leverage,
            margin: decimal_text(cents(margin)),
            reduce_only: kind == DraftKind::Reduce,
            stop_loss: stop_loss.map(decimal_text),
            take_profit: take_profit.map(decimal_text),
            est_liquidation: est_liquidation.map(decimal_text),
            effect,
            rationale: spec.rationale.trim().chars().take(400).collect(),
        };
        let draft = Draft {
            network,
            market: market.clone(),
            side,
            qty,
            kind,
            held,
            price,
            leverage,
            isolated,
            stop_loss,
            take_profit,
            closes,
            by_assistant: spec.by_assistant,
            view: view.clone(),
        };
        let mut state = self.state();
        if state.network != network || state.epoch != epoch {
            bail!(
                "The network, the wallet or the risk limits changed while this ticket was being priced. Draft it again."
            );
        }
        state.draft = Some(draft);
        Ok(view)
    }

    /// Drafts a ticket from the manual order form.
    pub async fn prepare_ticket(&self, request: TicketRequest) -> Result<Snapshot> {
        let size = match (given(request.qty.as_deref()), given(request.notional.as_deref())) {
            (Some(qty), None) => Size::Qty(qty),
            (None, Some(notional)) => Size::Notional(notional),
            _ => bail!("Give either a quantity or an order value, not both."),
        };
        let spec = TicketSpec {
            symbol: &request.symbol,
            intent: Intent::Trade {
                side: request.side,
                size,
                reduce_only: request.reduce_only.unwrap_or(false),
            },
            leverage: request.leverage,
            stop_loss: request.stop_loss.as_deref(),
            take_profit: request.take_profit.as_deref(),
            rationale: "",
            by_assistant: false,
        };
        self.draft_ticket(spec).await?;
        Ok(self.snapshot())
    }

    /// Drafts a ticket that exits the whole position in a market.
    pub async fn close_position(&self, symbol: &str) -> Result<Snapshot> {
        let spec = TicketSpec {
            symbol,
            intent: Intent::Close,
            leverage: None,
            stop_loss: None,
            take_profit: None,
            rationale: "",
            by_assistant: false,
        };
        self.draft_ticket(spec).await?;
        Ok(self.snapshot())
    }

    pub fn dismiss_ticket(&self) -> Snapshot {
        self.state().draft = None;
        self.snapshot()
    }

    /// Sends the drafted ticket to the exchange as a market order, then its stop-loss
    /// and take-profit.
    ///
    /// The draft is consumed before anything is sent, so a second click cannot
    /// send a second order. If an order fails after it may have reached the exchange,
    /// the error says how to check before trying again.
    pub async fn submit_ticket(&self, id: &str) -> Result<Snapshot> {
        let draft = {
            let mut state = self.state();
            match state.draft.take() {
                Some(draft) if draft.view.id == id && draft.network == state.network => draft,
                other => {
                    state.draft = other.filter(|d| d.view.id != id);
                    bail!("This ticket has expired. Draft a new one.");
                }
            }
        };
        let started = Instant::now();
        let mut steps = Vec::new();
        let outcome = self.carry_out(&draft, &mut steps).await;
        let title = format!("Confirm {} {} {}", draft.side, decimal_text(draft.qty), draft.market.symbol);
        let run = self.quick_run("Execution", &title, draft.network, started, steps, &outcome);
        self.record(run, false);
        // Show what the order did. If this read fails the account panel says so.
        let _ = self.fetch_account(draft.network).await;
        match outcome {
            Ok(text) => {
                self.state().receipts.insert(draft.view.id.clone(), text);
                Ok(self.snapshot())
            }
            Err(error) => {
                // The reason stays with the ticket: it may say the order has to be checked on the exchange.
                self.state().failures.insert(draft.view.id.clone(), error.0.clone());
                Err(error)
            }
        }
    }

    /// Sends an order. When the exchange's answer is lost or cannot be read, asks the exchange
    /// what became of the order before saying anything, because it may have been taken.
    async fn send_order(&self, client: &ExchangeClient, order: &OrderRequest) -> Result<OrderAck> {
        let reason = match client.place_order(order).await {
            Placement::Accepted(ack) => return Ok(ack),
            Placement::Rejected(error) => return Err(error),
            Placement::Unknown(reason) => reason,
        };
        let mut absent = false;
        for _ in 0..LOOKUPS {
            tokio::time::sleep(LOOKUP_PAUSE).await;
            match client.find_order(&order.symbol, &order.client_id).await {
                Ok(Some(ack)) => return Ok(ack),
                Ok(None) => absent = true,
                Err(_) => absent = false,
            }
        }
        if absent {
            bail!(
                "{reason} The exchange shows no order with client ID {}, so it was most likely not placed. Check your positions before sending it again.",
                order.client_id
            );
        }
        bail!(
            "{reason} The order may or may not have reached the exchange. Check your open orders and positions for client ID {} before sending it again.",
            order.client_id
        )
    }

    async fn carry_out(&self, draft: &Draft, steps: &mut Vec<StepView>) -> Result<String> {
        let client = self.client(draft.network);
        let symbol = draft.market.symbol.as_str();

        // The ticket was priced against the position as it was. Make sure that still holds.
        let rows = timed(steps, "exchange.position", symbol, client.positions(Some(symbol))).await?;
        let live = rows.iter().find(|p| p.symbol == symbol);
        let amount = live.map_or(Decimal::ZERO, |p| p.amount);
        let with_order = !amount.is_zero() && (amount > Decimal::ZERO) == (draft.side == Side::Buy);
        let unchanged = match draft.kind {
            DraftKind::Open => amount.is_zero(),
            // An addition takes the position's leverage and margin mode, so those must still be the ticket's.
            DraftKind::Add => live.is_some_and(|p| {
                with_order
                    && amount.abs() == draft.held
                    && p.leverage.max(1) == draft.leverage
                    && p.isolated == draft.isolated
            }),
            DraftKind::Reduce => !amount.is_zero() && !with_order && amount.abs() == draft.held,
        };
        if !unchanged {
            bail!(
                "The {symbol} position changed after this ticket was drafted. Nothing was sent; draft it again."
            );
        }

        if draft.kind != DraftKind::Reduce {
            // Prices move while a ticket waits. What it promised must still hold at the price it would fill near.
            let mark =
                timed(steps, "exchange.mark_price", symbol, async { Ok(client.premium(symbol).await?.mark) })
                    .await?;
            let drift = (mark - draft.price).abs().checked_div(draft.price);
            if drift.is_none_or(|drift| drift > drift_limit()) {
                bail!(
                    "The mark price moved from {} to {} after this ticket was drafted. Nothing was sent; draft it again at the current price.",
                    price_text(draft.price),
                    price_text(mark)
                );
            }
            let entry = match live {
                Some(position) if draft.kind == DraftKind::Add => {
                    blended_entry(draft.held, position.entry_price, draft.qty, mark)
                }
                _ => mark,
            };
            let liquidation =
                liquidation_estimate(&draft.market, draft.side, entry, draft.leverage, draft.isolated);
            if let Err(error) = check_guards(
                draft.side,
                mark,
                draft.stop_loss,
                draft.take_profit,
                liquidation,
                draft.leverage,
            ) {
                bail!(
                    "{} The price moved after this ticket was drafted. Nothing was sent; draft it again.",
                    error.0
                );
            }
        }
        if draft.kind == DraftKind::Open {
            if live.is_none_or(|p| p.isolated != draft.isolated) {
                let mode = if draft.isolated { "isolated" } else { "cross" };
                timed(steps, "exchange.margin_mode", mode, client.set_margin_type(symbol, draft.isolated))
                    .await?;
            }
            if live.is_none_or(|p| p.leverage != draft.leverage) {
                let detail = format!("{}x", draft.leverage);
                timed(steps, "exchange.leverage", &detail, client.set_leverage(symbol, draft.leverage))
                    .await?;
            }
        }

        let amount = decimal_text(draft.qty);
        let entry = OrderRequest {
            symbol: symbol.to_string(),
            side: draft.side,
            kind: OrderKind::Market,
            qty: draft.qty,
            reduce_only: draft.kind == DraftKind::Reduce,
            client_id: draft.view.id.clone(),
        };
        let detail = format!("{} {amount} {symbol}", draft.side);
        let ack = timed(steps, "exchange.order", &detail, self.send_order(client, &entry)).await?;
        let unfilled =
            ack.executed_qty.is_zero() && matches!(ack.status.as_str(), "EXPIRED" | "CANCELED" | "REJECTED");
        if unfilled {
            bail!(
                "The exchange took the order but did not fill it (status {}). Nothing was opened or closed.",
                ack.status.to_lowercase()
            );
        }
        // A market order normally fills at once and in full. The receipt says so when it did not.
        let done = if ack.executed_qty.is_zero() { draft.qty } else { ack.executed_qty.min(draft.qty) };
        let at = if ack.avg_price.is_zero() {
            String::new()
        } else {
            format!(" at {}", price_text(ack.avg_price))
        };
        let filled = if done < draft.qty {
            format!("only {} of it filled{at}", decimal_text(done))
        } else if at.is_empty() {
            format!("status {}", ack.status.to_lowercase())
        } else {
            format!("filled{at}")
        };
        let mut lines = vec![format!(
            "Sent on {}: {} {amount} {symbol}, order {}, {filled}.",
            draft.network.as_str(),
            draft.side,
            ack.order_id
        )];

        // The stop and target cover what was filled, and can only ever reduce the position.
        let guards = [
            (
                draft.stop_loss.map(|trigger| OrderKind::StopMarket { trigger }),
                "sl",
                "exchange.stop_loss",
                "stop-loss",
            ),
            (
                draft.take_profit.map(|trigger| OrderKind::TakeProfitMarket { trigger }),
                "tp",
                "exchange.take_profit",
                "take-profit",
            ),
        ];
        for (kind, suffix, step, name) in guards {
            let Some(kind) = kind else {
                continue;
            };
            let trigger = match &kind {
                OrderKind::StopMarket { trigger } | OrderKind::TakeProfitMarket { trigger } => *trigger,
                OrderKind::Market | OrderKind::Limit { .. } => Decimal::ZERO,
            };
            let order = OrderRequest {
                symbol: symbol.to_string(),
                side: draft.side.opposite(),
                kind,
                qty: done,
                reduce_only: true,
                client_id: format!("{}-{suffix}", draft.view.id),
            };
            match timed(steps, step, &price_text(trigger), self.send_order(client, &order)).await {
                Ok(_) => lines.push(format!("The {name} is set at {}.", price_text(trigger))),
                // The position is open: say plainly that it is not protected the way the ticket promised.
                Err(error) => lines.push(format!(
                    "Warning: the {name} at {} was not confirmed ({}). The position may be open without it: check the open orders, then close the position or set one on the exchange.",
                    price_text(trigger),
                    error.0.trim_end_matches('.')
                )),
            }
        }

        if draft.closes {
            // Reduce-only orders left behind would act on the next position opened in this market. They go
            // only once the position is really flat: after a partial fill they still guard what is left.
            let flat = client
                .positions(Some(symbol))
                .await
                .map(|rows| rows.iter().filter(|p| p.symbol == symbol).all(|p| p.amount.is_zero()));
            match (flat, client.open_orders(Some(symbol)).await) {
                (Ok(true), Ok(orders)) => {
                    let leftover: Vec<String> =
                        orders.into_iter().filter(|order| order.reduce_only).map(|order| order.id).collect();
                    if !leftover.is_empty() {
                        let cancels = join_all(leftover.iter().map(|id| client.cancel_order(symbol, id)));
                        let detail = format!("{} reduce-only", leftover.len());
                        let results = timed(steps, "exchange.cancel", &detail, async { Ok(cancels.await) }).await?;
                        let failed = results.iter().filter(|result| result.is_err()).count();
                        let cancelled = results.len() - failed;
                        if cancelled > 0 {
                            lines.push(format!(
                                "Cancelled {cancelled} reduce-only order{} left on the position.",
                                if cancelled == 1 { "" } else { "s" }
                            ));
                        }
                        if failed > 0 {
                            lines.push(format!("{failed} could not be cancelled; check the open orders for {symbol}."));
                        }
                    }
                }
                (Ok(false), _) => lines.push(
                    "The position is not fully closed, so the reduce-only orders on it were left in place.".to_string(),
                ),
                _ => lines.push(format!(
                    "The position or its orders could not be read again, so no reduce-only order was cancelled; check the open orders for {symbol}."
                )),
            }
        }
        Ok(lines.join(" "))
    }

    /// Checks what the interface passed and names the market.
    async fn order_target(&self, raw: &str) -> Result<(Network, String)> {
        let network = self.network();
        Ok((network, self.client(network).market(raw).await?.symbol))
    }

    /// Carries out a cancellation the trader asked for and records it.
    async fn cancellation(
        &self,
        network: Network,
        title: String,
        work: impl Future<Output = Result<()>>,
    ) -> Result<Snapshot> {
        let started = Instant::now();
        let mut steps = Vec::new();
        let outcome =
            timed(&mut steps, "exchange.cancel", &title, work).await.map(|()| format!("{title}: done."));
        let run = self.quick_run("Execution", &title, network, started, steps, &outcome);
        self.record(run, false);
        let _ = self.fetch_account(network).await;
        outcome?;
        Ok(self.snapshot())
    }

    /// Cancels one open order.
    pub async fn cancel_order(&self, symbol: &str, order_id: &str) -> Result<Snapshot> {
        let (network, symbol) = self.order_target(symbol).await?;
        let order_id = order_id.trim();
        if order_id.is_empty() || order_id.len() > 24 || !order_id.bytes().all(|b| b.is_ascii_digit()) {
            bail!("That is not an order id.");
        }
        let title = format!("Cancel order {order_id} on {symbol}");
        self.cancellation(network, title, self.client(network).cancel_order(&symbol, order_id)).await
    }

    /// Cancels every open order in one market.
    pub async fn cancel_all_orders(&self, symbol: &str) -> Result<Snapshot> {
        let (network, symbol) = self.order_target(symbol).await?;
        let title = format!("Cancel all open orders on {symbol}");
        self.cancellation(network, title, self.client(network).cancel_all(&symbol)).await
    }

    /// Makes a wallet the trading identity of a network and remembers it.
    fn keep_wallet(&self, network: Network, wallet: Wallet, needs_deposit: bool) -> Result<()> {
        self.secrets.set(&agent_secret(network), &wallet.agent.to_secret())?;
        let remembered = WalletPref {
            user: wallet.user.to_string(),
            agent: wallet.agent.address().to_string(),
            expires_ms: wallet.expires.map(|t| t.timestamp_millis()),
        };
        self.client(network).set_wallet(Some(wallet));
        {
            let mut state = self.state();
            state.prefs.wallets.insert(network.as_str().to_string(), remembered);
            if needs_deposit {
                state.needs_deposit.insert(network);
            } else {
                state.needs_deposit.remove(&network);
            }
            state.wallet_notice = None;
            if state.network == network {
                state.epoch += 1;
                state.account = None;
                state.account_error.clear();
                state.draft = None;
                state.grid_draft = None;
            }
        }
        self.save_prefs()
    }

    /// Connects with an API wallet the trader created on the exchange's own site.
    ///
    /// The key is checked against the exchange before it is stored. The exchange answers a
    /// wallet that has never deposited the same way whatever key signs, so such
    /// a wallet is accepted and marked as waiting for its deposit.
    pub async fn connect_wallet_key(&self, request: WalletKeyRequest) -> Result<Snapshot> {
        let _hold = self.begin_change("changing wallets")?;
        let network = request.network;
        let user = Address::parse(&request.user)?;
        let agent = AgentKey::parse(&request.agent_key)?;
        if agent.address() == user {
            bail!(
                "That key belongs to the main wallet itself. Never paste your main wallet's key into any app. Create an API wallet on the exchange and paste the key it shows for that wallet."
            );
        }
        let client = self.client(network);
        let previous = client.wallet();
        let wallet = Wallet { user, agent, expires: None };
        client.set_wallet(Some(wallet.clone()));
        let restore = || client.set_wallet(previous.as_deref().cloned());
        let needs_deposit = match client.needs_deposit().await {
            Ok(needs_deposit) => needs_deposit,
            Err(error) => {
                restore();
                bail!("The exchange did not accept this API wallet: {}", error.0);
            }
        };
        if let Err(error) = self.keep_wallet(network, wallet, needs_deposit) {
            restore();
            return Err(error);
        }
        if network == self.network() && !needs_deposit {
            let _ = self.fetch_account(network).await;
        }
        Ok(self.snapshot())
    }

    /// Starts a browser approval: a fresh API wallet is made here, and a page on
    /// this computer asks the trader's wallet to approve it for trading only.
    /// The outcome arrives later through the notifier.
    pub async fn connect_wallet_browser(self: &Arc<Self>, request: WalletBrowserRequest) -> Result<Snapshot> {
        let _hold = self.begin_change("changing wallets")?;
        let agent = AgentKey::generate()?;
        let task = connect::Task::Connect { agent: agent.address(), days: request.days };
        self.open_page(request.network, WalletTask::Connect, task, Some(agent)).await?;
        Ok(self.snapshot())
    }

    /// Starts a deposit or a withdrawal: a page on this computer where the
    /// trader's own wallet sends the deposit, or signs the withdrawal. Nothing
    /// moves without that wallet, and a withdrawal only ever goes back to it.
    /// The outcome arrives later through the notifier.
    pub async fn fund_wallet(self: &Arc<Self>, request: FundingRequest) -> Result<Snapshot> {
        let network = request.network;
        let Some(wallet) = self.client(network).wallet() else {
            bail!("Connect a wallet on {} first.", network.name());
        };
        let task = match request.task {
            WalletTask::Deposit => connect::Task::Deposit { account: wallet.user },
            WalletTask::Withdraw => {
                if self.state().needs_deposit.contains(&network) {
                    bail!(
                        "There is nothing to withdraw yet: this wallet has not deposited on {}.",
                        network.name()
                    );
                }
                connect::Task::Withdraw { account: wallet.user }
            }
            WalletTask::Connect => bail!("Choose a deposit or a withdrawal."),
        };
        self.open_page(network, request.task, task, None).await?;
        Ok(self.snapshot())
    }

    /// Serves a wallet page and waits for it in the background. One page at a
    /// time: opening another withdraws the one before.
    async fn open_page(
        self: &Arc<Self>,
        network: Network,
        task: WalletTask,
        work: connect::Task,
        agent: Option<AgentKey>,
    ) -> Result<()> {
        let pending = connect::start(Arc::clone(self.client(network)), work).await?;
        let url = pending.url.clone();
        let replaced = {
            let mut state = self.state();
            state.wallet_notice = None;
            state.pending.replace(PendingPage {
                network,
                task,
                url: url.clone(),
                cancel: pending.cancel.clone(),
            })
        };
        if let Some(replaced) = replaced {
            replaced.cancel.cancel();
        }
        let studio = Arc::clone(self);
        let started = Instant::now();
        tokio::spawn(async move {
            let outcome = pending
                .outcome
                .await
                .unwrap_or_else(|_| Err(DeskError::new("The wallet page ended unexpectedly.")));
            studio.finish_page(network, task, agent, &url, started, outcome).await;
        });
        Ok(())
    }

    async fn finish_page(
        &self,
        network: Network,
        task: WalletTask,
        agent: Option<AgentKey>,
        url: &str,
        started: Instant,
        outcome: Result<connect::Done>,
    ) {
        let on_screen = {
            let mut state = self.state();
            let on_screen = state.pending.as_ref().is_some_and(|pending| pending.url == url);
            if on_screen {
                state.pending = None;
            }
            on_screen
        };
        // A page the trader cancelled or replaced may not change the desk. A deposit
        // their wallet already sent is the exception: it happened, so it is recorded.
        if !on_screen && !matches!(outcome, Ok(connect::Done::Deposited(_))) {
            return;
        }
        let notice = match outcome {
            Ok(connect::Done::Approved(approval)) => self.finish_connect(network, agent, approval).await,
            Ok(connect::Done::Deposited(deposit)) => self.finish_deposit(network, started, &deposit).await,
            Ok(connect::Done::Withdrawn(withdrawn)) => {
                self.finish_withdrawal(network, started, &withdrawn).await
            }
            Err(error) => Err(error),
        };
        let (ok, text) = match notice {
            Ok(text) => (true, text),
            Err(error) => (false, error.0),
        };
        self.state().wallet_notice = Some(WalletNoticeView { network, task, ok, text });
        self.notify();
    }

    async fn finish_connect(
        &self,
        network: Network,
        agent: Option<AgentKey>,
        approval: connect::Approval,
    ) -> Result<String> {
        let Some(agent) = agent else {
            bail!("The approval arrived without the key it approves. Connect again.");
        };
        self.keep_wallet(
            network,
            Wallet { user: approval.user, agent, expires: Some(approval.expires) },
            false,
        )?;
        if network == self.network() {
            let _ = self.fetch_account(network).await;
        } else if let Ok(true) = self.client(network).needs_deposit().await {
            self.state().needs_deposit.insert(network);
        }
        Ok(format!("Wallet connected on {}.", network.name()))
    }

    /// Records a deposit the trader's wallet sent, and reads the account again.
    /// The record keeps the transaction; what is said on screen is kept short.
    async fn finish_deposit(
        &self,
        network: Network,
        started: Instant,
        deposit: &connect::Deposit,
    ) -> Result<String> {
        let what = format!("{} {}", deposit.amount, deposit.asset);
        let place = deposit.chain.name;
        let title = format!("Deposit {what} from {place}");
        let said = match deposit.confirmed {
            Some(true) => Ok(format!(
                "Deposit of {what} confirmed on {place}. The exchange credits it within a few minutes."
            )),
            None => Ok(format!(
                "Deposit of {what} sent on {place}. The page closed before the network confirmed it; the balance changes once it does."
            )),
            Some(false) => {
                Err(desk_err!("The deposit of {what} failed on {place}, so nothing was credited."))
            }
        };
        let kept = match &said {
            Ok(text) => Ok(format!("{text} Transaction {}.", deposit.hash)),
            Err(error) => Err(desk_err!("{} Transaction {}.", error.0, deposit.hash)),
        };
        let step = StepView {
            name: "wallet.deposit".to_string(),
            detail: format!("{what}, {place}"),
            status: if kept.is_ok() { StepStatus::Ok } else { StepStatus::Error },
            ms: started.elapsed().as_millis() as u64,
            preview: kept.as_ref().err().map(|error| error.0.clone()).unwrap_or_default(),
        };
        self.record(self.quick_run("Execution", &title, network, started, vec![step], &kept), false);
        let _ = self.fetch_account(network).await;
        said
    }

    /// Records a withdrawal the exchange accepted, and reads the account again.
    async fn finish_withdrawal(
        &self,
        network: Network,
        started: Instant,
        withdrawn: &connect::Withdrawn,
    ) -> Result<String> {
        let what = format!("{} {}", withdrawn.amount, withdrawn.asset);
        let title = format!("Withdraw {what} to {}", withdrawn.chain.name);
        let request =
            if withdrawn.id.is_empty() { String::new() } else { format!(" Request {}.", withdrawn.id) };
        let outcome = Ok(format!(
            "Withdrawal of {what} to {} requested, with a fee of {} {}. It reaches your wallet once the exchange has processed it.{request}",
            withdrawn.chain.name, withdrawn.fee, withdrawn.asset
        ));
        let step = StepView {
            name: "wallet.withdraw".to_string(),
            detail: format!("{what}, {}", withdrawn.chain.name),
            status: StepStatus::Ok,
            ms: started.elapsed().as_millis() as u64,
            preview: String::new(),
        };
        self.record(self.quick_run("Execution", &title, network, started, vec![step], &outcome), false);
        let _ = self.fetch_account(network).await;
        outcome
    }

    /// Withdraws a wallet page that is still waiting.
    pub fn cancel_wallet_page(&self) -> Snapshot {
        let pending = self.state().pending.take();
        if let Some(pending) = pending {
            pending.cancel.cancel();
        }
        self.snapshot()
    }

    /// Forgets a network's API wallet key on this computer. The approval itself
    /// stays on the exchange until it expires or the trader revokes it there.
    pub fn disconnect_wallet(&self, network: Network) -> Result<Snapshot> {
        let _hold = self.begin_change("changing wallets")?;
        // The stored key goes first. If it cannot be removed, the wallet stays connected
        // rather than vanish from the screen and come back at the next launch.
        self.secrets.delete(&agent_secret(network))?;
        self.client(network).set_wallet(None);
        {
            let mut state = self.state();
            state.prefs.wallets.remove(network.as_str());
            state.needs_deposit.remove(&network);
            state.wallet_notice = None;
            if state.network == network {
                state.epoch += 1;
                state.account = None;
                state.account_error.clear();
                state.draft = None;
                state.grid_draft = None;
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Attaches an MCP tool server under the name the trader gave it, replacing one with the same name.
    pub async fn mcp_connect(&self, request: McpConnectRequest) -> Result<Snapshot> {
        let _hold = self.begin_change("changing tool servers")?;
        let id = request.id().to_string();
        {
            let state = self.state();
            if state.servers.len() >= SERVER_LIMIT && !state.servers.iter().any(|server| server.id == id) {
                bail!("Up to {SERVER_LIMIT} tool servers can be attached. Detach one first.");
            }
        }
        let link = Arc::new(McpLink::connect(&request).await?);
        let view = McpView {
            id: id.clone(),
            name: link.name.clone(),
            version: link.version.clone(),
            transport: link.transport,
            tools: link.tools().len(),
        };
        let previous = self.links.write().await.insert(id.clone(), link);
        if let Some(previous) = previous {
            previous.close().await;
        }
        {
            let mut state = self.state();
            state.servers.retain(|server| server.id != id);
            state.servers.push(view);
        }
        Ok(self.snapshot())
    }

    pub async fn mcp_disconnect(&self, id: &str) -> Result<Snapshot> {
        let _hold = self.begin_change("changing tool servers")?;
        let link = self.links.write().await.remove(id);
        if let Some(link) = link {
            link.close().await;
        }
        self.state().servers.retain(|server| server.id != id);
        Ok(self.snapshot())
    }

    async fn link(&self, id: &str) -> Result<Arc<McpLink>> {
        match self.links.read().await.get(id) {
            Some(link) => Ok(Arc::clone(link)),
            None => bail!("No tool server named {id} is attached. Attach one in Settings."),
        }
    }

    pub async fn mcp_tools(&self, id: &str) -> Result<Vec<ToolInfo>> {
        Ok(self.link(id).await?.tools().to_vec())
    }

    /// Calls a tool on an attached server. `by_trader` is true for the tool
    /// inspector, where the trader chose and ran the tool; the assistant is
    /// limited to tools the server marks read-only.
    pub(crate) async fn server_tool(
        &self,
        id: &str,
        name: &str,
        arguments: &Value,
        by_trader: bool,
    ) -> Result<Value> {
        let link = self.link(id).await?;
        let Some(tool) = link.tool(name) else {
            bail!("{name} is not a tool on the {id} server. Settings lists the tools it offers.");
        };
        if !by_trader && !tool.read_only {
            bail!(
                "The {id} server does not mark {name} as read-only, so only the trader can run it, from Settings."
            );
        }
        link.call(name, arguments).await
    }

    /// Runs a tool from the inspector and returns its output as text.
    pub async fn mcp_call(&self, id: &str, name: &str, arguments: Value) -> Result<String> {
        let started = Instant::now();
        let outcome = self.server_tool(id, name, &arguments, true).await.map(|value| match value {
            Value::String(text) => text,
            other => serde_json::to_string_pretty(&other).unwrap_or_default(),
        });
        let outcome = outcome.map(|text| text.chars().take(32_000).collect::<String>());
        let step = StepView {
            name: format!("{id}.{name}"),
            detail: "tool inspector".to_string(),
            status: if outcome.is_ok() { StepStatus::Ok } else { StepStatus::Error },
            ms: started.elapsed().as_millis() as u64,
            preview: String::new(),
        };
        let run = self.quick_run(
            "Tool inspector",
            &format!("{id} {name}"),
            self.network(),
            started,
            vec![step],
            &outcome,
        );
        // Tool output may hold private details, so it is not written to disk.
        self.record(run, true);
        outcome
    }

    /// Where a provider on this computer listens: what was typed, else what is stored, else its usual address.
    fn local_address(&self, provider: Provider, typed: Option<&str>) -> Result<String> {
        let (stored, default) = {
            let state = self.state();
            match provider {
                Provider::Ollama => (state.prefs.ollama_url.clone(), ollama::DEFAULT_URL),
                _ => (state.prefs.lmstudio_url.clone(), lmstudio::DEFAULT_URL),
            }
        };
        local_url(given(typed).unwrap_or(&stored), default)
    }

    /// The model that answers, with the connection that reaches it. Fails when
    /// none is connected.
    pub(crate) fn chosen(&self) -> Result<Chosen> {
        let (provider, choice, key, token, account, gateway) = {
            let state = self.state();
            let prefs = &state.prefs;
            (
                prefs.provider,
                prefs.choice(prefs.provider).cloned(),
                state.openrouter_key.clone(),
                state.cloudflare_token.clone(),
                prefs.cloudflare_account.clone(),
                prefs.cloudflare_gateway.clone(),
            )
        };
        let Some(choice) = choice else {
            bail!("{NO_MODEL}");
        };
        // A model carried over from an older release has no record of what it can do.
        let model = choice.info.unwrap_or_else(|| ModelInfo {
            id: choice.id.clone(),
            name: choice.id.clone(),
            tools: true,
            ..ModelInfo::default()
        });
        let (connection, url) = match provider {
            Provider::None => bail!("{NO_MODEL}"),
            Provider::OpenRouter => {
                let Some(key) = key else {
                    bail!("{NO_MODEL}");
                };
                let endpoint = self.openrouter.endpoint(&key)?;
                (Connection::Compatible { http: self.http.clone(), endpoint }, String::new())
            }
            Provider::Cloudflare => {
                let Some(token) = token else {
                    bail!("{NO_MODEL}");
                };
                let endpoint = self.cloudflare.endpoint(&account, &gateway, &token)?;
                (Connection::Compatible { http: self.http.clone(), endpoint }, String::new())
            }
            Provider::Ollama => {
                let url = self.local_address(provider, None)?;
                let context = ollama::context_for(&model);
                (Connection::Ollama { client: self.ollama.clone(), url: url.clone(), context }, url)
            }
            Provider::LmStudio => {
                let url = self.local_address(provider, None)?;
                let endpoint = self.lmstudio.endpoint(&url);
                (Connection::Compatible { http: self.local_http.clone(), endpoint }, url)
            }
        };
        Ok(Chosen { provider, model, connection, url })
    }

    /// Makes sure a model on this computer is loaded with room for the assistant.
    pub(crate) async fn prepare_model(&self, chosen: &Chosen) -> Result<()> {
        if chosen.provider == Provider::LmStudio {
            self.lmstudio.prepare(&chosen.url, &chosen.model.id).await?;
        }
        Ok(())
    }

    /// The models a provider offers. Whatever the request leaves out is taken
    /// from what is stored for that provider.
    pub async fn list_models(&self, request: ModelsRequest) -> Result<Vec<ModelInfo>> {
        let supplied = given(request.key.as_deref());
        match request.provider {
            Provider::None => bail!("Choose a provider first."),
            Provider::OpenRouter => {
                let key = supplied.map(str::to_string).or_else(|| self.state().openrouter_key.clone());
                let models = self.openrouter.models(key.as_deref()).await?;
                self.state().catalog = models.clone();
                Ok(models)
            }
            Provider::Cloudflare => {
                let (account, token) = {
                    let state = self.state();
                    (
                        given(request.account.as_deref())
                            .map_or_else(|| state.prefs.cloudflare_account.clone(), str::to_string),
                        supplied.map(str::to_string).or_else(|| state.cloudflare_token.clone()),
                    )
                };
                let Some(token) = token.filter(|_| !account.is_empty()) else {
                    bail!("Enter your Cloudflare account ID and API token first.");
                };
                self.cloudflare.models(&account, &token).await
            }
            Provider::Ollama => {
                self.ollama.models(&self.local_address(Provider::Ollama, request.url.as_deref())?).await
            }
            Provider::LmStudio => {
                self.lmstudio.models(&self.local_address(Provider::LmStudio, request.url.as_deref())?).await
            }
        }
    }

    /// Connects a model. Nothing is stored until the provider has shown that
    /// the model exists, answers, and can call tools, which the assistant
    /// cannot work without.
    pub async fn save_assistant(&self, request: AssistantRequest) -> Result<Snapshot> {
        let _hold = self.begin_change("changing the model")?;
        let provider = request.provider;
        let model = request.model.trim();
        if provider == Provider::None {
            bail!("Choose a provider first.");
        }
        if model.is_empty() {
            bail!("Choose a model first.");
        }
        let supplied = given(request.key.as_deref());
        if supplied.is_none() && self.connection_unchanged(&request, model) {
            // The model in use, with nothing new typed: only the options change. It was proved when it
            // was connected, so no provider is asked again and a switch in Settings works offline.
            {
                let mut state = self.state();
                Self::apply_options(&mut state, &request);
            }
            self.save_prefs()?;
            return Ok(self.snapshot());
        }
        let mut secret: Option<String> = None;
        let (mut account, mut gateway, mut url) = (None, None, None);
        let info = match provider {
            Provider::None => bail!("Choose a provider first."),
            Provider::OpenRouter => {
                let key = match supplied {
                    Some(key) => {
                        let key = valid_key(key)?;
                        self.openrouter.check_key(&key).await?;
                        secret = Some(key.clone());
                        key
                    }
                    None => match self.state().openrouter_key.clone() {
                        Some(key) => key,
                        None => bail!("Paste your OpenRouter key first."),
                    },
                };
                // A key pasted into the wrong field must not be said back in an error.
                if valid_key(model).is_ok() {
                    bail!("That is a key, not a model. Paste it into the key field.");
                }
                if !valid_model_id(model) {
                    bail!("Choose a model from the list.");
                }
                let cached = self.state().catalog.iter().find(|m| m.id == model).cloned();
                let info = match cached {
                    Some(info) => info,
                    None => {
                        let models = self.openrouter.models(Some(&key)).await?;
                        self.state().catalog = models.clone();
                        match models.into_iter().find(|m| m.id == model) {
                            Some(info) => info,
                            None => bail!("OpenRouter has no model named {model}. Choose one from the list."),
                        }
                    }
                };
                if !info.tools {
                    bail!("{} cannot use tools. Pick a model that can.", info.name);
                }
                info
            }
            Provider::Cloudflare => {
                let (stored_account, stored_gateway, stored_token) = {
                    let state = self.state();
                    (
                        state.prefs.cloudflare_account.clone(),
                        state.prefs.cloudflare_gateway.clone(),
                        state.cloudflare_token.clone(),
                    )
                };
                let id =
                    cloudflare::valid_account(given(request.account.as_deref()).unwrap_or(&stored_account))?;
                let route =
                    cloudflare::valid_gateway(given(request.gateway.as_deref()).unwrap_or(&stored_gateway))?;
                let token = match supplied {
                    Some(token) => {
                        let token = cloudflare::valid_token(token)?;
                        secret = Some(token.clone());
                        token
                    }
                    None => match stored_token {
                        Some(token) => token,
                        None => bail!("Paste your Cloudflare API token first."),
                    },
                };
                let endpoint = self.cloudflare.endpoint(&id, &route, &token)?;
                let info = self.cloudflare.verify(&endpoint, model).await?;
                (account, gateway) = (Some(id), Some(route));
                info
            }
            Provider::Ollama => {
                let address = self.local_address(provider, request.url.as_deref())?;
                let info = self.ollama.verify(&address, model).await?;
                url = Some(address);
                info
            }
            Provider::LmStudio => {
                let address = self.local_address(provider, request.url.as_deref())?;
                let info = self.lmstudio.prepare(&address, model).await?;
                url = Some(address);
                info
            }
        };
        if let Some(secret) = &secret {
            let name = if provider == Provider::Cloudflare { CLOUDFLARE_SECRET } else { OPENROUTER_SECRET };
            self.secrets.set(name, secret)?;
        }
        {
            let mut state = self.state();
            match provider {
                Provider::OpenRouter if secret.is_some() => state.openrouter_key = secret,
                Provider::Cloudflare if secret.is_some() => state.cloudflare_token = secret,
                _ => {}
            }
            if let (Some(account), Some(gateway)) = (account, gateway) {
                state.prefs.cloudflare_account = account;
                state.prefs.cloudflare_gateway = gateway;
            }
            match (provider, url) {
                (Provider::Ollama, Some(url)) => state.prefs.ollama_url = url,
                (Provider::LmStudio, Some(url)) => state.prefs.lmstudio_url = url,
                _ => {}
            }
            state.prefs.provider = provider;
            let choice = ModelChoice { id: info.id.clone(), info: Some(info) };
            state.prefs.models.insert(provider.as_str().to_string(), choice);
            Self::apply_options(&mut state, &request);
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// The settings that are not about which model answers.
    fn apply_options(state: &mut State, request: &AssistantRequest) {
        state.prefs.effort = request.effort;
        state.prefs.live_tickets = request.live_tickets;
        // A mainnet ticket or grid bot the assistant drafted does not outlive the permission it was drafted under.
        let withdrawn = |draft: &Draft| draft.by_assistant && draft.network == Network::Mainnet;
        if !request.live_tickets && state.draft.as_ref().is_some_and(withdrawn) {
            state.draft = None;
        }
        if !request.live_tickets
            && state.grid_draft.as_ref().is_some_and(|draft| draft.view.network == Network::Mainnet)
        {
            state.grid_draft = None;
        }
    }

    /// Whether a request names the model already in use and nothing about how it is reached.
    fn connection_unchanged(&self, request: &AssistantRequest, model: &str) -> bool {
        let provider = request.provider;
        let same = |typed: Option<&str>, stored: &str| given(typed).is_none_or(|typed| typed == stored);
        let address = match provider {
            Provider::Ollama | Provider::LmStudio => self.local_address(provider, None).unwrap_or_default(),
            _ => String::new(),
        };
        let state = self.state();
        let prefs = &state.prefs;
        let gateway = if prefs.cloudflare_gateway.is_empty() {
            cloudflare::DEFAULT_GATEWAY
        } else {
            prefs.cloudflare_gateway.as_str()
        };
        prefs.provider == provider
            && prefs.choice(provider).is_some_and(|choice| choice.id == model)
            && match provider {
                Provider::Cloudflare => {
                    same(request.account.as_deref(), &prefs.cloudflare_account)
                        && same(request.gateway.as_deref(), gateway)
                }
                Provider::Ollama | Provider::LmStudio => same(request.url.as_deref(), &address),
                _ => true,
            }
    }

    /// Forgets a provider: its key or token, its model and its address. If it
    /// was the one in use, no model is connected afterwards.
    pub fn forget_provider(&self, provider: Provider) -> Result<Snapshot> {
        let _hold = self.begin_change("changing the model")?;
        // The stored secret goes first. If it cannot be removed, the provider stays
        // connected rather than vanish from the screen and come back at the next launch.
        match provider {
            Provider::None => bail!("Choose a provider first."),
            Provider::OpenRouter => self.secrets.delete(OPENROUTER_SECRET)?,
            Provider::Cloudflare => self.secrets.delete(CLOUDFLARE_SECRET)?,
            Provider::Ollama | Provider::LmStudio => {}
        }
        {
            let mut state = self.state();
            match provider {
                Provider::OpenRouter => {
                    state.openrouter_key = None;
                    state.catalog.clear();
                }
                Provider::Cloudflare => {
                    state.cloudflare_token = None;
                    state.prefs.cloudflare_account.clear();
                    state.prefs.cloudflare_gateway.clear();
                }
                Provider::Ollama => state.prefs.ollama_url.clear(),
                Provider::LmStudio => state.prefs.lmstudio_url.clear(),
                Provider::None => {}
            }
            state.prefs.models.remove(provider.as_str());
            if state.prefs.provider == provider {
                state.prefs.provider = Provider::None;
            }
        }
        self.save_prefs()?;
        Ok(self.snapshot())
    }

    /// Stops background work and closes attached servers. Call before exit.
    pub async fn close(&self) {
        self.stop_turn();
        self.cancel_wallet_page();
        let links: Vec<Arc<McpLink>> = self.links.write().await.drain().map(|(_, link)| link).collect();
        for link in links {
            link.close().await;
        }
    }
}

#[cfg(test)]
mod tests;
