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

  it("shows a compact update pill in the footer until the version is skipped", () => {
    state.app.set({
      update: {
        status: "available",
        info: {
          version: "0.7.0",
          currentVersion: "0.6.0",
          date: "2026-11-20T00:00:00Z",
          notes: "Improvements",
          releaseUrl: "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0",
          canInstall: true,
        },
        downloaded: 0,
        contentLength: null,
        error: "",
        checkedAt: Date.now(),
        skippedVersion: "",
      },
    });
    const availableHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(availableHtml).toContain("foot-update");
    expect(availableHtml).toContain("Update v0.7.0");

    state.skipUpdate("0.7.0");
    const skippedHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(skippedHtml).not.toContain("foot-update");

    state.app.set({
      update: {
        ...state.app.get().update,
        status: "ready",
      },
    });
    const readyHtml = renderToStaticMarkup(<Sidebar overlay={false} />);
    expect(readyHtml).toContain("foot-update");
    expect(readyHtml).toContain("Restart for v0.7.0");
  });
});
