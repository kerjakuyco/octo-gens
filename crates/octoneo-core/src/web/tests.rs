use reqwest::dns::Resolve;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;

fn item(title: &str, link: &str, summary: &str, hour: u32, extra: &str) -> String {
    format!(
        "<item><title>{title}</title><link>{link}</link><pubDate>Thu, 19 Nov 2026 {hour:02}:00:00 GMT</pubDate>\
         <description><![CDATA[{summary}]]></description>{extra}</item>"
    )
}

fn rss(items: &[String]) -> ResponseTemplate {
    let body = format!(
        "<?xml version=\"1.0\"?><rss version=\"2.0\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\">\
         <channel><title>Wire</title>{}</channel></rss>",
        items.concat()
    );
    ResponseTemplate::new(200).set_body_raw(body, "application/rss+xml; charset=utf-8")
}

fn html(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(body.to_string(), "text/html; charset=utf-8")
}

async fn serve(server: &MockServer, route: &str, response: ResponseTemplate) {
    Mock::given(method("GET")).and(path(route)).respond_with(response).mount(server).await;
}

async fn hits(server: &MockServer, route: &str) -> usize {
    server.received_requests().await.expect("recorded").iter().filter(|r| r.url.path() == route).count()
}

fn web(server: &MockServer, feeds: &[(&str, &str)]) -> Web {
    let feeds =
        feeds.iter().map(|(name, route)| ((*name).to_string(), format!("{}{route}", server.uri()))).collect();
    Web::standing_in(feeds, None).expect("web")
}

const STORY: &str = "<html><head><title>Bitcoin slides - Desk</title>\
    <meta property=\"og:site_name\" content=\"Desk\">\
    <meta property=\"article:published_time\" content=\"2026-11-19T06:00:00Z\"></head><body>\
    <nav><p>Menu items that are certainly long enough to be a paragraph.</p></nav><article>\
    <p>Bitcoin slid twelve percent through its 200-week average on Thursday, a level it last lost in 2022.</p>\
    <p>Analysts said forced selling by leveraged traders explained most of the move.</p>\
    <p>Funding turned negative on the largest venues for the first time since the summer, and open interest \
    fell to a two-year low as positions were closed rather than rolled into the next week.</p>\
    <p>Desks expect the range to hold until the central bank's decision in December.</p></article></body></html>";

#[tokio::test]
async fn a_search_reads_every_publisher_once_and_answers_from_what_it_holds() {
    let server = MockServer::start().await;
    let link = |route: &str| format!("{}{route}", server.uri());
    serve(
        &server,
        "/desk/rss",
        rss(&[
            item(
                "Bitcoin slides 12% through its 200-week average",
                &link("/desk/btc"),
                "The drop has a bullish past.",
                6,
                "",
            ),
            item(
                "Solana says account rent could fall 86%",
                &link("/desk/sol"),
                "Developers would pay less.",
                4,
                "",
            ),
        ]),
    )
    .await;
    serve(
        &server,
        "/block/rss",
        rss(&[item(
            "Miner that sold its last BTC warns on cash",
            &link("/block/miner"),
            "It may run short.",
            7,
            "",
        )]),
    )
    .await;
    // One publisher is down. The others still answer.
    serve(&server, "/down/rss", ResponseTemplate::new(503)).await;
    let web = web(&server, &[("Desk", "/desk/rss"), ("Block", "/block/rss"), ("Down", "/down/rss")]);
    assert_eq!(web.publishers(), ["Desk", "Block", "Down"]);

    let found = web.search("BTC", &[]).await.expect("search");
    let titles: Vec<&str> = found.iter().map(|article| article.title.as_str()).collect();
    assert_eq!(
        titles,
        ["Miner that sold its last BTC warns on cash", "Bitcoin slides 12% through its 200-week average"]
    );
    assert_eq!((found[0].source.as_str(), found[0].url.as_str()), ("Block", link("/block/miner").as_str()));
    assert_eq!(found[1].summary, "The drop has a bullish past.");

    // The words searched for are matched here. Nothing more is asked of anyone.
    assert_eq!(web.search("solana rent", &[]).await.expect("search").len(), 1);
    assert_eq!(web.search("dogecoin", &[]).await.expect("search"), []);
    assert_eq!(web.search("", &[]).await.expect("newest").len(), 3);
    assert_eq!((hits(&server, "/desk/rss").await, hits(&server, "/block/rss").await), (1, 1));
    let asked: Vec<String> =
        server.received_requests().await.expect("recorded").iter().map(|r| r.url.to_string()).collect();
    assert!(
        asked.iter().all(|url| !url.to_lowercase().contains("btc") && url.ends_with("/rss")),
        "{asked:?}"
    );
}

