import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsFeedView } from "../../api/types";

/** The page as the browser build draws it, on the mock backend. Effects do not run here, so nothing is read. */
async function loadNews() {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { search: "?speed=0&history=0" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { news } = await import("./store");
  const { NewsPage } = await import("./NewsPage");
  const { createMockBackend } = await import("../../api/mock");
  const feed = await createMockBackend({ speed: 0, history: false }).newsFeed();
  return { state, news, NewsPage, feed };
}

describe("NewsPage", () => {
  let state: Awaited<ReturnType<typeof loadNews>>["state"];
  let news: Awaited<ReturnType<typeof loadNews>>["news"];
  let NewsPage: Awaited<ReturnType<typeof loadNews>>["NewsPage"];
  let feed: NewsFeedView;

  const render = () => renderToStaticMarkup(<NewsPage />);
  const title = (start: string) => feed.stories.find((story) => story.title.startsWith(start))!.title;

  function webSearch(on: boolean) {
    const snapshot = state.app.get().snapshot!;
    state.app.set({ snapshot: { ...snapshot, assistant: { ...snapshot.assistant, webSearch: on } } });
  }

  beforeAll(async () => {
    ({ state, news, NewsPage, feed } = await loadNews());
  });

  beforeEach(() => {
    state.navigate("news");
    webSearch(true);
    state.setNewsFilter("top");
    news.set({ feed, network: "testnet", loading: false, error: "", readAt: Date.now(), publisher: null, story: null });
  });

  it("offers to turn web search on while it is off, and reads nothing", () => {
    webSearch(false);
    const html = render();
    expect(html).toContain("Web search is off");
    expect(html).toContain("Turn on web search");
    expect(html).not.toContain(feed.stories[0]!.title);
    expect(html).not.toContain('role="radiogroup"');
  });

  it("shows the shape of the page while the first read is under way", () => {
    news.set({ feed: null, loading: true });
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Reading the news");
    expect(html).toContain("skel");
    expect(html).toContain('aria-label="Show"');
  });

  it("says why the read failed, with a way to try again", () => {
    news.set({ feed: null, error: "None of the newsrooms answered. Check the internet connection, then try again." });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("The news could not be read");
    expect(html).toContain("None of the newsrooms answered.");
    expect(html).toContain("Try again");
  });

  it("lays the stories out as a front page with pictures, publishers, times and markets", () => {
    const html = render();
    expect(html).toContain(feed.stories[0]!.title);
    expect(html).toContain("More stories");
    expect(html).toContain("In brief");
    expect(html).toContain('<span class="news-status">Updated just now</span>');
    expect(html).toMatch(/<span class="news-date">\w+day \d{1,2} \w+<\/span>/);
    expect(html).toContain('aria-label="Open the BTC market"');
    // Pictures are decorative, load as they are scrolled to, and the lead's does not wait.
    expect(html).toMatch(/<img src="data:image\/svg\+xml[^"]*" alt="" loading="eager"/);
    expect(html).toContain('loading="lazy"');
    // Cards prefer stories with pictures; the others are listed in brief, where no picture is shown.
    expect(html).not.toContain("pic-fallback");
    // Each story is opened from its headline.
    expect(html.match(/class="story-open"/g)).toHaveLength(feed.stories.length);
    expect(html).toContain("<time");
  });

  it("gives a story without a picture the publisher's tile instead of a broken image", () => {
    news.set({ publisher: "Kelp Desk" });
    const html = render();
    const miners = title("Miners sold");
    expect(html).toContain(miners);
    expect(html).toMatch(/<span class="pic-fallback" aria-hidden="true"><span class="pic-name">Kelp Desk<\/span><span class="pic-initial">K<\/span>/);
    expect(html).not.toMatch(/<img src=""/);
  });

  it("filters by desk, by watchlist and by publisher", () => {
    state.setNewsFilter("macro");
    let html = render();
    expect(html).toContain(title("Payrolls beat"));
    expect(html).not.toContain(title("Ether funding"));

    state.setNewsFilter("watchlist");
    html = render();
    expect(html).toContain(title("Ether funding"));
    expect(html).not.toContain(title("Payrolls beat"));
    // TON and LTC are listed on testnet but not watched.
    expect(html).not.toContain(title("TON and LTC"));

    state.setNewsFilter("top");
    news.set({ publisher: "Inkline" });
    html = render();
    const shown = feed.stories.filter((story) => html.includes(story.title));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((story) => story.source === "Inkline")).toBe(true);
    expect(html).toContain('aria-label="Publisher: Inkline"');
  });

  it("explains a filter that keeps nothing, with the way back to stories", () => {
    state.setNewsFilter("crypto");
    news.set({ publisher: "The Pelagic Post" });
    const html = render();
    expect(html).toContain("Nothing from The Pelagic Post");
    expect(html).toContain("The Pelagic Post has no crypto stories right now.");
    expect(html).toContain("Show every publisher");
  });

  it("says plainly which publishers could not be reached", () => {
    news.set({ feed: { ...feed, missing: ["Kelp Desk"] } });
    expect(render()).toContain("Kelp Desk could not be reached, so its newest stories may be missing.");
  });

  it("opens a story in the reading panel in a plain browser, keeping the front page behind it", () => {
    const story = feed.stories.find((item) => item.markets.length > 0)!;
    news.set({ story });
    const html = render();
    expect(html).toMatch(/<div class="page news-page" hidden="">/);
    expect(html).toContain('aria-label="Back to News"');
    expect(html).toContain("Open in browser");
    expect(html).toContain(story.source);
    expect(html).toContain("In the desktop app the full article opens right here");
    // The browser has no separate view to reload.
    expect(html).not.toContain('aria-label="Reload"');
  });

  it("closes the article view when the trader goes to another page", () => {
    news.set({ story: feed.stories[0]! });
    state.navigate("markets");
    expect(news.get().story).toBeNull();
  });
});
