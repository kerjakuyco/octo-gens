import { type FormEvent, useDeferredValue, useId, useMemo, useRef, useState } from "react";
import type { Network, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Pagination } from "../../components/Pagination";
import { StepList } from "../../components/StepList";
import { dayTime, direction, leverage, money, orderType, percent, price, signedMoney, units } from "../../lib/format";
import {
  JOURNAL_SETUPS,
  type JournalEntry,
  type JournalMetrics,
  type JournalOutcome,
  type JournalSetup,
  closeJournalComposer,
  computeJournalMetrics,
  deleteJournalEntry,
  draftFromExecution,
  draftFromPosition,
  formatJournalMarkdown,
  journalReviewPrompt,
  openJournalComposer,
  saveJournalEntry,
  updateJournalDraft,
  useJournal,
} from "../../lib/journal";
import { instrumentFor } from "../../lib/market";
import { networkName } from "../../lib/network";
import { paginateList } from "../../lib/pagination";
import {
  type EnrichedOrder,
  type EnrichedPosition,
  type ExecutionCategory,
  type ExecutionRecord,
  buildExecutionHistory,
  enrichOrders,
  enrichPositions,
} from "../../lib/portfolio";
import { ask, focusMarket, navigate, openTrade, useBusy, useSnapshot } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";

type ActivityTab = "journal" | "history" | "edge";
type OutcomeFilter = "all" | JournalOutcome;
type HistoryFilter = "all" | ExecutionCategory | "onbook";
type SetupSortKey = "setup" | "total" | "winRate" | "netPnl" | "avgPnl" | "discipline";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const OUTCOME_META: Record<JournalOutcome, { label: string; tone?: "up" | "down" | "warn" }> = {
  open: { label: "Open thesis", tone: "warn" },
  win: { label: "Win", tone: "up" },
  loss: { label: "Loss", tone: "down" },
  breakeven: { label: "Breakeven" },
  note: { label: "Market note" },
};

const CATEGORY_LABEL: Record<ExecutionCategory, string> = {
  order: "Exchange Fill",
  ticket: "Order Ticket",
  cancel: "Cancellation",
  wallet: "Vault Funding",
  tool: "Tool Run",
};

