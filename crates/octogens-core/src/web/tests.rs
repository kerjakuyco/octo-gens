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
