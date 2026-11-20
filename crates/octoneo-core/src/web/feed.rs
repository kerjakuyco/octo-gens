//! Reads a publisher's news feed (RSS 2.0) into articles.

use chrono::{DateTime, Utc};
use roxmltree::{Document, Node};
use scraper::Html;
use url::Url;

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
/// Endings of picture files. A `media:content` that says nothing else about
/// itself is a picture when its file says so.
const PICTURE_ENDINGS: [&str; 6] = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"];

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
    /// Where the story's picture is, when the feed names one at an ordinary public https address.
    pub image: Option<String>,
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

/// Where `raw` leads, read against the story's own link, if that is an ordinary public https address.
fn address(raw: &str, link: &Url, guard: Guard) -> Option<Url> {
    let raw = raw.trim();
    // Nothing, or only a place in the story's own page, leads back to the story, not to a picture.
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    guard.parse(link.join(raw).ok()?.as_str()).ok()
}

/// Whether a `type` names a picture: `image/jpeg`, or `image/*` as some feeds write it.
/// An SVG is drawn by code, not shown as a picture.
fn picture_kind(kind: Option<&str>) -> bool {
    let kind = kind.unwrap_or_default().trim().to_ascii_lowercase();
    kind.starts_with("image/") && !kind.starts_with("image/svg")
}

/// What Media RSS gives a story: the first `media:content` that is a picture, loose or inside a
/// `media:group`, else the first `media:thumbnail`.
fn media(item: Node<'_, '_>, link: &Url, guard: Guard) -> Option<Url> {
    let offered = |name: &'static str| {
        item.descendants()
            .filter(move |node| named(node, name))
            .filter_map(move |node| Some((node, address(node.attribute("url")?, link, guard)?)))
    };
    let picture = |(node, url): &(Node<'_, '_>, Url)| {
        let path = url.path().to_ascii_lowercase();
        node.attribute("medium").is_some_and(|medium| medium.trim().eq_ignore_ascii_case("image"))
            || picture_kind(node.attribute("type"))
            || PICTURE_ENDINGS.iter().any(|ending| path.ends_with(ending))
    };
    offered("content").find(picture).or_else(|| offered("thumbnail").next()).map(|(_, url)| url)
}

/// An enclosure that is a picture. A feed also encloses sound and video.
fn enclosure(item: Node<'_, '_>, link: &Url, guard: Guard) -> Option<Url> {
    item.children()
        .filter(|node| named(node, "enclosure") && picture_kind(node.attribute("type")))
        .find_map(|node| address(node.attribute("url")?, link, guard))
}

