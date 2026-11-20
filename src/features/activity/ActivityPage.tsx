import { type KeyboardEvent, useId, useMemo, useState } from "react";
import type { Network } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { useFlash } from "../../lib/hooks";
import { buildActivity, filterActivity } from "../../lib/history";
import {
  type JournalDraft,
  computeJournalMetrics,
  formatJournalMarkdown,
  openJournalComposer,
  useJournal,
} from "../../lib/journal";
import { enrichPositions } from "../../lib/portfolio";
import { notify, prefillComposer, useBusy, useSnapshot } from "../../state/app";
import { ActivitySummary } from "./ActivitySummary";
import { JournalView } from "./JournalView";
import { Timeline } from "./Timeline";

type View = "timeline" | "journal";
type Scope = Network | "all";

const VIEWS: { value: View; label: string }[] = [
  { value: "timeline", label: "What the app did" },
  { value: "journal", label: "Journal" },
];

/** Brings the journal form into view, smoothly unless the trader asked for less motion. */
function revealForm(): void {
  requestAnimationFrame(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("av-journal-form")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  });
}

/**
 * Activity: what the app did on the exchange, grid bots included, and the journal of the trader's own
 * trades, with four figures from the journal above both.
 */
export function ActivityPage() {
  const snapshot = useSnapshot();
  const busy = useBusy();
  const { entries, composerOpen } = useJournal();
  const [scope, setScope] = useState<Scope>("all");
  const activity = useMemo(() => buildActivity(snapshot), [snapshot]);
  // The form opened from another page is shown at once; otherwise the timeline leads, unless only the journal has anything.
  const [view, setView] = useState<View>(() =>
    composerOpen || (activity.length === 0 && entries.length > 0) ? "journal" : "timeline",
  );
  const [copied, flash] = useFlash();
  const panelId = useId();

  const items = useMemo(() => filterActivity(activity, "all", scope), [activity, scope]);
  const scoped = useMemo(
    () => (scope === "all" ? entries : entries.filter((entry) => entry.network === scope)),
    [entries, scope],
  );
  const metrics = useMemo(() => computeJournalMetrics(entries, scope), [entries, scope]);
  const positions = useMemo(() => enrichPositions(snapshot), [snapshot]);
  const aiReady = snapshot.assistant.ready;
  const counts: Record<View, number> = { timeline: items.length, journal: scoped.length };

  function log(draft: Partial<JournalDraft>) {
    openJournalComposer(draft);
    setView("journal");
    revealForm();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatJournalMarkdown(scoped, metrics));
      flash();
    } catch {
      notify("Copying is blocked here. Try again from the desktop app.", "error");
    }
  }

  function onViewKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = VIEWS.findIndex((item) => item.value === view);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % VIEWS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + VIEWS.length) % VIEWS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = VIEWS.length - 1;
    const target = VIEWS[next];
    if (!target) return;
    event.preventDefault();
    setView(target.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div className="page">
      <div className="page-inner av-page">
        <header className="av-head">
          <Segmented
            label="Networks"
            value={scope}
            options={[
              { value: "all", label: "Both networks" },
              { value: "mainnet", label: "Mainnet" },
              { value: "testnet", label: "Testnet" },
            ]}
            onChange={setScope}
          />
          <span className="grow" />
          <div className="av-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={scoped.length === 0}
              onClick={() => void copy()}
            >
              <Icon name={copied ? "check" : "copy"} size={14} />
              <span>{copied ? "Copied" : "Copy as Markdown"}</span>
            </button>
            {aiReady && metrics.totalCount > 0 ? (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => prefillComposer("journal")}>
                <Icon name="assistant" size={14} />
                <span>Review with AI</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => log({ network: snapshot.network, symbol: snapshot.focus })}
            >
              <Icon name="plus" size={14} />
              <span>Log a trade</span>
            </button>
          </div>
        </header>

        <ActivitySummary metrics={metrics} />

        <div className="av-views" role="tablist" aria-label="Activity" onKeyDown={onViewKey}>
          {VIEWS.map((item) => {
            const selected = item.value === view;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                id={`av-tab-${item.value}`}
                className="av-view"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => setView(item.value)}
              >
                <span>{item.label}</span>
                <span className="av-count num">{counts[item.value]}</span>
              </button>
            );
          })}
        </div>

        <div id={panelId} role="tabpanel" aria-labelledby={`av-tab-${view}`} className="av-panel" key={view}>
          {view === "timeline" ? (
            <Timeline items={items} showNetwork={scope === "all"} aiReady={aiReady} onLog={log} />
          ) : (
            <JournalView
              entries={scoped}
              metrics={metrics}
              snapshot={snapshot}
              positions={positions}
              bots={snapshot.grids}
              composerOpen={composerOpen}
              busy={busy}
              showNetwork={scope === "all"}
            />
          )}
        </div>
      </div>
    </div>
  );
}
