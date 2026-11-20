import { useSyncExternalStore } from "react";

/**
 * One shared one-second tick for countdowns. It runs only while something on
 * screen is counting, and every counter moves on the same beat.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time in milliseconds, refreshed once a second. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

function minute(): number {
  // While nothing is counting, the last tick may be long gone: read the clock instead.
  if (timer === undefined) now = Date.now();
  return now - (now % 60_000);
}

/**
 * The current time to the minute, for "12 minutes ago". It follows the same tick, but a
 * component only draws again when the minute changes.
 */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, minute, minute);
}