#[tokio::test]
async fn with_no_publisher_in_reach_the_search_says_so() {
    let server = MockServer::start().await;
    serve(&server, "/a/rss", ResponseTemplate::new(503)).await;
    serve(&server, "/b/rss", html("<html><body>Just a moment...</body></html>")).await;
    let web = web(&server, &[("Desk", "/a/rss"), ("Block", "/b/rss")]);
    let error = web.search("bitcoin", &[]).await.expect_err("nobody answered");
    assert_eq!(error.0, "Desk did not send its news (503).");
    // Nothing was kept, so the next search asks again.
    assert!(web.search("bitcoin", &[]).await.is_err());
    assert_eq!(hits(&server, "/a/rss").await, 2);

    let nowhere = Web::standing_in(vec![("Gone".to_string(), "http://127.0.0.1:9/rss".to_string())], None)
        .expect("web");
    let error = nowhere.search("bitcoin", &[]).await.expect_err("unreachable");
    assert!(error.0.starts_with("Could not reach Gone"), "{}", error.0);
    assert!(!error.0.contains("127.0.0.1"), "the address is not shown: {}", error.0);
}

#[tokio::test]
async fn a_page_is_read_as_its_article() {
    let server = MockServer::start().await;
    serve(&server, "/desk/btc", html(STORY)).await;
    serve(&server, "/moved", ResponseTemplate::new(302).insert_header("location", "/desk/btc")).await;
    serve(
        &server,
        "/scripted",
        html(
            "<html><head><meta property=\"og:title\" content=\"Carry trades\">\
              <meta name=\"description\" content=\"Sygnum expects carry trades to beat bills.\"></head>\
              <body><div id=\"app\"></div></body></html>",
        ),
    )
    .await;
    serve(
        &server,
        "/notes.txt",
        ResponseTemplate::new(200).set_body_raw("  Line one \n\n line   two\n", "text/plain"),
    )
    .await;
    serve(
        &server,
        "/latin",
        ResponseTemplate::new(200).set_body_raw(
            b"<html><head><meta charset=\"windows-1252\"></head><body><p>Le march\xe9 recule de 3 % apr\xe8s la d\xe9cision de la Fed.</p></body></html>".to_vec(),
            "text/html",
        ),
    )
    .await;
    let web = web(&server, &[]);
    let link = |route: &str| format!("{}{route}", server.uri());

    let page = web.read(&link("/desk/btc")).await.expect("page");
    assert_eq!((page.title.as_str(), page.site.as_str()), ("Bitcoin slides - Desk", "Desk"));
    assert_eq!(page.published.as_deref(), Some("2026-11-19 06:00"));
    assert_eq!(page.text.lines().count(), 4);
    assert!(page.text.starts_with("Bitcoin slid twelve percent") && !page.text.contains("Menu items"));
    assert!(!page.summary_only);

    // A redirect is followed, and the page says where it ended up.
    let moved = web.read(&link("/moved")).await.expect("redirect");
    assert_eq!(moved.url, link("/desk/btc"));

    // A page drawn by scripts has only its own summary to offer, and says so.
    let scripted = web.read(&link("/scripted")).await.expect("summary");
    assert_eq!(
        (scripted.text.as_str(), scripted.summary_only),
        ("Sygnum expects carry trades to beat bills.", true)
    );
    assert_eq!(scripted.site, "127.0.0.1");

    let notes = web.read(&link("/notes.txt")).await.expect("plain text");
    assert_eq!(notes.text, "Line one\nline two");
    // A paragraph or two is the opening of an article, not the article, and is not passed off as one.
    let latin = web.read(&link("/latin")).await.expect("another encoding");
    assert_eq!(latin.text, "Le marché recule de 3 % après la décision de la Fed.");
    assert!(latin.summary_only);
}

