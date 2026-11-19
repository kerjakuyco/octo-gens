/**
 * Application state and the actions that change it.
 *
 * The backend owns the truth: almost every command answers with a fresh
 * `Snapshot`, which replaces the previous one. The store adds only what the
 * backend cannot know: the visible page, what is open, the turn being
 * streamed, and notices.
 */

import { loadBackend } from "../api";
import type {
  AssistantRequest,
  Backend,
  McpConnectRequest,
  Network,
  Provider,
  ProviderView,
  RiskRequest,
  RunView,
  Snapshot,
  Theme,
  TicketRequest,
  TicketView,
  TurnEvent,
  WalletBrowserRequest,
  WalletKeyRequest,
} from "../api/types";
import { activeWallet } from "../lib/market";
import { networkName } from "../lib/network";
import { devParams } from "./dev";
import { createStore, useStore } from "./store";

export type Page = "chat" | "markets" | "account" | "activity";
export type SettingsTab = "models" | "wallet" | "trading" | "tools" | "appearance" | "about";
export type PanelTab = "book" | "funding" | "technicals" | "watchlist";

/** Window widths from which the sidebar and the market panel sit beside the page instead of over it. */
export const SIDEBAR_INLINE = "(min-width: 900px)";
export const PANEL_INLINE = "(min-width: 1180px)";

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

/** The open trade dialog. With a ticket it shows that ticket for review instead of the order form. */
export interface TradeState {
  ticket: TicketView | null;
}

/** The open settings dialog. `setup` opens the Models tab straight on one provider. */
export interface SettingsState {
  tab: SettingsTab;
  setup: Provider | null;
}

export interface AppState {
  phase: "booting" | "ready" | "failed";
  bootError: string;
  snapshot: Snapshot | null;
  page: Page;
  live: LiveTurn | null;
  /** What the in-flight command is doing, or empty when idle. */
  working: string;
  notice: Notice | null;
  /** Whether the sidebar and the market panel are kept open on a wide window. Remembered between launches. */
  sidebarOpen: boolean;
  panelOpen: boolean;
  /** Which of the two is slid over the page on a window too narrow to show it beside the page. */
  drawer: "sidebar" | "panel" | null;
  panelTab: PanelTab;
  settings: SettingsState | null;
  trade: TradeState | null;
  /** Incremented to ask the composer to take focus. */
  composerFocus: number;
}

const PANEL_TABS: readonly PanelTab[] = ["book", "funding", "technicals", "watchlist"];

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
  live: null,
  working: "",
  notice: null,
  sidebarOpen: remembered("sidebar") !== "0",
  panelOpen: remembered("panel") !== "0",
  drawer: null,
  panelTab: PANEL_TABS.find((tab) => tab === remembered("tab")) ?? "book",
  settings: null,
  trade: null,
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
let cancellingConnect = false;

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

/** A snapshot pushed by background work in the core, such as a wallet approval finishing. */
function applyPushed(next: Snapshot): void {
  const waited = app.get().snapshot?.pendingConnect;
  epoch += 1;
  app.set({ snapshot: next });
  if (!waited || next.pendingConnect || cancellingConnect) return;
  const wallet = next.wallets.find((item) => item.network === waited.network);
  if (wallet?.connected) {
    notify(`Wallet connected on ${networkName(waited.network)}`);
    void refreshAccount();
  } else {
    notify(next.connectError || "The wallet approval ended without connecting.", "error");
  }
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
    if (dev.panel !== undefined) {
      patch.panelOpen = dev.panel;
      if (dev.panel && !wide(PANEL_INLINE)) patch.drawer = "panel";
    }
    if (dev.tab) patch.panelTab = dev.tab;
    if (dev.settings || dev.setup) patch.settings = { tab: dev.settings ?? "models", setup: dev.setup ?? null };
    if (dev.dialog === "trade") patch.trade = { ticket: null };
    app.set(patch);
    backend.onSnapshot(applyPushed);
    if (dev.ask) void ask(dev.ask);
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

function showPanel(open: boolean): void {
  if (wide(PANEL_INLINE)) {
    remember("panel", open ? "1" : "0");
    app.set({ panelOpen: open });
  } else {
    app.set({ drawer: open ? "panel" : null });
  }
}

export function togglePanel(): void {
  const state = app.get();
  showPanel(wide(PANEL_INLINE) ? !state.panelOpen : state.drawer !== "panel");
}

export function closeDrawer(): void {
  if (app.get().drawer) app.set({ drawer: null });
}

export function setPanelTab(tab: PanelTab): void {
  remember("tab", tab);
  app.set({ panelTab: tab });
}

export function openSettings(tab: SettingsTab = "models", setup: Provider | null = null): void {
  app.set({ settings: { tab, setup }, drawer: null });
}

export function closeSettings(): void {
  app.set({ settings: null });
}

/** Opens the trade dialog: on the order form, or on a drafted ticket to review. */
export function openTrade(ticket: TicketView | null = null): void {
  app.set({ trade: { ticket } });
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

/** Shows a market in the panel, opening the panel if it is closed. */
export async function focusMarket(symbol: string): Promise<void> {
  showPanel(true);
  if (app.get().snapshot?.focus !== symbol) await selectSymbol(symbol);
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

export async function cancelWalletConnect(): Promise<boolean> {
  // The core may also push a snapshot when the approval stops; that one is not a failure to report.
  cancellingConnect = true;
  try {
    return await command("Cancelling the approval", (api) => api.cancelWalletConnect());
  } finally {
    cancellingConnect = false;
  }
}

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
