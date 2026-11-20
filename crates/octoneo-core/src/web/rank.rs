//! Finds the headlines a few words are about, and the coins a story names.
//!
//! The news the app holds is a few hundred recent articles, so this is not a
//! search engine: it matches words. What makes it useful for markets is that
//! it knows a ticker and a name are the same thing ("BTC" finds "Bitcoin"),
//! and that it prefers a match in the headline, then newer over older.

use std::collections::{HashMap, HashSet};

use super::feed::Article;

/// Words that say nothing about the subject.
const FILLER: &[&str] = &[
    "a",
    "an",
    "the",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "for",
    "with",
    "by",
    "at",
    "from",
    "about",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "why",
    "what",
    "when",
    "where",
    "who",
    "how",
    "which",
    "will",
    "would",
    "could",
    "should",
    "can",
    "do",
    "does",
    "did",
    "has",
    "have",
    "had",
    "not",
    "no",
    "vs",
    "than",
    "then",
    "so",
    "if",
    "into",
    "over",
    "after",
    "before",
    "today",
    "yesterday",
    "now",
    "latest",
    "recent",
    "recently",
    "current",
    "currently",
    "news",
    "headline",
    "update",
    "week",
    "month",
    "year",
    "daily",
    "weekly",
    "happening",
    "going",
    "me",
    "my",
    "any",
    "there",
];

/// Names that mean the same market. A query word matching a key on the left
/// is looked for as any phrase on the right. A ticker that is also an ordinary
/// word ("link", "near", "dot") is left out on the right, so it finds its coin
/// and not every sentence that uses the word.
const SAME: &[(&[&str], &[&str])] = &[
    (&["btc", "xbt", "bitcoin"], &["btc", "bitcoin"]),
    (&["eth", "ethereum", "ether"], &["eth", "ethereum", "ether"]),
    (&["sol", "solana"], &["sol", "solana"]),
    (&["xrp", "ripple"], &["xrp", "ripple"]),
    (&["bnb"], &["bnb", "bnb chain"]),
    (&["doge", "dogecoin"], &["doge", "dogecoin"]),
    (&["ada", "cardano"], &["cardano"]),
    (&["avax", "avalanche"], &["avax", "avalanche"]),
    (&["link", "chainlink"], &["chainlink"]),
    (&["dot", "polkadot"], &["polkadot"]),
    (&["ltc", "litecoin"], &["ltc", "litecoin"]),
    (&["trx", "tron"], &["trx", "tron"]),
    (&["ton", "toncoin"], &["toncoin", "ton"]),
    (&["apt", "aptos"], &["aptos"]),
    (&["arb", "arbitrum"], &["arbitrum"]),
    (&["op", "optimism"], &["optimism"]),
    (&["near"], &["near protocol"]),
    (&["atom", "cosmos"], &["cosmos"]),
    (&["uni", "uniswap"], &["uniswap"]),
    (&["hype", "hyperliquid"], &["hyperliquid"]),
    (&["shib"], &["shib", "shiba inu"]),
    (&["bch"], &["bch", "bitcoin cash"]),
    (&["xlm", "stellar"], &["xlm", "stellar"]),
    (&["hbar", "hedera"], &["hbar", "hedera"]),
    (&["tao", "bittensor"], &["bittensor"]),
    (&["ena", "ethena"], &["ethena"]),
    (&["wld", "worldcoin"], &["worldcoin"]),
    (&["xau", "gold"], &["gold"]),
    (&["xag", "silver"], &["silver"]),
    (&["fed", "fomc"], &["fed", "fomc", "federal reserve", "federal open market committee"]),
    (&["sec"], &["sec", "securities and exchange commission"]),
];

/// Letters the news writes in capitals for something other than a coin, though a
/// coin may trade under them: "AI agents", "US stocks", the "GENIUS Act".
const NOT_TICKERS: &[&str] = &["ai", "us", "uk", "eu", "id", "ceo", "ipo", "etf", "genius"];

