import { chip, code, doc, docPage, esc, facts, icon, network, out, table, ui } from "../site.mjs";

/**
 * The head's picture: "Any news on BTC and ETH?" as the app answers it with its built-in mock,
 * which invents its headlines and newsrooms. The app itself reads the publishers listed below.
 */
const HEADLINES = [
  ["Funding on ETH perpetuals stays positive after the move", "The Brine Report", "38m"],
  ["ETH slides 1.2% in a day as traders cut leverage", "Kelp Desk", "1h"],
  ["What BTC holders are watching this week", "The Brine Report", "5h"],
  ["Funding on BTC perpetuals stays positive after the move", "Kelp Desk", "5h"],
  ["BTC slides 0.9% in a day as traders cut leverage", "Tidewire", "6h"],
  ["What ETH holders are watching this week", "Tidewire", "6h"],
];

const ANSWER = ui({
  className: "ui-chat",
  label:
    "A sample answer in OctoNeo to Any news on BTC and ETH?: a line saying it checked the news, a news card with six headlines from invented newsrooms, each with its newsroom and age, from 38 minutes to 6 hours old, and a short answer naming who reported what.",
  caption: "Sample headlines from invented newsrooms, from the app’s built-in mock. OctoNeo itself reads eight real publishers.",
  body: `<div class="ui-bar">
<span class="ui-bar-start"><span class="ui-model">Lantern 2 Large${icon("chevronDown", 14)}</span>${chip("Sample")}</span>
<span class="ui-bar-end">${network("Testnet")}</span>
</div>
<div class="ui-thread">
<p class="ui-said"><span>Any news on BTC and ETH?</span></p>
<p class="ui-activity">Checked the news${icon("chevron", 14)}</p>
<div class="ui-card ui-news">
<div class="ui-card-head"><span class="ui-news-head">${icon("news", 16)}<strong>News</strong><span>BTC ETH</span></span></div>
<ul class="ui-headlines">
${HEADLINES.map(([title, source, age]) => `<li><span class="ui-headline">${esc(title)}</span><span class="ui-newsroom">${esc(source)}</span><span class="ui-age num">${age}</span></li>`).join("\n")}
</ul>
</div>
<div class="ui-answer">
<p><strong>The Brine Report has the newest report on BTC and ETH:</strong> funding on ETH perpetuals stays positive after the move.</p>
<ul>
<li>6 headlines from the last day, the oldest 6h ago.</li>
<li>News explains a move. It does not say what comes next, so the stop stays where the chart puts it. This is testnet: prices can differ from mainnet.</li>
</ul>
</div>
</div>`,
});

