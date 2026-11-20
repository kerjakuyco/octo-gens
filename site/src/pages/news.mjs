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
  caption: "Sample headlines from invented newsrooms, from the app’s built-in mock. OctoNeo itself reads seven real publishers.",
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
    "OctoNeo's News page lays out the newest stories from seven publishers like a magazine and opens each one inside the app. The assistant reads the same feeds to explain a move. No key, no account, and one switch turns it off.",
  render: (ctx) =>
    docPage({
      path: "/news/",
      title: "Seven newsrooms, without leaving the app",
      lead: "The News page lays out the newest stories from seven publishers like a magazine, and a story opens right inside the window. Ask why a market is moving, and the assistant reads the same feeds, says who reported what and how long ago, and lists the headlines with links. Neither needs a key or an account, and one switch turns both off.",
      visual: ANSWER,
      sections: [
        {
          id: "page",
          title: "The News page",
          lead: "News in the sidebar lays out the newest stories from the seven publishers like a magazine: a lead story with a large picture, the next ones beside it, a grid of stories with their pictures, then the remaining headlines in brief.",
          body: `${ctx.figure("news-page", {
  alt: "The News page in OctoNeo beside the sidebar: the date, when the stories were read and Refresh; the filters Top stories, Watchlist, Crypto and Macro, and a menu of publishers; a lead story from Tidewire about bitcoin options with a large abstract picture, its summary, its age and a BTC chip; and beside it two stories, from Tidal Reserve Bank and Kelp Desk, each with its picture.",
  caption: "The News page. The newsrooms, their stories and the abstract pictures are invented by the app’s built-in mock; the app reads the seven publishers listed below.",
  kind: "inset",
})}
${facts([
  ["Filters", "Top stories, or only the stories that name a market on your watchlist, the crypto news, or the economy under Macro. A menu narrows any of them to one publisher."],
  ["Each story", "Who published it, how long ago, and chips for the markets it names. A chip opens that market’s page."],
  ["What it holds", "Up to 120 of the newest stories, newest first, each one once. The feeds are read again once the copy the app holds is five minutes old, when you open the page or press Refresh. A publisher that could not be reached is named."],
  ["Pictures", "A story’s picture is the one its feed offers, fetched by the app’s core, never by the interface: only real images, at most 4 MB each, kept in memory and not between launches."],
], "facts-wide")}`,
        },
        {
          id: "article",
          title: "Reading a story in the app",
          lead: "Pick a story and it opens in a browser view inside the window. The bar above it has the way back to News, Reload and Open in browser; going back, or pressing Esc, returns to the page where you left it.",
          body: `<ul class="checks">
<li>The view cannot reach the app’s commands. Tauri refuses commands from remote pages, the interface’s permissions name only its own web view, and every command checks which web view asked.</li>
<li>It moves only to public ${code("https")} pages, and refuses downloads, new windows and other schemes.</li>
<li>It keeps no cookies or storage once you close it.</li>
<li>It loads the publisher’s page as a browser would, with its own scripts, trackers and ads, and the publisher sees your network address. Open in browser hands the story to your own browser instead.</li>
</ul>`,
        },
        {
          id: "publishers",
          title: "Seven publishers",
          lead: "The News page and the assistant read the public RSS feeds of seven publishers, and no other source of news. Together the feeds hold the last day or two of news, about 300 articles.",
          body: table({
            head: ["Publisher", "Feed"],
            stack: true,
            rows: [
              ["CoinDesk", code("https://www.coindesk.com/arc/outboundfeeds/rss/")],
              ["Cointelegraph", code("https://cointelegraph.com/rss")],
              ["The Block", code("https://www.theblock.co/rss.xml")],
              ["Decrypt", code("https://decrypt.co/feed")],
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
          title: "When the assistant reads an article",
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
          title: "How the assistant treats a headline",
          body: `<p>The assistant searches the news when you ask about news or why a market is moving, and once beside the technical reading when you ask for an outlook. It is told to say who reported something and how old it is, to treat a headline as one newsroom’s report and not as a fact, and never to take news as a reason to raise size or leverage.</p>
<p>What it reads on the web reaches the model marked as written by strangers, and its standing instructions say to treat that text as data. The limits on this page do not depend on the model believing it: whatever an article says, the assistant can still only draft a ticket you must confirm. It cannot check the news either, so a headline can be wrong.</p>`,
        },
        {
          id: "privacy",
          title: "Privacy, and turning it off",
          body: `<p>With web search on, the app downloads the public feeds of the seven publishers, the pictures of the stories on the News page and the articles the assistant reads, from your computer. The publishers see a request from your network address, as any site you visit does, and an article you open on the News page loads in the app’s browser view as the publisher made it. What you type is not sent to them, except the ticker of a share, a fund or a commodity you ask about, which goes to Yahoo Finance.</p>
<p>Turn <strong>Web search</strong> off in Settings under Tools. The news tools are then not offered to the model at all, the News page reads nothing and offers to turn it back on, and nothing is downloaded. While it is on, one answer makes at most four news searches and reads at most four pages.</p>
${ctx.figure("settings-tools", {
  alt: "Settings open on Tools: the Web search switch, on, which lets the assistant read news feeds and web pages you share, and an attached tool server.",
  caption: "Settings, Tools. Web search covers the News page, the news the assistant reads and the pages it opens.",
  kind: "column",
})}
<p>The list of publishers is ${code("PUBLISHERS")} in the app’s source; ${out(doc("docs/assistant.md", "news-and-web-pages"), "docs/assistant.md")} describes the search in full.</p>`,
        },
      ],
    }),
};
