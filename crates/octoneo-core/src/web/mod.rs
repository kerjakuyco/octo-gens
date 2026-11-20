//! News and web pages for the assistant and the News page.
//!
//! Three things leave this computer here, and only while web search is on: the
//! app reads the public news feeds of a fixed list of publishers, it reads a
//! single page when the assistant asks for one, and it fetches the picture of a
//! story on the News page from the address that story's feed gave for it, when
//! the page shows it. A search is answered from the feeds already read, on this
//! computer, so what the trader types is not sent anywhere, with one
//! exception: the ticker of a share, a fund or a commodity that was asked about
//! goes to Yahoo Finance, which files its news by ticker. No key and no account
//! is involved. An article opened on the News page is loaded by the desktop
//! shell's own browser view, not here, once [`public_link`] has passed it.
//!
//! Everything that comes back was written by strangers. It is handed to the
//! model as data, a picture is passed on only when its first bytes show it is
//! one, and [`guard`] decides which addresses may be read at all.

mod feed;
mod guard;
mod page;
mod picture;
mod rank;
mod text;

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use futures_util::future::join_all;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Response};
use url::Url;

pub use feed::Article;
pub use picture::Picture;
pub use text::fit;

use crate::error::{DeskError, Result};
use crate::net::unreachable;
use crate::{bail, desk_err};
use guard::{Guard, PublicOnly};
use picture::{Album, Offered};
use rank::{Coin, Indexed, Mentions, Query, normal};

/// The publishers whose feeds are read: crypto newsrooms, the Federal
/// Reserve's own press releases, and Yahoo Finance for the stock market. Each
/// feed is the publisher's public RSS. `true` marks a feed that gathers other
/// publishers' articles, so its links lead off its own site.
const PUBLISHERS: [(&str, &str, bool); 8] = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", false),
    ("Cointelegraph", "https://cointelegraph.com/rss", false),
    ("The Block", "https://www.theblock.co/rss.xml", false),
    ("Decrypt", "https://decrypt.co/feed", false),
    ("The Defiant", "https://thedefiant.io/feed", false),
    ("crypto.news", "https://crypto.news/feed/", false),
    (FED, "https://www.federalreserve.gov/feeds/press_all.xml", false),
    // Yahoo Finance has no feed of everything; the news filed under the S&P 500 is its market news.
    (YAHOO, "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US", true),
];
const FED: &str = "Federal Reserve";
const YAHOO: &str = "Yahoo Finance";
/// The publishers that report on the economy and the stock market rather than on crypto.
const MACRO: [&str; 2] = [FED, YAHOO];
/// Where Yahoo Finance serves the headlines filed under one ticker: `?s=NVDA`.
const BY_TICKER: &str = "https://feeds.finance.yahoo.com/rss/2.0/headline";
/// Tickers looked up for one search, and kept in memory at once.
const TICKERS: usize = 3;
const TICKERS_KEPT: usize = 32;

/// Headlines returned by one search.
pub const RESULTS: usize = 8;
/// How long the feeds are kept before they are read again. Publishers ask for five minutes.
const FRESH: Duration = Duration::from_secs(300);
/// If no publisher can be reached, headlines up to this old are better than none.
const KEPT: Duration = Duration::from_secs(7200);
const FEED_TIMEOUT: Duration = Duration::from_secs(8);
const PAGE_TIMEOUT: Duration = Duration::from_secs(20);
/// Reading the text out of a page. A page built to be slow to read is given up on.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Less text than this is a teaser or the opening lines, not an article.
const ARTICLE_MIN_CHARS: usize = 400;
const FEED_LIMIT: usize = 2_000_000;
const PAGE_LIMIT: usize = 2_000_000;
const HEADERS_LIMIT: u32 = 256 * 1024;
const REDIRECTS: usize = 5;
/// Stories on the News page: a few hours of news from every publisher.
const STORIES: usize = 120;
/// Markets shown with one story. A story naming more is a roundup, and its first few say what it is about.
const STORY_MARKETS: usize = 6;
/// A picture is a few hundred kilobytes. One that takes longer than this, or is larger, is not waited for.
const PICTURE_TIMEOUT: Duration = Duration::from_secs(10);
const PICTURE_LIMIT: usize = 4 * 1024 * 1024;
/// The kinds of picture that are shown, best first. Anything else is refused when it arrives.
const PICTURE_KINDS: &str = "image/avif, image/webp, image/png, image/jpeg, image/gif;q=0.9, */*;q=0.1";

