import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

async function loadSettings() {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { search: "?speed=0&history=0" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const state = await import("../../state/app");
  await state.start();
  const { SettingsDialog } = await import("./SettingsDialog");
  return { state, SettingsDialog };
}

describe("SettingsDialog About updates", () => {
  let state: Awaited<ReturnType<typeof loadSettings>>["state"];
  let SettingsDialog: Awaited<ReturnType<typeof loadSettings>>["SettingsDialog"];

  beforeAll(async () => {
    ({ state, SettingsDialog } = await loadSettings());
    state.openSettings("about");
  });

  it("renders signed update details, expandable release notes, the About dot, and when it last looked", () => {
    state.app.set({
      update: {
        ...state.app.get().update,
        status: "available",
        info: {
          version: "0.7.0",
          currentVersion: "0.6.0",
          date: "2026-11-20T00:00:00Z",
          notes: "- Signed cross-platform updates",
          releaseUrl: "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.7.0",
          canInstall: true,
        },
        downloaded: 0,
        contentLength: null,
        error: "",
        failure: "",
        checkedAt: Date.now() - 5 * 60_000,
        skippedVersion: "",
      },
    });
    const html = renderToStaticMarkup(<SettingsDialog />);
    expect(html).toContain("tab-dot");
    expect(html).toContain("OctoNeo 0.7.0 is available");
    expect(html).toContain("Download update</button>");
    expect(html).toContain("Skip version");
    expect(html).toContain("Check now");
    expect(html).toContain("Last checked 5 minutes ago");
    expect(html).toContain('<details class="update-notes">');
    expect(html).toContain("<summary>Release notes</summary>");
    expect(html).toContain("Signed cross-platform updates");
    // The switch for background downloads, on by default.
    expect(html).toContain("Download updates automatically");
    expect(html).toMatch(/role="switch"[^>]*checked=""/);
  });

  it("renders a GitHub download fallback when native install is unavailable", () => {
    const update = state.app.get().update;
    state.app.set({
      update: { ...update, status: "available", info: update.info && { ...update.info, canInstall: false } },
    });
    const html = renderToStaticMarkup(<SettingsDialog />);
    expect(html).toContain("Download from GitHub");
    expect(html).toContain("can’t update itself");
    expect(html).toContain("your wallet, settings and conversations stay");
    expect(html).not.toContain("Download update</button>");
  });

  it("offers to try again after a failed download, and the release page after a failed install", () => {
    const update = state.app.get().update;
    const info = update.info && { ...update.info, canInstall: true };
    state.app.set({
      update: { ...update, status: "available", info, failure: "download", error: "Could not download or verify the update." },
    });
    const downloadHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(downloadHtml).toContain('role="alert"');
    expect(downloadHtml).toContain("Could not download or verify the update.");
    expect(downloadHtml).toContain("Try again");

    state.app.set({
      update: { ...state.app.get().update, failure: "install", error: "Could not install the update automatically." },
    });
    const installHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(installHtml).toContain("Could not install the update automatically.");
    expect(installHtml).toContain("Download from GitHub");
    expect(installHtml).toContain("Try again");
    state.app.set({ update: { ...state.app.get().update, failure: "", error: "" } });
  });

  it("renders native determinate and indeterminate progress bars while downloading", () => {
    state.app.set({
      update: {
        ...state.app.get().update,
        status: "downloading",
        downloaded: 9_200_000,
        contentLength: 18_400_000,
      },
    });
    const detHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(detHtml).toContain("Downloading OctoNeo 0.7.0");
    expect(detHtml).toContain('<progress id=');
    expect(detHtml).toContain('max="18400000"');
    expect(detHtml).toContain('value="9200000"');
    expect(detHtml).toContain("50%");

    state.app.set({
      update: {
        ...state.app.get().update,
        status: "downloading",
        downloaded: 1_048_576,
        contentLength: null,
      },
    });
    const indetHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(indetHtml).toContain('<progress id=');
    expect(indetHtml).not.toContain('value="');
    expect(indetHtml).toContain("Downloading…");
  });

  it("renders ready, restart-when-done, restarting and error recovery states", () => {
    state.app.set({
      update: {
        ...state.app.get().update,
        status: "ready",
      },
    });
    const readyHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(readyHtml).toContain("OctoNeo 0.7.0 is ready");
    expect(readyHtml).toContain("Restart to update");
    expect(readyHtml).toContain("Later");

    state.app.set({ working: "Sending the order" });
    expect(renderToStaticMarkup(<SettingsDialog />)).toContain("Restart when done");
    state.app.set({ update: { ...state.app.get().update, restartQueued: true } });
    const queuedHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(queuedHtml).toContain("Restarts when the current task is done.");
    expect(queuedHtml).toContain("Cancel");
    state.app.set({ working: "", update: { ...state.app.get().update, restartQueued: false } });

    state.app.set({ update: { ...state.app.get().update, status: "installing" } });
    expect(renderToStaticMarkup(<SettingsDialog />)).toContain("Restarting to update…");

    state.app.set({
      update: {
        ...state.app.get().update,
        status: "error",
        failure: "check",
        error: "Could not reach GitHub Releases.",
      },
    });
    const errorHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(errorHtml).toContain("Couldn’t check for updates");
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Could not reach GitHub Releases.");
    expect(errorHtml).toContain("Open the release page");

    state.app.set({ update: { ...state.app.get().update, status: "upToDate", info: null, error: "", failure: "" } });
    const upToDateHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(upToDateHtml).toContain("OctoNeo is up to date");
    expect(upToDateHtml).toContain("Last checked");
  });

  it("says how long ago it last looked", async () => {
    const { formatCheckedAgo } = await import("./SettingsDialog");
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(formatCheckedAgo(null, now)).toBe("");
    expect(formatCheckedAgo(now - 20_000, now)).toBe("just now");
    expect(formatCheckedAgo(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatCheckedAgo(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(formatCheckedAgo(now - 26 * 3_600_000, now)).toBe("yesterday");
  });

  it("organizes settings into Assistant, Exchange, and App groups with rich section views", () => {
    state.openSettings("models");
    const modelsHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(modelsHtml).toContain('focusgroup="tablist nomemory"');
    expect(modelsHtml).toContain("Assistant");
    expect(modelsHtml).toContain("Exchange");
    expect(modelsHtml).toContain("App");
    expect(modelsHtml).toContain("Active model");
    expect(modelsHtml).toContain("Cloud providers");
    expect(modelsHtml).toContain("Local servers");
    expect(modelsHtml).toContain("Reasoning effort");

    state.openSettings("trading");
    const tradingHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(tradingHtml).toContain("Order guardrails");
    expect(tradingHtml).toContain("Quick leverage caps");
    expect(tradingHtml).toContain("Assistant permissions");

    state.openSettings("appearance");
    const generalHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(generalHtml).toContain("General");
    expect(generalHtml).toContain("theme-grid");
    expect(generalHtml).toContain("Market chart defaults");
    expect(generalHtml).toContain("Default timeframe");
    expect(generalHtml).toContain("Bollinger Bands");

    state.openSettings("tools");
    const toolsHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(toolsHtml).toContain("Built-in research");
    expect(toolsHtml).toContain("MCP tool servers");

    state.openSettings("wallet");
    const walletHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(walletHtml).toContain("Copy wallet address");
  });
});
