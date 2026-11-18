import { useEffect, useLayoutEffect } from "react";
import { BrandMark } from "./components/BrandMark";
import { Rail } from "./components/Rail";
import { Toast } from "./components/Toast";
import { ActivityPage } from "./features/activity/ActivityPage";
import { AssistantPage } from "./features/assistant/AssistantPage";
import { ConnectionsPage } from "./features/connections/ConnectionsPage";
import { TradeDialog } from "./features/market/TradeDialog";
import { PortfolioPage } from "./features/portfolio/PortfolioPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { app, focusComposer, refreshQuotes, setPanelOpen, start, stopTurn, useApp, useSnapshot } from "./state/app";

const REFRESH_MS = 20_000;

function Shell() {
  const snapshot = useSnapshot();
  const page = useApp((state) => state.page);
  const working = useApp((state) => state.working);

  // A layout effect, so the theme is on the document before any child effect reads design tokens.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = snapshot.theme;
  }, [snapshot.theme]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusComposer();
        return;
      }
      // An open dialog handles Escape itself.
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      const state = app.get();
      if (state.panelOpen) setPanelOpen(false);
      else if (state.live) stopTurn();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Live prices move; the sample tape does not, and `refreshQuotes` skips it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refreshQuotes();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="app">
      <Rail />
      <main className="main">
        {working ? (
          <div className="progress" role="status">
            <span className="visually-hidden">{working}</span>
          </div>
        ) : null}
        {page === "assistant" ? <AssistantPage /> : null}
        {page === "portfolio" ? <PortfolioPage /> : null}
        {page === "connections" ? <ConnectionsPage /> : null}
        {page === "activity" ? <ActivityPage /> : null}
        {page === "settings" ? <SettingsPage /> : null}
      </main>
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

  if (phase === "ready") return <Shell />;
  return (
    <div className="boot">
      <BrandMark size={48} />
      {phase === "failed" ? (
        <>
          <p className="boot-error" role="alert">
            Octo Gens could not start. {bootError}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void start()}>
            Try again
          </button>
        </>
      ) : (
        <p role="status">Opening your desk</p>
      )}
    </div>
  );
}