#[tokio::test]
async fn a_page_that_cannot_be_read_is_explained() {
    let server = MockServer::start().await;
    for (route, status) in [("/blocked", 403), ("/busy", 429), ("/gone", 404), ("/broken", 500)] {
        serve(&server, route, ResponseTemplate::new(status).set_body_string("<p>Attention required</p>"))
            .await;
    }
    serve(&server, "/chart.png", ResponseTemplate::new(200).set_body_raw(vec![0u8; 64], "image/png")).await;
    serve(&server, "/empty", html("<html><body><div id=\"app\"></div></body></html>")).await;
    serve(
        &server,
        "/away",
        ResponseTemplate::new(302).insert_header("location", "ftp://files.example.com/a"),
    )
    .await;
    let web = web(&server, &[]);
    let read = async |route: &str| web.read(&format!("{}{route}", server.uri())).await.expect_err(route).0;

    let refused = "127.0.0.1 does not let apps read this page. Work from the headline and summary, or use another source.";
    assert_eq!(read("/blocked").await, refused);
    assert_eq!(read("/busy").await, refused);
    assert_eq!(read("/gone").await, "127.0.0.1 no longer has that page.");
    assert_eq!(read("/broken").await, "127.0.0.1 could not send the page (500).");
    assert_eq!(read("/chart.png").await, "That link is not a page of text.");
    assert_eq!(read("/empty").await, "127.0.0.1 sent a page with no text to read. It may need a browser.");
    assert_eq!(read("/away").await, "127.0.0.1 sends this link somewhere that cannot be read.");
    assert!(web.read("file:///etc/passwd").await.is_err());
}

#[tokio::test]
async fn an_article_the_feed_carries_whole_is_read_without_asking_for_the_page() {
    let server = MockServer::start().await;
    let link = format!("{}/whole", server.uri());
    let body: String = (0..8)
        .map(|n| format!("<p>Paragraph number {n} of a story that the feed carries whole, with plenty of words in it.</p>"))
        .collect();
    let extra = format!("<content:encoded><![CDATA[{body}]]></content:encoded>");
    serve(&server, "/rss", rss(&[item("A story carried whole", &link, "A teaser.", 5, &extra)])).await;
    serve(&server, "/whole", ResponseTemplate::new(403)).await;
    let web = web(&server, &[("Desk", "/rss")]);

    // Before the feeds are read the page has to be asked for, and it refuses.
    assert!(web.read(&link).await.is_err());
    assert_eq!(web.search("story", &[]).await.expect("search").len(), 1);
    let page = web.read(&link).await.expect("from the feed");
    assert_eq!((page.title.as_str(), page.site.as_str()), ("A story carried whole", "Desk"));
    assert_eq!((page.text.lines().count(), page.published.as_deref()), (8, Some("2026-11-19 05:00")));
    assert_eq!(hits(&server, "/whole").await, 1, "the second read did not go to the site");
}

#[tokio::test]
async fn only_public_pages_are_read_outside_tests() {
    let web = Web::new().expect("web");
    assert_eq!(web.publishers().len(), 8);
    for feed in &web.feeds {
        assert!(Guard::Public.parse(&feed.url).is_ok(), "{}", feed.url);
        // Only the feed that gathers other publishers' articles may link off its own site.
        assert_eq!(feed.gathers, feed.name == "Yahoo Finance", "{}", feed.name);
    }
    assert!(Guard::Public.parse(BY_TICKER).is_ok());
    let refused = "That is not a public web page. Only https links to public sites can be read.";
    for address in [
        "http://127.0.0.1:11434/api/tags",
        "https://127.0.0.1/",
        "https://localhost/",
        "https://[::1]/",
        "https://router.lan/",
        "http://example.com/",
        "file:///etc/passwd",
    ] {
        assert_eq!(web.read(address).await.expect_err(address).0, refused);
    }
    // A name that leads to this computer is refused when the connection is made, whatever it is called.
    let resolved = PublicOnly.resolve("localhost".parse().expect("name")).await;
    assert!(resolved.is_err(), "localhost must not resolve to an address the app connects to");

    // One publisher's feed does not vouch for another site's pages.
    let site = |address: &str| Url::parse(address).expect("url");
    assert!(same_site(&site("https://www.coindesk.com/arc/rss/"), &site("https://coindesk.com/markets/a")));
    assert!(same_site(&site("https://crypto.news/feed/"), &site("https://crypto.news/a-story/")));
    assert!(!same_site(&site("https://www.coindesk.com/rss/"), &site("https://coindesk.com.evil.example/a")));
    assert!(!same_site(&site("https://decrypt.co/feed"), &site("https://theblock.co/a")));
}

