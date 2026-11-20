/**
 * Application state and the actions that change it.
 *
 * The backend owns the truth: almost every command answers with a fresh
 * `Snapshot`, which replaces the previous one. The store adds only what the
 * backend cannot know: the visible page, what is open, the turn being
 * streamed, and notices.
 */

import { isDesktop, loadBackend } from "../api";
import type {
  ArticleEvent,
  AssistantRequest,
  Backend,
  McpConnectRequest,
  Network,
  Provider,
  ProviderView,
  RiskRequest,
  RunView,
  Side,
  Snapshot,
  Theme,
  TicketRequest,
  TicketView,
  Timeframe,
  TurnEvent,
  UpdateInfo,
  UpdateProgress,
  FundingRequest,
  WalletBrowserRequest,
  WalletKeyRequest,
} from "../api/types";
import { activeWallet } from "../lib/market";
import { networkName } from "../lib/network";
import { devParams } from "./dev";
import { createStore, useStore } from "./store";

export type Page = "chat" | "markets" | "market" | "news" | "account" | "activity";
export type SettingsTab = "models" | "wallet" | "trading" | "tools" | "appearance" | "about";
export type MarketTab = "book" | "funding" | "technicals" | "watchlist";
/** Which stories the News page shows: all of them, those about watched markets, or one desk. */
export type NewsFilter = "top" | "watchlist" | "crypto" | "macro";

export interface ChartOverlays {
  ema: boolean;
  ema200: boolean;
  bollinger: boolean;
  levels: boolean;
  orders: boolean;
}

/** Window width from which the sidebar sits beside the page instead of over it. */
export const SIDEBAR_INLINE = "(min-width: 900px)";

/** The turn currently being streamed. */
export interface LiveTurn {
  run: RunView;
  /** Answer text of the current model round. */
  text: string;
  reasoning: string;
}

export interface Notice {
  id: number;
  text: string;
  tone: "info" | "error";
}

/** Optional values prefilled into the manual order form (for example from a clicked chart level). */
export interface TradePrefill {
  symbol?: string;
  side?: Side;
  qty?: string;
  reduceOnly?: boolean;
  stopLoss?: string;
  takeProfit?: string;
}

/** The open trade dialog. With a ticket it shows that ticket for review instead of the order form. */
export interface TradeState {
  ticket: TicketView | null;
  prefill?: TradePrefill;
}

/** The open settings dialog. `setup` opens the Models tab straight on one provider. */
export interface SettingsState {
  tab: SettingsTab;
  setup: Provider | null;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  downloaded: number;
  contentLength: number | null;
  error: string;
  checkedAt: number | null;
  /** Release version the trader chose to skip for sidebar reminders. */
  skippedVersion: string;
}

/** True when the sidebar and About tab should surface an active update indicator. */
export function hasVisibleUpdate(update: UpdateState): boolean {
  if (update.status === "downloading" || update.status === "ready" || update.status === "installing") return true;
  if (update.status === "available" && update.info) {
    return update.info.version !== update.skippedVersion;
  }
  return false;
}

export interface AppState {
  phase: "booting" | "ready" | "failed";
  bootError: string;
  snapshot: Snapshot | null;
  page: Page;
  /** Where the Back button on the Market detail view returns to. */
  previousPage: Exclude<Page, "market">;
  live: LiveTurn | null;
  /** What the in-flight command is doing, or empty when idle. */
  working: string;
  notice: Notice | null;
  /** Whether the sidebar is kept open on a wide window. Remembered between launches. */
  sidebarOpen: boolean;
  /** Whether the sidebar is slid over the page on a narrow window. */
  drawer: "sidebar" | null;
  marketTab: MarketTab;
  chartTimeframe: Timeframe;
  chartOverlays: ChartOverlays;
  /** The News page's filter. Remembered between launches. */
  newsFilter: NewsFilter;
  settings: SettingsState | null;
  trade: TradeState | null;
  /** Desktop release update check, download progress, and install readiness. */
  update: UpdateState;
  /** Incremented to ask the composer to take focus. */
  composerFocus: number;
}

const MARKET_TABS: readonly MarketTab[] = ["book", "funding", "technicals", "watchlist"];
const NEWS_FILTERS: readonly NewsFilter[] = ["top", "watchlist", "crypto", "macro"];
const TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h", "1d"];
const DEFAULT_OVERLAYS: ChartOverlays = {
  ema: true,
  ema200: false,
  bollinger: false,
  levels: true,
  orders: true,
};

