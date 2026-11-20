/** What the News page shows and how it words it: no rendering here, so it is easy to test. */

import type { StoryView } from "../../api/types";
import type { NewsFilter } from "../../state/app";

export interface StoryFilter {
  filter: NewsFilter;
  /** Only this publisher's stories, or every publisher's. */
  publisher: string | null;
  /** Symbols on the watchlist. */
  watchlist: ReadonlySet<string>;
}

/** The stories one filter keeps, in the order the feed gave them (newest first). */
export function filterStories(stories: StoryView[], { filter, publisher, watchlist }: StoryFilter): StoryView[] {
  return stories.filter((story) => {
    if (publisher !== null && story.source !== publisher) return false;
    switch (filter) {
      case "watchlist":
        return story.markets.some((symbol) => watchlist.has(symbol));
      case "crypto":
        return story.desk === "crypto";
      case "macro":
        return story.desk === "macro";
      default:
        return true;
    }
  });
}

/** How the stories are laid out, from the top of the page down. */
export interface Front {
  /** The biggest story, with a picture when one of the newest has one. */
  lead: StoryView | null;
  /** Up to two stories beside the lead. */
  rail: StoryView[];
  /** Six or three stories shown as cards with pictures, so the cards fill whole rows; none when fewer are left. */
  grid: StoryView[];
  /** Every other headline, in a compact list. */
  brief: StoryView[];
}

const RAIL = 2;
const GRID = 6;

/** Takes the first story with a picture among the next `window`, or else simply the next one. */
function takePictured(pool: StoryView[], window: number): StoryView | undefined {
  const found = pool.slice(0, window).findIndex((story) => story.image !== null);
  return pool.splice(found >= 0 ? found : 0, 1)[0];
}

/**
 * Lays the stories out like a front page. The newest stories lead, but one with a picture
 * is preferred when it is nearly as new, so the top of the page is never a wall of text.
 * The compact list keeps the feed's order.
 */
export function frontPage(stories: StoryView[]): Front {
  const pool = [...stories];
  const lead = takePictured(pool, 4) ?? null;
  const rail: StoryView[] = [];
  while (rail.length < RAIL && pool.length > 0) rail.push(takePictured(pool, 3)!);

  // Cards come in whole rows; a story or two left over reads better as a line in brief than as a lone card.
  const cards = pool.length >= GRID ? GRID : pool.length >= GRID / 2 ? GRID / 2 : 0;
  // Cards look best with pictures: among the next few stories, pictured ones are shown as cards first.
  const nearby = pool.slice(0, cards + 3);
  const ranked = new Set([...nearby.filter((story) => story.image !== null), ...nearby]);
  const chosen = new Set([...ranked].slice(0, cards));
  const grid = pool.filter((story) => chosen.has(story));
  const brief = pool.filter((story) => !chosen.has(story));
  return { lead, rail, grid, brief };
}

function minutesSince(iso: string | null, now: number): number | null {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? null : Math.max(0, Math.floor((now - time) / 60_000));
}

/** How long ago a story was published, in words: `Just now`, `12 minutes ago`, `Yesterday`. Empty when unknown. */
export function storyAge(iso: string | null, now: number): string {
  const minutes = minutesSince(iso, now);
  if (minutes === null) return "";
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/** When the feeds were read: `Updated 4 minutes ago`. */
export function updatedText(readAt: string, now: number): string {
  const age = storyAge(readAt, now);
  return age ? `Updated ${age.charAt(0).toLowerCase()}${age.slice(1)}` : "";
}

const LIST = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });

/** Which publishers did not answer, in a plain sentence; empty when every one did. */
export function missingText(missing: string[]): string {
  if (missing.length === 0) return "";
  const whose = missing.length === 1 ? "its" : "their";
  return `${LIST.format(missing)} could not be reached, so ${whose} newest stories may be missing.`;
}

/** The site an address is on, without `www.`: what the article view shows while a page is open. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** What an empty page says, and the one action that gets the reader back to stories. */
export interface EmptyCopy {
  title: string;
  text: string;
  action: { label: string; kind: "top" | "publisher" | "refresh" };
}

/** What a publisher has none of, in the filter's own words. */
const NONE_OF: Record<NewsFilter, string> = {
  top: "no stories in the latest read",
  watchlist: "no stories about your watchlist right now",
  crypto: "no crypto stories right now",
  macro: "no macro stories right now",
};

/** The empty state for a filter that keeps no story. `total` is how many stories the feed has. */
export function emptyCopy(filter: NewsFilter, publisher: string | null, missing: string[], total: number): EmptyCopy {
  if (total === 0) {
    return {
      title: "No stories yet",
      text: "The publishers have nothing new right now. Try again in a few minutes.",
      action: { label: "Refresh", kind: "refresh" },
    };
  }
  if (publisher !== null) {
    const unreachable = missing.includes(publisher);
    return {
      title: `Nothing from ${publisher}`,
      text: unreachable
        ? `${publisher} could not be reached on the last read, so its stories are missing for now.`
        : `${publisher} has ${NONE_OF[filter]}.`,
      action: { label: "Show every publisher", kind: "publisher" },
    };
  }
  if (filter === "watchlist") {
    return {
      title: "Nothing about your watchlist",
      text: "None of the latest stories mention a market on your watchlist.",
      action: { label: "Show top stories", kind: "top" },
    };
  }
  return {
    title: filter === "crypto" ? "No crypto stories right now" : "No macro stories right now",
    text: "The latest read has none. Try again in a few minutes, or read the top stories.",
    action: { label: "Show top stories", kind: "top" },
  };
}
