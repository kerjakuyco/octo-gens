//! Pulls the readable text out of a web page.
//!
//! A news page is mostly not news: menus, related links, sign-up boxes. The
//! article is taken to be the paragraphs that are not inside page furniture
//! and are not mostly links, preferring those inside an `<article>`. It is a
//! rule of thumb, and where it finds nothing the page's own summary is used.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDate, Utc};
use ego_tree::iter::Edge;
use scraper::{Html, Node};

use super::text::{clip, squeeze};

/// Elements whose contents are never part of the article.
const FURNITURE: [&str; 17] = [
    "script", "style", "noscript", "template", "nav", "header", "footer", "aside", "form", "button",
    "select", "svg", "iframe", "figure", "dialog", "menu", "label",
];
/// Elements that hold one paragraph's worth of text.
const BLOCKS: [&str; 12] = ["p", "h1", "h2", "h3", "h4", "li", "blockquote", "pre", "td", "th", "dd", "dt"];
/// Elements that sit inside a line of text. Any other element separates words.
const INLINE: [&str; 20] = [
    "a", "abbr", "b", "cite", "code", "em", "i", "mark", "q", "s", "small", "span", "strong", "sub", "sup",
    "time", "u", "var", "font", "bdi",
];
/// Shorter than this is a caption, a byline or a button, not a paragraph.
const MIN_BLOCK_CHARS: usize = 30;
/// An `<article>` with less text than this is a teaser; the whole page is read instead.
const MIN_ARTICLE_CHARS: usize = 400;
/// Where pages say when they were published, in the order they are trusted.
const DATE_KEYS: [&str; 5] =
    ["article:published_time", "og:article:published_time", "datepublished", "parsely-pub-date", "date"];

/// What a page says about itself, and its text.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Extract {
    pub title: String,
    pub site: String,
    /// `2026-11-18 19:46` in UTC, or just the date when the page gives no time zone.
    pub published: Option<String>,
    pub description: String,
    /// The article's paragraphs, one per line. Empty when none were found.
    pub text: String,
}

#[derive(Default)]
struct Block {
    text: String,
    /// Characters of `text` that are link text.
    linked: usize,
}

#[derive(Default)]
struct Reader {
    furniture: usize,
    article: usize,
    link: usize,
    title: bool,
    open: Option<Block>,
    /// `(inside an article, paragraph)`, in page order.
    blocks: Vec<(bool, String)>,
    seen: HashSet<String>,
    page_title: String,
    meta: HashMap<String, String>,
}

impl Reader {
    fn close_block(&mut self) {
        let Some(block) = self.open.take() else {
            return;
        };
        let text = squeeze(&block.text);
        let length = text.chars().count();
        // A list of headlines is all links; a paragraph that cites a source is not.
        let mostly_links = block.linked * 2 > block.text.chars().count();
        if length >= MIN_BLOCK_CHARS && !mostly_links && self.seen.insert(text.clone()) {
            self.blocks.push((self.article > 0, text));
        }
    }

    fn enter(&mut self, element: &scraper::node::Element) {
        let name = element.name();
        if name == "meta" {
            let key = ["property", "name", "itemprop"].into_iter().find_map(|attr| element.attr(attr));
            if let (Some(key), Some(content)) = (key, element.attr("content")) {
                self.meta.entry(key.trim().to_ascii_lowercase()).or_insert_with(|| squeeze(content));
            }
            return;
        }
        if !INLINE.contains(&name) {
            self.say(" ");
        }
        if FURNITURE.contains(&name) {
            self.furniture += 1;
        }
        match name {
            "article" => self.article += 1,
            "a" => self.link += 1,
            "title" => self.title = self.page_title.is_empty(),
            _ => {}
        }
        if BLOCKS.contains(&name) && self.furniture == 0 {
            self.close_block();
            self.open = Some(Block::default());
        }
    }

    fn leave(&mut self, element: &scraper::node::Element) {
        let name = element.name();
        if BLOCKS.contains(&name) {
            self.close_block();
        }
        match name {
            "article" => self.article = self.article.saturating_sub(1),
            "a" => self.link = self.link.saturating_sub(1),
            "title" => self.title = false,
            _ => {}
        }
        if FURNITURE.contains(&name) {
            self.furniture = self.furniture.saturating_sub(1);
        }
        if !INLINE.contains(&name) {
            self.say(" ");
        }
    }

    fn say(&mut self, text: &str) {
        if self.title {
            self.page_title.push_str(text);
        }
        if self.furniture > 0 {
            return;
        }
        if let Some(block) = &mut self.open {
            block.text.push_str(text);
            if self.link > 0 {
                block.linked += text.chars().count();
            }
        }
    }

