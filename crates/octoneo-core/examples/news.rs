//! Reads the news the way the assistant does: the publishers' feeds, a search
//! over them, and the articles behind the first results. It is read-only, and
//! the only requests it makes are for the feeds and for those pages.
//!
//!     cargo run -p octoneo-core --example news -- bitcoin etf
//!     cargo run -p octoneo-core --example news -- '$NVDA' earnings
//!
//! A word written with `$` is taken for the ticker of a share or a fund, the
//! way the app takes one the exchange lists, and its own headlines are fetched
//! from Yahoo Finance too.
//!
//! Useful to check that the feeds are reachable from your network, that they
//! still parse, and which publishers let an app read their pages.

use chrono::Utc;
use octoneo_core::assistant::tools::age;
use octoneo_core::web::{Ticker, Web, tickers_in};

#[tokio::main]
async fn main() {
    let query = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let web = match Web::new() {
        Ok(web) => web,
        Err(error) => {
            println!("the web client could not start: {error}");
            return;
        }
    };
    println!("publishers: {}", web.publishers().join(", "));
    let queries = if query.is_empty() {
        vec!["", "BTC", "ethereum etf", "fed", "SOLUSDT", "$NVDA", "$TSLA earnings"]
    } else {
        vec![query.as_str()]
    };
    // The app asks the exchange which words are shares; here a `$` says so.
    let marked = |query: &str| -> Vec<Ticker> {
        let named: Vec<String> = query
            .split_whitespace()
            .filter_map(|word| word.strip_prefix('$'))
            .map(str::to_uppercase)
            .collect();
        tickers_in(query, |word| {
            named.contains(&word.to_uppercase()).then(|| (word.to_uppercase(), Vec::new()))
        })
    };
    let now = Utc::now();
    let mut first = Vec::new();
    for query in queries {
        match web.search(query, &marked(query)).await {
            Ok(found) => {
                println!(
                    "\n== {} ({} headlines) ==",
                    if query.is_empty() { "newest" } else { query },
                    found.len()
                );
                for article in &found {
                    let when = article.published.map_or("undated".to_string(), |at| age(now, at));
                    println!("{:>14}  {:<16} {}", when, article.source, article.title);
                }
                if first.is_empty() {
                    first = found;
                }
            }
            Err(error) => println!("\n== {query} ==\n{error}"),
        }
    }
    // One article from each publisher in the first result, to see who lets an app read.
    println!("\n== pages ==");
    let mut seen = Vec::new();
    for article in &first {
        if seen.contains(&article.source) {
            continue;
        }
        seen.push(article.source.clone());
        match web.read(&article.url).await {
            Ok(page) => {
                let start: String = page.text.chars().take(160).collect();
                println!(
                    "{:<16} {} characters{}: {}…",
                    article.source,
                    page.text.chars().count(),
                    if page.summary_only { " (summary only)" } else { "" },
                    start.replace('\n', " ")
                );
            }
            Err(error) => println!("{:<16} {error}", article.source),
        }
    }
}
