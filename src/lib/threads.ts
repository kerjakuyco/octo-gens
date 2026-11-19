import type { ThreadView } from "../api/types";

export type ThreadGroupLabel = "Today" | "Yesterday" | "Previous 7 days" | "Older";

export interface ThreadGroup {
  label: ThreadGroupLabel;
  threads: ThreadView[];
}

const DAY_MS = 86_400_000;
const LABELS: ThreadGroupLabel[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

/** Conversations bucketed by the local day of their latest turn, keeping the order they came in. */
export function groupThreads(threads: ThreadView[], now: number = Date.now()): ThreadGroup[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const buckets: ThreadView[][] = [[], [], [], []];
  for (const thread of threads) {
    const at = Date.parse(thread.time);
    let slot = 3;
    if (Number.isFinite(at)) {
      if (at >= today) slot = 0;
      else if (at >= today - DAY_MS) slot = 1;
      else if (at >= today - 7 * DAY_MS) slot = 2;
    }
    buckets[slot]!.push(thread);
  }
  return LABELS.map((label, index) => ({ label, threads: buckets[index]! })).filter((group) => group.threads.length > 0);
}
