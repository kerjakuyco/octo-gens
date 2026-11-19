//! News and web pages for the assistant.
//!
//! Two things leave this computer here, and only while web search is on: the
//! app reads the public news feeds of a fixed list of publishers, and it reads
//! a single page when the assistant asks for one. A search is answered from
//! the feeds already read, on this computer, so what the trader types is not
//! sent anywhere, with one exception: the ticker of a share, a fund or a
//! commodity that was asked about goes to Yahoo Finance, which files its news
//! by ticker. No key and no account is involved.
//!
//! Everything that comes back was written by strangers. It is handed to the
//! model as data, and [`guard`] decides which addresses may be read at all.

mod feed;
mod guard;
mod page;
mod rank;
mod text;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::future::join_all;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Response};
use url::Url;

pub use feed::Article;
pub use text::fit;

use crate::error::{DeskError, Result};
use crate::net::unreachable;
use crate::{bail, desk_err};
use guard::{Guard, PublicOnly};
use rank::{Indexed, Query};

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
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", false),
    // Yahoo Finance has no feed of everything; the news filed under the S&P 500 is its market news.
    (YAHOO, "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US", true),
];
const YAHOO: &str = "Yahoo Finance";
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

/// Reads news feeds and web pages.
pub struct Web {
    http: Client,
    guard: Guard,
    feeds: Vec<Feed>,
    /// Where the headlines filed under one ticker are asked for. `None`: nowhere.
    by_ticker: Option<String>,
    /// The feeds as last read. Held while they are being read again, so two searches read them once.
    wire: tokio::sync::Mutex<Option<Wire>>,
    /// The headlines of each ticker asked about, as last read.
    tickers: tokio::sync::Mutex<HashMap<String, Wire>>,
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
        if let Some(wire) = held.get(&ticker.symbol).filter(|wire| wire.read_at.elapsed() < FRESH) {
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
    async fn wire(&self) -> Result<Arc<Vec<Indexed>>> {
        let mut wire = self.wire.lock().await;
        if let Some(held) = wire.as_ref().filter(|held| held.read_at.elapsed() < FRESH) {
            return Ok(held.articles.clone());
        }
        let read =
            join_all(self.feeds.iter().map(|feed| self.feed(&feed.name, &feed.url, feed.gathers))).await;
        let mut failure: Option<DeskError> = None;
        let mut articles = Vec::new();
        let mut answered = 0;
        for outcome in read {
            match outcome {
                Ok(found) => {
                    answered += 1;
                    articles.extend(found.into_iter().map(Indexed::new));
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        if answered == 0 {
            // Nobody answered. Headlines read a while ago still say what happened today.
            if let Some(held) = wire.as_ref().filter(|held| held.read_at.elapsed() < KEPT) {
                return Ok(held.articles.clone());
            }
            return Err(failure.unwrap_or_else(|| desk_err!("No news source is set up.")));
        }
        let articles = Arc::new(articles);
        *wire = Some(Wire { read_at: Instant::now(), articles: articles.clone() });
        Ok(articles)
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
            Ok(wire) => Some(wire),
            // The newsrooms are out of reach, but the headlines about what was asked for are here.
            Err(_) if about.iter().any(|found| !found.is_empty()) => None,
            Err(error) => return Err(error),
        };
        let all = wire.iter().flat_map(|wire| wire.iter()).chain(about.iter().flat_map(|found| found.iter()));
        Ok(rank::pick(all, &asked, RESULTS).into_iter().cloned().collect())
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