/// A web page, reduced to its text.
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    /// Where the text came from, after any redirect.
    pub url: String,
    pub title: String,
    /// The publisher's name, or the site's address.
    pub site: String,
    /// When it was published, if the page says so.
    pub published: Option<String>,
    pub text: String,
    /// Only a summary or the opening lines could be read, not the article.
    pub summary_only: bool,
}

/// A share, a fund or a commodity whose own headlines a search should include.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticker {
    /// The word it was asked for by, e.g. `nvidia` or `NVDAUSDT`.
    pub asked: String,
    /// What the financial news files it under, e.g. `NVDA` or `GC=F`.
    pub symbol: String,
    /// Other words for the same thing, e.g. `nvidia`. Newsrooms that do not
    /// file by ticker write the company's name.
    pub names: Vec<String>,
}

/// Where a story belongs on the News page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desk {
    /// The crypto newsrooms.
    Crypto,
    /// The economy and the stock market: the Federal Reserve and Yahoo Finance.
    Macro,
}

/// One story on the News page.
#[derive(Clone, Debug, PartialEq)]
pub struct Story {
    pub article: Article,
    pub desk: Desk,
}

/// The News page: the newest stories from every publisher, one copy of each, as
/// one read of the feeds found them.
#[derive(Clone, Debug, PartialEq)]
pub struct Front {
    /// Newest first; stories that give no time come last.
    pub stories: Vec<Story>,
    /// Every publisher read, in the order they are read.
    pub publishers: Vec<String>,
    /// The publishers that did not answer the last read. When nobody answered and
    /// stories read earlier are shown instead, that is every publisher.
    pub missing: Vec<String>,
    /// When the stories shown were read.
    pub read_at: DateTime<Utc>,
}

/// The coins a list of markets trades, to tell which markets a story is about.
#[derive(Default)]
pub struct Coins {
    /// `(market, coin)`, in the order given.
    markets: Vec<(String, Coin)>,
    /// The few markets whose coin has names, which are looked for in every story.
    named: Vec<usize>,
    /// The markets by ticker. A story's words in capitals are looked up here, so
    /// that hundreds of markets are not tried against every story.
    tickers: HashMap<String, Vec<usize>>,
}

impl Coins {
    /// From `(market, base asset)` pairs such as `("BTCUSDT", "BTC")`, one market per coin.
    pub fn new<'a>(markets: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut coins = Self::default();
        for (symbol, base) in markets {
            let Some(coin) = Coin::new(base) else {
                continue;
            };
            let at = coins.markets.len();
            if coin.has_names() {
                coins.named.push(at);
            }
            if let Some(ticker) = coin.ticker() {
                coins.tickers.entry(ticker.to_string()).or_default().push(at);
            }
            coins.markets.push((symbol.to_string(), coin));
        }
        coins
    }

    /// The markets whose coin a story names in its headline, its topics or its
    /// summary, by ticker or by name. Those named in the headline come first; among
    /// equals, the order the markets were given in.
    pub fn named_in(&self, article: &Article) -> Vec<String> {
        if self.markets.is_empty() {
            return Vec::new();
        }
        let mentions = Mentions::new(article);
        let by_ticker = mentions.capitals().filter_map(|word| self.tickers.get(word)).flatten();
        let mut tried: Vec<usize> = by_ticker.chain(&self.named).copied().collect();
        tried.sort_unstable();
        tried.dedup();
        let mut named: Vec<(u32, usize)> = tried
            .into_iter()
            .map(|at| (mentions.of(&self.markets[at].1), at))
            .filter(|(place, _)| *place > 0)
            .collect();
        named.sort_by_key(|(place, _)| Reverse(*place));
        named.into_iter().take(STORY_MARKETS).map(|(_, at)| self.markets[at].0.clone()).collect()
    }
}