/// What a market symbol ends with: `BTCUSDT` is about `BTC`.
const QUOTES: [&str; 4] = ["usdt", "usdc", "usd1", "usd"];
/// Words of a query that are looked for. More than this and the query is an essay.
const TERMS: usize = 8;
/// Articles from one publisher in a result, while others have something to offer.
const PER_SOURCE: usize = 3;

/// A word in the form it is compared in: a plural is its singular.
fn stem(word: &str) -> &str {
    if word.len() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        &word[..word.len() - 1]
    } else {
        word
    }
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| stem(word).to_string())
        .collect()
}

/// Text as a run of words with a space on both sides of each, so that a
/// phrase is found only as whole words: `" sol "` is not in `" solana "`.
pub(crate) fn normal(text: &str) -> String {
    let words = words(text);
    if words.is_empty() { String::new() } else { format!(" {} ", words.join(" ")) }
}

/// What a query asks for: each term is satisfied by any of its phrases.
#[derive(Debug, PartialEq)]
pub(crate) struct Query {
    terms: Vec<Vec<String>>,
}

impl Query {
    pub(crate) fn new(text: &str) -> Self {
        let mut seen = HashSet::new();
        let mut terms = Vec::new();
        for word in words(text) {
            // A market symbol stands for its base asset.
            let word = QUOTES
                .iter()
                .find_map(|quote| word.strip_suffix(quote).filter(|base| base.len() >= 2))
                .map_or(word.clone(), str::to_string);
            if word.chars().count() < 2 || FILLER.iter().any(|filler| stem(filler) == word) {
                continue;
            }
            let same = SAME.iter().find(|(keys, _)| keys.iter().any(|key| stem(key) == word));
            let phrases: Vec<String> = match same {
                Some((_, phrases)) => phrases.iter().map(|phrase| normal(phrase)).collect(),
                None => vec![format!(" {word} ")],
            };
            if seen.insert(phrases.clone()) {
                terms.push(phrases);
            }
            if terms.len() == TERMS {
                break;
            }
        }
        Self { terms }
    }

    /// Nothing to look for: the query was empty or all filler.
    pub(crate) fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// Lets one thing the query asks for also be found under another name: a
    /// company under its ticker, whichever of the two was typed.
    pub(crate) fn also(&mut self, word: &str, name: &str) {
        let names: Vec<String> = [word, name].into_iter().map(normal).filter(|n| !n.is_empty()).collect();
        if names.is_empty() {
            return;
        }
        match self.terms.iter_mut().find(|phrases| names.iter().any(|name| phrases.contains(name))) {
            Some(phrases) => {
                for name in names {
                    if !phrases.contains(&name) {
                        phrases.push(name);
                    }
                }
            }
            None => self.terms.push(names),
        }
    }
}

/// An article with its text prepared for matching.
pub(crate) struct Indexed {
    pub article: Article,
    title: String,
    filed: String,
    summary: String,
    /// The headline's words, to tell two reports of one story apart from two stories.
    key: HashSet<String>,
}

impl Indexed {
    pub(crate) fn new(article: Article) -> Self {
        let filed = format!("{} {}", article.topics.join(" . "), article.source);
        Self {
            title: normal(&article.title),
            filed: normal(&filed),
            summary: normal(&article.summary),
            key: words(&article.title).into_iter().filter(|word| word.chars().count() > 2).collect(),
            article,
        }
    }

    /// `(terms found, weight)`: a headline counts for more than a topic, a topic for more than the summary.
    fn score(&self, query: &Query) -> (usize, u32) {
        let mut found = (0, 0);
        for phrases in &query.terms {
            let within = |text: &str| phrases.iter().any(|phrase| text.contains(phrase.as_str()));
            let weight = if within(&self.title) {
                3
            } else if within(&self.filed) {
                2
            } else if within(&self.summary) {
                1
            } else {
                continue;
            };
            found = (found.0 + 1, found.1 + weight);
        }
        found
    }

