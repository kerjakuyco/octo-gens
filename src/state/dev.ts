/**
 * Development-only starting points, read from the page URL when the UI runs in
 * a plain browser against the mock backend. Used for screenshots and for
 * jumping straight to the state you are working on. Ignored in the desktop app.
 *
 *   page=chat|markets|market|news|account|activity
 *   sidebar=1|0                                  sidebar open or closed on a wide window
 *   tab=book|funding|technicals|watchlist        tab of the market view
 *   news=top|watchlist|crypto|macro              filter of the News page
 *   story=3                                      open the third story of the News page in the article view
 *   settings=models|wallet|trading|tools|appearance|about
 *                                                open Settings on a tab
 *   setup=openrouter|cloudflare|ollama|lmstudio  open Settings on that provider's setup
 *   dialog=trade                                 open the order form
 *   ask=<prompt>                                 send a prompt on startup (seed=live does this for you)
 *   platform=macos                               lay the window out as the macOS app does
 *   update=available|manual|upToDate|error       simulate a desktop update check on startup
 *
 * The mock backend reads its own parameters (seed, network, wallet, …); see `api/mock.ts`.
 */

import { isDesktop } from "../api";
import type { Provider } from "../api/types";
import type { MarketTab, NewsFilter, Page, SettingsTab } from "./app";

export interface DevParams {
  page?: Page;
  sidebar?: boolean;
  tab?: MarketTab;
  news?: NewsFilter;
  /** One-based position of the story to open once the News page has read the feed. */
  story?: number;
  settings?: SettingsTab;
  setup?: Provider;
  dialog?: "trade";
  ask?: string;
  platform?: "macos";
  update?: boolean;
}

const PAGES: readonly Page[] = ["chat", "markets", "market", "news", "account", "activity"];
const TABS: readonly MarketTab[] = ["book", "funding", "technicals", "watchlist"];
const NEWS: readonly NewsFilter[] = ["top", "watchlist", "crypto", "macro"];
const SETTINGS: readonly SettingsTab[] = ["models", "wallet", "trading", "tools", "appearance", "about"];
const PROVIDERS: readonly Provider[] = ["openrouter", "cloudflare", "ollama", "lmstudio"];

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function flag(value: string | null): boolean | undefined {
  if (value === "1") return true;
  return value === "0" ? false : undefined;
}

export function devParams(): DevParams {
  if (isDesktop() || typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const ask = params.get("ask") ?? (params.get("seed") === "live" ? "BTC outlook" : "");
  const story = Number(params.get("story"));
  return {
    page: oneOf(params.get("page"), PAGES),
    sidebar: flag(params.get("sidebar")),
    tab: oneOf(params.get("tab"), TABS),
    news: oneOf(params.get("news"), NEWS),
    story: Number.isInteger(story) && story > 0 ? story : undefined,
    settings: oneOf(params.get("settings"), SETTINGS),
    setup: oneOf(params.get("setup"), PROVIDERS),
    dialog: oneOf(params.get("dialog"), ["trade"] as const),
    ask: ask || undefined,
    platform: oneOf(params.get("platform"), ["macos"] as const),
    update: params.has("update") || undefined,
  };
}