#[test]
fn encodings_are_taken_from_the_server_then_the_page() {
    assert_eq!(decode(b"caf\xc3\xa9", None), "café");
    assert_eq!(decode(b"caf\xe9", Some("iso-8859-1")), "café");
    assert_eq!(decode(b"<meta charset='windows-1252'>caf\xe9", None), "<meta charset='windows-1252'>café");
    assert_eq!(
        decode(
            b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=Shift_JIS\">\x93\xfa\x96\x7b",
            None
        )
        .chars()
        .rev()
        .take(2)
        .collect::<String>(),
        "本日"
    );
    // An encoding nobody knows is read as UTF-8, and broken bytes do not stop the reading.
    assert_eq!(decode(b"plain \xff text", Some("klingon")), "plain \u{fffd} text");
    assert_eq!(declared_charset(b"<html><body>no word about it</body></html>"), None);
}

#[tokio::test]
async fn a_share_asked_about_brings_the_headlines_filed_under_its_ticker() {
    let server = MockServer::start().await;
    let link = |route: &str| format!("{}{route}", server.uri());
    serve(
        &server,
        "/desk/rss",
        rss(&[
            item(
                "Chip stocks slide as rates rise",
                &link("/desk/chips"),
                "Nvidia fell with the sector.",
                6,
                "",
            ),
            item("Bitcoin slides 12% through its 200-week average", &link("/desk/btc"), "", 4, ""),
        ]),
    )
    .await;
    // The feed filed by ticker answers whatever ticker it is asked for, and says which.
    Mock::given(method("GET"))
        .and(path("/ticker"))
        .respond_with(|request: &wiremock::Request| {
            let asked: String = request
                .url
                .query_pairs()
                .find(|(key, _)| key == "s")
                .map(|(_, v)| v.into())
                .unwrap_or_default();
            match asked.as_str() {
                "NVDA" => rss(&[
                    item(
                        "A board that would look like clowns",
                        "https://www.example.com/markets/board",
                        "Investors doubt a return.",
                        8,
                        "",
                    ),
                    item(
                        "Nvidia guides to $130 billion",
                        "https://finance.example.com/nvda-guide",
                        "The memory trade is back.",
                        7,
                        "",
                    ),
                ]),
                "GC=F" => rss(&[item(
                    "Gold and silver slide hard",
                    "https://finance.example.com/gold",
                    "Volatility jumped.",
                    5,
                    "",
                )]),
                _ => rss(&[]),
            }
        })
        .mount(&server)
        .await;
    let feeds = vec![("Desk".to_string(), link("/desk/rss"))];
    let web = Web::standing_in(feeds, Some(link("/ticker"))).expect("web");
    let ticker = |asked: &str, symbol: &str| Ticker {
        asked: asked.to_string(),
        symbol: symbol.to_string(),
        names: if symbol == "NVDA" { vec!["nvidia".to_string()] } else { Vec::new() },
    };

    // Without the ticker only the newsroom's own headline is found, by the company's name in its summary.
    let plain = web.search("nvidia", &[]).await.expect("search");
    assert_eq!(
        plain.iter().map(|a| a.title.as_str()).collect::<Vec<_>>(),
        ["Chip stocks slide as rates rise"]
    );
    assert_eq!(hits(&server, "/ticker").await, 0);

    // With it, what is filed under the ticker is found too, whether or not a headline names the company.
    let found = web.search("nvidia", &[ticker("nvidia", "NVDA")]).await.expect("search");
    assert_eq!(
        found.iter().map(|a| (a.source.as_str(), a.title.as_str())).collect::<Vec<_>>(),
        [
            ("Yahoo Finance", "Nvidia guides to $130 billion"),
            ("Yahoo Finance", "A board that would look like clowns"),
            ("Desk", "Chip stocks slide as rates rise"),
        ]
    );
    // The feed gathers other publishers' articles, so its links lead elsewhere, and they are kept as they are.
    assert_eq!(found[1].url, "https://www.example.com/markets/board");
    let asked: Vec<String> = server
        .received_requests()
        .await
        .expect("recorded")
        .iter()
        .filter(|request| request.url.path() == "/ticker")
        .map(|request| request.url.query().unwrap_or_default().to_string())
        .collect();
    assert_eq!(asked, ["s=NVDA&region=US&lang=en-US"], "the ticker is all that is sent");

    // Asked again by ticker: the same headlines, from memory, and the newsroom that wrote the
    // company's name is found by it.
    let again = web.search("NVDA outlook", &[ticker("NVDA", "NVDA")]).await.expect("search");
    assert_eq!(again.len(), 3);
    assert!(again.iter().any(|article| article.source == "Desk"));
    assert_eq!(hits(&server, "/ticker").await, 1);
    // A commodity is filed under its future, and a ticker with no news changes nothing.
    let gold = web.search("XAU", &[ticker("XAU", "GC=F")]).await.expect("search");
    assert_eq!(gold.iter().map(|a| a.title.as_str()).collect::<Vec<_>>(), ["Gold and silver slide hard"]);
    assert_eq!(web.search("bitcoin", &[ticker("SKHYNIX", "SKHYNIX")]).await.expect("search").len(), 1);

    // Which words of a question are tickers is for the caller to say; no more than three are looked up.
    let known = |word: &str| match word.to_uppercase().as_str() {
        "NVDA" | "NVIDIA" => Some(("NVDA".to_string(), vec!["nvidia".to_string()])),
        symbol @ ("TSLA" | "AAPL" | "AMD") => Some((symbol.to_string(), Vec::new())),
        _ => None,
    };
    assert_eq!(
        tickers_in("Why is nvidia (NVDA) down, and TSLA? aapl, amd too", known),
        [ticker("nvidia", "NVDA"), ticker("TSLA", "TSLA"), ticker("aapl", "AAPL")]
    );
    assert_eq!(tickers_in("why is bitcoin down", known), []);
}