    /// Two outlets reporting one story use mostly the same words in the headline.
    fn same_story(&self, other: &Indexed) -> bool {
        let shared = self.key.intersection(&other.key).count();
        let smaller = self.key.len().min(other.key.len());
        smaller >= 4 && shared * 10 >= smaller * 7
    }
}

/// Picks up to `limit` articles for a query, best first. With nothing to look
/// for, the newest. Either way one story is shown once, and no publisher takes
/// more than a few places while others have something to offer.
pub(crate) fn pick<'a>(
    wire: impl IntoIterator<Item = &'a Indexed>,
    query: &Query,
    limit: usize,
) -> Vec<&'a Article> {
    let mut ranked: Vec<(&Indexed, (usize, u32))> = if query.is_empty() {
        wire.into_iter().map(|indexed| (indexed, (0, 0))).collect()
    } else {
        let scored: Vec<(&Indexed, (usize, u32))> = wire
            .into_iter()
            .map(|indexed| (indexed, indexed.score(query)))
            .filter(|(_, (terms, _))| *terms > 0)
            .collect();
        // An article matching one word of four is about something else.
        let best = scored.iter().map(|(_, (terms, _))| *terms).max().unwrap_or(0);
        scored.into_iter().filter(|(_, (terms, _))| *terms >= best.div_ceil(2)).collect()
    };
    // Best match first; among equals the newest, and undated last.
    ranked.sort_by(|(a, a_score), (b, b_score)| {
        b_score.cmp(a_score).then_with(|| b.article.published.cmp(&a.article.published))
    });

    let mut chosen: Vec<&Indexed> = Vec::new();
    let mut held: Vec<&Indexed> = Vec::new();
    for (indexed, _) in ranked {
        if chosen.len() == limit {
            break;
        }
        if chosen.iter().any(|taken| taken.same_story(indexed)) {
            continue;
        }
        let from_source =
            chosen.iter().filter(|taken| taken.article.source == indexed.article.source).count();
        if from_source >= PER_SOURCE {
            held.push(indexed);
        } else {
            chosen.push(indexed);
        }
    }
    // One publisher may fill the rest only when nobody else has anything.
    for indexed in held {
        if chosen.len() == limit {
            break;
        }
        chosen.push(indexed);
    }
    chosen.into_iter().map(|indexed| &indexed.article).collect()
}

/// How the news names one coin: by a name [`SAME`] gives it, written any way,
/// or by its ticker written in capitals. "LINK" is the coin; "link" is a word,
/// and so is "Link" at the start of a headline.
pub(crate) struct Coin {
    /// Names in the form they are compared in, e.g. `" chainlink "`. None for a coin `SAME` does not know.
    names: Vec<String>,
    /// The ticker in lower case. `None` when it is one character, a word that says
    /// nothing, or letters the news uses for something else.
    ticker: Option<String>,
}

impl Coin {
    /// The coin a market trades, from its base asset: `BTC`, or `1000PEPE`, which
    /// is PEPE by the thousand. `None` when the news has no way to name it.
    pub(crate) fn new(base: &str) -> Option<Self> {
        let base = base.trim().to_lowercase();
        let ticker = base
            .strip_prefix("1000")
            .map(|rest| rest.trim_start_matches('0'))
            .filter(|rest| rest.chars().count() >= 2)
            .unwrap_or(&base);
        let names: Vec<String> = SAME
            .iter()
            .find(|(keys, _)| keys.contains(&ticker))
            .map(|(_, names)| names.iter().map(|name| normal(name)).collect())
            .unwrap_or_default();
        let usable =
            ticker.chars().count() >= 2 && !FILLER.contains(&ticker) && !NOT_TICKERS.contains(&ticker);
        let ticker = usable.then(|| ticker.to_string());
        (!names.is_empty() || ticker.is_some()).then_some(Self { names, ticker })
    }