function rememberedOverlays(): ChartOverlays {
  const raw = remembered("overlays");
  if (!raw) return DEFAULT_OVERLAYS;
  try {
    const parsed = JSON.parse(raw) as Partial<ChartOverlays>;
    return {
      ema: typeof parsed.ema === "boolean" ? parsed.ema : DEFAULT_OVERLAYS.ema,
      ema200: typeof parsed.ema200 === "boolean" ? parsed.ema200 : DEFAULT_OVERLAYS.ema200,
      bollinger: typeof parsed.bollinger === "boolean" ? parsed.bollinger : DEFAULT_OVERLAYS.bollinger,
      levels: typeof parsed.levels === "boolean" ? parsed.levels : DEFAULT_OVERLAYS.levels,
      orders: typeof parsed.orders === "boolean" ? parsed.orders : DEFAULT_OVERLAYS.orders,
    };
  } catch {
    return DEFAULT_OVERLAYS;
  }
}

// The prefix keeps the name the app had before it was called OctoNeo, so what was remembered is still found.
function remembered(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`octogens.${key}`) ?? null;
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(`octogens.${key}`, value);
  } catch {
    // Private windows may refuse storage; the choice then lasts for this session only.
  }
}

function wide(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
}

export const app = createStore<AppState>({
  phase: "booting",
  bootError: "",
  snapshot: null,
  page: "chat",
  previousPage: "markets",
  live: null,
  working: "",
  notice: null,
  sidebarOpen: remembered("sidebar") !== "0",
  drawer: null,
  marketTab: MARKET_TABS.find((tab) => tab === remembered("tab")) ?? "book",
  chartTimeframe: TIMEFRAMES.find((tf) => tf === remembered("timeframe")) ?? "4h",
  chartOverlays: rememberedOverlays(),
  newsFilter: NEWS_FILTERS.find((filter) => filter === remembered("news")) ?? "top",
  settings: null,
  trade: null,
  update: {
    status: "idle",
    info: null,
    downloaded: 0,
    contentLength: null,
    error: "",
    checkedAt: null,
    skippedVersion: remembered("skippedUpdate") ?? "",
  },
  composerFocus: 0,
});

export function useApp<S>(selector: (state: AppState) => S): S {
  return useStore(app, selector);
}

/** The latest snapshot. Only call below the boot gate in `App`. */
export function useSnapshot(): Snapshot {
  const snapshot = useApp((state) => state.snapshot);
  if (!snapshot) throw new Error("The snapshot is read before the app finished starting.");
  return snapshot;
}

/** Something is running that the core will not be interrupted in: a command or an assistant turn. */
export function useBusy(): boolean {
  return useApp((state) => Boolean(state.working) || Boolean(state.live) || Boolean(state.snapshot?.busy));
}

let backend: Backend | null = null;
let started = false;
let noticeId = 0;
/** Counts snapshots applied by commands, turns and pushes, so a slower background read never overwrites them. */
let epoch = 0;

