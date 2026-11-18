/**
 * Chooses the backend at startup: the Rust core inside the desktop app, or the
 * in-browser mock everywhere else. Each one is loaded on demand, so the mock
 * never ships inside the desktop bundle's startup path.
 */

import { isTauri } from "@tauri-apps/api/core";
import type { Backend } from "./types";

export function isDesktop(): boolean {
  return isTauri();
}

export async function loadBackend(): Promise<Backend> {
  if (isDesktop()) {
    const { createTauriBackend } = await import("./tauri");
    return createTauriBackend();
  }
  const { createMockBackend, mockOptionsFromUrl } = await import("./mock");
  return createMockBackend(mockOptionsFromUrl(window.location.search));
}