#[tokio::test]
async fn headlines_filed_under_a_ticker_stand_in_when_no_newsroom_answers() {
    let server = MockServer::start().await;
    serve(&server, "/down/rss", ResponseTemplate::new(503)).await;
    serve(
        &server,
        "/ticker",
        rss(&[item("Nvidia guides to $130 billion", "https://finance.example.com/nvda", "", 7, "")]),
    )
    .await;
    let web = Web::standing_in(
        vec![("Down".to_string(), format!("{}/down/rss", server.uri()))],
        Some(format!("{}/ticker", server.uri())),
    )
    .expect("web");
    let nvda = [Ticker { asked: "NVDA".to_string(), symbol: "NVDA".to_string(), names: Vec::new() }];
    assert_eq!(web.search("NVDA", &nvda).await.expect("search").len(), 1);
    // A question about something else still says that the newsrooms are out of reach.
    assert_eq!(web.search("bitcoin", &[]).await.expect_err("down").0, "Down did not send its news (503).");
}

fn titles(front: &Front) -> Vec<&str> {
    front.stories.iter().map(|story| story.article.title.as_str()).collect()
}

#[tokio::test]
async fn the_front_page_shows_every_story_once_newest_first_and_who_did_not_answer() {
    let server = MockServer::start().await;
    let link = |route: &str| format!("{}{route}", server.uri());
    let picture = format!("<enclosure url=\"{}\" type=\"image/jpeg\"/>", link("/pictures/btc.jpg"));
    serve(
        &server,
        "/desk/rss",
        rss(&[
            item("Bitcoin slides 12% through its 200-week average", &link("/desk/btc"), "", 6, &picture),
            item("Solana says account rent could fall 86%", &link("/desk/sol"), "", 4, ""),
            // The same headline again, under a link the publisher tagged.
            item("Bitcoin slides 12% through its 200-week average", &link("/desk/btc?ref=rss"), "", 3, ""),
            format!(
                "<item><title>A note that gives no time</title><link>{}</link></item>",
                link("/desk/note")
            ),
        ]),
    )
    .await;
    serve(
        &server,
        "/block/rss",
        rss(&[
            item("Miner that sold its last BTC warns on cash", &link("/block/miner"), "", 7, ""),
            // Another publisher's link: the same story, whatever its headline here.
            item("Bitcoin falls through a long average", &link("/desk/btc"), "", 5, ""),
            // Another publisher's headline that happens to read the same is its own story.
            item("Solana says account rent could fall 86%", &link("/block/sol"), "", 2, ""),
        ]),
    )
    .await;
    serve(
        &server,
        "/fed/rss",
        rss(&[item("Minutes of the Federal Open Market Committee", &link("/fed/minutes"), "", 5, "")]),
    )
    .await;
    serve(&server, "/down/rss", ResponseTemplate::new(503)).await;
    let web = web(
        &server,
        &[
            ("Desk", "/desk/rss"),
            ("Block", "/block/rss"),
            ("Federal Reserve", "/fed/rss"),
            ("Down", "/down/rss"),
        ],
    );

    let before = Utc::now();
    let front = web.front().await.expect("front page");
    assert_eq!(
        titles(&front),
        [
            "Miner that sold its last BTC warns on cash",
            "Bitcoin slides 12% through its 200-week average",
            "Minutes of the Federal Open Market Committee",
            "Solana says account rent could fall 86%",
            "Solana says account rent could fall 86%",
            "A note that gives no time",
        ]
    );
    let story = &front.stories[1];
    assert_eq!(
        (story.article.url.as_str(), story.article.image.as_deref()),
        (link("/desk/btc").as_str(), Some(link("/pictures/btc.jpg").as_str()))
    );
    assert_eq!(front.stories[4].article.source, "Block");
    // The Federal Reserve and Yahoo Finance report on the economy; the newsrooms on crypto.
    let desks: Vec<Desk> = front.stories.iter().map(|story| story.desk).collect();
    assert_eq!(desks, [Desk::Crypto, Desk::Crypto, Desk::Macro, Desk::Crypto, Desk::Crypto, Desk::Crypto]);
    assert_eq!(desk_of(YAHOO), Desk::Macro);
    // Who was read, who did not answer that read, and when it was made.
    assert_eq!(front.publishers, ["Desk", "Block", "Federal Reserve", "Down"]);
    assert_eq!(front.missing, ["Down"]);
    assert!(before <= front.read_at && front.read_at <= Utc::now(), "{}", front.read_at);

    // The page and the assistant's searches share one read, kept for a few minutes.
    assert_eq!(web.front().await.expect("again"), front);
    assert_eq!(web.search("miner", &[]).await.expect("search").len(), 1);
    assert_eq!((hits(&server, "/desk/rss").await, hits(&server, "/down/rss").await), (1, 1));
}