    /// Whether the coin has names of its own, which have to be looked for in every story.
    pub(crate) fn has_names(&self) -> bool {
        !self.names.is_empty()
    }

    pub(crate) fn ticker(&self) -> Option<&str> {
        self.ticker.as_deref()
    }
}

/// The words of `text` written in capitals (`BTC`, `$PEPE`), in lower case. A
/// text written all in capitals has none: there, capitals do not mark a ticker.
fn capitals(text: &str) -> Vec<String> {
    let words: Vec<&str> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().any(char::is_alphabetic))
        .collect();
    let loud = |word: &&str| word.chars().any(char::is_uppercase) && !word.chars().any(char::is_lowercase);
    if words.len() >= 3 && words.iter().all(loud) {
        return Vec::new();
    }
    words.into_iter().filter(loud).map(str::to_lowercase).collect()
}

/// A story's words, ready to be looked through for coins.
pub(crate) struct Mentions {
    title: String,
    /// Each topic apart: two labels side by side are not one phrase.
    topics: Vec<String>,
    summary: String,
    /// Words written in capitals, with the best place each was found: 3 the
    /// headline, 2 a topic, 1 the summary.
    capitals: HashMap<String, u32>,
}

impl Mentions {
    pub(crate) fn new(article: &Article) -> Self {
        let mut found = HashMap::new();
        let places = std::iter::once((1, article.summary.as_str()))
            .chain(article.topics.iter().map(|topic| (2, topic.as_str())))
            .chain(std::iter::once((3, article.title.as_str())));
        // From the least telling place to the most, so that each word keeps the best.
        for (place, text) in places {
            for word in capitals(text) {
                found.insert(word, place);
            }
        }
        Self {
            title: normal(&article.title),
            topics: article.topics.iter().map(|topic| normal(topic)).collect(),
            summary: normal(&article.summary),
            capitals: found,
        }
    }

    /// The words the story writes in capitals, in lower case: the tickers it may name.
    pub(crate) fn capitals(&self) -> impl Iterator<Item = &str> {
        self.capitals.keys().map(String::as_str)
    }

    /// Where the story names `coin`: 3 in the headline, 2 in a topic, 1 in the summary, 0 nowhere.
    pub(crate) fn of(&self, coin: &Coin) -> u32 {
        let named = |text: &String| coin.names.iter().any(|name| text.contains(name.as_str()));
        let by_name = if named(&self.title) {
            3
        } else if self.topics.iter().any(named) {
            2
        } else if named(&self.summary) {
            1
        } else {
            0
        };
        let by_ticker =
            coin.ticker.as_ref().and_then(|ticker| self.capitals.get(ticker)).copied().unwrap_or(0);
        by_name.max(by_ticker)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone, Utc};

    use super::*;

    fn at(hour: u32) -> Option<DateTime<Utc>> {
        Utc.with_ymd_and_hms(2026, 11, 19, hour, 0, 0).single()
    }

    fn story(source: &str, title: &str, summary: &str, topics: &[&str], hour: u32) -> Indexed {
        Indexed::new(Article {
            title: title.to_string(),
            source: source.to_string(),
            url: format!("https://{}.example.com/{}", source.to_lowercase().replace(' ', ""), title.len()),
            published: at(hour),
            summary: summary.to_string(),
            topics: topics.iter().map(|topic| (*topic).to_string()).collect(),
            body: None,
            image: None,
        })
    }

