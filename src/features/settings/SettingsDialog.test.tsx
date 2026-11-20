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

  it("renders signed update details, expandable release notes, and the About dot", () => {
    state.app.set({
      update: {
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
        checkedAt: Date.now(),
        skippedVersion: "",
      },
    });
    const html = renderToStaticMarkup(<SettingsDialog />);
    expect(html).toContain("tab-dot");
    expect(html).toContain("Version 0.7.0 available");
    expect(html).toContain("Download update");
    expect(html).toContain("Skip version");
    expect(html).toContain('<details class="update-notes">');
    expect(html).toContain("<summary>Release notes</summary>");
    expect(html).toContain("Signed cross-platform updates");
  });

  it("renders a GitHub download fallback when native install is unavailable", () => {
    state.app.set({
      update: {
        ...state.app.get().update,
        status: "available",
        info: {
          ...state.app.get().update.info!,
          canInstall: false,
        },
      },
    });
    const html = renderToStaticMarkup(<SettingsDialog />);
    expect(html).toContain("Download on GitHub");
    expect(html).not.toContain("Download update");
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

  it("renders ready-to-restart and error recovery states", () => {
    state.app.set({
      update: {
        ...state.app.get().update,
        status: "ready",
      },
    });
    const readyHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(readyHtml).toContain("Version 0.7.0 ready to install");
    expect(readyHtml).toContain("Restart to update");

    state.app.set({
      update: {
        ...state.app.get().update,
        status: "error",
        error: "Could not reach GitHub Releases.",
      },
    });
    const errorHtml = renderToStaticMarkup(<SettingsDialog />);
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Could not reach GitHub Releases.");
    expect(errorHtml).toContain("Open GitHub Releases");
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
