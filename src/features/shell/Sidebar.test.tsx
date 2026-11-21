import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

async function loadShell() {
  vi.stubGlobal("window", {
    location: { search: "?speed=0" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { Sidebar } = await import("./Sidebar");
  return { state, Sidebar };
}

describe("Sidebar", () => {
  let state: Awaited<ReturnType<typeof loadShell>>["state"];
  let Sidebar: Awaited<ReturnType<typeof loadShell>>["Sidebar"];

  beforeAll(async () => {
    ({ state, Sidebar } = await loadShell());
  });

  it("renders a logo-free utility header, workspace nav, streamlined chats, and direct footer controls", () => {
    state.navigate("markets");
    const html = renderToStaticMarkup(<Sidebar overlay={false} />);

    // No brand wordmark or logo in the sidebar.
    expect(html).not.toContain("OctoNeo");
    // Compact header carries the sidebar toggle directly.
    expect(html).toContain('aria-label="Close sidebar"');
    // Distinct primary action and workspace navigation with active page state.
    expect(html).toContain('class="sidebar-cta"');
    expect(html).toContain("New chat");
    expect(html).toContain('aria-label="Workspace"');
    expect(html).toMatch(/aria-current="page"[^>]*>.*Markets/);
    // Chat list exposes filter toggle and direct delete triggers (no per-row menu popups).
    expect(html).toContain('aria-label="Filter chats"');
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).toContain("thread-delete");
    // Direct footer controls: wallet row, Settings button, and theme radiogroup.
    expect(html).toContain("foot-wallet");
    expect(html).toContain(">Settings<");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="System theme (currently dark)"');
    // Docked inline sidebar is not exposed as a modal dialog.
    expect(html).not.toContain('role="dialog"');

    // Market detail view keeps Markets highlighted in the sidebar.
    state.navigate("market");
    const marketHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(marketHtml).toMatch(/aria-current="page"[^>]*>.*Markets/);
  });

  it("lists Grid bots and News after Markets and marks the active workspace page", () => {
    state.navigate("news");
    const html = renderToStaticMarkup(<Sidebar overlay={false} />);
    const labels = [...html.matchAll(/class="nav-item"[^>]*>.*?<span class="grow truncate">([^<]+)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(["Markets", "Grid bots", "News", "Account", "Activity"]);
    expect(html).toMatch(/<button type="button" class="nav-item" aria-current="page"><svg[^>]*>.*?<\/svg><span class="grow truncate">News</);
    expect(html).not.toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*Markets/);

    state.navigate("grid");
    const gridHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(gridHtml).toMatch(/aria-current="page"[^>]*>.*Grid bots/);
    state.navigate("markets");
  });

  it("marks the overlay sidebar as a modal dialog when open and inert/hidden when closed", () => {
    const openTag = renderToStaticMarkup(<Sidebar overlay open />).split(">")[0] ?? "";
    expect(openTag).toContain('role="dialog"');
    expect(openTag).toContain('aria-modal="true"');
    expect(openTag).toContain('data-open="true"');
    expect(openTag).not.toContain('aria-hidden="true"');
    expect(openTag).not.toContain("inert");

    const closedTag = renderToStaticMarkup(<Sidebar overlay open={false} />).split(">")[0] ?? "";
    expect(closedTag).not.toContain('role="dialog"');
    expect(closedTag).not.toContain('aria-modal="true"');
    expect(closedTag).toContain('data-open="false"');
    expect(closedTag).toContain('aria-hidden="true"');
    expect(closedTag).toContain("inert");
  });

  it("shows a found update quietly, a downloaded one as one clear card, and stays quiet while it downloads by itself", () => {
    const base = state.app.get().update;
    state.app.set({
      update: {
        ...base,
        status: "available",
        info: {
          version: "0.7.0",
          currentVersion: "0.6.0",
          date: "2026-11-20T00:00:00Z",
          notes: "Improvements",
          releaseUrl: "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0",
          canInstall: true,
        },
        checkedAt: Date.now(),
        skippedVersion: "",
      },
    });
    const availableHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(availableHtml).toContain("foot-update");
    expect(availableHtml).toContain("OctoNeo 0.7.0 is out");

    state.skipUpdate("0.7.0");
    const skippedHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(skippedHtml).not.toContain("foot-update");

    // A background download says nothing; one the trader started shows its progress.
    state.app.set({
      update: { ...state.app.get().update, status: "downloading", background: true, downloaded: 9_200_000, contentLength: 18_400_000 },
    });
    expect(renderToStaticMarkup(<Sidebar overlay={false} />)).not.toContain("foot-update");
    state.app.set({ update: { ...state.app.get().update, background: false } });
    expect(renderToStaticMarkup(<Sidebar overlay={false} />)).toContain("Downloading update 50%");

    state.app.set({ update: { ...state.app.get().update, status: "ready" } });
    const readyHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(readyHtml).toContain('class="foot-ready"');
    expect(readyHtml).toContain("OctoNeo 0.7.0 is ready");
    expect(readyHtml).toContain("Restart to update");
    expect(readyHtml).toContain("Later");

    // While a task runs, the restart offers to wait for it, and says so once asked.
    state.app.set({ working: "Sending the order" });
    expect(renderToStaticMarkup(<Sidebar overlay={false} />)).toContain("Restart when done");
    state.app.set({ update: { ...state.app.get().update, restartQueued: true } });
    const queuedHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(queuedHtml).toContain("Restarts when the current task is done.");
    expect(queuedHtml).toContain("Cancel");
    state.app.set({ working: "", update: { ...state.app.get().update, restartQueued: false } });

    state.app.set({ update: { ...state.app.get().update, status: "installing" } });
    expect(renderToStaticMarkup(<Sidebar overlay={false} />)).toContain("Restarting to update…");

    // Later keeps the sidebar quiet about this version.
    state.app.set({ update: { ...state.app.get().update, status: "ready" } });
    state.deferUpdate();
    expect(renderToStaticMarkup(<Sidebar overlay={false} />)).not.toContain("foot-ready");
  });

  it("says once that OctoNeo was updated, with a link to what is new", () => {
    state.app.set({
      update: {
        ...state.app.get().update,
        status: "upToDate",
        info: null,
        updated: { version: "0.10.1", url: "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.10.1" },
      },
    });
    const html = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(html).toContain("Updated to OctoNeo 0.10.1");
    expect(html).toContain("What’s new");
    expect(html).toContain('aria-label="Dismiss"');
    state.dismissUpdated();
    expect(renderToStaticMarkup(<Sidebar overlay={false} />)).not.toContain("Updated to OctoNeo");
  });
});