function JournalKpiStrip({
  metrics,
  executionCount,
  openPositionsCount,
}: {
  metrics: JournalMetrics;
  executionCount: number;
  openPositionsCount: number;
}) {
  const pfText =
    metrics.profitFactor === null
      ? "—"
      : Number.isFinite(metrics.profitFactor)
        ? metrics.profitFactor.toFixed(2)
        : "∞";

  const winShare =
    metrics.winCount + metrics.lossCount > 0
      ? (metrics.winCount / (metrics.winCount + metrics.lossCount)) * 100
      : 50;

  return (
    <section className="portfolio-kpis" aria-label="Trading journal performance summary">
      {/* Card 1: Net Realized P&L & Profit Factor */}
      <div className="kpi-card kpi-card-lead">
        <div className="kpi-top">
          <span className="kpi-label">Logged Realized P&amp;L</span>
          <span className="chip num" data-tone={metrics.netPnlUsd > 0 ? "up" : metrics.netPnlUsd < 0 ? "down" : undefined}>
            PF {pfText}
          </span>
        </div>
        <div className={`kpi-value num ${direction(metrics.netPnlUsd)}`}>
          {signedMoney(metrics.netPnlUsd.toFixed(2))} <small>USDT</small>
        </div>
        <dl className="kpi-subgrid num">
          <div>
            <dt>Expectancy</dt>
            <dd className={direction(metrics.expectancyUsd ?? 0)}>
              {metrics.expectancyUsd !== null ? `${signedMoney(metrics.expectancyUsd.toFixed(2))} USDT` : "—"}
            </dd>
          </div>
          <div>
            <dt>Gross win / loss</dt>
            <dd>
              <span className="up">+{money(metrics.grossProfitUsd.toFixed(0))}</span>
              {" / "}
              <span className="down">−{money(metrics.grossLossUsd.toFixed(0))}</span>
            </dd>
          </div>
        </dl>
      </div>

      {/* Card 2: Win Rate & Win/Loss Distribution */}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">Win Rate &amp; Sample</span>
          <span className="chip num">
            {metrics.winCount}W · {metrics.lossCount}L · {metrics.breakevenCount}BE
          </span>
        </div>
        <div className="kpi-value num">
          {metrics.winRatePct !== null ? `${metrics.winRatePct.toFixed(1)}%` : "—"}{" "}
          <small>{metrics.closedCount} closed</small>
        </div>
        <div className="kpi-meter-wrap">
          <div className="exposure-bar" aria-hidden="true">
            <span className="exposure-long" style={{ width: `${winShare.toFixed(1)}%` }} />
            <span className="exposure-short" style={{ width: `${(100 - winShare).toFixed(1)}%` }} />
          </div>
          <div className="kpi-meter-labels num">
            <span className="up">
              Avg W {metrics.avgWinUsd !== null ? `+${money(metrics.avgWinUsd.toFixed(0))}` : "—"}
            </span>
            <span className="down">
              Avg L {metrics.avgLossUsd !== null ? `−${money(metrics.avgLossUsd.toFixed(0))}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Card 3: Execution Discipline & Planned R:R */}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">Risk Discipline</span>
          <span
            className="chip num"
            data-tone={metrics.disciplinePct >= 85 ? "up" : metrics.disciplinePct >= 65 ? "warn" : "down"}
          >
            {metrics.avgRr !== null ? `Avg 1 : ${metrics.avgRr.toFixed(1)} R` : "Rule audit"}
          </span>
        </div>
        <div className="kpi-value num">
          {metrics.disciplinePct.toFixed(0)}% <small>plan adherence</small>
        </div>
        <div className="kpi-meter-wrap">
          <div
            className="kpi-meter"
            role="progressbar"
            aria-label="Execution discipline score"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(metrics.disciplinePct)}
          >
            <span
              className="kpi-meter-fill"
              data-tone={metrics.disciplinePct >= 85 ? "up" : metrics.disciplinePct >= 65 ? "warn" : "down"}
              style={{ width: `${Math.min(100, Math.max(0, metrics.disciplinePct)).toFixed(1)}%` }}
            />
          </div>
          <div className="kpi-meter-labels num">
            <span>{metrics.openCount} active theses</span>
            <span>{openPositionsCount} live positions</span>
          </div>
        </div>
      </div>

      {/* Card 4: Top Setup Edge & Session Ledger */}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">Top Setup Edge</span>
          <span className="chip num">{executionCount} events</span>
        </div>
        <div className="kpi-value">
          {metrics.bestSetup ? metrics.bestSetup.setup : "No closed setup"}
        </div>
        <dl className="kpi-subgrid num">
          <div>
            <dt>Setup net P&amp;L</dt>
            <dd className={direction(metrics.bestSetup?.netPnlUsd ?? 0)}>
              {metrics.bestSetup ? `${signedMoney(metrics.bestSetup.netPnlUsd.toFixed(2))} USDT` : "—"}
            </dd>
          </div>
          <div>
            <dt>Setup win rate</dt>
            <dd>
              {metrics.bestSetup?.winRatePct !== null && metrics.bestSetup?.winRatePct !== undefined
                ? `${metrics.bestSetup.winRatePct.toFixed(0)}% (${metrics.bestSetup.total})`
                : "—"}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function JournalComposer({
  snapshot,
  openPositions,
}: {
  snapshot: Snapshot;
  openPositions: EnrichedPosition[];
}) {
  const { draft, editingId } = useJournal();
  const [thesisError, setThesisError] = useState("");
  const thesisRef = useRef<HTMLTextAreaElement>(null);

  const symbolId = useId();
  const outcomeId = useId();
  const setupId = useId();
  const levId = useId();
  const entryId = useId();
  const exitId = useId();
  const qtyId = useId();
  const pnlId = useId();
  const rrId = useId();
  const thesisId = useId();
  const lessonId = useId();

  const knownSymbols = useMemo(() => {
    const list = snapshot.instruments.map((inst) => ({
      symbol: inst.symbol,
      label: `${inst.base}-${inst.quote || "USDT"} Perp`,
    }));
    if (draft.symbol && !list.some((item) => item.symbol === draft.symbol)) {
      const custom = instrumentFor(snapshot, draft.symbol);
      list.unshift({
        symbol: draft.symbol,
        label: `${custom.base}-${custom.quote || "USDT"} Perp`,
      });
    }
    return list;
  }, [snapshot, draft.symbol]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.thesis.trim() && !draft.lesson.trim()) {
      setThesisError("Enter a trade thesis or post-trade review note before saving.");
      thesisRef.current?.focus();
      return;
    }
    saveJournalEntry(draft, editingId);
  }

  return (
    <section className="journal-composer" aria-label={editingId ? "Edit journal entry" : "New trading journal entry"}>
      <header className="journal-composer-head">
        <div>
          <h3>{editingId ? "Edit Trade Journal Entry" : "Log Perpetual Trade & Thesis"}</h3>
          <p className="muted">
            Record setup structure, entry/exit execution, and risk adherence on {networkName(draft.network)}.
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close journal editor"
          onClick={closeJournalComposer}
        >
          <Icon name="close" size={16} />
        </button>
      </header>

      {openPositions.length > 0 && !editingId ? (
        <div className="composer-prefill-bar">
          <span className="muted">Snapshot active position:</span>
          {openPositions.map((item) => (
            <button
              key={item.position.symbol}
              type="button"
              className="filter-pill num"
              onClick={() => updateJournalDraft(draftFromPosition(item, snapshot.network))}
            >
              <InstrumentMark base={item.base} size="sm" />
              <span>
                {item.base} {item.position.side === "long" ? "Long" : "Short"} {item.position.leverage}x
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <form className="journal-form" noValidate onSubmit={onSubmit}>
        <div className="journal-form-grid">
          <div className="field">
            <label className="field-label" htmlFor={symbolId}>
              Contract
            </label>
            <select
              id={symbolId}
              className="input"
              value={draft.symbol}
              onChange={(event) => updateJournalDraft({ symbol: event.target.value })}
            >
              {knownSymbols.map((item) => (
                <option key={item.symbol} value={item.symbol}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="field journal-side-fieldset">
            <legend className="field-label">Direction</legend>
            <div className="journal-side-radios">
              {(["long", "short"] as const).map((side) => {
                const checked = draft.side === side;
                return (
                  <label
                    key={side}
                    className="journal-side-option"
                    data-side={side}
                    data-checked={checked}
                  >
                    <input
                      type="radio"
                      name="journal-side"
                      className="visually-hidden"
                      value={side}
                      checked={checked}
                      onChange={() => updateJournalDraft({ side })}
                    />
                    <span>{side === "long" ? "Long" : "Short"}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="field">
            <label className="field-label" htmlFor={levId}>
              Leverage (x)
            </label>
            <input
              id={levId}
              type="text"
              inputMode="numeric"
              className="input num"
              value={String(draft.leverage)}
              onChange={(event) => {
                const parsed = Number(event.target.value.replace(/[^0-9]/g, ""));
                updateJournalDraft({ leverage: parsed >= 1 ? Math.min(50, parsed) : 1 });
              }}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={outcomeId}>
              Status / Outcome
            </label>
            <select
              id={outcomeId}
              className="input"
              value={draft.outcome}
              onChange={(event) => updateJournalDraft({ outcome: event.target.value as JournalOutcome })}
            >
              <option value="open">Open thesis</option>
              <option value="win">Closed — Win</option>
              <option value="loss">Closed — Loss</option>
              <option value="breakeven">Closed — Breakeven</option>
              <option value="note">Market observation</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor={setupId}>
              Setup Playbook
            </label>
            <select
              id={setupId}
              className="input"
              value={draft.setup}
              onChange={(event) => updateJournalDraft({ setup: event.target.value as JournalSetup })}
            >
              {JOURNAL_SETUPS.map((setup) => (
                <option key={setup} value={setup}>
                  {setup}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="journal-form-grid journal-form-numbers">
          <div className="field">
            <label className="field-label" htmlFor={entryId}>
              Entry price
            </label>
            <input
              id={entryId}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="e.g. 62450.00"
              value={draft.entryPrice}
              onChange={(event) => updateJournalDraft({ entryPrice: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={exitId}>
              Exit / Target price
            </label>
            <input
              id={exitId}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="e.g. 64800.00"
              value={draft.exitPrice}
              onChange={(event) => updateJournalDraft({ exitPrice: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={qtyId}>
              Size (base units)
            </label>
            <input
              id={qtyId}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="e.g. 0.25"
              value={draft.qty}
              onChange={(event) => updateJournalDraft({ qty: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={pnlId}>
              P&amp;L (USDT)
            </label>
            <input
              id={pnlId}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="e.g. +240.00 or -65.00"
              value={draft.pnlUsd}
              onChange={(event) => updateJournalDraft({ pnlUsd: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={rrId}>
              Planned R:R
            </label>
            <input
              id={rrId}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="e.g. 2.2"
              value={draft.rrPlanned}
              onChange={(event) => updateJournalDraft({ rrPlanned: event.target.value })}
            />
          </div>
        </div>

        <fieldset className="journal-checklist">
          <legend className="field-label">Risk &amp; Execution Discipline</legend>
          <div className="journal-checks">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.checklist.stopRespected}
                onChange={(event) =>
                  updateJournalDraft({
                    checklist: { ...draft.checklist, stopRespected: event.target.checked },
                  })
                }
              />
              <span>Stop-loss defined &amp; respected</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.checklist.sizedWithinRisk}
                onChange={(event) =>
                  updateJournalDraft({
                    checklist: { ...draft.checklist, sizedWithinRisk: event.target.checked },
                  })
                }
              />
              <span>Position sized within risk limit</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.checklist.followedPlan}
                onChange={(event) =>
                  updateJournalDraft({
                    checklist: { ...draft.checklist, followedPlan: event.target.checked },
                  })
                }
              />
              <span>No impulsive entry / followed setup rules</span>
            </label>
          </div>
        </fieldset>

        <div className="journal-notes-grid">
          <div className="field">
            <label className="field-label" htmlFor={thesisId}>
              Trade Thesis &amp; Market Structure
            </label>
            <textarea
              ref={thesisRef}
              id={thesisId}
              rows={3}
              className="input"
              placeholder="What was the 4h/1h structure, funding regime, or catalyst that justified this entry?"
              aria-invalid={thesisError ? true : undefined}
              value={draft.thesis}
              onChange={(event) => {
                if (thesisError) setThesisError("");
                updateJournalDraft({ thesis: event.target.value });
              }}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={lessonId}>
              Execution Review &amp; Post-Trade Takeaway
            </label>
            <textarea
              id={lessonId}
              rows={3}
              className="input"
              placeholder="How was the entry/exit managed? What should be repeated or improved next time?"
              value={draft.lesson}
              onChange={(event) => {
                if (thesisError) setThesisError("");
                updateJournalDraft({ lesson: event.target.value });
              }}
            />
          </div>
        </div>

        {thesisError ? (
          <p className="form-error" role="alert">
            {thesisError}
          </p>
        ) : null}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={closeJournalComposer}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            {editingId ? "Update Journal Entry" : "Save Journal Entry"}
          </button>
        </div>
      </form>
    </section>
  );
}

function JournalEntriesView({
  entries,
  snapshot,
  busy,
}: {
  entries: JournalEntry[];
  snapshot: Snapshot;
  busy: boolean;
}) {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [setupFilter, setSetupFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const outcomeCounts = useMemo(() => {
    let open = 0;
    let win = 0;
    let loss = 0;
    for (const entry of entries) {
      if (entry.outcome === "open") open += 1;
      else if (entry.outcome === "win") win += 1;
      else if (entry.outcome === "loss") loss += 1;
    }
    return { open, win, loss };
  }, [entries]);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (outcomeFilter !== "all" && entry.outcome !== outcomeFilter) return false;
      if (setupFilter !== "all" && entry.setup !== setupFilter) return false;
      if (!q) return true;
      return (
        entry.symbol.toLowerCase().includes(q) ||
        entry.setup.toLowerCase().includes(q) ||
        entry.thesis.toLowerCase().includes(q) ||
        entry.lesson.toLowerCase().includes(q)
      );
    });
  }, [entries, outcomeFilter, setupFilter, deferredQuery]);

  const pageSlice = useMemo(() => paginateList(filtered, page, pageSize), [filtered, page, pageSize]);

  function reviewWithAi(entry: JournalEntry) {
    const instrument = instrumentFor(snapshot, entry.symbol);
    const prompt = [
      `Review my ${instrument.base} ${entry.side} (${entry.leverage}x, ${entry.setup}, outcome: ${entry.outcome}) journal entry:`,
      `- Entry: ${entry.entryPrice || "—"}, Exit/Target: ${entry.exitPrice || "—"}, Qty: ${entry.qty || "—"}, P&L: ${entry.pnlUsd || "—"} USDT, Planned R:R: ${entry.rrPlanned || "—"}`,
      `- Thesis: ${entry.thesis || "—"}`,
      `- Notes: ${entry.lesson || "—"}`,
      "Give me concise feedback on the setup quality, risk management, and what to watch on the current chart.",
    ].join("\n");
    navigate("chat");
    void ask(prompt);
  }

  return (
    <div className="desk-section">
      <div className="desk-toolbar">
        <div className="desk-filters" role="group" aria-label="Filter journal by outcome">
          {(
            [
              { id: "all", label: `All (${entries.length})` },
              { id: "open", label: `Open (${outcomeCounts.open})` },
              { id: "win", label: `Wins (${outcomeCounts.win})` },
              { id: "loss", label: `Losses (${outcomeCounts.loss})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className="filter-pill"
              aria-pressed={outcomeFilter === item.id}
              onClick={() => {
                setOutcomeFilter(item.id);
                setPage(1);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="journal-search-cluster">
          <select
            aria-label="Filter by setup playbook"
            className="input input-sm"
            value={setupFilter}
            onChange={(event) => {
              setSetupFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">All setups</option>
            {JOURNAL_SETUPS.map((setup) => (
              <option key={setup} value={setup}>
                {setup}
              </option>
            ))}
          </select>

          <label className="search journal-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              className="input input-sm"
              placeholder="Search symbol or thesis"
              aria-label="Search trading journal"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          <p>No journal entries yet. Log a trade from a position under Account, from a fill below, or start one here.</p>
          <button type="button" className="btn btn-secondary" onClick={() => openJournalComposer()}>
            New entry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <p>No matching journal entries</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setOutcomeFilter("all");
              setSetupFilter("all");
              setQuery("");
              setPage(1);
            }}
          >
            Reset filters
          </button>
        </div>
      ) : (
        <>
          <ul className="journal-cards">
            {pageSlice.items.map((entry) => {
            const instrument = instrumentFor(snapshot, entry.symbol);
            const quote = instrument.quote || "USDT";
            const outcome = OUTCOME_META[entry.outcome];
            const pnlNum = entry.pnlUsd.trim() ? Number(entry.pnlUsd) : Number.NaN;
            const hasPnl = Number.isFinite(pnlNum);
            const rulesPassed =
              (entry.checklist.stopRespected ? 1 : 0) +
              (entry.checklist.sizedWithinRisk ? 1 : 0) +
              (entry.checklist.followedPlan ? 1 : 0);

            return (
              <li key={entry.id} className="journal-card">
                <header className="journal-card-head">
                  <button
                    type="button"
                    className="symbol"
                    onClick={() => void focusMarket(entry.symbol)}
                  >
                    <InstrumentMark base={instrument.base} size="sm" />
                    <span className="symbol-name">
                      {instrument.base}-{quote}
                    </span>
                  </button>
                  <span className="chip" data-tone={entry.side === "long" ? "up" : "down"}>
                    {entry.side === "long" ? "Long" : "Short"} {leverage(entry.leverage)}
                  </span>
                  <span className="chip">{entry.setup}</span>
                  <span className="chip" data-tone={outcome.tone}>
                    {outcome.label}
                  </span>
                  {entry.rrPlanned ? <span className="chip num">R:R 1 : {entry.rrPlanned}</span> : null}
                  <span
                    className="chip num"
                    data-tone={rulesPassed === 3 ? "up" : rulesPassed === 2 ? "warn" : "down"}
                    title="Risk discipline checklist score"
                  >
                    {rulesPassed}/3 rules
                  </span>
                  <span className="grow" />
                  {hasPnl ? (
                    <span className={`journal-pnl num ${direction(pnlNum)}`}>
                      {signedMoney(pnlNum.toFixed(2))} {quote}
                    </span>
                  ) : null}
                </header>

                <div className="journal-card-body">
                  {entry.thesis ? (
                    <div className="journal-note-block">
                      <span className="journal-note-label">Thesis &amp; Setup</span>
                      <p>{entry.thesis}</p>
                    </div>
                  ) : null}
                  {entry.lesson ? (
                    <div className="journal-note-block">
                      <span className="journal-note-label">Execution &amp; Review</span>
                      <p>{entry.lesson}</p>
                    </div>
                  ) : null}
                </div>

                <footer className="journal-card-foot">
                  <div className="journal-meta-inline num muted">
                    <span>Entry {entry.entryPrice ? price(entry.entryPrice) : "—"}</span>
                    <span>→</span>
                    <span>
                      {entry.outcome === "open" ? "Target" : "Exit"} {entry.exitPrice ? price(entry.exitPrice) : "—"}
                    </span>
                    {entry.qty ? (
                      <span>
                        · {units(entry.qty)} {instrument.base}
                      </span>
                    ) : null}
                    <span>· {networkName(entry.network)}</span>
                    <span>· {dayTime(entry.createdAt)}</span>
                  </div>

                  <div className="perp-actions">
                    {snapshot.assistant.ready ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        onClick={() => reviewWithAi(entry)}
                      >
                        <Icon name="assistant" size={13} />
                        AI Critique
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() =>
                        openTrade(null, {
                          symbol: entry.symbol,
                          side: entry.side === "long" ? "buy" : "sell",
                        })
                      }
                    >
                      Trade {instrument.base}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() => openJournalComposer(entry, entry.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-label={`Delete ${instrument.base} journal entry`}
                      onClick={() => deleteJournalEntry(entry.id)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </footer>
              </li>
            );
          })}
          </ul>

          <Pagination
            label="Trading journal pagination"
            itemLabel="journal entries"
            slice={pageSlice}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  );
}

function ExecutionRow({ record }: { record: ExecutionRecord }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="entry">
      <div className="entry-bar">
        <button
          type="button"
          className="entry-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="entry-time num">{dayTime(record.time)}</span>
          <span className="chip">{CATEGORY_LABEL[record.category]}</span>
          {record.base ? (
            <span className="entry-symbol">
              <InstrumentMark base={record.base} size="sm" />
              <strong>{record.base}</strong>
            </span>
          ) : null}
          {record.side ? (
            <span className="chip" data-tone={record.side === "buy" ? "up" : "down"}>
              {record.side === "buy" ? "Buy" : "Sell"}
            </span>
          ) : null}
          <span className="grow entry-title">{record.title}</span>
          <span className="chip">{networkName(record.network)}</span>
          <span className="chip" data-tone={record.tone}>
            {record.statusLabel}
          </span>
          <Icon name="chevron" size={14} />
        </button>

        {record.symbol ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost entry-journal-btn"
            title="Log this execution to your trading journal"
            onClick={() => openJournalComposer(draftFromExecution(record))}
          >
            <Icon name="compose" size={13} />
            Journal
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="entry-body">
          <p className={record.status === "failed" ? "entry-output down" : "entry-output"}>{record.summary}</p>
          {record.fillPrice || record.qty || record.stopLoss || record.takeProfit ? (
            <dl className="entry-facts num">
              {record.qty ? (
                <div>
                  <dt>Quantity</dt>
                  <dd>
                    {units(record.qty)} {record.base ?? ""}
                  </dd>
                </div>
              ) : null}
              {record.fillPrice ? (
                <div>
                  <dt>Ref / Fill Price</dt>
                  <dd>{price(record.fillPrice)}</dd>
                </div>
              ) : null}
              {record.notional ? (
                <div>
                  <dt>Notional</dt>
                  <dd>{money(record.notional)} USDT</dd>
                </div>
              ) : null}
              {record.stopLoss ? (
                <div>
                  <dt>Stop-Loss Trigger</dt>
                  <dd>{price(record.stopLoss)}</dd>
                </div>
              ) : null}
              {record.takeProfit ? (
                <div>
                  <dt>Take-Profit Trigger</dt>
                  <dd>{price(record.takeProfit)}</dd>
                </div>
              ) : null}
              {record.orderId ? (
                <div>
                  <dt>Order ID</dt>
                  <dd className="mono">{record.orderId}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {record.steps.length > 0 ? <StepList steps={record.steps} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function ExecutionHistoryView({
  records,
  positions,
  orders,
  network,
}: {
  records: ExecutionRecord[];
  positions: EnrichedPosition[];
  orders: EnrichedOrder[];
  network: Network;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const captionId = useId();

  const categoryCounts = useMemo(() => {
    let order = 0;
    let ticket = 0;
    let cancel = 0;
    let wallet = 0;
    for (const rec of records) {
      if (rec.category === "order") order += 1;
      else if (rec.category === "ticket") ticket += 1;
      else if (rec.category === "cancel") cancel += 1;
      else if (rec.category === "wallet") wallet += 1;
    }
    return { order, ticket, cancel, wallet };
  }, [records]);

  const filteredRecords = useMemo(() => {
    if (filter === "onbook") return [];
    if (filter === "all") return records;
    return records.filter((rec) => rec.category === filter);
  }, [records, filter]);

  const recordsSlice = useMemo(
    () => paginateList(filteredRecords, page, pageSize),
    [filteredRecords, page, pageSize],
  );

  const showOnBook = filter === "all" || filter === "onbook";

  return (
    <div className="desk-section">
      <div className="desk-toolbar">
        <div className="desk-filters" role="group" aria-label="Filter execution history">
          {(
            [
              { id: "all", label: `All Activity (${records.length + positions.length + orders.length})` },
              { id: "order", label: `Exchange Fills (${categoryCounts.order})` },
              { id: "ticket", label: `Order Tickets (${categoryCounts.ticket})` },
              { id: "cancel", label: `Cancellations (${categoryCounts.cancel})` },
              { id: "wallet", label: `Vault Funding (${categoryCounts.wallet})` },
              { id: "onbook", label: `On-Book Ledger (${positions.length + orders.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className="filter-pill"
              aria-pressed={filter === item.id}
              onClick={() => {
                setFilter(item.id);
                setPage(1);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {filteredRecords.length > 0 ? (
        <>
          <ul className="entries">
            {recordsSlice.items.map((rec) => (
              <ExecutionRow key={rec.id} record={rec} />
            ))}
          </ul>
          <Pagination
            label="Execution history pagination"
            itemLabel="events"
            slice={recordsSlice}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      ) : filter !== "onbook" && !showOnBook ? (
        <p className="empty">No matching execution events in this session</p>
      ) : null}

      {showOnBook && (positions.length > 0 || orders.length > 0) ? (
        <section className="onbook-ledger" aria-label="Active exchange positions and resting orders ledger">
          <h3 className="section-title">
            On-Book Positions &amp; Resting Triggers ({networkName(network)})
            <span className="section-count num">{positions.length + orders.length}</span>
          </h3>
          <div className="table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
            <table className="table">
              <caption id={captionId} className="visually-hidden">
                Active on-book perpetual positions and resting trigger orders
              </caption>
              <thead>
                <tr>
                  <th scope="col">Contract</th>
                  <th scope="col">Ledger Type</th>
                  <th scope="col">Side</th>
                  <th scope="col" className="num">
                    Entry / Trigger
                  </th>
                  <th scope="col" className="num">
                    Mark Price
                  </th>
                  <th scope="col" className="num">
                    Size / Value
                  </th>
                  <th scope="col" className="num">
                    Unrealized P&amp;L / Status
                  </th>
                  <th scope="col" className="num">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((item) => (
                  <tr key={`pos-${item.position.symbol}`}>
                    <th scope="row">
                      <button
                        type="button"
                        className="symbol"
                        onClick={() => void focusMarket(item.position.symbol)}
                      >
                        <InstrumentMark base={item.base} size="sm" />
                        <span className="symbol-name">
                          {item.base}-{item.quote}
                        </span>
                      </button>
                    </th>
                    <td>
                      <span className="cell-main">Open Perpetual Position</span>
                      <span className="cell-sub">
                        {item.position.isolated ? "Isolated" : "Cross"} · {leverage(item.position.leverage)}
                      </span>
                    </td>
                    <td>
                      <span className="chip" data-tone={item.position.side === "long" ? "up" : "down"}>
                        {item.position.side === "long" ? "Long" : "Short"}
                      </span>
                    </td>
                    <td className="num">{price(item.position.entryPrice)}</td>
                    <td className="num">{price(item.position.markPrice)}</td>
                    <td className="num">
                      <span className="cell-main">
                        {units(item.position.qty)} {item.base}
                      </span>
                      <span className="cell-sub">
                        {money(item.position.notional)} {item.quote}
                      </span>
                    </td>
                    <td className={`num ${direction(item.position.unrealizedPnl)}`}>
                      <span className="cell-main">
                        {signedMoney(item.position.unrealizedPnl)} {item.quote}
                      </span>
                      <span className="cell-sub">{percent(item.position.roePct)} ROE</span>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => openJournalComposer(draftFromPosition(item, network))}
                      >
                        <Icon name="compose" size={13} />
                        Journal
                      </button>
                    </td>
                  </tr>
                ))}

                {orders.map((item) => (
                  <tr key={`ord-${item.order.id}`}>
                    <th scope="row">
                      <button
                        type="button"
                        className="symbol"
                        onClick={() => void focusMarket(item.order.symbol)}
                      >
                        <InstrumentMark base={item.base} size="sm" />
                        <span className="symbol-name">
                          {item.base}-{item.quote}
                        </span>
                      </button>
                    </th>
                    <td>
                      <span className="cell-main">{orderType(item.order.type)}</span>
                      <span className="cell-sub">
                        {item.roleLabel} · #{item.order.id}
                      </span>
                    </td>
                    <td>
                      <span className="chip" data-tone={item.order.side === "buy" ? "up" : "down"}>
                        {item.order.side === "buy" ? "Buy" : "Sell"}
                      </span>
                    </td>
                    <td className="num">{item.effectivePrice ? price(item.effectivePrice) : "Market"}</td>
                    <td className="num">
                      {item.markPrice !== null ? price(String(item.markPrice)) : "—"}
                    </td>
                    <td className="num">
                      <span className="cell-main">
                        {units(item.order.qty)} {item.base}
                      </span>
                      {item.estNotional !== null ? (
                        <span className="cell-sub">
                          ≈ {money(item.estNotional.toFixed(2))} {item.quote}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">
                      <span className="chip">{item.order.reduceOnly ? "Armed Guard" : "Resting"}</span>
                    </td>
                    <td className="num muted">{dayTime(item.order.time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {filteredRecords.length === 0 && (!showOnBook || (positions.length === 0 && orders.length === 0)) ? (
        <p className="empty">No activity yet</p>
      ) : null}
    </div>
  );
}

function SetupEdgeMatrixView({ metrics }: { metrics: JournalMetrics }) {
  const captionId = useId();
  const [sortKey, setSortKey] = useState<SetupSortKey>("netPnl");
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");

  const sorted = useMemo(() => {
    const factor = sortDir === "ascending" ? 1 : -1;
    return [...metrics.bySetup].sort((a, b) => {
      switch (sortKey) {
        case "setup":
          return factor * collator.compare(a.setup, b.setup);
        case "total":
          return factor * (a.total - b.total);
        case "winRate":
          return factor * ((a.winRatePct ?? -1) - (b.winRatePct ?? -1));
        case "avgPnl":
          return factor * ((a.avgPnlUsd ?? 0) - (b.avgPnlUsd ?? 0));
        case "discipline":
          return factor * (a.disciplinePct - b.disciplinePct);
        case "netPnl":
        default:
          return factor * (a.netPnlUsd - b.netPnlUsd);
      }
    });
  }, [metrics.bySetup, sortKey, sortDir]);

  function toggleSort(nextKey: SetupSortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === "ascending" ? "descending" : "ascending"));
    } else {
      setSortKey(nextKey);
      setSortDir("descending");
    }
  }

  if (metrics.bySetup.length === 0) {
    return <p className="empty">Log journal entries to analyze performance by setup playbook.</p>;
  }

  return (
    <div className="desk-section">
      <div className="visually-hidden" role="status">
        Sorted by {sortKey}, {sortDir}, {sorted.length} rows
      </div>

      <div className="table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="table sortable-data-table">
          <caption id={captionId} className="visually-hidden">
            Perpetual trading performance by setup playbook
          </caption>
          <thead>
            <tr>
              <th scope="col" aria-sort={sortKey === "setup" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn" onClick={() => toggleSort("setup")}>
                  <span>Setup Playbook</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "total" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("total")}>
                  <span>Logged Trades</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "winRate" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("winRate")}>
                  <span>Win Rate</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "avgPnl" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("avgPnl")}>
                  <span>Avg P&amp;L</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "netPnl" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("netPnl")}>
                  <span>Net P&amp;L</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "discipline" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("discipline")}>
                  <span>Discipline</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.setup}>
                <th scope="row">
                  <span className="cell-main">{row.setup}</span>
                  <span className="cell-sub">
                    {row.wins}W · {row.losses}L · {row.total - row.closed} open
                  </span>
                </th>
                <td className="num">{row.total}</td>
                <td className="num">
                  {row.winRatePct !== null ? (
                    <span className="chip num" data-tone={row.winRatePct >= 55 ? "up" : row.winRatePct < 45 ? "down" : undefined}>
                      {row.winRatePct.toFixed(0)}%
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={`num ${direction(row.avgPnlUsd ?? 0)}`}>
                  {row.avgPnlUsd !== null ? `${signedMoney(row.avgPnlUsd.toFixed(2))} USDT` : "—"}
                </td>
                <td className={`num ${direction(row.netPnlUsd)}`}>
                  <strong>{signedMoney(row.netPnlUsd.toFixed(2))} USDT</strong>
                </td>
                <td className="num">
                  <span
                    className="chip num"
                    data-tone={row.disciplinePct >= 85 ? "up" : row.disciplinePct >= 65 ? "warn" : "down"}
                  >
                    {row.disciplinePct.toFixed(0)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Trading Journal, Setup Edge Analytics, and Exchange Execution History. */
export function ActivityPage() {
  const snapshot = useSnapshot();
  const busy = useBusy();
  const { entries, composerOpen } = useJournal();

  const [tab, setTab] = useState<ActivityTab>("journal");
  const [networkFilter, setNetworkFilter] = useState<Network | "all">("all");
  const [copiedMd, setCopiedMd] = useState(false);
  const panelId = useId();

  const scopedEntries = useMemo(
    () =>
      networkFilter === "all"
        ? entries
        : entries.filter((entry) => entry.network === networkFilter),
    [entries, networkFilter],
  );

  const metrics = useMemo(
    () => computeJournalMetrics(entries, networkFilter),
    [entries, networkFilter],
  );

  const executionRecords = useMemo(() => {
    const all = buildExecutionHistory(snapshot);
    return networkFilter === "all" ? all : all.filter((rec) => rec.network === networkFilter);
  }, [snapshot, networkFilter]);

  const enrichedPositions = useMemo(() => enrichPositions(snapshot), [snapshot]);
  const enrichedOrders = useMemo(() => enrichOrders(snapshot), [snapshot]);

  function copyMarkdown() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    const text = formatJournalMarkdown(scopedEntries, metrics);
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 1800);
    });
  }

  function askAiCoach() {
    navigate("chat");
    void ask(journalReviewPrompt(metrics));
  }

  const tabs: { id: ActivityTab; label: string; count: number }[] = [
    { id: "journal", label: "Trading Journal", count: scopedEntries.length },
    {
      id: "history",
      label: "Execution & Ledger",
      count: executionRecords.length + enrichedPositions.length + enrichedOrders.length,
    },
    { id: "edge", label: "Setup Edge Matrix", count: metrics.bySetup.length },
  ];

  return (
    <div className="page">
      <div className="page-inner">
        <header className="portfolio-head">
          <div className="portfolio-identity">
            <div className="desk-filters" role="group" aria-label="Filter journal by network">
              {(
                [
                  { id: "all", label: "All Networks" },
                  { id: "testnet", label: "Testnet" },
                  { id: "mainnet", label: "Mainnet" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="filter-pill"
                  aria-pressed={networkFilter === item.id}
                  onClick={() => setNetworkFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="account-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={copyMarkdown}>
              <Icon name={copiedMd ? "check" : "copy"} size={14} />
              {copiedMd ? "Copied MD" : "Export MD"}
            </button>
            {snapshot.assistant.ready ? (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={busy}
                onClick={askAiCoach}
              >
                <Icon name="assistant" size={14} />
                AI Coach Review
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setTab("journal");
                openJournalComposer({ network: snapshot.network, symbol: snapshot.focus });
              }}
            >
              <Icon name="plus" size={14} />
              Log Trade
            </button>
          </div>
        </header>

        <JournalKpiStrip
          metrics={metrics}
          executionCount={executionRecords.length}
          openPositionsCount={enrichedPositions.length}
        />

        {composerOpen ? (
          <JournalComposer snapshot={snapshot} openPositions={enrichedPositions} />
        ) : null}

        <div className="desk-tabs-bar">
          <div
            className="desk-tablist"
            role="tablist"
            aria-label="Journal and activity views"
            onKeyDown={(event) => {
              const index = tabs.findIndex((item) => item.id === tab);
              let next = -1;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              const target = tabs[next];
              if (!target) return;
              event.preventDefault();
              setTab(target.id);
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            {tabs.map((item) => {
              const selected = item.id === tab;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`act-tab-${item.id}`}
                  className="desk-tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTab(item.id)}
                >
                  <span>{item.label}</span>
                  <span className="section-count num">{item.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`act-tab-${tab}`}
          className="desk-tabpanel"
        >
          {tab === "journal" ? (
            <JournalEntriesView entries={scopedEntries} snapshot={snapshot} busy={busy} />
          ) : null}
          {tab === "history" ? (
            <ExecutionHistoryView
              records={executionRecords}
              positions={enrichedPositions}
              orders={enrichedOrders}
              network={snapshot.network}
            />
          ) : null}
          {tab === "edge" ? <SetupEdgeMatrixView metrics={metrics} /> : null}
        </div>
      </div>
    </div>
  );
}
