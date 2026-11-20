import { useDeferredValue, useMemo, useState } from "react";
import type { GridBotView, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Pagination } from "../../components/Pagination";
import { Segmented } from "../../components/Segmented";
import {
  JOURNAL_SETUPS,
  type JournalEntry,
  type JournalMetrics,
  type JournalOutcome,
  openJournalComposer,
  setupLabel,
} from "../../lib/journal";
import { paginateList } from "../../lib/pagination";
import type { EnrichedPosition } from "../../lib/portfolio";
import { JournalComposer } from "./JournalComposer";
import { JournalEntryCard } from "./JournalEntryCard";
import { SetupTable } from "./SetupTable";

type OutcomeFilter = "all" | Extract<JournalOutcome, "open" | "win" | "loss">;

interface JournalViewProps {
  /** The entries on the networks in view, newest first. */
  entries: JournalEntry[];
  metrics: JournalMetrics;
  snapshot: Snapshot;
  positions: EnrichedPosition[];
  bots: GridBotView[];
  composerOpen: boolean;
  busy: boolean;
  showNetwork: boolean;
}

/** The trades the trader logged: filtered, searched and paged, with how each setup did beneath. */
export function JournalView({
  entries,
  metrics,
  snapshot,
  positions,
  bots,
  composerOpen,
  busy,
  showNetwork,
}: JournalViewProps) {
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [setup, setSetup] = useState("all");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const counts = useMemo(() => {
    const tally = { all: entries.length, open: 0, win: 0, loss: 0 };
    for (const entry of entries) {
      if (entry.outcome === "open" || entry.outcome === "win" || entry.outcome === "loss") tally[entry.outcome] += 1;
    }
    return tally;
  }, [entries]);

  const filtered = useMemo(() => {
    const text = deferred.trim().toLowerCase();
    return entries.filter((entry) => {
      if (outcome !== "all" && entry.outcome !== outcome) return false;
      if (setup !== "all" && entry.setup !== setup) return false;
      if (!text) return true;
      return [entry.symbol, setupLabel(entry.setup), entry.thesis, entry.lesson].some((field) =>
        field.toLowerCase().includes(text),
      );
    });
  }, [entries, outcome, setup, deferred]);

  const slice = useMemo(() => paginateList(filtered, page, pageSize), [filtered, page, pageSize]);

  function reset() {
    setOutcome("all");
    setSetup("all");
    setQuery("");
    setPage(1);
  }

  return (
    <div className="av-journal">
      {composerOpen ? <JournalComposer snapshot={snapshot} positions={positions} bots={bots} /> : null}

      <div className="av-toolbar">
        <Segmented
          label="Show"
          value={outcome}
          options={[
            { value: "all", label: `All ${counts.all}` },
            { value: "open", label: `Still open ${counts.open}` },
            { value: "win", label: `Won ${counts.win}` },
            { value: "loss", label: `Lost ${counts.loss}` },
          ]}
          onChange={(next) => {
            setOutcome(next);
            setPage(1);
          }}
        />
        <span className="grow" />
        <select
          aria-label="Setup"
          className="input av-select"
          value={setup}
          onChange={(event) => {
            setSetup(event.target.value);
            setPage(1);
          }}
        >
          <option value="all">Every setup</option>
          {JOURNAL_SETUPS.map((item) => (
            <option key={item} value={item}>
              {setupLabel(item)}
            </option>
          ))}
        </select>
        <label className="search av-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            className="input"
            placeholder="Search the journal"
            aria-label="Search the journal"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>

      {entries.length === 0 ? (
        <div className="av-empty">
          <p>
            Nothing logged yet. Log a trade from an open position, a fill under “What the app did”, a grid bot, or from
            scratch.
          </p>
          {composerOpen ? null : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => openJournalComposer({ network: snapshot.network, symbol: snapshot.focus })}
            >
              <Icon name="plus" size={14} />
              <span>Log a trade</span>
            </button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="av-empty">
          <p>No entry matches.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
            Show every entry
          </button>
        </div>
      ) : (
        <>
          <ul className="av-entries">
            {slice.items.map((entry, index) => (
              <JournalEntryCard
                key={entry.id}
                entry={entry}
                snapshot={snapshot}
                index={index}
                busy={busy}
                showNetwork={showNetwork}
              />
            ))}
          </ul>
          <Pagination
            label="Journal pages"
            itemLabel="entries"
            slice={slice}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}

      <SetupTable metrics={metrics} />
    </div>
  );
}
