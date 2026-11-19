/** The real backend: commands and events served by the Rust core through Tauri. */

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { safeExternalUrl } from "../lib/markdown";
import type {
  Backend,
  CandleSeries,
  FundingView,
  MarketRow,
  ModelInfo,
  OrderBookView,
  Snapshot,
  TechnicalsView,
  ToolInfo,
  TradeView,
  TurnEvent,
} from "./types";

export function createTauriBackend(): Backend {
  return {
    boot: () => invoke<Snapshot>("boot"),
    snapshot: () => invoke<Snapshot>("snapshot"),
    setNetwork: (network) => invoke<Snapshot>("set_network", { network }),
    selectSymbol: (symbol) => invoke<Snapshot>("select_symbol", { symbol }),
    refreshQuotes: () => invoke<Snapshot>("refresh_quotes"),
    refreshAccount: () => invoke<Snapshot>("refresh_account"),
    candles: (symbol, timeframe) => invoke<CandleSeries>("candles", { symbol, timeframe }),
    marketOverview: () => invoke<MarketRow[]>("market_overview"),
    orderBook: (symbol) => invoke<OrderBookView>("order_book", { symbol }),
    recentTrades: (symbol) => invoke<TradeView[]>("recent_trades", { symbol }),
    marketFunding: (symbol) => invoke<FundingView>("market_funding", { symbol }),
    marketTechnicals: (symbol) => invoke<TechnicalsView>("market_technicals", { symbol }),
    watchAdd: (symbol) => invoke<Snapshot>("watch_add", { symbol }),
    watchRemove: (symbol) => invoke<Snapshot>("watch_remove", { symbol }),

    ask(prompt, onEvent) {
      const channel = new Channel<TurnEvent>();
      channel.onmessage = onEvent;
      return invoke<Snapshot>("ask", { prompt, onEvent: channel });
    },
    stopTurn: () => invoke<void>("stop_turn"),
    newThread: () => invoke<Snapshot>("new_thread"),
    openThread: (id) => invoke<Snapshot>("open_thread", { id }),
    deleteThread: (id) => invoke<Snapshot>("delete_thread", { id }),

    prepareTicket: (request) => invoke<Snapshot>("prepare_ticket", { request }),
    submitTicket: (id) => invoke<Snapshot>("submit_ticket", { id }),
    dismissTicket: () => invoke<Snapshot>("dismiss_ticket"),
    closePosition: (symbol) => invoke<Snapshot>("close_position", { symbol }),
    cancelOrder: (symbol, orderId) => invoke<Snapshot>("cancel_order", { symbol, orderId }),
    cancelAllOrders: (symbol) => invoke<Snapshot>("cancel_all_orders", { symbol }),

    connectWalletKey: (request) => invoke<Snapshot>("connect_wallet_key", { request }),
    connectWalletBrowser: (request) => invoke<Snapshot>("connect_wallet_browser", { request }),
    cancelWalletConnect: () => invoke<Snapshot>("cancel_wallet_connect"),
    disconnectWallet: (network) => invoke<Snapshot>("disconnect_wallet", { network }),
    saveRisk: (request) => invoke<Snapshot>("save_risk", { request }),

    mcpConnect: (request) => invoke<Snapshot>("mcp_connect", { request }),
    mcpDisconnect: (id) => invoke<Snapshot>("mcp_disconnect", { id }),
    mcpTools: (id) => invoke<ToolInfo[]>("mcp_tools", { id }),
    mcpCall: (id, name, args) => invoke<string>("mcp_call", { id, name, args }),

    listModels: (request) => invoke<ModelInfo[]>("list_models", { request }),
    saveAssistant: (request) => invoke<Snapshot>("save_assistant", { request }),
    forgetProvider: (provider) => invoke<Snapshot>("forget_provider", { provider }),
    setTheme: (theme) => invoke<Snapshot>("set_theme", { theme }),
    setWebSearch: (on) => invoke<Snapshot>("set_web_search", { on }),

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