/// `address`, tidied, if it is an ordinary public https page by the rule every
/// read here follows, else an error that says so. The desktop shell asks before
/// it opens an article in its own browser view.
pub fn public_link(address: &str) -> Result<String> {
    Ok(Guard::Public.parse(address)?.into())
}

/// The tickers a query names, according to `known`, which says what the news
/// calls a word and what else it calls the same thing. Each ticker once, and
/// no more than a search looks up.
pub fn tickers_in(query: &str, known: impl Fn(&str) -> Option<(String, Vec<String>)>) -> Vec<Ticker> {
    let mut found: Vec<Ticker> = Vec::new();
    for word in query.split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()) {
        if let Some((symbol, names)) = known(word)
            && found.iter().all(|ticker| ticker.symbol != symbol)
        {
            found.push(Ticker { asked: word.to_string(), symbol, names });
        }
        if found.len() == TICKERS {
            break;
        }
    }
    found
}

struct Feed {
    name: String,
    url: String,
    gathers: bool,
}

struct Wire {
    read_at: Instant,
    articles: Arc<Vec<Indexed>>,
}

/// Every feed, as one read found them.
#[derive(Clone)]
struct Edition {
    /// When the read was made, by the clock that says how old it is.
    read_at: Instant,
    /// The same moment by the calendar, for the reader.
    at: DateTime<Utc>,
    articles: Arc<Vec<Indexed>>,
    /// The publishers that did not answer, in the order they are read.
    missing: Vec<String>,
}

/// Reads news feeds and web pages.
pub struct Web {
    http: Client,
    guard: Guard,
    feeds: Vec<Feed>,
    /// Where the headlines filed under one ticker are asked for. `None`: nowhere.
    by_ticker: Option<String>,
    /// The feeds as last read. Held while they are being read again, so two searches read them once.
    wire: tokio::sync::Mutex<Option<Edition>>,
    /// The headlines of each ticker asked about, as last read.
    tickers: tokio::sync::Mutex<HashMap<String, Wire>>,
    /// How long what was read is used before it is read again, and how long it may stand in
    /// when nobody answers. [`FRESH`] and [`KEPT`], except in tests that cannot wait for them.
    fresh: Duration,
    kept: Duration,
    /// The pictures of the stories the News page was given. No other picture is fetched.
    offered: Mutex<Offered>,
    /// Pictures fetched lately.
    album: Mutex<Album>,
}

fn client(guard: Guard) -> Result<Client> {
    let redirects = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > REDIRECTS {
            return attempt.error("too many redirects");
        }
        match guard.check(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(error) => attempt.error(error),
        }
    });
    let builder = Client::builder()
        // Says plainly what is asking. A site that does not want to be read by an app can tell.
        .user_agent(concat!("Mozilla/5.0 (compatible; OctoNeo/", env!("CARGO_PKG_VERSION"), ")"))
        .redirect(redirects)
        .referer(false)
        // Some sites answer with tens of kilobytes of headers, more than is allowed for by default.
        .http2_max_header_list_size(HEADERS_LIMIT)
        .connect_timeout(Duration::from_secs(8))
        .timeout(PAGE_TIMEOUT);
    let builder = match guard {
        Guard::Public => builder.https_only(true).dns_resolver(Arc::new(PublicOnly)),
        Guard::Open => builder,
    };
    builder.build().map_err(|error| desk_err!("The web client could not start: {error}."))
}

