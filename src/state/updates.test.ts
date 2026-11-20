import { describe, expect, it, vi } from "vitest";

async function startWith(search: string) {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  vi.stubGlobal("window", {
    location: { search },
    matchMedia: () => ({ matches: true }),
  });
  const state = await import("./app");
  await state.start();
  return { state, storage };
}

describe("desktop updates", () => {
  it("checks, skips, un-skips on manual check, downloads with progress, and installs cleanly", async () => {
    const { state, storage } = await startWith("?speed=0&history=0&update=available");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("available"));
    expect(state.app.get().update.info?.version).toBe("0.8.0");
    expect(state.app.get().update.info?.canInstall).toBe(true);
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(true);

    // Skipping hides the sidebar reminder and persists the skipped version.
    state.skipUpdate("0.8.0");
    expect(storage.get("octogens.skippedUpdate")).toBe("0.8.0");
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(false);

    // An explicit manual check un-skips the version so the trader can act on it.
    expect(await state.checkForUpdates()).toBe(true);
    expect(state.app.get().update.skippedVersion).toBe("");
    expect(state.hasVisibleUpdate(state.app.get().update)).toBe(true);

    // Downloading streams byte counts and moves cleanly to ready without restarting early.
    expect(await state.downloadUpdate()).toBe(true);
    expect(state.app.get().update.status).toBe("ready");
    expect(state.app.get().update.downloaded).toBe(18_400_000);
    expect(state.app.get().update.contentLength).toBe(18_400_000);

    // Installing is blocked while another command is running so active work is never interrupted.
    state.app.set({ working: "Sending the order" });
    expect(await state.installUpdate()).toBe(false);
    expect(state.app.get().notice?.tone).toBe("error");
    state.app.set({ working: "" });

    expect(await state.installUpdate()).toBe(true);
    expect(state.app.get().update.status).toBe("installing");
  });

  it("keeps silent startup errors quiet and surfaces manual check errors", async () => {
    const { state } = await startWith("?speed=0&history=0&update=error");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("idle"));
    expect(state.app.get().update.error).toBe("");

    expect(await state.checkForUpdates()).toBe(false);
    expect(state.app.get().update.status).toBe("error");
    expect(state.app.get().update.error).toContain("GitHub Releases");
  });

  it("supports manual GitHub fallback when native install is unavailable", async () => {
    const { state } = await startWith("?speed=0&history=0&update=manual");
    await vi.waitFor(() => expect(state.app.get().update.status).toBe("available"));
    expect(state.app.get().update.info?.canInstall).toBe(false);
    expect(await state.downloadUpdate()).toBe(false);
  });
});
