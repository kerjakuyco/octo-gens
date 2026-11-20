import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorText } from "../state/app";

/** Whether a media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

export interface Polled<T> {
  /** The latest good read, or null before the first one. */
  data: T | null;
  /** Why the latest read failed, or empty. */
  error: string;
}

interface PolledState<T> extends Polled<T> {
  key: string;
}

/**
 * Reads market data that goes stale: once when `key` changes, then every
 * `everyMs` while `active` and the window is in view. The last good value
 * stays on screen when a later read fails.
 */
export function usePolled<T>(key: string, read: () => Promise<T>, everyMs: number, active = true): Polled<T> {
  const [state, setState] = useState<PolledState<T>>({ key, data: null, error: "" });
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => {
      reader.current().then(
        (data) => {
          if (alive) setState({ key, data, error: "" });
        },
        (error: unknown) => {
          if (alive) setState((before) => ({ key, data: before.key === key ? before.data : null, error: errorText(error) }));
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, everyMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [key, everyMs, active]);

  // What was read for another market is not this market's data.
  return state.key === key ? state : { data: null, error: "" };
}

/** True for a moment after `flash()` is called: enough to show that a copy worked. */
export function useFlash(ms = 1600): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

export interface Read<T> {
  data: T | null;
  error: string;
  loading: boolean;
  /** Reads again, for a Retry button. */
  reload: () => void;
}

interface ReadState<T> {
  token: string;
  data: T | null;
  error: string;
}

/** Reads something once per `key`. A null key reads nothing, for when there is not yet enough to ask with. */
export function useRead<T>(key: string | null, read: () => Promise<T>): Read<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadState<T> | null>(null);
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });

  const token = key === null ? null : `${key}#${attempt}`;
  useEffect(() => {
    if (token === null) return;
    let alive = true;
    reader.current().then(
      (data) => {
        if (alive) setState({ token, data, error: "" });
      },
      (error: unknown) => {
        if (alive) setState({ token, data: null, error: errorText(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [token]);

  const settled = state !== null && state.token === token ? state : null;
  return {
    data: settled?.data ?? null,
    error: settled?.error ?? "",
    loading: token !== null && settled === null,
    reload: () => setAttempt((count) => count + 1),
  };
}

export interface Presence {
  /** Whether to render it at all. */
  mounted: boolean;
  /** It was closed and is on its way out: style it to leave, for example `data-state="closing"`. */
  closing: boolean;
}

/** Keeps something on screen for `ms` after it closes, so it can animate out instead of vanishing. */
export function usePresence(open: boolean, ms = 140): Presence {
  const [previous, setPrevious] = useState(open);
  const [leaving, setLeaving] = useState(false);
  // Adjusted while rendering, as React suggests for state that follows a prop, so no frame shows it gone.
  if (open !== previous) {
    setPrevious(open);
    setLeaving(!open);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), ms);
    return () => clearTimeout(timer);
  }, [leaving, ms]);
  return { mounted: open || leaving, closing: !open && leaving };
}

/** A value that follows `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