/// The body of a response, up to `limit` bytes. What lies beyond is not read.
async fn body(response: Response, limit: usize) -> std::result::Result<Vec<u8>, reqwest::Error> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let room = limit - body.len();
        if chunk.len() >= room {
            body.extend_from_slice(&chunk[..room]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// `(kind, charset)` of a response, both lower-case: `("text/html", Some("utf-8"))`.
fn content_type(response: &Response) -> (String, Option<String>) {
    let header =
        response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or_default();
    let mut parts = header.split(';').map(|part| part.trim().to_ascii_lowercase());
    let kind = parts.next().unwrap_or_default();
    let charset = parts.find_map(|part| {
        part.strip_prefix("charset=").map(|label| label.trim_matches(['"', '\'']).to_string())
    });
    (kind, charset)
}

/// The encoding a page names for itself in its first bytes, e.g. `<meta charset="windows-1252">`.
fn declared_charset(bytes: &[u8]) -> Option<String> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    let after = &head[head.find("charset=")? + "charset=".len()..];
    let label: String = after
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    (!label.is_empty()).then_some(label)
}

/// Bytes as text. The server's word on the encoding comes first, then the page's own, then UTF-8.
fn decode(bytes: &[u8], charset: Option<&str>) -> String {
    let declared = declared_charset(bytes);
    let encoding = charset
        .or(declared.as_deref())
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

/// A site's name without the `www.` nobody says.
fn site_of(url: &Url) -> String {
    url.host_str().unwrap_or("the site").trim_start_matches("www.").to_string()
}

fn desk_of(publisher: &str) -> Desk {
    if MACRO.contains(&publisher) { Desk::Macro } else { Desk::Crypto }
}

/// A lock that a panic elsewhere does not leave closed for good.
fn held<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether two sites belong to one publisher, judged by the end of their names.
fn same_site(a: &Url, b: &Url) -> bool {
    let tail = |url: &Url| -> Option<String> {
        let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
        let mut labels = host.rsplit('.');
        let (last, second) = (labels.next()?, labels.next()?);
        Some(format!("{second}.{last}"))
    };
    tail(a).is_some() && tail(a) == tail(b)
}

impl Web {
    pub fn new() -> Result<Self> {
        let feed = |(name, url, gathers): &(&str, &str, bool)| Feed {
            name: (*name).to_string(),
            url: (*url).to_string(),
            gathers: *gathers,
        };
        Ok(Self {
            http: client(Guard::Public)?,
            guard: Guard::Public,
            feeds: PUBLISHERS.iter().map(feed).collect(),
            by_ticker: Some(BY_TICKER.to_string()),
            wire: tokio::sync::Mutex::new(None),
            tickers: tokio::sync::Mutex::new(HashMap::new()),
            fresh: FRESH,
            kept: KEPT,
            offered: Mutex::default(),
            album: Mutex::default(),
        })
    }

    /// Reads from stand-in feeds, given as `(publisher, address)`, with an
    /// optional stand-in for the headlines filed by ticker, and lifts the rule
    /// that only public https addresses are read. For tests.
    pub fn standing_in(feeds: Vec<(String, String)>, by_ticker: Option<String>) -> Result<Self> {
        Ok(Self {
            http: client(Guard::Open)?,
            guard: Guard::Open,
            feeds: feeds.into_iter().map(|(name, url)| Feed { name, url, gathers: false }).collect(),
            by_ticker,
            wire: tokio::sync::Mutex::new(None),
            tickers: tokio::sync::Mutex::new(HashMap::new()),
            fresh: FRESH,
            kept: KEPT,
            offered: Mutex::default(),
            album: Mutex::default(),
        })
    }

    /// The publishers read, by name.
    pub fn publishers(&self) -> Vec<&str> {
        self.feeds.iter().map(|feed| feed.name.as_str()).collect()
    }

    async fn feed(&self, name: &str, address: &str, gathers: bool) -> Result<Vec<Article>> {
        let url = self.guard.parse(address)?;
        let request = self
            .http
            .get(url.clone())
            .header(ACCEPT, "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8")
            .timeout(FEED_TIMEOUT);
        let response = request.send().await.map_err(|error| unreachable(name, error))?;
        let status = response.status();
        if !status.is_success() {
            bail!("{name} did not send its news ({}).", status.as_u16());
        }
        let (_, charset) = content_type(&response);
        let bytes = body(response, FEED_LIMIT).await.map_err(|error| unreachable(name, error))?;
        let mut articles = feed::parse(&decode(&bytes, charset.as_deref()), name, self.guard)?;
        if self.guard == Guard::Public && !gathers {
            // A publisher's feed links to the publisher's own pages. Anything else is not its news.
            articles.retain(|article| Url::parse(&article.url).is_ok_and(|link| same_site(&link, &url)));
        }
        Ok(articles)
    }

    /// The headlines filed under one ticker, read again when they are older
    /// than a few minutes. `None` when there are none to be had: a search is
    /// not failed for want of them.
    async fn about(&self, ticker: &Ticker) -> Option<Arc<Vec<Indexed>>> {
        let base = self.by_ticker.as_deref()?;
        let mut held = self.tickers.lock().await;
        if let Some(wire) = held.get(&ticker.symbol).filter(|wire| wire.read_at.elapsed() < self.fresh) {
            return Some(wire.articles.clone());
        }
        let asked = [("s", ticker.symbol.as_str()), ("region", "US"), ("lang", "en-US")];
        let address = Url::parse_with_params(base, asked).ok()?;
        let found = self.feed(YAHOO, address.as_str(), true).await.ok()?;
        let filed = |mut article: Article| {
            // The feed is about this ticker whether or not a headline spells it out.
            article.topics.push(ticker.symbol.clone());
            Indexed::new(article)
        };
        let articles: Arc<Vec<Indexed>> = Arc::new(found.into_iter().map(filed).collect());
        if held.len() >= TICKERS_KEPT {
            held.clear();
        }
        held.insert(ticker.symbol.clone(), Wire { read_at: Instant::now(), articles: articles.clone() });
        Some(articles)
    }

    /// The feeds, read again when they are older than a few minutes.
    async fn wire(&self) -> Result<Edition> {
        let mut wire = self.wire.lock().await;
        if let Some(held) = wire.as_ref().filter(|held| held.read_at.elapsed() < self.fresh) {
            return Ok(held.clone());
        }
        let read =
            join_all(self.feeds.iter().map(|feed| self.feed(&feed.name, &feed.url, feed.gathers))).await;
        let mut failure: Option<DeskError> = None;
        let mut articles = Vec::new();
        let mut missing = Vec::new();
        for (feed, outcome) in self.feeds.iter().zip(read) {
            match outcome {
                Ok(found) => articles.extend(found.into_iter().map(Indexed::new)),
                Err(error) => {
                    missing.push(feed.name.clone());
                    failure.get_or_insert(error);
                }
            }
        }
        if missing.len() == self.feeds.len() {
            // Nobody answered. Headlines read a while ago still say what happened today, and
            // whoever shows them can say that no publisher was reached.
            if let Some(held) = wire.as_ref().filter(|held| held.read_at.elapsed() < self.kept) {
                return Ok(Edition { missing, ..held.clone() });
            }
            return Err(failure.unwrap_or_else(|| desk_err!("No news source is set up.")));
        }
        let edition =
            Edition { read_at: Instant::now(), at: Utc::now(), articles: Arc::new(articles), missing };
        *wire = Some(edition.clone());
        Ok(edition)
    }

    /// Recent news about `query`, best match first. An empty query gives the
    /// newest headlines. `tickers` are the shares, funds and commodities the
    /// query names: their own headlines are fetched and searched too.
    pub async fn search(&self, query: &str, tickers: &[Ticker]) -> Result<Vec<Article>> {
        let mut asked = Query::new(query);
        let mut about = Vec::new();
        for ticker in tickers.iter().take(TICKERS) {
            asked.also(&ticker.asked, &ticker.symbol);
            for name in &ticker.names {
                asked.also(&ticker.symbol, name);
            }
            if let Some(found) = self.about(ticker).await {
                about.push(found);
            }
        }
        let wire = match self.wire().await {
            Ok(edition) => Some(edition.articles),
            // The newsrooms are out of reach, but the headlines about what was asked for are here.
            Err(_) if about.iter().any(|found| !found.is_empty()) => None,
            Err(error) => return Err(error),
        };
        let all = wire.iter().flat_map(|wire| wire.iter()).chain(about.iter().flat_map(|found| found.iter()));
        Ok(rank::pick(all, &asked, RESULTS).into_iter().cloned().collect())
    }

    /// The News page: every story the feeds hold, one copy of each, newest first,
    /// read again when the copy held is older than a few minutes. The headlines
    /// fetched for one ticker are a search's, not the page's. The stories'
    /// pictures may be fetched with [`Web::picture`] from then on.
    pub async fn front(&self) -> Result<Front> {
        let edition = self.wire().await?;
        let mut newest: Vec<&Article> = edition.articles.iter().map(|indexed| &indexed.article).collect();
        // Newest first, and those that give no time last. Among equals, the order the feeds were read in.
        newest.sort_by_key(|article| Reverse(article.published));
        let (mut links, mut headlines) = (HashSet::new(), HashSet::new());
        let mut stories = Vec::new();
        for article in newest {
            // One story twice: the same link, or the same headline from the same publisher. Headlines
            // are compared by their words; one with none, all emoji say, as it is written.
            let words = normal(&article.title);
            let headline = if words.is_empty() { article.title.clone() } else { words };
            let new_link = links.insert(article.url.as_str());
            let new_headline = headlines.insert((article.source.as_str(), headline));
            if new_link && new_headline {
                stories.push(Story { article: article.clone(), desk: desk_of(&article.source) });
            }
            if stories.len() == STORIES {
                break;
            }
        }
        // What the page is given is what it may ask to see.
        let mut offered = held(&self.offered);
        for image in stories.iter().filter_map(|story| story.article.image.clone()) {
            offered.add(image);
        }
        drop(offered);
        Ok(Front {
            stories,
            publishers: self.publishers().into_iter().map(str::to_string).collect(),
            missing: edition.missing,
            read_at: edition.at,
        })
    }

    /// The picture of a story the News page was given, for the interface, which
    /// cannot reach the web. The bytes must show it is a JPEG, PNG, WebP, GIF or
    /// AVIF picture, whatever the server calls it, and a picture shown lately is
    /// not fetched again.
    pub async fn picture(&self, address: &str) -> Result<Picture> {
        let Some(url) = self.guard.parse(address).ok().filter(|url| held(&self.offered).has(url.as_str()))
        else {
            bail!("That picture is not one the News page showed.");
        };
        if let Some(picture) = held(&self.album).get(url.as_str()) {
            return Ok(picture);
        }
        let site = site_of(&url);
        let lost = |error: reqwest::Error| {
            if error.is_redirect() {
                desk_err!("{site} sends this picture somewhere that cannot be read.")
            } else {
                unreachable(&site, error)
            }
        };
        let request = self.http.get(url.clone()).header(ACCEPT, PICTURE_KINDS).timeout(PICTURE_TIMEOUT);
        let response = request.send().await.map_err(lost)?;
        let status = response.status();
        if !status.is_success() {
            bail!("{site} did not send the picture ({}).", status.as_u16());
        }
        let too_large = || desk_err!("{site} sent a picture too large to show.");
        if response.content_length().is_some_and(|length| length > PICTURE_LIMIT as u64) {
            return Err(too_large());
        }
        // One byte past the limit is enough to know that the picture goes past it.
        let bytes = body(response, PICTURE_LIMIT + 1).await.map_err(lost)?;
        if bytes.len() > PICTURE_LIMIT {
            return Err(too_large());
        }
        let Some(kind) = picture::kind(&bytes) else {
            bail!("{site} sent something that is not a picture.");
        };
        let picture = Picture { content_type: kind.to_string(), bytes };
        held(&self.album).put(url.into(), picture.clone());
        Ok(picture)
    }

    /// An article the feeds carried whole, if `url` is one.
    async fn carried(&self, url: &Url) -> Option<Page> {
        let wire = self.wire.lock().await;
        let articles = &wire.as_ref()?.articles;
        let article = articles.iter().map(|indexed| &indexed.article).find(|a| a.url == url.as_str())?;
        Some(Page {
            url: article.url.clone(),
            title: article.title.clone(),
            site: article.source.clone(),
            published: article.published.map(|at| at.format("%Y-%m-%d %H:%M").to_string()),
            text: article.body.clone()?,
            summary_only: false,
        })
    }

    /// Reads one page and returns its text. The address must be an ordinary
    /// public web page, and so must every address it redirects to.
    pub async fn read(&self, address: &str) -> Result<Page> {
        let url = self.guard.parse(address)?;
        if let Some(page) = self.carried(&url).await {
            return Ok(page);
        }
        let site = site_of(&url);
        let lost = |error: reqwest::Error| {
            if error.is_redirect() {
                desk_err!("{site} sends this link somewhere that cannot be read.")
            } else {
                unreachable(&site, error)
            }
        };
        let request =
            self.http.get(url).header(ACCEPT, "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8");
        let response = request.send().await.map_err(lost)?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 402 | 403 | 429 | 451 => bail!(
                "{site} does not let apps read this page. Work from the headline and summary, or use another source."
            ),
            404 | 410 => bail!("{site} no longer has that page."),
            code => bail!("{site} could not send the page ({code})."),
        }
        let (kind, charset) = content_type(&response);
        // No stated kind is taken for a page; anything else that is not text is not read.
        if !matches!(kind.as_str(), "" | "text/html" | "application/xhtml+xml" | "text/plain") {
            bail!("That link is not a page of text.");
        }
        let landed = response.url().clone();
        let bytes = body(response, PAGE_LIMIT).await.map_err(lost)?;
        let content = decode(&bytes, charset.as_deref());
        let site = site_of(&landed);
        if kind == "text/plain" {
            let lines: Vec<String> =
                content.lines().map(text::squeeze).filter(|line| !line.is_empty()).collect();
            return Ok(Page {
                url: landed.into(),
                title: String::new(),
                site,
                published: None,
                text: lines.join("\n"),
                summary_only: false,
            });
        }
        // Parsing is plain computation and can be slow on a hostile page, so it
        // runs off the async threads and is given up on rather than waited for.
        let reading = tokio::task::spawn_blocking(move || page::extract(&content));
        let Ok(Ok(found)) = tokio::time::timeout(READ_TIMEOUT, reading).await else {
            bail!("{site} sent a page that cannot be read.");
        };
        let (text, summary_only) = match (found.text.is_empty(), found.description.is_empty()) {
            // A site that draws its article with scripts often leaves only the opening lines in the page.
            (false, _) => {
                let short = found.text.chars().count() < ARTICLE_MIN_CHARS;
                (found.text, short)
            }
            (true, false) => (found.description, true),
            (true, true) => bail!("{site} sent a page with no text to read. It may need a browser."),
        };
        Ok(Page {
            url: landed.into(),
            title: found.title,
            site: if found.site.is_empty() { site } else { found.site },
            published: found.published,
            text,
            summary_only,
        })
    }
}

#[cfg(test)]
mod tests;
