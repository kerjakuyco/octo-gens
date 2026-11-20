//! The shapes that cross to the user interface.
//!
//! These mirror `src/api/types.ts` field for field (camelCase on the wire).
//! Change both together. Decimal amounts are sent as strings so no precision is
//! lost on the way; nothing here contains a secret.

use std::collections::HashMap;

use chrono::{DateTime, SecondsFormat, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};

use crate::assistant::tools::Plan;
use crate::bail;
use crate::error::Result;
use crate::exchange::{Premium, Tick, Trade};
use crate::indicators::{Analysis, tidy, two};
use crate::llm::Usage;
use crate::mcp::Transport;
use crate::model::{Account, Candle, Market, Network, OrderBook, Quote, Side, cents, decimal_text};
use crate::store::{Effort, Provider, Theme};
use crate::web::{Article, Coins, Desk, Front, Story};

/// Daily closes kept on a quote that is stored with an answer: enough for a sparkline.
const CARD_CLOSES: usize = 30;

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// A funding rate as a percent per interval.
pub(crate) fn rate_pct(rate: Decimal) -> Option<f64> {
    rate.checked_mul(Decimal::from(100)).and_then(|pct| pct.to_f64())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentView {
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub custom: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteView {
    pub symbol: String,
    pub price: String,
    pub mark_price: Option<String>,
    pub index_price: Option<String>,
    pub funding_rate_pct: Option<f64>,
    pub next_funding: Option<String>,
    pub change_pct: Option<f64>,
    pub high24h: Option<String>,
    pub low24h: Option<String>,
    pub volume24h: Option<String>,
    pub quote_volume24h: Option<String>,
    pub closes: Vec<String>,
    pub as_of: String,
    pub source: String,
}

impl From<&Quote> for QuoteView {
    fn from(quote: &Quote) -> Self {
        let text = |value: &Option<Decimal>| value.map(decimal_text);
        Self {
            symbol: quote.symbol.clone(),
            price: decimal_text(quote.price),
            mark_price: text(&quote.mark),
            index_price: text(&quote.index),
            funding_rate_pct: quote.funding_pct(),
            next_funding: quote.next_funding.map(stamp),
            change_pct: quote.change_pct(),
            high24h: text(&quote.stats.high),
            low24h: text(&quote.stats.low),
            volume24h: text(&quote.stats.volume),
            quote_volume24h: text(&quote.stats.quote_volume),
            closes: quote.closes.iter().map(|c| decimal_text(*c)).collect(),
            as_of: stamp(quote.as_of),
            source: quote.source.clone(),
        }
    }
}

impl QuoteView {
    /// A quote as it is kept with an answer: the same reading with a shorter history.
    pub fn for_card(quote: &Quote) -> Self {
        let mut view = Self::from(quote);
        let extra = view.closes.len().saturating_sub(CARD_CLOSES);
        view.closes.drain(..extra);
        view
    }
}

/// One row of the market screener.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRow {
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub price: String,
    pub mark_price: Option<String>,
    pub change_pct: Option<f64>,
    pub quote_volume24h: Option<String>,
    pub funding_rate_pct: Option<f64>,
    pub next_funding: Option<String>,
}

impl MarketRow {
    pub fn new(market: &Market, tick: &Tick, premium: Option<&Premium>) -> Self {
        Self {
            symbol: market.symbol.clone(),
            base: market.base.clone(),
            quote: market.quote.clone(),
            price: decimal_text(tick.price),
            mark_price: premium.map(|p| decimal_text(p.mark)),
            change_pct: tick.stats.change_pct,
            quote_volume24h: tick.stats.quote_volume.map(decimal_text),
            funding_rate_pct: premium.and_then(|p| p.funding_rate).and_then(rate_pct),
            next_funding: premium.and_then(|p| p.next_funding).map(stamp),
        }
    }

    /// The same row from a quote the desk already holds.
    pub fn from_quote(instrument: &InstrumentView, quote: &Quote) -> Self {
        Self {
            symbol: instrument.symbol.clone(),
            base: instrument.base.clone(),
            quote: instrument.quote.clone(),
            price: decimal_text(quote.price),
            mark_price: quote.mark.map(decimal_text),
            change_pct: quote.change_pct(),
            quote_volume24h: quote.stats.quote_volume.map(decimal_text),
            funding_rate_pct: quote.funding_pct(),
            next_funding: quote.next_funding.map(stamp),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookLevel {
    pub price: String,
    pub size: String,
    /// Size resting from the best price down to this level, inclusive.
    pub total: String,
}

/// The top of the order book, best prices first on both sides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBookView {
    pub symbol: String,
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
    pub mid: String,
    pub spread_bps: Option<f64>,
    pub bid_share_pct: Option<f64>,
    pub as_of: String,
}

impl OrderBookView {
    /// The best `depth` levels a side. An empty side is an error: there is no book to show.
    pub fn new(symbol: &str, book: &OrderBook, depth: usize) -> Result<Self> {
        let (mut bids, mut asks) = (book.bids.clone(), book.asks.clone());
        // Best first, whatever order the venue sent.
        bids.sort_by_key(|(price, _)| std::cmp::Reverse(*price));
        asks.sort_by_key(|(price, _)| *price);
        let (Some((bid, _)), Some((ask, _))) = (bids.first().copied(), asks.first().copied()) else {
            bail!("The order book for {symbol} is empty right now.");
        };
        // Checked throughout: an absurd level is skipped, never allowed to overflow.
        let side = |levels: &[(Decimal, Decimal)]| -> (Vec<BookLevel>, Decimal) {
            let mut total = Decimal::ZERO;
            let rows = levels
                .iter()
                .take(depth)
                .map(|(price, size)| {
                    total = total.checked_add(*size).unwrap_or(total);
                    BookLevel {
                        price: decimal_text(*price),
                        size: decimal_text(*size),
                        total: decimal_text(total),
                    }
                })
                .collect();
            (rows, total)
        };
        let ((bids, bid_size), (asks, ask_size)) = (side(&bids), side(&asks));
        let Some(mid) = bid.checked_add(ask).map(|sum| sum / Decimal::from(2)) else {
            bail!("The order book for {symbol} cannot be read right now.");
        };
        let spread = (ask - bid).checked_div(mid).and_then(|share| share.checked_mul(Decimal::from(10_000)));
        let share = bid_size
            .checked_add(ask_size)
            .and_then(|both| bid_size.checked_div(both))
            .and_then(|share| share.checked_mul(Decimal::from(100)));
        Ok(Self {
            symbol: symbol.to_string(),
            bids,
            asks,
            mid: decimal_text(mid),
            spread_bps: spread.and_then(|bps| bps.to_f64()).map(two),
            bid_share_pct: share.and_then(|pct| pct.to_f64()).map(|pct| (pct * 10.0).round() / 10.0),
            as_of: stamp(book.as_of),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeView {
    pub time: String,
    pub price: String,
    pub size: String,
    /// The side that took liquidity.
    pub side: Side,
}

impl From<&Trade> for TradeView {
    fn from(trade: &Trade) -> Self {
        Self {
            time: stamp(trade.time),
            price: decimal_text(trade.price),
            size: decimal_text(trade.qty),
            side: trade.taker,
        }
    }
}

/// `(ISO-8601 UTC time, rate in percent per interval)`.
pub type FundingPoint = (String, f64);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingView {
    pub symbol: String,
    pub rate_pct: Option<f64>,
    pub annual_pct: Option<f64>,
    pub next_funding: Option<String>,
    pub interval_hours: Option<u32>,
    pub history: Vec<FundingPoint>,
    pub open_interest: Option<String>,
    pub open_interest_value: Option<String>,
}

impl FundingView {
    /// `history` is settled rates as fractions, oldest first. Without a published
    /// interval, the spacing of the last two payments is used.
    pub fn new(
        symbol: &str,
        premium: &Premium,
        interval_hours: Option<u32>,
        history: &[(DateTime<Utc>, Decimal)],
        open_interest: Option<Decimal>,
    ) -> Self {
        let spacing = || match history {
            [.., (earlier, _), (later, _)] => {
                u32::try_from(((*later - *earlier).num_minutes() + 30) / 60).ok().filter(|hours| *hours > 0)
            }
            _ => None,
        };
        let interval_hours = interval_hours.or_else(spacing);
        let rate = premium.funding_rate.and_then(rate_pct);
        let annual = rate
            .zip(interval_hours)
            .map(|(rate, hours)| two(rate * 24.0 / f64::from(hours) * 365.0))
            .filter(|annual| annual.is_finite());
        Self {
            symbol: symbol.to_string(),
            rate_pct: rate,
            annual_pct: annual,
            next_funding: premium.next_funding.map(stamp),
            interval_hours,
            history: history
                .iter()
                .filter_map(|(time, rate)| Some((stamp(*time), rate_pct(*rate)?)))
                .collect(),
            open_interest: open_interest.map(decimal_text),
            open_interest_value: open_interest
                .and_then(|size| size.checked_mul(premium.mark))
                .map(|value| decimal_text(cents(value))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trend {
    Uptrend,
    Downtrend,
    Mixed,
    /// Too little history to say.
    Unknown,
}

/// A technical reading of one market on one timeframe.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechnicalFrame {
    pub timeframe: String,
    pub trend: Trend,
    pub change_pct: Option<f64>,
    pub rsi14: Option<f64>,
    pub macd: Option<f64>,
    pub atr_pct: Option<f64>,
    pub ema20: Option<f64>,
    pub ema50: Option<f64>,
    pub ema200: Option<f64>,
    pub support: Vec<f64>,
    pub resistance: Vec<f64>,
}

impl From<&Analysis> for TechnicalFrame {
    fn from(reading: &Analysis) -> Self {
        let levels = |levels: &[f64]| levels.iter().map(|level| tidy(*level)).collect();
        Self {
            timeframe: reading.timeframe.as_str().to_string(),
            trend: match reading.trend {
                "uptrend" => Trend::Uptrend,
                "downtrend" => Trend::Downtrend,
                "mixed" => Trend::Mixed,
                _ => Trend::Unknown,
            },
            change_pct: reading.returns.iter().find(|(bars, _)| *bars == 5).map(|(_, pct)| *pct),
            rsi14: reading.rsi14.map(two),
            macd: reading.macd.map(|(_, _, histogram)| tidy(histogram)),
            atr_pct: reading
                .atr14
                .and_then(|atr| (reading.price != 0.0).then(|| two(atr / reading.price * 100.0))),
            ema20: reading.ema20.map(tidy),
            ema50: reading.ema50.map(tidy),
            ema200: reading.ema200.map(tidy),
            support: levels(&reading.supports),
            resistance: levels(&reading.resistances),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechnicalsView {
    pub symbol: String,
    pub price: String,
    pub frames: Vec<TechnicalFrame>,
    pub as_of: String,
}

/// Position sizing worked out by the assistant's planning tool.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub symbol: String,
    /// `long` or `short`.
    pub direction: String,
    pub entry: String,
    pub stop: String,
    pub target: Option<String>,
    pub qty: String,
    pub leverage: u32,
    pub notional: String,
    pub margin: String,
    pub loss_at_stop: String,
    pub risk_pct: Option<f64>,
    pub liquidation: Option<String>,
    pub stop_safe: bool,
    pub reward_to_risk: Option<f64>,
}

impl From<&Plan> for PlanView {
    fn from(plan: &Plan) -> Self {
        Self {
            symbol: plan.symbol.clone(),
            direction: plan.side.direction().to_string(),
            entry: decimal_text(plan.entry),
            stop: decimal_text(plan.stop),
            target: plan.target.map(decimal_text),
            qty: decimal_text(plan.quantity),
            leverage: plan.leverage,
            notional: decimal_text(cents(plan.notional)),
            margin: decimal_text(cents(plan.margin)),
            loss_at_stop: decimal_text(cents(plan.loss)),
            risk_pct: plan.loss_pct(),
            liquidation: (!plan.liquidation.is_zero()).then(|| decimal_text(plan.liquidation)),
            stop_safe: plan.stop_safe,
            reward_to_risk: plan.reward_to_risk(),
        }
    }
}

/// A headline the assistant was shown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsView {
    pub title: String,
    /// The publisher.
    pub source: String,
    pub url: String,
    /// When it was published, as RFC 3339, if the publisher said.
    #[serde(default)]
    pub published: Option<String>,
}

impl From<&Article> for NewsView {
    fn from(article: &Article) -> Self {
        Self {
            title: article.title.clone(),
            source: article.source.clone(),
            url: article.url.clone(),
            published: article.published.map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        }
    }
}

/// Where a story comes from: the crypto newsrooms, or the economy and the stock market.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewsDesk {
    Crypto,
    Macro,
}

impl From<Desk> for NewsDesk {
    fn from(desk: Desk) -> Self {
        match desk {
            Desk::Crypto => NewsDesk::Crypto,
            Desk::Macro => NewsDesk::Macro,
        }
    }
}

/// One story on the News page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryView {
    pub title: String,
    /// The publisher.
    pub source: String,
    pub url: String,
    /// When it was published, as RFC 3339 in UTC, if the publisher said.
    pub published: Option<String>,
    pub summary: String,
    /// The `https` address of the story's picture. The interface asks the core for it.
    pub image: Option<String>,
    pub topics: Vec<String>,
    /// Markets on the active network the story is about, e.g. `BTCUSDT`.
    pub markets: Vec<String>,
    pub desk: NewsDesk,
}

impl StoryView {
    fn new(story: Story, markets: Vec<String>) -> Self {
        let Story { article, desk } = story;
        Self {
            published: article.published.map(stamp),
            title: article.title,
            source: article.source,
            url: article.url,
            summary: article.summary,
            image: article.image,
            topics: article.topics,
            markets,
            desk: desk.into(),
        }
    }
}

/// The News page: the newest stories from every publisher.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsFeedView {
    /// Newest first; stories without a time come last.
    pub stories: Vec<StoryView>,
    /// Every publisher read, in a fixed order.
    pub publishers: Vec<String>,
    /// Publishers that could not be reached on the last read.
    pub missing: Vec<String>,
    /// When the stories were read, as RFC 3339 in UTC.
    pub read_at: String,
}

impl NewsFeedView {
    /// The page, with each story tied to the markets of `coins` it names.
    pub(crate) fn new(front: Front, coins: &Coins) -> Self {
        let stories = front
            .stories
            .into_iter()
            .map(|story| {
                let markets = coins.named_in(&story.article);
                StoryView::new(story, markets)
            })
            .collect();
        Self { stories, publishers: front.publishers, missing: front.missing, read_at: stamp(front.read_at) }
    }
}

/// Something the assistant looked at, shown with its answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CardView {
    Quotes {
        quotes: Vec<QuoteView>,
    },
    Technicals {
        symbol: String,
        frame: TechnicalFrame,
    },
    Book {
        book: OrderBookView,
    },
    Movers {
        rows: Vec<MarketRow>,
    },
    Plan {
        plan: PlanView,
    },
    /// Headlines a news search returned. `query` is empty for the newest headlines.
    News {
        query: String,
        articles: Vec<NewsView>,
    },
    /// Carries no data: the interface shows the live account.
    Account,
}

impl CardView {
    /// What the card is about. A second card about the same thing in one turn adds nothing.
    pub(crate) fn subject(&self) -> String {
        let joined = |symbols: Vec<&str>| symbols.join(",");
        match self {
            CardView::Quotes { quotes } => {
                let mut symbols: Vec<&str> = quotes.iter().map(|quote| quote.symbol.as_str()).collect();
                symbols.sort_unstable();
                format!("quotes {}", joined(symbols))
            }
            CardView::Technicals { symbol, frame } => format!("technicals {symbol} {}", frame.timeframe),
            CardView::Book { book } => format!("book {}", book.symbol),
            CardView::Movers { rows } => {
                format!("movers {}", joined(rows.iter().map(|row| row.symbol.as_str()).collect()))
            }
            CardView::Plan { plan } => format!("plan {} {} {}", plan.symbol, plan.entry, plan.stop),
            CardView::News { query, .. } => format!("news {}", query.trim().to_lowercase()),
            CardView::Account => "account".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletView {
    pub network: Network,
    pub connected: bool,
    pub user: Option<String>,
    pub agent: Option<String>,
    pub expires: Option<String>,
    pub needs_deposit: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceView {
    pub asset: String,
    pub balance: String,
    pub available: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionView {
    pub symbol: String,
    /// `long` or `short`.
    pub side: &'static str,
    pub qty: String,
    pub entry_price: String,
    pub mark_price: String,
    pub liquidation_price: Option<String>,
    pub leverage: u32,
    pub isolated: bool,
    pub notional: String,
    pub margin: String,
    pub unrealized_pnl: String,
    pub roe_pct: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrderView {
    pub id: String,
    pub client_id: String,
    pub symbol: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub kind: String,
    pub price: Option<String>,
    pub stop_price: Option<String>,
    pub qty: String,
    pub filled: String,
    pub reduce_only: bool,
    pub status: String,
    pub time: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub equity: String,
    pub wallet_balance: String,
    pub available: String,
    pub unrealized_pnl: String,
    pub margin_used: String,
    pub balances: Vec<BalanceView>,
    pub positions: Vec<PositionView>,
    pub orders: Vec<OpenOrderView>,
    /// The exchange's Multi-Assets mode is on: new positions can only use cross margin.
    pub multi_assets: bool,
    pub as_of: String,
}

impl From<&Account> for AccountView {
    fn from(account: &Account) -> Self {
        Self {
            equity: decimal_text(account.equity),
            wallet_balance: decimal_text(account.wallet_balance),
            available: decimal_text(account.available),
            unrealized_pnl: decimal_text(account.unrealized_pnl),
            margin_used: decimal_text(account.margin_used),
            balances: account
                .balances
                .iter()
                .map(|b| BalanceView {
                    asset: b.asset.clone(),
                    balance: decimal_text(b.balance),
                    available: decimal_text(b.available),
                })
                .collect(),
            positions: account
                .positions
                .iter()
                .map(|p| {
                    let margin = p.margin();
                    PositionView {
                        symbol: p.symbol.clone(),
                        side: if p.is_long() { "long" } else { "short" },
                        qty: decimal_text(p.amount.abs()),
                        entry_price: decimal_text(p.entry_price),
                        mark_price: decimal_text(p.mark_price),
                        liquidation_price: p.liquidation_price.map(decimal_text),
                        leverage: p.leverage,
                        isolated: p.isolated,
                        notional: decimal_text(p.notional.abs()),
                        margin: decimal_text(margin),
                        unrealized_pnl: decimal_text(p.unrealized_pnl),
                        // Checked, like all arithmetic on figures from the venue.
                        roe_pct: p
                            .unrealized_pnl
                            .checked_div(margin)
                            .and_then(|share| share.checked_mul(Decimal::from(100)))
                            .and_then(|pct| pct.to_f64())
                            .map(|pct| (pct * 100.0).round() / 100.0),
                    }
                })
                .collect(),
            orders: account
                .orders
                .iter()
                .map(|o| OpenOrderView {
                    id: o.id.clone(),
                    client_id: o.client_id.clone(),
                    symbol: o.symbol.clone(),
                    side: o.side,
                    kind: o.kind.clone(),
                    price: o.price.map(decimal_text),
                    stop_price: o.stop_price.map(decimal_text),
                    qty: decimal_text(o.qty),
                    filled: decimal_text(o.filled),
                    reduce_only: o.reduce_only,
                    status: o.status.clone(),
                    time: stamp(o.time),
                })
                .collect(),
            multi_assets: account.multi_assets,
            as_of: stamp(account.as_of),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskView {
    pub max_leverage: u32,
    pub isolated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub transport: Transport,
    pub tools: usize,
}

/// What is stored for one model provider. Secrets never reach the interface.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: Provider,
    pub name: &'static str,
    pub local: bool,
    pub has_key: bool,
    pub model: String,
    /// What that model is called on screen.
    pub label: String,
    pub account: String,
    pub gateway: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantView {
    pub provider: Provider,
    pub model: String,
    pub label: String,
    /// A model is connected and the assistant can answer.
    pub ready: bool,
    pub reasoning: bool,
    pub effort: Effort,
    pub live_tickets: bool,
    /// The assistant may search the news and read web pages.
    pub web_search: bool,
    pub providers: Vec<ProviderView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepView {
    pub name: String,
    pub detail: String,
    pub status: StepStatus,
    pub ms: u64,
    #[serde(default)]
    pub preview: String,
}

/// A market order waiting for the trader to confirm.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketView {
    pub id: String,
    pub network: Network,
    pub symbol: String,
    pub side: Side,
    pub qty: String,
    pub price: String,
    pub notional: String,
    pub leverage: u32,
    pub margin: String,
    pub reduce_only: bool,
    pub stop_loss: Option<String>,
    pub take_profit: Option<String>,
    pub est_liquidation: Option<String>,
    pub effect: String,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Complete,
    Failed,
    Stopped,
}

/// One unit of work: a chat turn, or something the app did on the exchange.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: String,
    /// Conversation id for chat turns; empty for everything else.
    #[serde(default)]
    pub thread: String,
    pub agent: String,
    pub title: String,
    pub network: Network,
    pub time: String,
    pub status: RunStatus,
    #[serde(default)]
    pub steps: Vec<StepView>,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub ms: u64,
    #[serde(default)]
    pub ticket: Option<TicketView>,
    /// What the assistant looked at, in the order it looked.
    #[serde(default)]
    pub cards: Vec<CardView>,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub model: String,
}

/// A conversation in the sidebar.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub id: String,
    /// The first message, shortened.
    pub title: String,
    /// When the latest turn started.
    pub time: String,
    /// Network the conversation started on.
    pub network: Network,
    pub turns: usize,
}

/// What a wallet page in the trader's browser is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WalletTask {
    /// Approve the app's API wallet.
    Connect,
    Deposit,
    Withdraw,
}

/// A wallet page that is waiting for the trader's wallet.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWalletView {
    pub network: Network,
    pub task: WalletTask,
    pub url: String,
}

/// How the last wallet page ended.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletNoticeView {
    pub network: Network,
    pub task: WalletTask,
    /// Whether it ended the way the trader meant it to.
    pub ok: bool,
    pub text: String,
}

/// Everything the user interface renders.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: &'static str,
    pub network: Network,
    pub focus: String,
    pub feed_error: String,
    pub instruments: Vec<InstrumentView>,
    pub quotes: HashMap<String, QuoteView>,
    pub wallets: Vec<WalletView>,
    pub account: Option<AccountView>,
    pub account_error: String,
    /// How the last wallet page ended, until the next one opens.
    pub wallet_notice: Option<WalletNoticeView>,
    pub assistant: AssistantView,
    pub risk: RiskView,
    pub theme: Theme,
    /// The open conversation.
    pub thread: String,
    /// Conversations, latest first.
    pub threads: Vec<ThreadView>,
    /// The open conversation's turns, oldest first.
    pub turns: Vec<RunView>,
    /// What the app did on the exchange outside chat turns, newest first.
    pub activity: Vec<RunView>,
    pub draft: Option<TicketView>,
    pub receipts: HashMap<String, String>,
    /// Why a confirmed ticket was not carried out, by ticket id.
    pub failures: HashMap<String, String>,
    pub servers: Vec<McpView>,
    pub pending_wallet: Option<PendingWalletView>,
    pub busy: bool,
}

/// `[open time ms, open, high, low, close, volume]`.
pub type CandleRow = (i64, String, String, String, String, String);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandleSeries {
    pub symbol: String,
    pub timeframe: String,
    pub rows: Vec<CandleRow>,
    pub source: String,
}

impl CandleSeries {
    pub fn new(symbol: &str, timeframe: &str, source: &str, candles: &[Candle]) -> Self {
        Self {
            symbol: symbol.to_string(),
            timeframe: timeframe.to_string(),
            rows: candles
                .iter()
                .map(|c| {
                    (
                        c.t,
                        decimal_text(c.o),
                        decimal_text(c.h),
                        decimal_text(c.l),
                        decimal_text(c.c),
                        decimal_text(c.v),
                    )
                })
                .collect(),
            source: source.to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRequest {
    pub symbol: String,
    pub side: Side,
    #[serde(default)]
    pub qty: Option<String>,
    #[serde(default)]
    pub notional: Option<String>,
    #[serde(default)]
    pub leverage: Option<u32>,
    #[serde(default)]
    pub reduce_only: Option<bool>,
    #[serde(default)]
    pub stop_loss: Option<String>,
    #[serde(default)]
    pub take_profit: Option<String>,
}

/// Connect with an API wallet created on the exchange's site. `Debug` is not derived:
/// the key must not reach a log.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletKeyRequest {
    pub network: Network,
    pub user: String,
    pub agent_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletBrowserRequest {
    pub network: Network,
    pub days: u32,
}

/// A deposit or a withdrawal to start in the trader's browser.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingRequest {
    pub network: Network,
    pub task: WalletTask,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskRequest {
    pub max_leverage: u32,
    pub isolated: bool,
}

/// Where to look for models. Anything left out falls back to what is stored for
/// the provider. `Debug` is not derived: the key must not reach a log.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsRequest {
    pub provider: Provider,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub gateway: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Connects a model. `Debug` is not derived: the key must not reach a log.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRequest {
    pub provider: Provider,
    #[serde(default)]
    pub model: String,
    /// A new OpenRouter key or Cloudflare token; empty keeps the stored one.
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub gateway: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub effort: Effort,
    #[serde(default)]
    pub live_tickets: bool,
}

/// Streamed to the user interface while a turn runs.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TurnEvent {
    Started {
        run: RunView,
    },
    Text {
        delta: String,
    },
    /// A new model round began; interim text shown so far is superseded.
    Round,
    Reasoning {
        delta: String,
    },
    Step {
        index: usize,
        step: StepView,
    },
    /// Something the assistant looked at.
    Card {
        card: CardView,
    },
    Ticket {
        ticket: TicketView,
    },
    Finished {
        run: RunView,
    },
}

/// Receives [`TurnEvent`]s. The desktop shell forwards them over an IPC channel.
pub trait TurnSink: Sync {
    fn emit(&self, event: TurnEvent);
}

/// Discards events, for work nobody is watching live.
pub struct Silent;

impl TurnSink for Silent {
    fn emit(&self, _: TurnEvent) {}
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn wire_names_match_the_typescript_contract() {
        let step = StepView {
            name: "get_quote".into(),
            detail: "BTCUSDT".into(),
            status: StepStatus::Ok,
            ms: 12,
            preview: "{}".into(),
        };
        assert_eq!(
            serde_json::to_value(TurnEvent::Step { index: 0, step }).expect("json"),
            json!({"type": "step", "index": 0, "step": {"name": "get_quote", "detail": "BTCUSDT", "status": "ok", "ms": 12, "preview": "{}"}})
        );
        assert_eq!(serde_json::to_value(TurnEvent::Round).expect("json"), json!({"type": "round"}));

        let ticket = TicketView {
            id: "a".repeat(32),
            network: Network::Testnet,
            symbol: "BTCUSDT".into(),
            side: Side::Sell,
            qty: "0.015".into(),
            price: "62786.7".into(),
            notional: "941.8".into(),
            leverage: 3,
            margin: "313.93".into(),
            reduce_only: false,
            stop_loss: Some("64000".into()),
            take_profit: None,
            est_liquidation: Some("82100".into()),
            effect: "Opens a 0.015 BTC short at 3x".into(),
            rationale: String::new(),
        };
        let wire = serde_json::to_value(&ticket).expect("json");
        assert_eq!(
            (&wire["side"], &wire["network"], &wire["reduceOnly"], &wire["stopLoss"]),
            (&json!("sell"), &json!("testnet"), &json!(false), &json!("64000"))
        );
        assert!(wire["takeProfit"].is_null() && wire["estLiquidation"] == "82100");

        let request: TicketRequest =
            serde_json::from_value(json!({"symbol": "BTCUSDT", "side": "buy", "notional": "250", "leverage": 5, "stopLoss": "61000"})).expect("request");
        assert_eq!(
            (request.notional.as_deref(), request.qty, request.leverage, request.reduce_only),
            (Some("250"), None, Some(5), None)
        );
        let key: WalletKeyRequest =
            serde_json::from_value(json!({"network": "mainnet", "user": "0xabc", "agentKey": "0xdef"}))
                .expect("request");
        assert_eq!((key.network, key.agent_key.as_str()), (Network::Mainnet, "0xdef"));
        let risk: RiskRequest =
            serde_json::from_value(json!({"maxLeverage": 10, "isolated": false})).expect("request");
        assert_eq!((risk.max_leverage, risk.isolated), (10, false));

        // A run written before the perpetuals rewrite named a feed instead of a network and is not loaded.
        assert!(serde_json::from_value::<RunView>(json!({"id": "1", "agent": "a", "title": "t", "feed": "sample", "time": "t", "status": "complete"})).is_err());
        let run: RunView =
            serde_json::from_value(json!({"id": "1", "agent": "a", "title": "t", "network": "testnet", "time": "t", "status": "complete"})).expect("run");
        assert!(run.thread.is_empty() && run.steps.is_empty() && run.usage.is_none() && run.cards.is_empty());
        let order = OpenOrderView {
            id: "7".into(),
            client_id: String::new(),
            symbol: "BTCUSDT".into(),
            side: Side::Buy,
            kind: "STOP_MARKET".into(),
            price: None,
            stop_price: Some("1".into()),
            qty: "1".into(),
            filled: "0".into(),
            reduce_only: true,
            status: "NEW".into(),
            time: String::new(),
        };
        assert_eq!(serde_json::to_value(order).expect("json")["type"], "STOP_MARKET");
    }
}
