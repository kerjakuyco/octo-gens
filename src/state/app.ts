/**
 * Application state and the actions that change it.
 *
 * The backend owns the truth: almost every command answers with a fresh
 * `Snapshot`, which replaces the previous one. The store adds only what the
 * backend cannot know: the visible page, the turn being streamed, and notices.
 */

import { loadBackend } from "../api";
import type {
  AssistantRequest,
  Backend,
  CredentialsRequest,
  Feed,
  McpConnectRequest,
  RunView,
  Snapshot,
  Theme,
  TicketRequest,
  TurnEvent,
  VenueId,
} from "../api/types";
import { devParams } from "./dev";
import { createStore, useStore } from "./store";

export type Page = "assistant" | "portfolio" | "connections" | "activity" | "settings";

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

export interface AppState {
  phase: "booting" | "ready" | "failed";
  bootError: string;
  snapshot: Snapshot | null;
  page: Page;
  live: LiveTurn | null;
  /** What the in-flight command is doing, or empty when idle. */
  working: string;
  notice: Notice | null;
  /** Market drawer visibility on narrow windows. */
  panelOpen: boolean;
  tradeOpen: boolean;
  /** Incremented to ask the composer to take focus. */
  composerFocus: number;
}

export const app = createStore<AppState>({
  phase: "booting",
  bootError: "",
  snapshot: null,
  page: "assistant",
  live: null,
  working: "",
  notice: null,
  panelOpen: false,
  tradeOpen: false,
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

let backend: Backend | null = null;
let started = false;
let noticeId = 0;

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

/** Loads the backend and the first snapshot. Safe to call more than once. */
export async function start(): Promise<void> {
  if (started) return;
  started = true;
  try {
    backend = await loadBackend();
    const snapshot = await backend.boot();
    const dev = devParams();
    app.set({
      phase: "ready",
      snapshot,
      page: dev.page ?? "assistant",
      panelOpen: dev.panel,
      tradeOpen: dev.dialog === "trade",
    });
    backend.onSnapshot((next) => app.set({ snapshot: next }));
    if (dev.ask) void ask(dev.ask);
  } catch (error) {
    started = false;
    app.set({ phase: "failed", bootError: errorText(error) });
  }
}

/**
 * Runs a command that answers with a snapshot. Shows progress, applies the
 * result, and reports failures as a notice. Resolves to whether it succeeded.
 */
async function command(label: string, work: (backend: Backend) => Promise<Snapshot>): Promise<boolean> {
  if (app.get().working) return false;
  app.set({ working: label });
  try {
    const snapshot = await work(core());
    app.set({ snapshot, working: "" });
    return true;
  } catch (error) {
    app.set({ working: "" });
    notify(errorText(error), "error");
    return false;
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

/* ------------------------------------------------------------- navigation */

export function navigate(page: Page): void {
  app.set({ page, panelOpen: false });
}

export function setPanelOpen(open: boolean): void {
  app.set({ panelOpen: open });
}

export function setTradeOpen(open: boolean): void {
  app.set({ tradeOpen: open });
}

export function focusComposer(): void {
  const state = app.get();
  app.set({ page: "assistant", panelOpen: false, composerFocus: state.composerFocus + 1 });
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
    agent: "",
    title: text,
    feed: state.snapshot.feed,
    time: new Date().toISOString(),
    status: "running",
    steps: [],
    output: "",
    reasoning: "",
    ms: 0,
    ticket: null,
    usage: null,
    model: "",
  };
  app.set({ live: { run: pending, text: "", reasoning: "" }, page: "assistant" });
  try {
    const snapshot = await core().ask(text, applyTurnEvent);
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

export const newThread = () => command("Starting a new chat", (api) => api.newThread());

/* ----------------------------------------------------------------- market */

export const setFeed = (feed: Feed) => command("Switching price feed", (api) => api.setFeed(feed));
export const selectPair = (pair: string) => command("Loading quote", (api) => api.selectPair(pair));
export const watchAdd = (symbol: string) => command("Checking the listing", (api) => api.watchAdd(symbol));
export const watchRemove = (pair: string) => command("Updating watchlist", (api) => api.watchRemove(pair));

/** Background price refresh. Quiet on failure; skipped while anything else is running. */
export async function refreshQuotes(): Promise<void> {
  const before = app.get();
  if (!backend || before.live || before.working || before.snapshot?.feed === "sample") return;
  try {
    const snapshot = await backend.refreshQuotes();
    const after = app.get();
    if (!after.live && !after.working) app.set({ snapshot });
  } catch {
    // The next tick tries again; the market panel shows the age of the last quote.
  }
}

/* ---------------------------------------------------------------- tickets */

export const prepareTicket = (ticket: TicketRequest) =>
  command("Pricing the ticket", (api) => api.prepareTicket(ticket));
export const submitTicket = (id: string) => command("Sending the order", (api) => api.submitTicket(id));
export const dismissTicket = () => command("Dismissing the ticket", (api) => api.dismissTicket());

/* ---------------------------------------------------------- pattern agent */

export const runPattern = (pair: string, budget: string) =>
  command("Evaluating the pattern", (api) => api.runPattern(pair, budget));
export const startWatch = (pair: string, budget: string) =>
  command("Starting the watch", (api) => api.startWatch(pair, budget));
export const stopWatch = () => command("Stopping the watch", (api) => api.stopWatch());

/* ------------------------------------------------------------ connections */

export const setCredentials = (credentials: CredentialsRequest) =>
  command("Checking API keys", (api) => api.setCredentials(credentials));
export const clearCredentials = (venue: VenueId) =>
  command("Removing API keys", (api) => api.clearCredentials(venue));
export const mcpConnect = (server: McpConnectRequest) =>
  command("Starting the server", (api) => api.mcpConnect(server));
export const mcpDisconnect = (venue: VenueId) =>
  command("Detaching the server", (api) => api.mcpDisconnect(venue));

/* --------------------------------------------------------------- settings */

export const saveAssistant = (settings: AssistantRequest) =>
  command("Saving assistant settings", (api) => api.saveAssistant(settings));
export const setTheme = (theme: Theme) => command("Changing theme", (api) => api.setTheme(theme));

export function openExternal(url: string): void {
  request((api) => api.openExternal(url)).catch((error: unknown) => notify(errorText(error), "error"));
}