#[tokio::test]
async fn the_front_page_holds_the_newest_hundred_and_twenty_stories() {
    let server = MockServer::start().await;
    let mut feeds = Vec::new();
    for (feed, name) in ["A", "B", "C"].into_iter().enumerate() {
        // Every story a minute older than the one before, across the three feeds in turn.
        let items: Vec<String> = (0..60)
            .map(|n| {
                let minutes = 23 * 60 + 59 - (feed * 60 + n);
                format!(
                    "<item><title>{name} story {n}</title><link>{}/{name}/{n}</link>\
                     <pubDate>Thu, 19 Nov 2026 {:02}:{:02}:00 GMT</pubDate></item>",
                    server.uri(),
                    minutes / 60,
                    minutes % 60
                )
            })
            .collect();
        let route = format!("/{name}/rss");
        serve(&server, &route, rss(&items)).await;
        feeds.push((name, route));
    }
    let feeds: Vec<(&str, &str)> = feeds.iter().map(|(name, route)| (*name, route.as_str())).collect();
    let front = web(&server, &feeds).front().await.expect("front page");
    assert_eq!(front.stories.len(), 120);
    assert_eq!((titles(&front)[0], titles(&front)[119]), ("A story 0", "B story 59"));
    assert!(front.stories.iter().all(|story| story.article.source != "C"), "the oldest stories are left out");
}

#[tokio::test]
async fn when_nobody_answers_the_last_stories_stand_in_and_every_publisher_is_missing() {
    let server = MockServer::start().await;
    let link = format!("{}/desk/btc", server.uri());
    // The newsroom answers once, then goes down.
    Mock::given(method("GET"))
        .and(path("/desk/rss"))
        .respond_with(rss(&[item("Bitcoin slides 12% through its 200-week average", &link, "", 6, "")]))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    serve(&server, "/desk/rss", ResponseTemplate::new(503)).await;
    serve(&server, "/block/rss", ResponseTemplate::new(503)).await;
    let mut web = web(&server, &[("Desk", "/desk/rss"), ("Block", "/block/rss")]);

    let first = web.front().await.expect("front page");
    assert_eq!((first.stories.len(), first.missing.as_slice()), (1, ["Block".to_string()].as_slice()));

    // What was read goes stale and is read again; nobody answers. The stories read before are
    // shown, with when they were read, and no publisher is said to have answered.
    web.fresh = Duration::ZERO;
    let again = web.front().await.expect("the last stories");
    assert_eq!(again.stories, first.stories);
    assert_eq!(again.read_at, first.read_at);
    assert_eq!(again.missing, ["Desk", "Block"]);
    assert_eq!(hits(&server, "/desk/rss").await, 2);
    // The assistant's search is answered from them too.
    assert_eq!(web.search("bitcoin", &[]).await.expect("search").len(), 1);

    // Stories too old to stand in are not shown; the trader is told why.
    web.kept = Duration::ZERO;
    assert_eq!(web.front().await.expect_err("too old").0, "Desk did not send its news (503).");
}

