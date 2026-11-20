import { useEffect, useLayoutEffect, useRef } from "react";
import { isDesktop } from "./api";
import { Toast } from "./components/Toast";
import { AccountPage } from "./features/account/AccountPage";
import { ActivityPage } from "./features/activity/ActivityPage";
import { ChatPage } from "./features/chat/ChatPage";
import { MarketPage } from "./features/market/MarketPage";
import { TradeDialog } from "./features/market/TradeDialog";
import { MarketsPage } from "./features/markets/MarketsPage";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { Sidebar } from "./features/shell/Sidebar";
import { TopBar } from "./features/shell/TopBar";
import { useMedia } from "./lib/hooks";
import {
  SIDEBAR_INLINE,
  app,
  closeDrawer,
  closeSettings,
  focusComposer,
  openSettings,
  refreshAccount,
  refreshQuotes,
  start,
  stopTurn,
  toggleSidebar,
  useApp,
  useSnapshot,
} from "./state/app";
import { devParams } from "./state/dev";

const QUOTES_REFRESH_MS = 20_000;
const ACCOUNT_REFRESH_MS = 15_000;

/** The desktop app on macOS draws its window buttons over the page, so the bars leave room for them. */
function platform(): string | undefined {
  const forced = devParams().platform;
  if (forced) return forced;
  const mac = /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform ?? "");
  return isDesktop() && mac ? "macos" : undefined;
}

function Shell() {
  const snapshot = useSnapshot();
  const page = useApp((state) => state.page);
  const sidebarOpen = useApp((state) => state.sidebarOpen);
  const drawer = useApp((state) => state.drawer);
  const sidebarBeside = useMedia(SIDEBAR_INLINE);

  const sidebarShown = sidebarBeside ? sidebarOpen : drawer === "sidebar";
  const sidebarOverlaid = sidebarShown && !sidebarBeside;
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const wasSidebarDrawer = useRef(false);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = snapshot.theme;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) meta.content = snapshot.theme === "system" ? "light dark" : snapshot.theme;
  }, [snapshot.theme]);

  // A drawer belongs to the narrow layout; widening the window puts it away.
  useEffect(() => {
    if (drawer === "sidebar" && sidebarBeside) closeDrawer();
  }, [drawer, sidebarBeside]);

  // Return focus to the sidebar button when the narrow drawer closes, unless another control took focus.
  useEffect(() => {
    if (wasSidebarDrawer.current && !sidebarOverlaid && !sidebarBeside) {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest("#app-sidebar")) {
        sidebarTriggerRef.current?.focus();
      }
    }
    wasSidebarDrawer.current = sidebarOverlaid;
  }, [sidebarOverlaid, sidebarBeside]);

  // Prices and the account are re-read on a timer, but only while the window is in view.
  useEffect(() => {
    const quotes = setInterval(() => {
      if (!document.hidden) void refreshQuotes();
    }, QUOTES_REFRESH_MS);
    const account = setInterval(() => {
      if (!document.hidden) void refreshAccount();
    }, ACCOUNT_REFRESH_MS);
    return () => {
      clearInterval(quotes);
      clearInterval(account);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "k") {
          event.preventDefault();
          focusComposer();
          return;
        }
        if (key === "b" && !document.querySelector("dialog[open]")) {
          event.preventDefault();
          toggleSidebar();
          return;
        }
        if (event.key === ",") {
          event.preventDefault();
          const state = app.get();
          if (state.settings) closeSettings();
          else if (!state.trade) openSettings();
          return;
        }
      }
      // A dialog or a menu that is open handles its own Escape.
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const state = app.get();
      if (state.drawer) closeDrawer();
      else if (state.live) stopTurn();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app">
      {sidebarBeside ? (
        sidebarOpen ? <Sidebar key="inline" overlay={false} open /> : null
      ) : (
        <Sidebar key="overlay" overlay open={sidebarShown} />
      )}
      <main className="main" inert={sidebarOverlaid || undefined}>
        <TopBar
          sidebarBeside={sidebarShown && sidebarBeside}
          sidebarShown={sidebarShown}
          sidebarTriggerRef={sidebarTriggerRef}
        />
        {page === "chat" ? <ChatPage /> : null}
        {page === "markets" ? <MarketsPage /> : null}
        {page === "market" ? <MarketPage /> : null}
        {page === "account" ? <AccountPage /> : null}
        {page === "activity" ? <ActivityPage /> : null}
      </main>
      <div className="scrim" data-open={sidebarOverlaid} aria-hidden="true" onClick={closeDrawer} />
      <SettingsDialog />
      <TradeDialog />
      <Toast />
    </div>
  );
}

export function App() {
  const phase = useApp((state) => state.phase);
  const bootError = useApp((state) => state.bootError);

  useEffect(() => {
    void start();
  }, []);

  useLayoutEffect(() => {
    const name = platform();
    if (name) document.documentElement.dataset.platform = name;
  }, []);

  if (phase === "ready") return <Shell />;
  return (
    <div className="boot" data-tauri-drag-region>
      {phase === "failed" ? (
        <>
          <p className="boot-text" role="alert">
            {bootError}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void start()}>
            Try again
          </button>
        </>
      ) : (
        <span className="spinner" role="status" aria-label="Starting" />
      )}
    </div>
  );
}