    fn wire() -> Vec<Indexed> {
        vec![
            story(
                "Desk",
                "Bitcoin slides 12% through its 200-week average",
                "The drop has a bullish past.",
                &["Markets"],
                6,
            ),
            story(
                "Wire",
                "ETF outflows mount as Ether risks $1,500",
                "Spot funds lost $399M.",
                &["Ethereum"],
                5,
            ),
            story(
                "Desk",
                "Solana says account rent could fall 86%",
                "Developers would pay less for storage.",
                &[],
                4,
            ),
            story(
                "Block",
                "Miner that sold its last BTC warns on cash",
                "It may run short for an AI deal.",
                &["Mining"],
                7,
            ),
            story(
                "Wire",
                "Analysts link the selloff to rate fears",
                "Bitcoin and Ether both fell.",
                &["Markets"],
                3,
            ),
            story(
                "Central Bank",
                "Minutes of the Federal Open Market Committee, October 27-28",
                "",
                &["Monetary Policy"],
                2,
            ),
            story(
                "Block",
                "Chainlink whale accumulates $2.16M in LINK",
                "Can buying trigger a rebound?",
                &[],
                1,
            ),
            story(
                "Desk",
                "Bitcoin slides 12% below 200-week average, a level with a bullish past",
                "",
                &[],
                8,
            ),
        ]
    }

    fn titles(query: &str) -> Vec<String> {
        let wire = wire();
        pick(&wire, &Query::new(query), 8).into_iter().map(|article| article.title.clone()).collect()
    }

    #[test]
    fn queries_are_reduced_to_what_they_are_about() {
        assert_eq!(normal("Bitcoin's ETFs, re-priced!"), " bitcoin s etf re priced ");
        assert_eq!(normal("  "), "");
        assert!(Query::new("what is the latest news today?").is_empty());
        assert!(Query::new("").is_empty());
        let query = Query::new("Why is BTCUSDT down today, and the ETFs?");
        assert_eq!(
            query.terms,
            [
                vec![" btc ".to_string(), " bitcoin ".to_string()],
                vec![" down ".to_string()],
                vec![" etf ".to_string()]
            ]
        );
        // A ticker that is also a word looks for its coin by name only.
        assert_eq!(Query::new("LINK").terms, [vec![" chainlink ".to_string()]]);
        assert_eq!(Query::new("fed").terms[0].len(), 4);
        // The same thing asked twice is one term, and an essay is cut short.
        assert_eq!(Query::new("bitcoin btc Bitcoin").terms.len(), 1);
        assert_eq!(Query::new("alpha beta gamma delta epsilon zeta eta theta iota kappa").terms.len(), 8);
    }

    #[test]
    fn a_ticker_finds_its_name_and_headlines_outrank_summaries() {
        // Two reports of one story are shown once: the newer one.
        assert_eq!(
            titles("BTC"),
            [
                "Bitcoin slides 12% below 200-week average, a level with a bullish past",
                "Miner that sold its last BTC warns on cash",
                "Analysts link the selloff to rate fears",
            ]
        );
        assert_eq!(titles("solana"), ["Solana says account rent could fall 86%"]);
        // "link" the ticker is Chainlink, not the verb in another headline.
        assert_eq!(titles("link"), ["Chainlink whale accumulates $2.16M in LINK"]);
        // A name the publisher filed it under counts, and so does who published it.
        // All three terms are in one headline, so an article that only mentions Ether is left out.
        assert_eq!(titles("ethereum etf outflows"), ["ETF outflows mount as Ether risks $1,500"]);
        assert_eq!(titles("fed"), ["Minutes of the Federal Open Market Committee, October 27-28"]);
        assert_eq!(titles("dogecoin"), Vec::<String>::new());
    }