fn article(title: &str, summary: &str, topics: &[&str]) -> Article {
    Article {
        title: title.to_string(),
        source: "Desk".to_string(),
        url: "https://desk.example.com/a".to_string(),
        published: None,
        summary: summary.to_string(),
        topics: topics.iter().map(|topic| (*topic).to_string()).collect(),
        body: None,
        image: None,
    }
}

#[test]
fn a_story_is_about_the_markets_whose_coins_it_names() {
    let coins = Coins::new([
        ("BTCUSDT", "BTC"),
        ("ETHUSDT", "ETH"),
        ("SOLUSDT", "SOL"),
        ("LINKUSDT", "LINK"),
        ("1000PEPEUSDT", "1000PEPE"),
        ("AIUSDT", "AI"),
        ("UPUSDT", "UP"),
        ("XAUUSD1", "XAU"),
    ]);
    let about =
        |title: &str, summary: &str, topics: &[&str]| coins.named_in(&article(title, summary, topics));
    // By name or by ticker, in the headline, a topic or the summary.
    assert_eq!(about("Bitcoin slides 12%", "", &[]), ["BTCUSDT"]);
    assert_eq!(about("Funds sell", "Spot ETH funds lost $399M.", &[]), ["ETHUSDT"]);
    assert_eq!(about("Funds sell", "", &["Ethereum"]), ["ETHUSDT"]);
    assert_eq!(about("Gold and silver slide", "", &[]), ["XAUUSD1"]);
    // Named in the headline first, then in the order of the market list.
    assert_eq!(
        about("Solana rallies", "Bitcoin and ether held steady.", &[]),
        ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
    );
    // "link" is a word, and Chainlink, or LINK in capitals, is the coin.
    assert_eq!(about("Analysts link the selloff to rate fears", "", &[]), Vec::<String>::new());
    assert_eq!(about("Chainlink whale accumulates $2.16M", "", &[]), ["LINKUSDT"]);
    assert_eq!(about("Whales buy LINK", "", &[]), ["LINKUSDT"]);
    // A coin by the thousand is that coin; everyday words and the news's own abbreviations are not coins.
    assert_eq!(about("PEPE jumps 30%", "", &[]), ["1000PEPEUSDT"]);
    assert_eq!(about("AI agents go rogue as US stocks fall", "Prices went up.", &[]), Vec::<String>::new());
    // A story is tied to no more than a few markets.
    let bases = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];
    let symbols: Vec<String> = bases.iter().map(|base| format!("{base}USDT")).collect();
    let many = Coins::new(symbols.iter().map(String::as_str).zip(bases));
    let roundup = article(&format!("{} all rally today", bases.join(" ")), "", &[]);
    assert_eq!(many.named_in(&roundup), ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT"]);
    // Without a market list a story is tied to none.
    assert_eq!(Coins::default().named_in(&article("Bitcoin slides 12%", "", &[])), Vec::<String>::new());
}

const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x01];
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0";

fn served(bytes: &[u8], kind: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(bytes.to_vec(), kind)
}