function core(): Backend {
  if (!backend) throw new Error("The app is still starting. Try again in a moment.");
  return backend;
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function notify(text: string, tone: Notice["tone"] = "info"): void {
  noticeId += 1;
  app.set({ notice: { id: noticeId, text, tone } });
}

export function dismissNotice(): void {
  app.set({ notice: null });
}

/** A snapshot pushed by background work in the core, such as a wallet page finishing in the browser. */
function applyPushed(next: Snapshot): void {
  const before = app.get().snapshot?.walletNotice;
  epoch += 1;
  app.set({ snapshot: next });
  // How a wallet page ended is said once, when the core first reports it.
  const notice = next.walletNotice;
  if (!notice || (before && before.text === notice.text && before.task === notice.task)) return;
  notify(notice.text, notice.ok ? "info" : "error");
  if (notice.ok) void refreshAccount();
}

/** Loads the backend and the first snapshot. Safe to call more than once. */
export async function start(): Promise<void> {
  if (started) return;
  started = true;
  try {
    backend = await loadBackend();
    const snapshot = await backend.boot();
    const dev = devParams();
    const patch: Partial<AppState> = { phase: "ready", snapshot, page: dev.page ?? "chat" };
    if (dev.sidebar !== undefined) patch.sidebarOpen = dev.sidebar;
    if (dev.tab) patch.marketTab = dev.tab;
    if (dev.news) patch.newsFilter = dev.news;
    if (dev.settings || dev.setup) patch.settings = { tab: dev.settings ?? "models", setup: dev.setup ?? null };
    if (dev.dialog === "trade") patch.trade = { ticket: null };
    app.set(patch);
    backend.onSnapshot(applyPushed);
    if (dev.ask) void ask(dev.ask);
    if (isDesktop()) {
      setTimeout(() => void checkForUpdates({ silent: true }), 2500);
    } else if (dev.update) {
      void checkForUpdates({ silent: true });
    }
  } catch (error) {
    started = false;
    app.set({ phase: "failed", bootError: errorText(error) });
  }
}

/** How a command ended. `reason` is empty when it never started, because another command was running. */
type Outcome = { ok: true } | { ok: false; reason: string };

/** Runs a command that answers with a snapshot. Shows progress and applies the result. */
async function attempt(label: string, work: (backend: Backend) => Promise<Snapshot>): Promise<Outcome> {
  if (app.get().working) return { ok: false, reason: "" };
  epoch += 1;
  app.set({ working: label });
  try {
    const snapshot = await work(core());
    epoch += 1;
    app.set({ snapshot, working: "" });
    return { ok: true };
  } catch (error) {
    app.set({ working: "" });
    // A refused command can still have changed things: a ticket is spent once it is confirmed, even if
    // The exchange then turns the order down. Read the state again so the screen shows where things stand.
    void resync();
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * Runs a command that answers with a snapshot. Shows progress, applies the
 * result, and reports failures as a notice. Resolves to whether it succeeded.
 */
async function command(label: string, work: (backend: Backend) => Promise<Snapshot>): Promise<boolean> {
  const outcome = await attempt(label, work);
  if (!outcome.ok && outcome.reason) notify(outcome.reason, "error");
  return outcome.ok;
}

async function resync(): Promise<void> {
  const at = epoch;
  try {
    const snapshot = await core().snapshot();
    if (at === epoch) app.set({ snapshot });
  } catch {
    // The next background read brings the screen up to date.
  }
}

/** Runs a command that answers with data. The caller shows any error in place. */
export function request<T>(work: (backend: Backend) => Promise<T>): Promise<T> {
  try {
    return work(core());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * A background read. Quiet on failure, skipped while anything else is running,
 * and dropped if something newer was applied while it was in flight.
 */
async function background(read: (backend: Backend) => Promise<Snapshot>): Promise<void> {
  const before = app.get();
  if (!backend || before.live || before.working || !before.snapshot) return;
  const at = epoch;
  try {
    const snapshot = await read(backend);
    const after = app.get();
    if (at === epoch && !after.live && !after.working) app.set({ snapshot });
  } catch {
    // The next tick tries again; the screen keeps showing when its figures were read.
  }
}

/* ------------------------------------------------------------- navigation */

export function navigate(page: Page): void {
  app.set({ page, drawer: null });
}

export function toggleSidebar(): void {
  const state = app.get();
  if (wide(SIDEBAR_INLINE)) {
    remember("sidebar", state.sidebarOpen ? "0" : "1");
    app.set({ sidebarOpen: !state.sidebarOpen });
  } else {
    app.set({ drawer: state.drawer === "sidebar" ? null : "sidebar" });
  }
}

export function closeDrawer(): void {
  if (app.get().drawer) app.set({ drawer: null });
}

export function setMarketTab(tab: MarketTab): void {
  remember("tab", tab);
  app.set({ marketTab: tab });
}

export function setNewsFilter(filter: NewsFilter): void {
  remember("news", filter);
  app.set({ newsFilter: filter });
}

export function setChartTimeframe(timeframe: Timeframe): void {
  remember("timeframe", timeframe);
  app.set({ chartTimeframe: timeframe });
}

export function toggleChartOverlay(key: keyof ChartOverlays): void {
  const next: ChartOverlays = { ...app.get().chartOverlays, [key]: !app.get().chartOverlays[key] };
  remember("overlays", JSON.stringify(next));
  app.set({ chartOverlays: next });
}

export function openSettings(tab: SettingsTab = "models", setup: Provider | null = null): void {
  app.set({ settings: { tab, setup }, drawer: null });
}

export function closeSettings(): void {
  app.set({ settings: null });
}

/** Opens the trade dialog: on the order form (optionally prefilled), or on a drafted ticket to review. */
export function openTrade(ticket: TicketView | null = null, prefill?: TradePrefill): void {
  app.set({ trade: { ticket, prefill } });
}

export function closeTrade(): void {
  app.set({ trade: null });
}

export function focusComposer(): void {
  const state = app.get();
  app.set({ page: "chat", drawer: null, composerFocus: state.composerFocus + 1 });
}

/* ------------------------------------------------------------------ turns */

function applyTurnEvent(event: TurnEvent): void {
  const state = app.get();
  const { live } = state;
  if (!live) return;
  switch (event.type) {
    case "started":
    case "finished":
      app.set({ live: { ...live, run: event.run } });
      break;
    case "text":
      app.set({ live: { ...live, text: live.text + event.delta } });
      break;
    case "round":
      app.set({ live: { ...live, text: "" } });
      break;
    case "reasoning":
      app.set({ live: { ...live, reasoning: live.reasoning + event.delta } });
      break;
    case "step": {
      const steps = [...live.run.steps];
      steps[event.index] = event.step;
      app.set({ live: { ...live, run: { ...live.run, steps } } });
      break;
    }
    case "card":
      app.set({ live: { ...live, run: { ...live.run, cards: [...live.run.cards, event.card] } } });
      break;
    case "ticket":
      // The final snapshot confirms this; until then show the ticket as awaiting confirmation.
      app.set({
        live: { ...live, run: { ...live.run, ticket: event.ticket } },
        snapshot: state.snapshot ? { ...state.snapshot, draft: event.ticket } : state.snapshot,
      });
      break;
  }
}

export async function ask(prompt: string): Promise<boolean> {
  const text = prompt.trim();
  const state = app.get();
  if (!text || state.live || !state.snapshot) return false;
  const pending: RunView = {
    id: "",
    thread: state.snapshot.thread,
    agent: "Assistant",
    title: text,
    network: state.snapshot.network,
    time: new Date().toISOString(),
    status: "running",
    steps: [],
    output: "",
    reasoning: "",
    ms: 0,
    ticket: null,
    cards: [],
    usage: null,
    model: state.snapshot.assistant.model,
  };
  epoch += 1;
  app.set({ live: { run: pending, text: "", reasoning: "" }, page: "chat", drawer: null });
  try {
    const snapshot = await core().ask(text, applyTurnEvent);
    epoch += 1;
    app.set({ snapshot, live: null });
    return true;
  } catch (error) {
    app.set({ live: null });
    notify(errorText(error), "error");
    return false;
  }
}

export function stopTurn(): void {
  if (!app.get().live) return;
  core()
    .stopTurn()
    .catch((error: unknown) => notify(errorText(error), "error"));
}

/** A fresh conversation. Nothing is asked of the core when the open one is still empty. */
export async function newThread(): Promise<void> {
  const state = app.get();
  if (state.live || state.snapshot?.busy) return;
  if (state.snapshot && state.snapshot.turns.length > 0) {
    if (!(await command("Starting a new chat", (api) => api.newThread()))) return;
  }
  focusComposer();
}

export async function openThread(id: string): Promise<boolean> {
  if (app.get().snapshot?.thread === id) {
    navigate("chat");
    return true;
  }
  const ok = await command("Opening the chat", (api) => api.openThread(id));
  if (ok) navigate("chat");
  return ok;
}

export const deleteThread = (id: string) => command("Deleting the chat", (api) => api.deleteThread(id));

/* ----------------------------------------------------------------- market */

export const setNetwork = (network: Network) =>
  command(`Switching to ${networkName(network)}`, (api) => api.setNetwork(network));
export const selectSymbol = (symbol: string) => command("Loading the market", (api) => api.selectSymbol(symbol));
export const watchAdd = (symbol: string) => command("Adding the market", (api) => api.watchAdd(symbol));
export const watchRemove = (symbol: string) => command("Updating the watchlist", (api) => api.watchRemove(symbol));

/** Opens the full-width Market view for `symbol`, remembering where to return. */
export async function focusMarket(symbol: string): Promise<void> {
  const state = app.get();
  const patch: Partial<AppState> = { page: "market", drawer: null };
  if (state.page !== "market") patch.previousPage = state.page;
  app.set(patch);
  if (state.snapshot?.focus !== symbol) await selectSymbol(symbol);
}

/** Returns from the Market detail view to the page that opened it. */
export function leaveMarket(): void {
  app.set({ page: app.get().previousPage, drawer: null });
}

/** Background price refresh for the watchlist. */
export const refreshQuotes = () => background((api) => api.refreshQuotes());

/* ---------------------------------------------------------------- account */

/** Background re-read of balances, positions and open orders. Does nothing without a connected wallet. */
export async function refreshAccount(): Promise<void> {
  const snapshot = app.get().snapshot;
  if (!snapshot || !activeWallet(snapshot).connected) return;
  await background((api) => api.refreshAccount());
}

/** The Refresh button: the same read, with progress and a notice if it fails. */
export const reloadAccount = () => command("Reading the account", (api) => api.refreshAccount());

async function thenRefresh(done: Promise<boolean>): Promise<boolean> {
  const ok = await done;
  if (ok) void refreshAccount();
  return ok;
}

export const cancelOrder = (symbol: string, orderId: string) =>
  thenRefresh(command("Cancelling the order", (api) => api.cancelOrder(symbol, orderId)));
export const cancelAllOrders = (symbol: string) =>
  thenRefresh(command("Cancelling the orders", (api) => api.cancelAllOrders(symbol)));

/* ---------------------------------------------------------------- tickets */

export const prepareTicket = (ticket: TicketRequest) =>
  command("Pricing the ticket", (api) => api.prepareTicket(ticket));
export const submitTicket = (id: string) =>
  thenRefresh(command("Sending the order", (api) => api.submitTicket(id)));
export const dismissTicket = () => command("Dismissing the ticket", (api) => api.dismissTicket());

/** Drafts a ticket that closes the whole position, and opens it for review. Nothing is sent yet. */
export async function closePosition(symbol: string): Promise<boolean> {
  const ok = await command("Drafting the closing ticket", (api) => api.closePosition(symbol));
  const draft = app.get().snapshot?.draft;
  if (ok && draft) openTrade(draft);
  return ok;
}

/* ----------------------------------------------------------------- wallet */

export const connectWalletKey = (wallet: WalletKeyRequest) =>
  thenRefresh(command("Checking the API wallet", (api) => api.connectWalletKey(wallet)));
export const connectWalletBrowser = (wallet: WalletBrowserRequest) =>
  command("Opening your browser", (api) => api.connectWalletBrowser(wallet));
export const disconnectWallet = (network: Network) =>
  command("Forgetting the API wallet", (api) => api.disconnectWallet(network));

/** Opens the page where the trader's own wallet deposits or withdraws. The core opens the browser. */
export const fundWallet = (request: FundingRequest) =>
  command("Opening your browser", (api) => api.fundWallet(request));
export const cancelWalletPage = () => command("Closing the wallet page", (api) => api.cancelWalletPage());

/* ----------------------------------------------------------- tool servers */

export const mcpConnect = (server: McpConnectRequest) =>
  command("Starting the server", (api) => api.mcpConnect(server));
export const mcpDisconnect = (id: string) => command("Removing the server", (api) => api.mcpDisconnect(id));

/* --------------------------------------------------------------- settings */

export const saveAssistant = (settings: AssistantRequest) =>
  command("Connecting the model", (api) => api.saveAssistant(settings));
export const forgetProvider = (provider: Provider) =>
  command("Disconnecting the model", (api) => api.forgetProvider(provider));
export const setTheme = (theme: Theme) => command("Changing theme", (api) => api.setTheme(theme));
export const setWebSearch = (on: boolean) => command("Saving", (api) => api.setWebSearch(on));

/**
 * Saves the trading limits. They apply as they are changed, so a failure is
 * not a notice: this resolves to the reason, for the setting to show beside
 * itself. An empty string means the limits were saved.
 */
export async function saveRisk(limits: RiskRequest): Promise<string> {
  const outcome = await attempt("Saving", (api) => api.saveRisk(limits));
  if (outcome.ok) return "";
  return outcome.reason || "Another change is still being applied. Try again.";
}

/** Switches to a provider that is already connected, with the model it last used. */
export function switchModel(provider: ProviderView): Promise<boolean> {
  const assistant = app.get().snapshot?.assistant;
  if (!assistant) return Promise.resolve(false);
  return saveAssistant({
    provider: provider.id,
    model: provider.model,
    effort: assistant.effort,
    liveTickets: assistant.liveTickets,
  });
}

export function openExternal(url: string): void {
  request((api) => api.openExternal(url)).catch((error: unknown) => notify(errorText(error), "error"));
}

/* ------------------------------------------------------------------- news */

/** An address for an `<img>` of a story's picture, which the core fetches; empty when there is none to show. */
export function pictureSrc(image: string | null): string {
  return image && backend ? backend.pictureSrc(image) : "";
}

/** Follows the in-app article view's loading, title and address. Returns an unsubscribe function. */
export function onArticle(listener: (event: ArticleEvent) => void): () => void {
  return backend ? backend.onArticle(listener) : () => {};
}

/* ---------------------------------------------------------------- updates */

function setUpdate(patch: Partial<UpdateState>): void {
  app.set({ update: { ...app.get().update, ...patch } });
}

/**
 * Checks GitHub Releases (and signed `latest.json` when configured) for a newer
 * version. Silent startup checks never raise an error state when offline.
 */
export async function checkForUpdates(options?: { silent?: boolean }): Promise<boolean> {
  const silent = options?.silent ?? false;
  const current = app.get().update;
  if (
    !backend ||
    current.status === "checking" ||
    current.status === "downloading" ||
    current.status === "installing"
  ) {
    return false;
  }
  if (silent && current.status === "ready") return true;

  setUpdate({ status: "checking", error: "" });
  try {
    const result = await core().checkUpdate();
    const checkedAt = Date.now();
    if (result.status === "available") {
      const { status: _status, ...info } = result;
      void _status;
      const prev = app.get().update;
      const keepReady = prev.status === "ready" && prev.info?.version === info.version;
      // An explicit manual check un-skips the discovered version so the trader can act on it.
      let skippedVersion = prev.skippedVersion;
      if (!silent && skippedVersion === info.version) {
        skippedVersion = "";
        remember("skippedUpdate", "");
      }
      setUpdate({
        status: keepReady ? "ready" : "available",
        info,
        downloaded: keepReady ? prev.downloaded : 0,
        contentLength: keepReady ? prev.contentLength : null,
        error: "",
        checkedAt,
        skippedVersion,
      });
      return true;
    }
    setUpdate({
      status: "upToDate",
      info: null,
      downloaded: 0,
      contentLength: null,
      error: "",
      checkedAt,
    });
    return true;
  } catch (error) {
    if (silent) {
      setUpdate({ status: current.info ? "available" : "idle", error: "" });
      return false;
    }
    setUpdate({ status: "error", error: errorText(error), checkedAt: Date.now() });
    return false;
  }
}

function applyUpdateProgress(progress: UpdateProgress): void {
  const current = app.get().update;
  if (current.status !== "downloading") return;
  if (progress.event === "started") {
    setUpdate({ downloaded: 0, contentLength: progress.contentLength });
  } else if (progress.event === "progress") {
    setUpdate({ downloaded: progress.downloaded, contentLength: progress.contentLength });
  }
}

/** Downloads and cryptographically verifies the available update without restarting yet. */
export async function downloadUpdate(): Promise<boolean> {
  const current = app.get().update;
  if (!backend || !current.info?.canInstall) return false;
  if (current.status === "downloading" || current.status === "installing" || current.status === "ready") {
    return current.status === "ready";
  }

  setUpdate({ status: "downloading", downloaded: 0, contentLength: null, error: "" });
  try {
    await core().downloadUpdate(applyUpdateProgress);
    setUpdate({ status: "ready", error: "" });
    return true;
  } catch (error) {
    setUpdate({ status: "error", error: errorText(error) });
    return false;
  }
}

/** Applies the verified downloaded update and restarts OctoNeo once idle. */
export async function installUpdate(): Promise<boolean> {
  const state = app.get();
  if (!backend || state.update.status !== "ready") return false;
  if (state.live || state.working || state.snapshot?.busy) {
    notify("Wait for the active task to finish before restarting to update.", "error");
    return false;
  }

  setUpdate({ status: "installing", error: "" });
  try {
    await core().installUpdate();
    return true;
  } catch (error) {
    setUpdate({ status: "error", error: errorText(error) });
    return false;
  }
}

/** Hides the sidebar reminder for `version` while leaving it reachable in Settings -> About. */
export function skipUpdate(version: string): void {
  remember("skippedUpdate", version);
  setUpdate({ skippedVersion: version });
}
