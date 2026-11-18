/**
 * Development-only starting points, read from the page URL when the UI runs in
 * a plain browser against the mock backend. Used for screenshots and for
 * jumping straight to the state you are working on. Ignored in the desktop app.
 *
 *   page=assistant|portfolio|connections|activity|settings
 *   panel=1                      open the market drawer on narrow windows
 *   dialog=trade|keys|mcp|tools  open a dialog (the last three on the Connections page)
 *   venue=binance|bybit|okx      which venue the Connections dialog is for
 *   ask=<prompt>                 send a prompt on startup (seed=live does this for you)
 *
 * The mock backend reads its own parameters (seed, feed, provider, …); see `api/mock.ts`.
 */

import { isDesktop } from "../api";
import type { VenueId } from "../api/types";
import type { Page } from "./app";

export type DevDialog = "trade" | "keys" | "mcp" | "tools";

export interface DevParams {
  page?: Page;
  panel: boolean;
  dialog?: DevDialog;
  venue?: VenueId;
  ask?: string;
}

const PAGES: readonly Page[] = ["assistant", "portfolio", "connections", "activity", "settings"];
const DIALOGS: readonly DevDialog[] = ["trade", "keys", "mcp", "tools"];
const VENUES: readonly VenueId[] = ["binance", "bybit", "okx"];

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

export function devParams(): DevParams {
  if (isDesktop() || typeof window === "undefined") return { panel: false };
  const params = new URLSearchParams(window.location.search);
  const ask = params.get("ask") ?? (params.get("seed") === "live" ? "Analyze BTC on the 4h chart" : "");
  return {
    page: oneOf(params.get("page"), PAGES),
    panel: params.get("panel") === "1",
    dialog: oneOf(params.get("dialog"), DIALOGS),
    venue: oneOf(params.get("venue"), VENUES),
    ask: ask || undefined,
  };
}