/// The first `<img>` in a piece of HTML that leads somewhere usable. One that is
/// a pixel wide counts visits; it is not a picture.
fn inline(html: &str, link: &Url, guard: Guard) -> Option<Url> {
    if !html.as_bytes().windows(4).any(|four| four.eq_ignore_ascii_case(b"<img")) {
        return None;
    }
    let fragment = Html::parse_fragment(html);
    fragment
        .tree
        .root()
        .descendants()
        .filter_map(|node| node.value().as_element())
        .filter(|element| element.name() == "img")
        .filter(|img| {
            ["width", "height"].iter().all(|side| !matches!(img.attr(side).map(str::trim), Some("0" | "1")))
        })
        .find_map(|img| address(img.attr("src")?, link, guard))
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
    let description = field(item, "description");
    let encoded = field(item, "encoded");
    let summary = description
        .as_deref()
        .map(|text| clip(&squeeze(&plain(text)), SUMMARY_CHARS))
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
    // Feeds name a story's picture in several ways. The ones made for it come first, then the
    // first picture in the summary, then the first in the article.
    let image = media(item, &url, guard)
        .or_else(|| enclosure(item, &url, guard))
        .or_else(|| description.as_deref().and_then(|html| inline(html, &url, guard)))
        .or_else(|| encoded.as_deref().and_then(|html| inline(html, &url, guard)))
        .map(String::from);
    let body = encoded
        .as_deref()
        .map(plain)
        .filter(|text| text.chars().count() >= BODY_MIN_CHARS)
        .map(|text| clip(&text, BODY_CHARS));
    Some(Article {
        title,
        source: source.to_string(),
        url: url.into(),
        published,
        summary,
        topics,
        body,
        image,
    })
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

    /// One story for each way the publishers' feeds name a picture, and for what is passed over.
    const PICTURES: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <item><title>By medium</title><link>https://wire.example.com/a</link>
      <media:content url="https://cdn.example.com/a.jpg?fm=jpg&amp;w=800" medium="image"/>
      <media:thumbnail url="https://cdn.example.com/a-small.jpg"/></item>
    <item><title>By kind, after a video</title><link>https://wire.example.com/b</link>
      <media:content url="https://cdn.example.com/b.mp4" type="video/mp4" medium="video"/>
      <media:content url="https://cdn.example.com/b" type="image/*"/></item>
    <item><title>By its file, relative</title><link>https://wire.example.com/news/c</link>
      <media:content url="/covers/c.webp"/></item>
    <item><title>In a group</title><link>https://wire.example.com/d</link>
      <media:group><media:content url="https://cdn.example.com/d.png" type="image/png"/></media:group></item>
    <item><title>A thumbnail</title><link>https://wire.example.com/e</link>
      <media:content url="https://cdn.example.com/e.mp3" type="audio/mpeg"/>
      <enclosure url="https://cdn.example.com/e-enclosed.png" type="image/png" length="1"/>
      <media:thumbnail url="https://cdn.example.com/e.jpg" width="1280"/></item>
    <item><title>An enclosure</title><link>https://wire.example.com/f</link>
      <enclosure url="https://cdn.example.com/f.mp3" type="audio/mpeg" length="1"/>
      <enclosure url="https://cdn.example.com/f.webp" type="image/jpg" length="1"/>
      <description><![CDATA[<img src="https://cdn.example.com/f-inline.jpg"><p>A summary.</p>]]></description></item>
    <item><title>In the summary</title><link>https://wire.example.com/news/2026/g</link>
      <description><![CDATA[<img src="https://feeds.example.com/count.gif" width="1" height="1"><p style="float:right"><img src="../img/g.jpg" alt="x"></p><p>A summary long enough to be a paragraph of its own.</p>]]></description>
      <content:encoded><![CDATA[<p><img src="https://cdn.example.com/g-article.jpg"></p>]]></content:encoded></item>
    <item><title>In the article</title><link>https://wire.example.com/h</link>
      <description>A summary without a picture.</description>
      <content:encoded><![CDATA[<p>The article.</p><IMG SRC="//cdn.example.com/h.gif">]]></content:encoded></item>
    <item><title>Plain http first, then https</title><link>https://wire.example.com/i</link>
      <media:content url="http://cdn.example.com/i.jpg" medium="image"/>
      <media:thumbnail url="https://cdn.example.com/i.jpg"/></item>
    <item><title>Nothing usable</title><link>https://wire.example.com/j</link>
      <media:content url="http://cdn.example.com/j.jpg" medium="image"/>
      <media:content url="" medium="image"/>
      <enclosure url="https://localhost/j.png" type="image/png"/>
      <enclosure url="https://cdn.example.com/j.svg" type="image/svg+xml"/>
      <description><![CDATA[<img src="data:image/png;base64,iVBORw0KGgo="><img src="#top"><img alt="no address">]]></description></item>
    <item><title>No picture at all</title><link>https://wire.example.com/k</link></item>
  </channel>
</rss>"##;

    #[test]
    fn a_story_takes_the_first_picture_its_feed_names_at_a_public_https_address() {
        let articles = parse(PICTURES, "Example Wire", Guard::Public).expect("feed");
        let pictures: Vec<(&str, Option<&str>)> =
            articles.iter().map(|article| (article.title.as_str(), article.image.as_deref())).collect();
        assert_eq!(
            pictures,
            [
                // Media RSS: a picture by its medium, by its kind, or by its file, and it comes first.
                ("By medium", Some("https://cdn.example.com/a.jpg?fm=jpg&w=800")),
                ("By kind, after a video", Some("https://cdn.example.com/b")),
                ("By its file, relative", Some("https://wire.example.com/covers/c.webp")),
                ("In a group", Some("https://cdn.example.com/d.png")),
                // A thumbnail is preferred to an enclosure, and an enclosure to a picture in the text.
                ("A thumbnail", Some("https://cdn.example.com/e.jpg")),
                ("An enclosure", Some("https://cdn.example.com/f.webp")),
                // In the summary: a counter one pixel wide is passed over, and a relative address
                // is read against the story's link. The summary comes before the article.
                ("In the summary", Some("https://wire.example.com/news/img/g.jpg")),
                ("In the article", Some("https://cdn.example.com/h.gif")),
                // What is not public https is passed over for the next picture, or for none.
                ("Plain http first, then https", Some("https://cdn.example.com/i.jpg")),
                ("Nothing usable", None),
                ("No picture at all", None),
            ]
        );
        // The picture is only a picture: the summary and the article read as before.
        assert_eq!(articles[6].summary, "A summary long enough to be a paragraph of its own.");
        assert_eq!(articles[5].summary, "A summary.");

        // Outside tests a picture on this computer is refused like a link to it; a stand-in may serve one.
        let local = "<rss><channel><item><title>Local</title><link>http://127.0.0.1:4010/a</link>\
            <enclosure url=\"/pictures/a.png\" type=\"image/png\"/></item></channel></rss>";
        let stand_in = parse(local, "Example Wire", Guard::Open).expect("feed");
        assert_eq!(stand_in[0].image.as_deref(), Some("http://127.0.0.1:4010/pictures/a.png"));
        let public = "<rss><channel><item><title>Local</title><link>https://wire.example.com/a</link>\
            <enclosure url=\"https://127.0.0.1/a.png\" type=\"image/png\"/></item></channel></rss>";
        assert_eq!(parse(public, "Example Wire", Guard::Public).expect("feed")[0].image, None);
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
