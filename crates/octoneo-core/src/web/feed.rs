//! Reads a publisher's news feed (RSS 2.0) into articles.

use chrono::{DateTime, Utc};
use roxmltree::{Document, Node};

use super::guard::Guard;
use super::page::plain;
use super::text::{clip, squeeze};
use crate::bail;
use crate::error::Result;

const TITLE_CHARS: usize = 200;
const SUMMARY_CHARS: usize = 280;
const TOPIC_CHARS: usize = 40;
/// Topics kept per article.
const TOPICS: usize = 8;
/// A feed may carry the whole article. Less than this is a teaser, not the article.
const BODY_MIN_CHARS: usize = 600;
const BODY_CHARS: usize = 12_000;
/// Articles read from one feed: its newest.
const ARTICLES: usize = 60;

/// One news article, as its publisher's feed describes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Article {
    pub title: String,
    /// The publisher.
    pub source: String,
    pub url: String,
    pub published: Option<DateTime<Utc>>,
    /// A sentence or two from the feed. May be empty.
    pub summary: String,
    /// What the publisher filed it under.
    pub topics: Vec<String>,
    /// The article itself, when the feed carries it whole.
    pub body: Option<String>,
}

fn named(node: &Node<'_, '_>, name: &str) -> bool {
    node.is_element() && node.tag_name().name().eq_ignore_ascii_case(name)
}

fn text_of(node: Node<'_, '_>) -> String {
    node.descendants().filter(Node::is_text).filter_map(|text| text.text()).collect()
}

fn field(item: Node<'_, '_>, name: &str) -> Option<String> {
    item.children().find(|child| named(child, name)).map(text_of).filter(|text| !text.trim().is_empty())
}

fn article(item: Node<'_, '_>, source: &str, guard: Guard) -> Option<Article> {
    let title = clip(&squeeze(&plain(&field(item, "title")?)), TITLE_CHARS);
    // A link that is not an ordinary public page is not offered to the model at all.
    let url = guard.parse(&field(item, "link")?).ok()?;
    if title.is_empty() {
        return None;
    }
    let published = field(item, "pubDate")
        .and_then(|text| DateTime::parse_from_rfc2822(text.trim()).ok())
        .map(|at| at.with_timezone(&Utc));
    let summary = field(item, "description")
        .map(|text| clip(&squeeze(&plain(&text)), SUMMARY_CHARS))
        // Some feeds repeat the headline as the summary, which says nothing more.
        .filter(|summary| !summary.eq_ignore_ascii_case(&title))
        .unwrap_or_default();
    let topics = item
        .children()
        .filter(|child| named(child, "category"))
        .map(|topic| clip(&squeeze(&text_of(topic)), TOPIC_CHARS))
        .filter(|topic| !topic.is_empty())
        .take(TOPICS)
        .collect();
    let body = field(item, "encoded")
        .map(|html| plain(&html))
        .filter(|text| text.chars().count() >= BODY_MIN_CHARS)
        .map(|text| clip(&text, BODY_CHARS));
    Some(Article { title, source: source.to_string(), url: url.into(), published, summary, topics, body })
}

