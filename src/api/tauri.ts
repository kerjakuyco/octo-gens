/** The real backend: commands and events served by the Rust core through Tauri. */

import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { safeExternalUrl } from "../lib/markdown";
import type {
  ArticleEvent,
  Backend,
  CandleSeries,
  FundingView,
  GridPreviewView,
  MarketRow,
  ModelInfo,
  NewsFeedView,
  OrderBookView,
  Snapshot,
  TechnicalsView,
  ToolInfo,
  TradeView,
  TurnEvent,
  UpdateCheckResult,
  UpdateProgress,
} from "./types";

/** Calls `listener` with each payload of a Tauri event until the returned function is called. */
function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  let active = true;
  let stop: (() => void) | undefined;
  void listen<T>(event, (received) => {
    if (active) listener(received.payload);
  }).then((unlisten) => {
    if (active) stop = unlisten;
    else unlisten();
  });
  return () => {
    active = false;
    stop?.();
  };
}

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
    previewGrid: (request) => invoke<GridPreviewView>("preview_grid", { request }),
    startGrid: (request) => invoke<Snapshot>("start_grid", { request }),
    syncGrids: () => invoke<Snapshot>("sync_grids"),
    stopGrid: (id, closePosition) => invoke<Snapshot>("stop_grid", { id, closePosition }),
    deleteGrid: (id) => invoke<Snapshot>("delete_grid", { id }),
    startGridDraft: (id) => invoke<Snapshot>("start_grid_draft", { id }),
    dismissGridDraft: () => invoke<Snapshot>("dismiss_grid_draft"),

    connectWalletKey: (request) => invoke<Snapshot>("connect_wallet_key", { request }),
    connectWalletBrowser: (request) => invoke<Snapshot>("connect_wallet_browser", { request }),
    fundWallet: (request) => invoke<Snapshot>("fund_wallet", { request }),
    cancelWalletPage: () => invoke<Snapshot>("cancel_wallet_page"),
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

    checkUpdate: () => invoke<UpdateCheckResult>("check_update"),
    downloadUpdate(onEvent) {
      const channel = new Channel<UpdateProgress>();
      channel.onmessage = onEvent;
      return invoke<void>("download_update", { onEvent: channel });
    },
    installUpdate: () => invoke<void>("install_update"),

    async openExternal(url) {
      const safe = safeExternalUrl(url);
      if (!safe) throw new Error("Only https links can be opened in the browser.");
      await openUrl(safe);
    },

    onSnapshot: (listener) => subscribe<Snapshot>("snapshot", listener),

    newsFeed: () => invoke<NewsFeedView>("news_feed"),
    // The core fetches the picture and serves it on its own scheme; the web view never reaches the publisher.
    pictureSrc: (image) => convertFileSrc(image, "newsimg"),
    openArticle: (url, bounds) => invoke<void>("article_open", { url, bounds }),
    moveArticle: (bounds) => invoke<void>("article_bounds", { bounds }),
    showArticle: (shown) => invoke<void>("article_shown", { shown }),
    reloadArticle: () => invoke<void>("article_reload"),
    closeArticle: () => invoke<void>("article_close"),
    onArticle: (listener) => subscribe<ArticleEvent>("article", listener),
  };
}
