import { describe, expect, it } from "vitest";
import type { StoryView } from "../../api/types";
import { emptyCopy, filterStories, frontPage, missingText, siteOf, storyAge, updatedText } from "./news";

let serial = 0;

function story(overrides: Partial<StoryView> = {}): StoryView {
  serial += 1;
  return {
    title: `Story ${serial}`,
    source: "Tidewire",
    url: `https://tidewire.example/story-${serial}`,
    published: new Date(Date.UTC(2026, 10, 20, 12, 0) - serial * 60_000).toISOString(),
    summary: "",
    image: `data:image/svg+xml,${serial}`,
    topics: [],
    markets: [],
    desk: "crypto",
    ...overrides,
  };
}

describe("filterStories", () => {
  const btc = story({ markets: ["BTCUSDT"] });
  const pepe = story({ markets: ["1000PEPEUSDT"], source: "Kelp Desk" });
  const rates = story({ desk: "macro", source: "Tidal Reserve Bank" });
  const all = [btc, pepe, rates];
  const watchlist = new Set(["BTCUSDT", "ETHUSDT"]);

  it("keeps every story for the top stories, in the feed's order", () => {
    expect(filterStories(all, { filter: "top", publisher: null, watchlist })).toEqual(all);
  });

  it("keeps the stories about a watched market", () => {
    expect(filterStories(all, { filter: "watchlist", publisher: null, watchlist })).toEqual([btc]);
  });

  it("keeps one desk", () => {
    expect(filterStories(all, { filter: "crypto", publisher: null, watchlist })).toEqual([btc, pepe]);
    expect(filterStories(all, { filter: "macro", publisher: null, watchlist })).toEqual([rates]);
  });

  it("narrows any filter to one publisher", () => {
    expect(filterStories(all, { filter: "top", publisher: "Kelp Desk", watchlist })).toEqual([pepe]);
    expect(filterStories(all, { filter: "macro", publisher: "Kelp Desk", watchlist })).toEqual([]);
  });
});

describe("frontPage", () => {
  it("leads with a new story that has a picture, puts two beside it, six in cards, and the rest in brief", () => {
    const stories = [
      story({ image: null }),
      story(),
      ...Array.from({ length: 4 }, () => story()),
      story({ image: null }),
      ...Array.from({ length: 13 }, () => story()),
    ];
    const front = frontPage(stories);
    expect(front.lead).toBe(stories[1]);
    expect(front.rail).toHaveLength(2);
    expect(front.grid).toHaveLength(6);
    expect(front.grid.every((item) => item.image !== null)).toBe(true);

    // Nothing is lost or shown twice, and the list in brief keeps the feed's order.
    const shown = [front.lead!, ...front.rail, ...front.grid, ...front.brief];
    expect(new Set(shown).size).toBe(stories.length);
    const order = front.brief.map((item) => stories.indexOf(item));
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(front.brief).toContain(stories[0]);
    expect(front.brief).toContain(stories[6]);
  });

  it("still leads with the newest story when none of the newest has a picture", () => {
    const stories = Array.from({ length: 5 }, () => story({ image: null }));
    expect(frontPage(stories).lead).toBe(stories[0]);
  });

  it("fills cards in whole rows and lists what is left over in brief", () => {
    const sized = (count: number) => frontPage(Array.from({ length: count }, () => story()));
    expect(sized(0)).toEqual({ lead: null, rail: [], grid: [], brief: [] });
    expect(sized(1)).toMatchObject({ rail: [], grid: [], brief: [] });
    expect(sized(3).rail).toHaveLength(2);
    expect(sized(4)).toMatchObject({ grid: [], brief: [expect.anything()] });
    expect(sized(6).grid).toHaveLength(3);
    expect(sized(8).grid).toHaveLength(3);
    expect(sized(9).grid).toHaveLength(6);
  });
});

describe("wording", () => {
  const now = Date.UTC(2026, 10, 20, 12, 0);
  const before = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("says how long ago a story was published, in words", () => {
    expect(storyAge(before(0), now)).toBe("Just now");
    expect(storyAge(before(1), now)).toBe("1 minute ago");
    expect(storyAge(before(42), now)).toBe("42 minutes ago");
    expect(storyAge(before(60), now)).toBe("1 hour ago");
    expect(storyAge(before(185), now)).toBe("3 hours ago");
    expect(storyAge(before(30 * 60), now)).toBe("Yesterday");
    expect(storyAge(before(3 * 24 * 60), now)).toBe("3 days ago");
    expect(storyAge(null, now)).toBe("");
    expect(storyAge("not a time", now)).toBe("");
  });

  it("says when the feeds were read", () => {
    expect(updatedText(before(0), now)).toBe("Updated just now");
    expect(updatedText(before(4), now)).toBe("Updated 4 minutes ago");
  });

  it("names the publishers that could not be reached, plainly", () => {
    expect(missingText([])).toBe("");
    expect(missingText(["Kelp Desk"])).toBe("Kelp Desk could not be reached, so its newest stories may be missing.");
    expect(missingText(["Kelp Desk", "Tidewire", "Inkline"])).toBe(
      "Kelp Desk, Tidewire and Inkline could not be reached, so their newest stories may be missing.",
    );
  });

  it("shows the site a page is on without www", () => {
    expect(siteOf("https://www.tidewire.example/markets/1")).toBe("tidewire.example");
    expect(siteOf("not an address")).toBe("");
  });

  it("explains an empty page with the one action that brings stories back", () => {
    expect(emptyCopy("top", null, [], 0)).toMatchObject({ title: "No stories yet", action: { kind: "refresh" } });
    expect(emptyCopy("watchlist", null, [], 12)).toMatchObject({
      title: "Nothing about your watchlist",
      action: { kind: "top", label: "Show top stories" },
    });
    expect(emptyCopy("macro", null, [], 12).title).toBe("No macro stories right now");
    expect(emptyCopy("crypto", "The Pelagic Post", [], 12)).toMatchObject({
      title: "Nothing from The Pelagic Post",
      text: "The Pelagic Post has no crypto stories right now.",
      action: { kind: "publisher" },
    });
    expect(emptyCopy("top", "Kelp Desk", ["Kelp Desk"], 12).text).toContain("could not be reached");
  });
});