    /// Walks the tree without recursion: a page nested ten thousand deep must not exhaust the stack.
    fn read(document: &Html) -> Self {
        let mut reader = Self::default();
        for edge in document.tree.root().traverse() {
            match edge {
                Edge::Open(node) => match node.value() {
                    Node::Element(element) => reader.enter(element),
                    Node::Text(text) => reader.say(text),
                    _ => {}
                },
                Edge::Close(node) => {
                    if let Node::Element(element) = node.value() {
                        reader.leave(element);
                    }
                }
            }
        }
        reader.close_block();
        reader
    }

    fn paragraphs(&self) -> String {
        let length = |inside: bool| -> usize {
            self.blocks.iter().filter(|(article, _)| *article || !inside).map(|(_, text)| text.len()).sum()
        };
        let inside = length(true) >= MIN_ARTICLE_CHARS;
        self.blocks
            .iter()
            .filter(|(article, _)| *article || !inside)
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// A publication time as pages write it, in one plain form.
fn when(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(raw) {
        return Some(at.with_timezone(&Utc).format("%Y-%m-%d %H:%M").to_string());
    }
    // No time zone: the day is still worth having.
    let day = raw.get(..10)?;
    NaiveDate::parse_from_str(day, "%Y-%m-%d").ok().map(|date| date.format("%Y-%m-%d").to_string())
}

/// Reads a whole page.
pub(crate) fn extract(html: &str) -> Extract {
    let reader = Reader::read(&Html::parse_document(html));
    let meta = |keys: &[&str]| keys.iter().find_map(|key| reader.meta.get(*key)).filter(|v| !v.is_empty());
    let title = meta(&["og:title"]).cloned().unwrap_or_else(|| squeeze(&reader.page_title));
    Extract {
        title: clip(&title, 200),
        site: clip(meta(&["og:site_name"]).map(String::as_str).unwrap_or_default(), 60),
        published: DATE_KEYS.iter().filter_map(|key| reader.meta.get(*key)).find_map(|raw| when(raw)),
        description: clip(
            meta(&["og:description", "description", "twitter:description"])
                .map(String::as_str)
                .unwrap_or_default(),
            500,
        ),
        text: reader.paragraphs(),
    }
}

/// The text of a piece of HTML, as a feed carries it: paragraphs one per
/// line, or the bare text when it has no paragraphs.
pub(crate) fn plain(fragment: &str) -> String {
    if !fragment.contains(['<', '&']) {
        return squeeze(fragment);
    }
    let document = Html::parse_fragment(fragment);
    let reader = Reader::read(&document);
    if !reader.blocks.is_empty() {
        return reader.paragraphs();
    }
    let mut furniture = 0usize;
    let mut text = String::new();
    for edge in document.tree.root().traverse() {
        let (node, opening) = match edge {
            Edge::Open(node) => (node, true),
            Edge::Close(node) => (node, false),
        };
        match node.value() {
            Node::Element(element) => {
                let name = element.name();
                if FURNITURE.contains(&name) {
                    furniture = if opening { furniture + 1 } else { furniture.saturating_sub(1) };
                }
                if !INLINE.contains(&name) {
                    text.push(' ');
                }
            }
            Node::Text(words) if opening && furniture == 0 => text.push_str(words),
            _ => {}
        }
    }
    squeeze(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTICLE: &str = r#"<!doctype html><html><head>
        <title>Why CoinShares Sold Its Ether - Decrypt</title>
        <meta property="og:title" content="Why CoinShares Sold Its Ether">
        <meta property="og:site_name" content="Decrypt">
        <meta name="description" content="The asset manager sold $16.6 million in Ethereum.">
        <meta property="article:published_time" content="2026-11-18T19:46:02+07:00">
        <script>var tracking = "<p>This is not a paragraph of the article at all.</p>";</script>
        <style>p { color: red }</style>
        </head><body>
        <header><p>Sign in to read more stories from our newsroom today.</p></header>
        <nav><ul><li><a href="/markets">Markets and prices and everything else here</a></li></ul></nav>
        <article>
          <h1>Why CoinShares Sold Its Ether</h1>
          <p>CoinShares sold its entire corporate holding of <a href="/eth">Ether</a> and half its Solana,
             freeing up $19.3&nbsp;million.</p>
          <p>Short.</p>
          <figure><img src="x.jpg"><figcaption>A photograph of a building that is not part of the text.</figcaption></figure>
          <p>The chief executive framed it as capital discipline,<br>not a bearish bet on either token.</p>
          <ul><li><a href="/a">Related: Bitcoin falls below a level nobody was watching closely</a></li></ul>
          <aside><p>Subscribe to the newsletter for a daily summary of the market.</p></aside>
          <p>The sale landed amid a sharp downturn, but the firm posted a strong quarter and is set to join
             a share index in December, which it says could broaden its base of shareholders in America.</p>
          <p>The sale landed amid a sharp downturn, but the firm posted a strong quarter and is set to join
             a share index in December, which it says could broaden its base of shareholders in America.</p>
          <p>Analysts said the move frees cash for a buyback of up to forty million dollars over the next year.</p>
        </article>
        <footer><p>Copyright notices and a long list of links that nobody reads.</p></footer>
        </body></html>"#;

    #[test]
    fn an_article_is_read_without_the_page_around_it() {
        let page = extract(ARTICLE);
        assert_eq!((page.title.as_str(), page.site.as_str()), ("Why CoinShares Sold Its Ether", "Decrypt"));
        assert_eq!(page.published.as_deref(), Some("2026-11-18 12:46"));
        assert_eq!(page.description, "The asset manager sold $16.6 million in Ethereum.");
        let lines: Vec<&str> = page.text.lines().collect();
        assert_eq!(
            lines,
            [
                "CoinShares sold its entire corporate holding of Ether and half its Solana, freeing up $19.3 million.",
                "The chief executive framed it as capital discipline, not a bearish bet on either token.",
                "The sale landed amid a sharp downturn, but the firm posted a strong quarter and is set to join a share index in December, which it says could broaden its base of shareholders in America.",
                "Analysts said the move frees cash for a buyback of up to forty million dollars over the next year.",
            ],
            "menus, captions, link lists, repeats, scripts and short scraps are left out"
        );
    }

    #[test]
    fn a_page_without_an_article_falls_back_to_its_paragraphs_and_its_own_words() {
        let plain_page = "<html><head><title> A  plain   page </title></head><body><div>\
            <p>The first paragraph of a page that never heard of the article element, long enough to keep.</p>\
            <p><a href='/x'>A paragraph that is nothing but one long link to somewhere else entirely</a></p>\
            <p>The second paragraph, which is also long enough to be kept by the reader.</p></div></body></html>";
        let page = extract(plain_page);
        assert_eq!(page.title, "A plain page");
        assert_eq!(page.text.lines().count(), 2);
        assert!(page.site.is_empty() && page.published.is_none() && page.description.is_empty());

        // A page drawn by scripts has no paragraphs; what it says about itself is all there is.
        let scripted = r#"<html><head><meta property="og:description" content="Sygnum expects carry trades to beat bills.">
            <meta itemprop="datePublished" content="2026-11-19"></head><body><div id="app"></div>
            <article><p>Too short.</p></article></body></html>"#;
        let page = extract(scripted);
        assert!(page.text.is_empty());
        assert_eq!(page.description, "Sygnum expects carry trades to beat bills.");
        assert_eq!(page.published.as_deref(), Some("2026-11-19"));

        assert_eq!(when("2026-11-18T19:46:02"), Some("2026-11-18".to_string()));
        assert_eq!(when("2026-11-19T06:00:00.000Z"), Some("2026-11-19 06:00".to_string()));
        assert_eq!((when("yesterday"), when("")), (None, None));
    }

    #[test]
    fn feed_text_is_made_plain_and_deep_nesting_is_survived() {
        assert_eq!(plain("Fed holds rates"), "Fed holds rates");
        assert_eq!(plain("AT&amp;T &#8217;s <b>bold</b>   move"), "AT&T ’s bold move");
        assert_eq!(
            plain(
                "<p style=\"float:right\"><img src=\"a.jpg\" alt=\"x\"></p><p>Sygnum predicts that Bitcoin carry trades may offer higher returns.</p>"
            ),
            "Sygnum predicts that Bitcoin carry trades may offer higher returns."
        );
        assert_eq!(
            plain(
                "<p>First paragraph of the story, with enough words in it.</p><script>x()</script><p>Second paragraph of the story, also long enough.</p>"
            ),
            "First paragraph of the story, with enough words in it.\nSecond paragraph of the story, also long enough."
        );
        assert_eq!(plain("Bit<b>coin</b> re<em>bounds</em><div>today</div>"), "Bitcoin rebounds today");
        // Thousands of nested elements: the walk keeps no call stack per level.
        let deep = format!(
            "{}<p>The paragraph at the bottom of a very deep page, still found.</p>",
            "<div>".repeat(5_000)
        );
        assert!(extract(&deep).text.contains("still found"));
    }
}