    #[test]
    fn an_article_about_one_word_of_many_is_left_out_and_no_query_means_the_newest() {
        // The best article matches two terms of three; the ones matching one follow it.
        assert_eq!(
            titles("bitcoin etf outflows"),
            [
                "ETF outflows mount as Ether risks $1,500",
                "Bitcoin slides 12% below 200-week average, a level with a bullish past",
                "Miner that sold its last BTC warns on cash",
                "Analysts link the selloff to rate fears",
            ]
        );
        // The best matches four; one that matches a single word is about something else.
        assert_eq!(titles("solana account rent fall bitcoin"), ["Solana says account rent could fall 86%"]);

        // Nothing to look for: newest first, one story shown once.
        let newest = titles("latest news");
        assert_eq!(newest.len(), 7);
        assert_eq!(newest[0], "Bitcoin slides 12% below 200-week average, a level with a bullish past");
        assert_eq!(newest[1], "Miner that sold its last BTC warns on cash");

        // One publisher does not crowd out the others, but fills the list when it is alone.
        let mut crowded: Vec<Indexed> = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
            .iter()
            .zip(10..)
            .map(|(word, hour)| {
                story("Loud", &format!("Bitcoin {word} {word}one {word}two {word}three"), "", &[], hour)
            })
            .collect();
        crowded.push(story("Quiet", "Bitcoin from a quieter publisher altogether", "", &[], 1));
        let picked = pick(&crowded, &Query::new("bitcoin"), 5);
        let sources: Vec<&str> = picked.iter().map(|article| article.source.as_str()).collect();
        assert_eq!(sources, ["Loud", "Loud", "Loud", "Quiet", "Loud"]);
    }

    /// Where `title`, `summary` and `topics` name the coin of `base`: 3 the
    /// headline, 2 a topic, 1 the summary.
    fn named(base: &str, title: &str, summary: &str, topics: &[&str]) -> u32 {
        let coin = Coin::new(base).expect("a coin the news can name");
        Mentions::new(&story("Desk", title, summary, topics, 1).article).of(&coin)
    }

    #[test]
    fn a_coin_is_named_by_its_names_or_by_its_ticker_in_capitals() {
        // By name, written any way, and by ticker.
        assert_eq!(named("BTC", "Bitcoin slides 12%", "", &[]), 3);
        assert_eq!(named("BTC", "Miners sell", "Forced selling of btc explained the move.", &[]), 1);
        assert_eq!(named("ETH", "Funds sell", "", &["Ether"]), 2);
        assert_eq!(named("BTC", "Gold rallies", "", &[]), 0);
        // The headline counts for more than a topic, and a topic for more than the summary.
        assert_eq!(named("SOL", "SOL rallies", "Solana gained.", &["Solana"]), 3);

        // A ticker that is also a word is the coin only in capitals, or by the coin's own name.
        assert_eq!(named("LINK", "Analysts link the selloff to rate fears", "", &[]), 0);
        assert_eq!(named("LINK", "Link between rates and crypto grows", "", &[]), 0);
        assert_eq!(named("LINK", "Whales accumulate", "Chainlink holders added $2.16M.", &[]), 1);
        assert_eq!(named("LINK", "LINK whales accumulate $2.16M", "", &[]), 3);
        // A coin the names table does not know is found by its ticker in capitals alone.
        assert_eq!(named("PEPE", "$PEPE jumps 30%", "", &[]), 3);
        assert_eq!(named("MOVE", "Bitcoin's next move", "The move was sharp.", &[]), 0);
        assert_eq!(named("MOVE", "Movement network", "MOVE fell 8%.", &[]), 1);
        // A market that trades a coin by the thousand is about that coin.
        assert_eq!(named("1000PEPE", "PEPE jumps 30%", "", &[]), 3);
        assert_eq!(named("1000SHIB", "Shiba Inu burn rate soars", "", &[]), 3);
        // A possessive is still the ticker.
        assert_eq!(named("PEPE", "PEPE's rally stalls", "", &[]), 3);

        // A headline written all in capitals does not say which words are tickers.
        assert_eq!(named("MOVE", "MARKETS MOVE LOWER AS RATES RISE", "", &[]), 0);
        assert_eq!(named("MOVE", "MOVE", "", &[]), 3);
        // Letters the news uses for something else are never a coin, and nor is a single letter
        // or a word that says nothing.
        for base in ["AI", "US", "GENIUS", "S", "W", "ME", "THE", "NOT", "4"] {
            assert!(Coin::new(base).is_none(), "{base}");
        }
        assert!(Coin::new("0G").is_some() && Coin::new("TRUMP").is_some());
        assert_eq!(named("0G", "0G Labs raises $40M", "", &[]), 3);
    }
}
