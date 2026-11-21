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
  GridPreviewView,
  GridRequest,
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
import { type CommandValues, marketName } from "../lib/commands";
import { activeWallet } from "../lib/market";
import { networkName } from "../lib/network";
import { devParams } from "./dev";
import { createStore, useStore } from "./store";

export type Page = "chat" | "markets" | "market" | "grid" | "news" | "account" | "activity";
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
  /** What went wrong last: a manual check (status `error`), or a download or install (status `available`). */
  error: string;
  failure: "" | "check" | "download" | "install";
  /** When the last check finished, in milliseconds. */
  checkedAt: number | null;
  /** Release version the trader chose to skip for sidebar reminders. */
  skippedVersion: string;
  /** Download an update that can install itself as soon as it is found. On unless turned off; remembered. */
  auto: boolean;
  /** The app started the download under way by itself, so the sidebar stays quiet about it. */
  background: boolean;
  /** A downloaded update put off with Later: the sidebar says nothing more about it until the next launch. */
  deferredVersion: string;
  /** The trader asked to restart once the task under way is done. */
  restartQueued: boolean;
  /** Said once, on the first launch after OctoNeo restarted into a new version. */
  updated: { version: string; url: string } | null;
}

/** True when the sidebar and the About tab should show that an update needs the trader. */
export function hasVisibleUpdate(update: UpdateState): boolean {
  const version = update.info?.version;
  switch (update.status) {
    case "installing":
      return true;
    case "ready":
      return Boolean(version) && version !== update.deferredVersion;
    case "downloading":
      return !update.background;
    case "available":
      return Boolean(version) && version !== update.skippedVersion;
    default:
      return false;
  }
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
  /** Preferred symbol when opening the Grid Bots workspace (e.g. from Market detail). */
  gridSymbol: string | null;
  /** Desktop release update check, download progress, and install readiness. */
  update: UpdateState;
  /** Incremented to ask the composer to take focus. */
  composerFocus: number;
  /** The latest request to put a command in the message box, or to open the list of commands. */
  composerPreset: ComposerPreset | null;
}

