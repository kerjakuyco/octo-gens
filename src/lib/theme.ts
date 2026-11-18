import { useSyncExternalStore } from "react";
import type { Theme } from "../api/types";

const QUERY = "(prefers-color-scheme: light)";

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/** The theme actually on screen: "system" resolved against the OS preference. */
export function useResolvedTheme(theme: Theme): "light" | "dark" {
  const systemLight = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
  if (theme === "system") return systemLight ? "light" : "dark";
  return theme;
}

/** Reads a design token from the document, for canvas drawing that cannot use CSS variables. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** `#rrggbb` to `rgba(r, g, b, alpha)`. Other colour syntaxes are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1]!, 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
