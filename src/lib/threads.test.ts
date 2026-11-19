import { describe, expect, it } from "vitest";
import type { ThreadView } from "../api/types";
import { groupThreads } from "./threads";

const NOW = new Date(2026, 10, 18, 15, 30).getTime();
const HOUR = 3_600_000;

function thread(id: string, hoursAgo: number): ThreadView {
  return { id, title: id, time: new Date(NOW - hoursAgo * HOUR).toISOString(), network: "testnet", turns: 1 };
}

describe("groupThreads", () => {
  it("buckets by local day and keeps the incoming order", () => {
    const groups = groupThreads(
      [thread("now", 0), thread("morning", 14), thread("last night", 17), thread("monday", 60), thread("old", 400)],
      NOW,
    );
    expect(groups.map((group) => [group.label, group.threads.map((item) => item.id)])).toEqual([
      ["Today", ["now", "morning"]],
      ["Yesterday", ["last night"]],
      ["Previous 7 days", ["monday"]],
      ["Older", ["old"]],
    ]);
  });

  it("leaves out empty groups and files unreadable dates under Older", () => {
    expect(groupThreads([], NOW)).toEqual([]);
    const broken = { ...thread("x", 0), time: "not a date" };
    expect(groupThreads([broken], NOW).map((group) => group.label)).toEqual(["Older"]);
  });
});