#[tokio::test]
async fn only_a_picture_the_front_page_offered_is_fetched_and_only_if_it_is_one() {
    let server = MockServer::start().await;
    let link = |route: &str| format!("{}{route}", server.uri());
    let pictured = |n: usize, route: &str| {
        let enclosure = format!("<enclosure url=\"{}\" type=\"image/jpeg\"/>", link(route));
        item(
            &format!("Story number {n} with a picture"),
            &link(&format!("/story/{n}")),
            "",
            10 - n as u32,
            &enclosure,
        )
    };
    let routes = [
        "/pictures/a.jpg",
        "/pictures/b.png",
        "/pictures/c.svg",
        "/pictures/d.jpg",
        "/pictures/e.jpg",
        "/pictures/f.jpg",
        "/pictures/g.jpg",
    ];
    serve(
        &server,
        "/rss",
        rss(&routes.iter().enumerate().map(|(n, route)| pictured(n, route)).collect::<Vec<_>>()),
    )
    .await;
    let mut huge = JPEG.to_vec();
    huge.resize(PICTURE_LIMIT + 1, 0);
    for (route, response) in [
        ("/pictures/a.jpg", served(JPEG, "image/jpeg")),
        // A server may not say what it sends, or may say something else.
        ("/pictures/b.png", served(PNG, "application/octet-stream")),
        (
            "/pictures/c.svg",
            served(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "image/png"),
        ),
        (
            "/pictures/d.jpg",
            served(b"<!doctype html><html><body>Just a moment...</body></html>", "image/jpeg"),
        ),
        ("/pictures/e.jpg", served(&huge, "image/jpeg")),
        ("/pictures/f.jpg", ResponseTemplate::new(404)),
        (
            "/pictures/g.jpg",
            ResponseTemplate::new(302).insert_header("location", "ftp://files.example.com/g.jpg"),
        ),
    ] {
        serve(&server, route, response).await;
    }
    let web = web(&server, &[("Desk", "/rss")]);
    let unknown = "That picture is not one the News page showed.";

    // Before the page has been given a picture, none is fetched.
    assert_eq!(web.picture(&link("/pictures/a.jpg")).await.expect_err("not offered yet").0, unknown);
    assert_eq!(hits(&server, "/pictures/a.jpg").await, 0);
    let front = web.front().await.expect("front page");
    assert_eq!(front.stories[0].article.image.as_deref(), Some(link("/pictures/a.jpg").as_str()));

    let first = web.picture(&link("/pictures/a.jpg")).await.expect("jpeg");
    assert_eq!(first, Picture { content_type: "image/jpeg".to_string(), bytes: JPEG.to_vec() });
    // Shown again, it comes from memory; the part after `#` changes nothing.
    assert_eq!(web.picture(&format!("{}#top", link("/pictures/a.jpg"))).await.expect("again"), first);
    assert_eq!(hits(&server, "/pictures/a.jpg").await, 1);
    // What a picture is, its first bytes say, whatever the server says.
    let png = web.picture(&link("/pictures/b.png")).await.expect("png");
    assert_eq!((png.content_type.as_str(), png.bytes.as_slice()), ("image/png", PNG));

    let refused = async |route: &str| web.picture(&link(route)).await.expect_err(route).0;
    assert_eq!(refused("/pictures/c.svg").await, "127.0.0.1 sent something that is not a picture.");
    assert_eq!(refused("/pictures/d.jpg").await, "127.0.0.1 sent something that is not a picture.");
    assert_eq!(refused("/pictures/e.jpg").await, "127.0.0.1 sent a picture too large to show.");
    assert_eq!(refused("/pictures/f.jpg").await, "127.0.0.1 did not send the picture (404).");
    assert_eq!(
        refused("/pictures/g.jpg").await,
        "127.0.0.1 sends this picture somewhere that cannot be read."
    );
    // An address the page was not given as a picture, a story's own page among them, is never asked for.
    for other in [link("/story/0"), link("/pictures/z.jpg"), "file:///etc/passwd".to_string(), String::new()]
    {
        assert_eq!(web.picture(&other).await.expect_err(&other).0, unknown);
    }
    assert_eq!((hits(&server, "/story/0").await, hits(&server, "/pictures/z.jpg").await), (0, 0));
}

#[test]
fn only_a_public_https_page_is_a_link_to_open() {
    assert_eq!(
        public_link(" https://www.coindesk.com/markets/2026/11/19/a-story?utm_source=rss#top ")
            .expect("public"),
        "https://www.coindesk.com/markets/2026/11/19/a-story?utm_source=rss"
    );
    let refused = "That is not a public web page. Only https links to public sites can be read.";
    for address in [
        "http://www.coindesk.com/markets",
        "https://127.0.0.1/",
        "https://localhost/admin",
        "https://router.lan/",
        "https://user:secret@example.com/",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "",
    ] {
        assert_eq!(public_link(address).expect_err(address).0, refused);
    }
}
