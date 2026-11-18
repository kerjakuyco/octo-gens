import { useSyncExternalStore } from "react";

type Listener = () => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(listener: Listener): () => void;
}

/** A minimal observable store. State objects are replaced, never mutated. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Subscribes a component to one slice of the store. The selector must return
 * a primitive or an existing reference (not a freshly built object), so that
 * unchanged state compares equal between renders.
 */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