/// The articles of one feed, in the feed's own order (newest first, by custom).
pub(crate) fn parse(xml: &str, source: &str, guard: Guard) -> Result<Vec<Article>> {
    let Ok(document) = Document::parse(xml.trim_start_matches('\u{feff}').trim_start()) else {
        bail!("{source} sent news that cannot be read.");
    };
    if !named(&document.root_element(), "rss") {
        bail!("{source} sent news that cannot be read.");
    }
    Ok(document
        .descendants()
        .filter(|node| named(node, "item"))
        .take(ARTICLES)
        .filter_map(|item| article(item, source, guard))
        .collect())
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    const FEED: &str = "\u{feff}<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<rss version=\"2.0\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">
  <channel>
    <title>Example Wire</title>
    <link>https://wire.example.com</link>
    <item>
      <title><![CDATA[Fed&#8217;s rate push may be a mistake &amp; here is why]]></title>
      <link>https://wire.example.com/markets/2026/11/19/fed-rate-push</link>
      <pubDate>Thu, 19 Nov 2026 06:23:19 +0000</pubDate>
      <description><![CDATA[<p style=\"float:right\"><img src=\"a.jpg\" alt=\"x\"></p><p>Experts argue that the Fed is looking at the wrong data as it pushes for more rate hikes.</p>]]></description>
      <dc:creator>A Writer</dc:creator>
      <category domain=\"tag\"><![CDATA[Federal Reserve]]></category>
      <category>Markets</category>
      <content:encoded/>
    </item>
    <item>
      <title>Minutes of the Federal Open Market Committee, October 27-28, 2026</title>
      <link><![CDATA[https://wire.example.com/press/monetary20261118a.htm#top]]></link>
      <description><![CDATA[Minutes of the Federal Open Market Committee, October 27-28, 2026]]></description>
      <pubDate><![CDATA[Wed, 18 Nov 2026 19:00:00 GMT]]></pubDate>
    </item>
    <item>
      <title>A story the feed carries whole</title>
      <link>https://wire.example.com/whole</link>
      <pubDate>not a date</pubDate>
      <content:encoded><![CDATA[BODY]]></content:encoded>
    </item>
    <item><title>No link</title></item>
    <item><title>A link to this computer</title><link>https://localhost/admin</link></item>
    <item><title>An old-style link</title><link>http://wire.example.com/plain</link></item>
    <item><title>  </title><link>https://wire.example.com/untitled</link></item>
  </channel>
</rss>";

    #[test]
    fn a_feed_becomes_articles_and_unusable_items_are_left_out() {
        let body =
            "<p>The first paragraph of a story that the feed carries whole, with plenty of words in it.</p>"
                .repeat(8);
        let articles = parse(&FEED.replace("BODY", &body), "Example Wire", Guard::Public).expect("feed");
        assert_eq!(articles.len(), 3, "{articles:?}");

        let first = &articles[0];
        assert_eq!(first.title, "Fed’s rate push may be a mistake & here is why");
        assert_eq!(
            (first.source.as_str(), first.url.as_str()),
            ("Example Wire", "https://wire.example.com/markets/2026/11/19/fed-rate-push")
        );
        assert_eq!(first.published, Utc.with_ymd_and_hms(2026, 11, 19, 6, 23, 19).single());
        assert_eq!(
            first.summary,
            "Experts argue that the Fed is looking at the wrong data as it pushes for more rate hikes."
        );
        assert_eq!(first.topics, ["Federal Reserve", "Markets"]);
        assert_eq!(first.body, None);

        // A summary that only repeats the headline is dropped, and the part after `#` is not kept.
        let second = &articles[1];
        assert_eq!((second.summary.as_str(), second.topics.len()), ("", 0));
        assert_eq!(second.url, "https://wire.example.com/press/monetary20261118a.htm");
        assert_eq!(second.published, Utc.with_ymd_and_hms(2026, 11, 18, 19, 0, 0).single());

        let third = &articles[2];
        assert_eq!(third.published, None);
        // The repeated paragraph is kept once: a body is read the way a page is.
        assert!(third.body.is_none(), "eight copies of one paragraph are one paragraph");

        let varied: String = (0..8)
            .map(|n| format!("<p>Paragraph number {n} of a story that the feed carries whole, with plenty of words in it.</p>"))
            .collect();
        let articles = parse(&FEED.replace("BODY", &varied), "Example Wire", Guard::Public).expect("feed");
        let whole = articles[2].body.as_deref().expect("body");
        assert_eq!(whole.lines().count(), 8);
        assert!(whole.starts_with("Paragraph number 0 of a story"));
    }

    #[test]
    fn what_is_not_a_feed_is_refused() {
        for bad in
            ["", "<html><body>Just a moment...</body></html>", "<rss><channel><item>", "{\"error\": true}"]
        {
            let error = parse(bad, "Example Wire", Guard::Public).expect_err(bad);
            assert_eq!(error.0, "Example Wire sent news that cannot be read.");
        }
        assert_eq!(
            parse("<rss version=\"2.0\"><channel/></rss>", "Example Wire", Guard::Public).expect("empty"),
            []
        );
        // A feed listing hundreds of items is cut to its newest.
        let many: String = (0..200)
            .map(|n| {
                format!("<item><title>Story {n}</title><link>https://wire.example.com/{n}</link></item>")
            })
            .collect();
        let articles = parse(&format!("<rss><channel>{many}</channel></rss>"), "Example Wire", Guard::Public)
            .expect("feed");
        assert_eq!((articles.len(), articles[59].title.as_str()), (60, "Story 59"));
    }
}