/** A request for the message box to take a command, ready to look over and send. */
export interface ComposerPreset {
  /** Grows with each request, so asking for the same command twice still applies it. */
  tick: number;
  /** The command to put in the box, or null to open the list of commands. */
  command: string | null;
  /** Settings for the command; whatever is left out keeps its default. */
  values?: Partial<CommandValues>;
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

function forget(key: string): void {
  try {
    globalThis.localStorage?.removeItem(`octogens.${key}`);
  } catch {
    // Nothing to do: storage that cannot be read holds nothing to forget.
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
  gridSymbol: null,
  update: {
    status: "idle",
    info: null,
    downloaded: 0,
    contentLength: null,
    error: "",
    failure: "",
    checkedAt: null,
    skippedVersion: remembered("skippedUpdate") ?? "",
    auto: remembered("autoUpdate") !== "0",
    background: false,
    deferredVersion: "",
    restartQueued: false,
    updated: null,
  },
  composerFocus: 0,
  composerPreset: null,
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
    if (isDesktop() || dev.update !== undefined) {
      // The browser mock shows a found update as it is, as when automatic downloads are off.
      if (dev.update === "available") setUpdate({ auto: false });
      if (dev.update === "installed") {
        setUpdate({ updated: { version: snapshot.version, url: releaseTagUrl(snapshot.version) } });
      } else {
        sayIfUpdated(snapshot.version);
      }
      startUpdateChecks(isDesktop() ? FIRST_UPDATE_CHECK_MS : 0);
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

/** Opens the Grid Bots workspace, optionally pre-selecting a perpetual contract symbol. */
export function openGrid(symbol?: string): void {
  app.set({
    page: "grid",
    drawer: null,
    ...(symbol ? { gridSymbol: symbol } : {}),
  });
}

export function focusComposer(): void {
  const state = app.get();
  app.set({ page: "chat", drawer: null, composerFocus: state.composerFocus + 1 });
}

/**
 * Puts a command in the message box with the given settings, for the trader to look over and send.
 * Nothing is sent. With no command, opens the list of commands instead.
 */
export function prefillComposer(command: string | null, values?: Partial<CommandValues>): void {
  const state = app.get();
  app.set({
    page: "chat",
    drawer: null,
    composerFocus: state.composerFocus + 1,
    composerPreset: { tick: (state.composerPreset?.tick ?? 0) + 1, command, values },
  });
}

/** Opens the list of commands in the message box. */
export function openCommands(): void {
  prefillComposer(null);
}

/** The message box took the latest request, so it is not applied again when the box is drawn anew. */
export function takeComposerPreset(): void {
  if (app.get().composerPreset) app.set({ composerPreset: null });
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
    case "grid":
      // Like a ticket: the drafted bot waits for the trader, and the final snapshot confirms it.
      app.set({
        live: { ...live, run: { ...live.run, grid: event.grid } },
        snapshot: state.snapshot ? { ...state.snapshot, gridDraft: event.grid } : state.snapshot,
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
    grid: null,
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

/* ------------------------------------------------------------------ grids */

/** Computes a dry-run futures grid preview without submitting any exchange orders. */
export const previewGrid = (grid: GridRequest): Promise<GridPreviewView> =>
  request((api) => api.previewGrid(grid));

/**
 * Starts a grid bot the trader reviewed. Resolves to an empty string once it is running, or waiting for
 * its start price, and otherwise to why it did not start, for the review to show beside its button.
 */
export async function startGrid(grid: GridRequest): Promise<string> {
  const name = marketName(grid.symbol);
  const outcome = await attempt(`Starting the ${name} grid bot`, (api) => api.startGrid(grid));
  if (!outcome.ok) return outcome.reason || "Another change is still being applied. Try again in a moment.";
  notify(`${name} grid bot started.`);
  return "";
}

/** Brings every running bot up to date with the exchange now, instead of at the next account read. */
export async function syncGrids(): Promise<boolean> {
  return command("Checking the bots", (api) => api.syncGrids());
}

/** Stops a bot: cancels its orders and, when asked, closes the position in its market. */
export async function stopGrid(id: string, closePosition: boolean): Promise<boolean> {
  const ok = await command(closePosition ? "Stopping the bot and closing the position" : "Stopping the bot", (api) =>
    api.stopGrid(id, closePosition),
  );
  if (ok) notify("Grid bot stopped.");
  return ok;
}

/** Removes a stopped bot from the list. */
export const deleteGrid = (id: string) => command("Removing the bot", (api) => api.deleteGrid(id));

/**
 * Starts the grid bot the assistant drafted, now that the trader has looked it over. The core checks the
 * draft again against the live price first; how it went is filed under the draft's id.
 */
export const startGridDraft = (id: string) =>
  thenRefresh(command("Starting the grid bot", (api) => api.startGridDraft(id)));

/** Discards the grid bot the assistant drafted. Nothing was sent for it. */
export const dismissGridDraft = () => command("Discarding the grid bot", (api) => api.dismissGridDraft());

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

/** How often a running app looks for a new version. */
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
/** The first look waits for the window to settle after launch. */
const FIRST_UPDATE_CHECK_MS = 2500;
/** A look prompted by focus or a regained connection waits at least this long after the last try. */
const UPDATE_RETRY_MS = 60 * 1000;
/** How long "Restarting to update…" shows before a queued restart goes ahead. */
const RESTART_PAUSE_MS = 1500;
/** An install that neither restarts the app nor fails within this time is given up on. */
const INSTALL_TIMEOUT_MS = 30 * 1000;
const RELEASES_URL = "https://github.com/kerjakuyco/octo-neo/releases";

let updateChecksOn = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let lastUpdateTry = 0;
let stopWatchingIdle: (() => void) | null = null;
let installTimer: ReturnType<typeof setTimeout> | null = null;

function setUpdate(patch: Partial<UpdateState>): void {
  app.set({ update: { ...app.get().update, ...patch } });
}

function releaseTagUrl(version: string): string {
  const clean = version.trim().replace(/^v/i, "");
  return /^[0-9A-Za-z.+-]+$/.test(clean) ? `${RELEASES_URL}/tag/v${clean}` : RELEASES_URL;
}

/** Whether something is running that a restart would cut short. */
function busyNow(state: AppState): boolean {
  return Boolean(state.live) || Boolean(state.working) || Boolean(state.snapshot?.busy);
}

/** Looks for a new version now and then: shortly after launch, every six hours, and when the window comes back after a long gap. */
function startUpdateChecks(firstDelay: number): void {
  updateChecksOn = true;
  scheduleUpdateCheck(firstDelay);
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const lookIfStale = () => {
    const { checkedAt } = app.get().update;
    const now = Date.now();
    const stale = checkedAt === null || now - checkedAt >= UPDATE_EVERY_MS;
    if (stale && now - lastUpdateTry >= UPDATE_RETRY_MS) void checkForUpdates({ silent: true });
  };
  window.addEventListener("focus", lookIfStale);
  window.addEventListener("online", lookIfStale);
}

function scheduleUpdateCheck(delay: number): void {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    updateTimer = null;
    void checkForUpdates({ silent: true });
  }, delay);
}

/**
 * Checks GitHub Releases (and signed `latest.json` when configured) for a newer
 * version. Silent checks never raise an error state when offline. A version that
 * can install itself is downloaded in the background when automatic downloads are on.
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

  lastUpdateTry = Date.now();
  setUpdate({ status: "checking", error: "", failure: "" });
  try {
    const result = await core().checkUpdate();
    const checkedAt = Date.now();
    if (result.status === "available") {
      const { status: _status, ...info } = result;
      void _status;
      const keepReady = current.status === "ready" && current.info?.version === info.version;
      // An explicit manual check un-skips the discovered version so the trader can act on it.
      let skippedVersion = app.get().update.skippedVersion;
      if (!silent && skippedVersion === info.version) {
        skippedVersion = "";
        remember("skippedUpdate", "");
      }
      setUpdate({
        status: keepReady ? "ready" : "available",
        info,
        downloaded: keepReady ? current.downloaded : 0,
        contentLength: keepReady ? current.contentLength : null,
        error: "",
        failure: "",
        checkedAt,
        skippedVersion,
      });
      downloadIfWanted();
      return true;
    }
    setUpdate({
      status: "upToDate",
      info: null,
      downloaded: 0,
      contentLength: null,
      error: "",
      failure: "",
      checkedAt,
    });
    return true;
  } catch (error) {
    if (silent) {
      // A look the trader did not ask for changes nothing when it fails, offline for instance.
      setUpdate({ status: current.status, error: current.error, failure: current.failure });
      return false;
    }
    setUpdate({ status: "error", error: errorText(error), failure: "check", checkedAt: Date.now() });
    return false;
  } finally {
    if (updateChecksOn) scheduleUpdateCheck(UPDATE_EVERY_MS);
  }
}

/** Starts a background download for a found update that can install itself, unless the trader said not to. */
function downloadIfWanted(): void {
  const { status, info, auto, skippedVersion } = app.get().update;
  if (status !== "available" || !info?.canInstall || !auto || info.version === skippedVersion) return;
  void downloadUpdate({ background: true });
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

/**
 * Downloads and cryptographically verifies the available update without restarting yet.
 * A download that fails leaves the update available, with the reason, to try again.
 */
export async function downloadUpdate(options?: { background?: boolean }): Promise<boolean> {
  const current = app.get().update;
  if (!backend || !current.info?.canInstall) return false;
  if (current.status === "downloading" || current.status === "installing" || current.status === "ready") {
    return current.status === "ready";
  }

  setUpdate({
    status: "downloading",
    background: options?.background ?? false,
    downloaded: 0,
    contentLength: null,
    error: "",
    failure: "",
  });
  try {
    await core().downloadUpdate(applyUpdateProgress);
    setUpdate({ status: "ready", error: "", failure: "" });
    return true;
  } catch (error) {
    setUpdate({ status: "available", error: errorText(error), failure: "download" });
    return false;
  }
}

/**
 * Restarts into the downloaded update. While a task is running it waits instead: the
 * restart then happens by itself once the app is idle.
 */
export async function installUpdate(): Promise<boolean> {
  const state = app.get();
  if (!backend || state.update.status !== "ready") return false;
  if (busyNow(state)) {
    setUpdate({ restartQueued: true });
    watchForIdle();
    return true;
  }
  return beginInstall(0);
}

/** Drops a restart that was waiting for the running task to finish. */
export function cancelQueuedRestart(): void {
  stopIdleWatch();
  setUpdate({ restartQueued: false });
}

function watchForIdle(): void {
  if (stopWatchingIdle) return;
  const look = () => {
    const state = app.get();
    if (!state.update.restartQueued || state.update.status !== "ready") {
      stopIdleWatch();
      return;
    }
    if (!busyNow(state)) void beginInstall(RESTART_PAUSE_MS);
  };
  stopWatchingIdle = app.subscribe(look);
  look();
}

function stopIdleWatch(): void {
  stopWatchingIdle?.();
  stopWatchingIdle = null;
}

async function beginInstall(pause: number): Promise<boolean> {
  stopIdleWatch();
  const { info } = app.get().update;
  setUpdate({ status: "installing", restartQueued: false, error: "", failure: "" });
  if (pause > 0) {
    await new Promise((done) => setTimeout(done, pause));
    if (busyNow(app.get())) {
      // Something started while "Restarting to update…" showed: wait for it again.
      setUpdate({ status: "ready", restartQueued: true });
      watchForIdle();
      return true;
    }
  }
  // Remembered so the next launch can say the update went through.
  if (info) remember("installingUpdate", JSON.stringify({ version: info.version, url: info.releaseUrl }));
  try {
    await core().installUpdate();
    // A successful install restarts the app before this point; never leave it spinning if not.
    if (installTimer) clearTimeout(installTimer);
    installTimer = setTimeout(() => {
      installTimer = null;
      if (app.get().update.status !== "installing") return;
      setUpdate({
        status: "available",
        failure: "install",
        error: "OctoNeo did not restart to finish the update. Quit and open it again, or download the new version from the release page.",
      });
    }, INSTALL_TIMEOUT_MS);
    return true;
  } catch (error) {
    forget("installingUpdate");
    setUpdate({ status: "available", error: errorText(error), failure: "install" });
    notify("OctoNeo could not install the update. Settings → About has the download link.", "error");
    return false;
  }
}

/** Hides the sidebar reminder for `version` while leaving it reachable in Settings -> About. */
export function skipUpdate(version: string): void {
  remember("skippedUpdate", version);
  setUpdate({ skippedVersion: version });
}

/** Puts off a downloaded update: the sidebar says nothing more about it until the next launch or a newer version. */
export function deferUpdate(): void {
  const version = app.get().update.info?.version;
  if (!version) return;
  cancelQueuedRestart();
  setUpdate({ deferredVersion: version });
}

/** Turns background downloads of new versions on or off. */
export function setAutoDownload(on: boolean): void {
  remember("autoUpdate", on ? "1" : "0");
  setUpdate({ auto: on });
  if (on) downloadIfWanted();
}

/** Clears the one-time "Updated to" line. */
export function dismissUpdated(): void {
  setUpdate({ updated: null });
}

/** On the first launch after an update, says once which version OctoNeo now runs. */
function sayIfUpdated(version: string): void {
  const raw = remembered("installingUpdate");
  if (!raw) return;
  forget("installingUpdate");
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; url?: unknown };
    if (typeof parsed.version !== "string") return;
    const clean = (value: string) => value.trim().replace(/^v/i, "");
    if (clean(parsed.version) !== clean(version)) return;
    const url =
      typeof parsed.url === "string" && parsed.url.startsWith(`${RELEASES_URL}/`) ? parsed.url : releaseTagUrl(version);
    setUpdate({ updated: { version: clean(version), url } });
  } catch {
    // Not what this app wrote: nothing to say.
  }
}
