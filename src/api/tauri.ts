/** The real backend: commands and events served by the Rust core through Tauri. */

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { safeExternalUrl } from "../lib/markdown";
import type {
  Backend,
  BalanceRow,
  CandleSeries,
  ModelInfo,
  Snapshot,
  ToolInfo,
  TurnEvent,
} from "./types";

export function createTauriBackend(): Backend {
  return {
    boot: () => invoke<Snapshot>("boot"),
    snapshot: () => invoke<Snapshot>("snapshot"),
    setFeed: (feed) => invoke<Snapshot>("set_feed", { feed }),
    selectPair: (pair) => invoke<Snapshot>("select_pair", { pair }),
    refreshQuotes: () => invoke<Snapshot>("refresh_quotes"),
    candles: (pair, timeframe) => invoke<CandleSeries>("candles", { pair, timeframe }),
    watchAdd: (symbol) => invoke<Snapshot>("watch_add", { symbol }),
    watchRemove: (pair) => invoke<Snapshot>("watch_remove", { pair }),

    ask(prompt, onEvent) {
      const channel = new Channel<TurnEvent>();
      channel.onmessage = onEvent;
      return invoke<Snapshot>("ask", { prompt, onEvent: channel });
    },
    stopTurn: () => invoke<void>("stop_turn"),
    newThread: () => invoke<Snapshot>("new_thread"),

    prepareTicket: (request) => invoke<Snapshot>("prepare_ticket", { request }),
    submitTicket: (id) => invoke<Snapshot>("submit_ticket", { id }),
    dismissTicket: () => invoke<Snapshot>("dismiss_ticket"),

    runPattern: (pair, budget) => invoke<Snapshot>("run_pattern", { pair, budget }),
    startWatch: (pair, budget) => invoke<Snapshot>("start_watch", { pair, budget }),
    stopWatch: () => invoke<Snapshot>("stop_watch"),

    setCredentials: (request) => invoke<Snapshot>("set_credentials", { request }),
    clearCredentials: (venue) => invoke<Snapshot>("clear_credentials", { venue }),
    balances: (venue) => invoke<BalanceRow[]>("balances", { venue }),

    mcpConnect: (request) => invoke<Snapshot>("mcp_connect", { request }),
    mcpDisconnect: (venue) => invoke<Snapshot>("mcp_disconnect", { venue }),
    mcpTools: (venue) => invoke<ToolInfo[]>("mcp_tools", { venue }),
    mcpCall: (venue, name, args) => invoke<string>("mcp_call", { venue, name, args }),

    listModels: (key) => invoke<ModelInfo[]>("list_models", { key: key || null }),
    saveAssistant: (request) => invoke<Snapshot>("save_assistant", { request }),
    setTheme: (theme) => invoke<Snapshot>("set_theme", { theme }),

    async openExternal(url) {
      const safe = safeExternalUrl(url);
      if (!safe) throw new Error("Only https links can be opened in the browser.");
      await openUrl(safe);
    },

    onSnapshot(listener) {
      let active = true;
      let stop: (() => void) | undefined;
      void listen<Snapshot>("snapshot", (event) => {
        if (active) listener(event.payload);
      }).then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      });
      return () => {
        active = false;
        stop?.();
      };
    },
  };
}
