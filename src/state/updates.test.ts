import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = () => void;

async function startWith(search: string, stored: Record<string, string> = {}) {
  vi.resetModules();
  const storage = new Map<string, string>(Object.entries(stored));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  const listeners = new Map<string, Listener[]>();
  vi.stubGlobal("window", {
    location: { search },
    matchMedia: () => ({ matches: true }),
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  });
  const state = await import("./app");
  await state.start();
  const fire = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return { state, storage, fire };
}

const RELEASE = "https://github.com/kerjakuyco/octo-neo/releases/tag/v0.10.2";
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop updates", () => {
  it("checks, skips, un-skips on manual check, downloads with progress, and restarts once idle", async () => {
    const { state, storage } = await startWith("?speed=0&history=0&update=available");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("available"));
    // The browser mock shows a found update as it is, as when automatic downloads are off.
    expect(state.app.get().update.auto).toBe(false);
    expect(state.app.get().update.info?.version).toBe("0.11.0");
    expect(state.app.get().update.info?.canInstall).toBe(true);
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(true);

    // Skipping hides the sidebar reminder and persists the skipped version.
    state.skipUpdate("0.11.0");
    expect(storage.get("octogens.skippedUpdate")).toBe("0.11.0");
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(false);

    // An explicit manual check un-skips the version so the trader can act on it.
    expect(await state.checkForUpdates()).toBe(true);
    expect(state.app.get().update.skippedVersion).toBe("");
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(true);

    // Downloading streams byte counts and moves cleanly to ready without restarting early.
    expect(await state.downloadUpdate()).toBe(true);
    expect(state.app.get().update.status).toBe("ready");
    expect(state.app.get().update.background).toBe(false);
    expect(state.app.get().update.downloaded).toBe(18_400_000);
    expect(state.app.get().update.contentLength).toBe(18_400_000);

    // While a command runs, the restart waits for it instead of being refused.
    state.app.set({ working: "Sending the order" });
    expect(await state.installUpdate()).toBe(true);
    expect(state.app.get().update.restartQueued).toBe(true);
    expect(state.app.get().update.status).toBe("ready");
    expect(state.app.get().notice).toBeNull();

    state.app.set({ working: "" });
    expect(state.app.get().update.status).toBe("installing");
    await vi.waitFor(() => expect(storage.get("octogens.installingUpdate")).toContain('"version":"0.11.0"'), {
      timeout: 4000,
    });
  });

  it("keeps silent startup errors quiet and surfaces manual check errors", async () => {
    const { state } = await startWith("?speed=0&history=0&update=error");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("idle"));
    expect(state.app.get().update.error).toBe("");

    expect(await state.checkForUpdates()).toBe(false);
    expect(state.app.get().update.status).toBe("error");
    expect(state.app.get().update.failure).toBe("check");
    expect(state.app.get().update.error).toContain("GitHub Releases");
  });

  it("supports manual GitHub fallback when native install is unavailable", async () => {
    const { state } = await startWith("?speed=0&history=0&update=manual");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("available"));
    expect(state.app.get().update.info?.canInstall).toBe(false);
    // Nothing to download in the background: the release page is the way.
    expect(state.app.get().update.auto).toBe(true);
    expect(await state.downloadUpdate()).toBe(false);
    expect(state.app.get().update.status).toBe("available");
  });

  it("looks again every six hours and when the window comes back after a long gap, never twice at once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T08:00:00Z"));
    const { state, fire } = await startWith("?speed=0&history=0&update=upToDate");
    await vi.advanceTimersByTimeAsync(10);
    const first = state.app.get().update.checkedAt;
    expect(state.app.get().update.status).toBe("upToDate");
    expect(first).not.toBeNull();

    // Coming back to the window soon after does not look again.
    await vi.advanceTimersByTimeAsync(HOUR);
    fire("focus");
    await vi.advanceTimersByTimeAsync(10);
    expect(state.app.get().update.checkedAt).toBe(first);

    // Six hours after the last look, it looks again by itself.
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    const second = state.app.get().update.checkedAt ?? 0;
    expect(second).toBeGreaterThan(first ?? 0);

    // After the computer slept, the clock moved but the timer did not: coming back online looks again.
    vi.setSystemTime(second + 7 * HOUR);
    fire("online");
    await vi.advanceTimersByTimeAsync(10);
    expect(state.app.get().update.checkedAt ?? 0).toBeGreaterThan(second);

    // A check already under way is never started twice.
    const running = state.checkForUpdates();
    expect(await state.checkForUpdates()).toBe(false);
    await running;
  });

  it("downloads in the background as soon as it finds an update, unless turned off", async () => {
    const ready = await startWith("?speed=0&history=0&update=ready");
    await vi.waitFor(() => expect(ready.state.app.get().update.status).toBe("ready"));
    expect(ready.state.app.get().update.background).toBe(true);
    expect(ready.state.hasVisibleUpdate(ready.state.app.get().update)).toBe(true);

    // The sidebar stays quiet while a background download runs.
    const running = await startWith("?speed=0&history=0&update=downloading");
    await vi.waitFor(() => expect(running.state.app.get().update.downloaded).toBe(9_200_000));
    expect(running.state.app.get().update.status).toBe("downloading");
    expect(running.state.app.get().update.background).toBe(true);
    expect(running.state.hasVisibleUpdate(running.state.app.get().update)).toBe(false);

    // Turned off: the update is found and waits for the trader.
    const off = await startWith("?speed=0&history=0&update=ready", { "octogens.autoUpdate": "0" });
    await vi.waitFor(() => expect(off.state.app.get().update.status).toBe("available"));
    expect(off.state.app.get().update.auto).toBe(false);

    // Turning it on starts the download, and is remembered.
    off.state.setAutoDownload(true);
    expect(off.storage.get("octogens.autoUpdate")).toBe("1");
    await vi.waitFor(() => expect(off.state.app.get().update.status).toBe("ready"));
  });

  it("leaves a skipped version alone in the background", async () => {
    const { state } = await startWith("?speed=0&history=0&update=ready", { "octogens.skippedUpdate": "0.11.0" });
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("available"));
    expect(state.app.get().update.info?.version).toBe("0.11.0");
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(false);
  });

  it("puts a ready update off with Later until a newer version arrives", async () => {
    const { state } = await startWith("?speed=0&history=0&update=ready");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("ready"));
    state.deferUpdate();
    expect(state.app.get().update.deferredVersion).toBe("0.11.0");
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(false);
    // Settings, About still has it, ready to restart.
    expect(state.app.get().update.status).toBe("ready");

    const update = state.app.get().update;
    if (!update.info) throw new Error("The ready update has no details.");
    state.app.set({ update: { ...update, info: { ...update.info, version: "0.12.0" } } });
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(true);
  });

  it("restarts by itself once the running task is done, waits again if one starts meanwhile, and can be called off", async () => {
    vi.useFakeTimers();
    const { state, storage } = await startWith("?speed=0&history=0&update=ready");
    await vi.advanceTimersByTimeAsync(10);
    expect(state.app.get().update.status).toBe("ready");

    // Called off: nothing happens when the task ends.
    state.app.set({ working: "Asking the assistant" });
    expect(await state.installUpdate()).toBe(true);
    expect(state.app.get().update.restartQueued).toBe(true);
    state.cancelQueuedRestart();
    state.app.set({ working: "" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.app.get().update.status).toBe("ready");
    expect(state.app.get().update.restartQueued).toBe(false);

    // A task starts while "Restarting to update…" shows: the restart waits for it again.
    state.app.set({ working: "Asking the assistant" });
    await state.installUpdate();
    state.app.set({ working: "" });
    expect(state.app.get().update.status).toBe("installing");
    state.app.set({ working: "Sending the order" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(state.app.get().update.status).toBe("ready");
    expect(state.app.get().update.restartQueued).toBe(true);
    expect(storage.has("octogens.installingUpdate")).toBe(false);

    // Idle again: "Restarting to update…" shows briefly, then the install goes ahead.
    state.app.set({ working: "" });
    expect(state.app.get().update.status).toBe("installing");
    await vi.advanceTimersByTimeAsync(1500);
    expect(storage.get("octogens.installingUpdate")).toContain('"version":"0.11.0"');

    // The mock never restarts: the app stops waiting and points to the release page.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.app.get().update.status).toBe("available");
    expect(state.app.get().update.failure).toBe("install");
    expect(state.app.get().update.error).toContain("did not restart");
  });

  it("says once, after the restart, that OctoNeo was updated", async () => {
    const note = JSON.stringify({ version: "0.10.2", url: RELEASE });
    const { state, storage } = await startWith("?speed=0&history=0&update=upToDate", { "octogens.installingUpdate": note });
    expect(state.app.get().update.updated).toEqual({ version: "0.10.2", url: RELEASE });
    expect(storage.has("octogens.installingUpdate")).toBe(false);
    state.dismissUpdated();
    expect(state.app.get().update.updated).toBeNull();

    // An install that never went through says nothing, and is forgotten.
    const stale = await startWith("?speed=0&history=0&update=upToDate", {
      "octogens.installingUpdate": JSON.stringify({ version: "0.9.0", url: RELEASE }),
    });
    expect(stale.state.app.get().update.updated).toBeNull();
    expect(stale.storage.has("octogens.installingUpdate")).toBe(false);

    // A link that is not this project's release page falls back to the version's own page.
    const odd = await startWith("?speed=0&history=0&update=upToDate", {
      "octogens.installingUpdate": JSON.stringify({ version: "v0.10.2", url: "https://example.com/" }),
    });
    expect(odd.state.app.get().update.updated).toEqual({ version: "0.10.2", url: RELEASE });

    // The browser mock can show the same line.
    const shown = await startWith("?speed=0&history=0&update=installed");
    expect(shown.state.app.get().update.updated?.version).toBe("0.10.2");
  });

  it("keeps a failed background download quiet and offers to try again", async () => {
    const { state } = await startWith("?speed=0&history=0&update=downloadError");
    await vi.waitFor(() => expect(state.app.get().update.failure).toBe("download"));
    expect(state.app.get().update.status).toBe("available");
    expect(state.app.get().update.error).toContain("connection was reset");
    expect(state.app.get().notice).toBeNull();

    expect(await state.downloadUpdate()).toBe(false);
    expect(state.app.get().update.failure).toBe("download");
    expect(state.app.get().update.status).toBe("available");
  });

  it("points to the release page when an install fails", async () => {
    const { state, storage } = await startWith("?speed=0&history=0&update=installError");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("ready"));
    expect(await state.installUpdate()).toBe(false);
    expect(state.app.get().update.status).toBe("available");
    expect(state.app.get().update.failure).toBe("install");
    expect(state.app.get().update.error).toContain("permission denied");
    expect(state.app.get().notice?.tone).toBe("error");
    expect(storage.has("octogens.installingUpdate")).toBe(false);
  });
});
