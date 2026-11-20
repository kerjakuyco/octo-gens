/**
 * What the News page keeps while the trader is elsewhere: the last feed read, the
 * publisher picked, the story open in the article view, and where the page was
 * scrolled. The filter is part of the app's state, remembered between launches.
 */

import type { Network, NewsFeedView, StoryView } from "../../api/types";
import { app, errorText, navigate, notify, request } from "../../state/app";
import { devParams } from "../../state/dev";
import { createStore, useStore } from "../../state/store";

export interface NewsState {
  feed: NewsFeedView | null;
  /** The network the feed was read on: the markets a story is about belong to it. */
  network: Network | null;
  /** A read is in flight. */
  loading: boolean;
  /** Why the last read failed while there was nothing to show, or empty. */
  error: string;
  /** When the last good read arrived, in milliseconds. */
  readAt: number;
  /** Only this publisher's stories, or every publisher's. */
  publisher: string | null;
  /** The story open in the article view. */
  story: StoryView | null;
  /** The story to give the focus back to on the way out of the article view. */
  returnTo: string | null;
  /** How far the front page was scrolled when it was left. */
  scroll: number;
}

export const news = createStore<NewsState>({
  feed: null,
  network: null,
  loading: false,
  error: "",
  readAt: 0,
  publisher: null,
  story: null,
  returnTo: null,
  scroll: 0,
});

export function useNews<S>(selector: (state: NewsState) => S): S {
  return useStore(news, selector);
}

/** A copy older than this is read again when the page opens. The core keeps its own for as long. */
export const STALE_MS = 5 * 60_000;

/** Whether the page should read the feed now, for the network the app is on. */
export function needsRead(network: Network, now: number): boolean {
  const state = news.get();
  if (state.loading) return false;
  return state.feed === null || state.network !== network || now - state.readAt > STALE_MS;
}

let devStoryOpened = false;

/** Reads the newest stories. A failure with stories on screen keeps them and says so in a notice. */
export async function readNews(): Promise<void> {
  if (news.get().loading) return;
  const network = app.get().snapshot?.network ?? null;
  news.set({ loading: true });
  try {
    const feed = await request((api) => api.newsFeed());
    news.set({ feed, network, loading: false, error: "", readAt: Date.now() });
    if (!devStoryOpened) {
      devStoryOpened = true;
      const wanted = devParams().story;
      const story = wanted ? feed.stories[wanted - 1] : undefined;
      if (story && app.get().page === "news") news.set({ story, returnTo: story.url });
    }
  } catch (error) {
    const reason = errorText(error);
    if (news.get().feed) {
      news.set({ loading: false });
      notify(reason, "error");
    } else {
      news.set({ loading: false, error: reason });
    }
  }
}

/** Opens a story in the article view. `scroll` is where the front page was, to come back to it. */
export function openStory(story: StoryView, scroll: number): void {
  news.set({ story, returnTo: story.url, scroll });
}

/** Back from the article view to the front page. */
export function closeStory(): void {
  news.set({ story: null });
}

export function setPublisher(publisher: string | null): void {
  news.set({ publisher });
}

export function rememberScroll(scroll: number): void {
  news.set({ scroll });
}

/** The sidebar's News item: the front page, even from inside an article. */
export function openNews(): void {
  if (news.get().story) news.set({ story: null });
  navigate("news");
}

// Leaving the page closes the article view: the next visit starts on the front page.
app.subscribe(() => {
  if (news.get().story && app.get().page !== "news") news.set({ story: null, returnTo: null });
});