export default {
  path: "/news/",
  title: "News | OctoNeo",
  description:
    "OctoNeo's assistant reads the news from eight publishers, Yahoo Finance by ticker among them, and searches it on your computer with no key. It works with every model and can be turned off.",
  render: (ctx) =>
    docPage({
      path: "/news/",
      title: "How the assistant reads the news",
      lead: "Ask why a market is moving. The assistant reads the latest headlines, says who reported what and how long ago, and lists the headlines with links. It works with every model, needs no key and no account, and can be turned off.",
      visual: ANSWER,
      sections: [
        {
          id: "publishers",
          title: "Eight publishers",
          lead: "The app reads the public RSS feeds of eight publishers, and nothing else. Together the feeds hold the last day or two of news, about 300 articles.",
          body: table({
            head: ["Publisher", "Feed"],
            stack: true,
            rows: [
              ["CoinDesk", code("https://www.coindesk.com/arc/outboundfeeds/rss/")],
              ["Cointelegraph", code("https://cointelegraph.com/rss")],
              ["The Block", code("https://www.theblock.co/rss.xml")],
              ["Decrypt", code("https://decrypt.co/feed")],
              ["The Defiant", code("https://thedefiant.io/feed")],
              ["crypto.news", code("https://crypto.news/feed/")],
              ["Federal Reserve press releases", code("https://www.federalreserve.gov/feeds/press_all.xml")],
              ["Yahoo Finance", `${code("https://feeds.finance.yahoo.com/rss/2.0/headline")}, by ticker`],
            ],
          }),
        },
        {
          id: "tickers",
          title: "Shares, funds and commodities",
          body: `<p>Yahoo Finance files its news by ticker and has no feed of everything, so it is read in two ways. The news filed under the S&amp;P 500 is read with the other feeds, as the news of the stock market. And when a search names a market that is not a coin, the headlines filed under that ticker are fetched as well.</p>
<p>The exchange says which markets track a share, a fund or a commodity, and for most shares the company’s name. So ${code("NVDA")}, ${code("NVDAUSDT")} and “nvidia” all bring the news filed under ${code("NVDA")}, and ${code("XAU")} brings the news filed under the gold future. Up to three tickers are looked up for one search. Yahoo Finance gathers articles from other publishers, so its headlines can lead to their sites.</p>`,
        },
        {
          id: "search",
          title: "Searched on your computer",
          body: `${facts([
            ["Downloading", "The first search downloads the feeds, and they are kept for five minutes."],
            ["Matching", `The search happens on your computer. Your words are matched against headlines, topics and summaries, and a ticker finds its coin: ${code("BTC")} finds “Bitcoin”, ${code("SOLUSDT")} finds “Solana”.`],
            ["Ranking", "A match in the headline counts for more than one in the summary, and newer comes before older."],
            ["Variety", "Two newsrooms reporting one story are shown once, and no publisher takes more than three places while others have something."],
            ["What leaves", "What you asked is not sent to any publisher. The one exception is the ticker Yahoo Finance is asked for."],
          ], "facts-wide")}
<p>This is not a search of the whole web. A general search engine needs an account and a key, and the news feeds of the large search engines forbid this kind of use.</p>`,
        },
        {
          id: "articles",
          title: "Reading an article",
          body: `<p>The assistant can read the article behind a headline, or a page you paste a link to. The app fetches the page and keeps its paragraphs: text outside menus, sidebars and forms that is not mostly links. Some sites refuse apps, and some draw their articles with scripts; then the assistant is told so and works from the headline and summary. A model on your computer is handed less of a long article.</p>
<ul class="checks">
<li>It reads only a page a news search showed it, or one you gave it a link to. A link it made up is refused before any request is made, so a page cannot talk it into carrying something away inside an address.</li>
<li>A link the model altered is read as it was first given, never as the model wrote it.</li>
<li>Only public ${code("https")} pages are read. An address on your computer or on a private network is refused: by name, by number, after a redirect, and again when the connection is made.</li>
<li>A publisher’s feed can only add links to that publisher’s own site. Yahoo Finance, which gathers other publishers’ articles, is the one exception.</li>
</ul>`,
        },
        {
          id: "reports",
          title: "How it treats a headline",
          body: `<p>The assistant searches the news when you ask about news or why a market is moving, and once beside the technical reading when you ask for an outlook. It is told to say who reported something and how old it is, to treat a headline as one newsroom’s report and not as a fact, and never to take news as a reason to raise size or leverage.</p>
<p>What it reads on the web reaches the model marked as written by strangers, and its standing instructions say to treat that text as data. The limits on this page do not depend on the model believing it: whatever an article says, the assistant can still only draft a ticket you must confirm. It cannot check the news either, so a headline can be wrong.</p>`,
        },
        {
          id: "privacy",
          title: "Privacy, and turning it off",
          body: `<p>With web search on, the app downloads the publishers’ feeds and the articles the assistant reads, from your computer. The publishers see a request from your network address, as any site you visit does. What you type is not sent to them, except the ticker of a share, a fund or a commodity you ask about, which goes to Yahoo Finance.</p>
<p>Turn <strong>Web search</strong> off in Settings under Tools. The news tools are then not offered to the model at all, and nothing is downloaded. While it is on, one answer makes at most four news searches and reads at most four pages.</p>
${ctx.figure("settings-tools", {
  alt: "Settings, Tools tab, with the Web search switch for news and web pages turned on.",
  caption: "Settings, Tools. Web search covers the news and the pages the assistant reads.",
  kind: "column",
})}
<p>The list of publishers is ${code("PUBLISHERS")} in the app’s source; ${out(doc("docs/assistant.md", "news-and-web-pages"), "docs/assistant.md")} describes the search in full.</p>`,
        },
      ],
    }),
};
