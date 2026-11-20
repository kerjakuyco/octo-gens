import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import type { GridBotView, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import {
  JOURNAL_SETUPS,
  type JournalOutcome,
  type JournalSetup,
  closeJournalComposer,
  draftFromGridBot,
  draftFromPosition,
  saveJournalEntry,
  setupLabel,
  updateJournalDraft,
  useJournal,
} from "../../lib/journal";
import { instrumentFor } from "../../lib/market";
import { networkName } from "../../lib/network";
import type { EnrichedPosition } from "../../lib/portfolio";
import { InstrumentMark } from "../market/InstrumentMark";
import { OUTCOME_CHOICES } from "./labels";

interface JournalComposerProps {
  snapshot: Snapshot;
  /** Open positions, to fill the form in from. */
  positions: EnrichedPosition[];
  /** Grid bots, to log one. */
  bots: GridBotView[];
}

/**
 * The journal form: what was traded, how it went, the three-point checklist, why it was taken and what
 * it taught. It can be filled in from an open position or a grid bot.
 */
export function JournalComposer({ snapshot, positions, bots }: JournalComposerProps) {
  const { draft, editingId } = useJournal();
  const [problem, setProblem] = useState("");
  const thesisRef = useRef<HTMLTextAreaElement>(null);
  const ids = {
    title: useId(),
    market: useId(),
    leverage: useId(),
    outcome: useId(),
    setup: useId(),
    entry: useId(),
    exit: useId(),
    size: useId(),
    pnl: useId(),
    rr: useId(),
    thesis: useId(),
    lesson: useId(),
  };
  const grid = draft.setup === "Grid Bot";
  const base = instrumentFor(snapshot, draft.symbol).base;

  const markets = useMemo(() => {
    const list = snapshot.instruments.map((item) => ({ symbol: item.symbol, label: `${item.base}-${item.quote || "USDT"}` }));
    if (draft.symbol && !list.some((item) => item.symbol === draft.symbol)) {
      const custom = instrumentFor(snapshot, draft.symbol);
      list.unshift({ symbol: draft.symbol, label: `${custom.base}-${custom.quote || "USDT"}` });
    }
    return list;
  }, [snapshot, draft.symbol]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.thesis.trim() && !draft.lesson.trim()) {
      setProblem("Write why you took it, or what you learned, before saving.");
      thesisRef.current?.focus();
      return;
    }
    saveJournalEntry(draft, editingId);
  }

  function check(key: keyof typeof draft.checklist, label: string) {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={draft.checklist[key]}
          onChange={(event) => updateJournalDraft({ checklist: { ...draft.checklist, [key]: event.target.checked } })}
        />
        <span>{label}</span>
      </label>
    );
  }

  const fillers = !editingId && (positions.length > 0 || bots.length > 0);

  return (
    <section id="av-journal-form" className="av-form" aria-labelledby={ids.title}>
      <header className="av-form-head">
        <div className="av-form-heading">
          <h3 id={ids.title} className="av-form-title">
            {editingId ? "Edit the entry" : "Log a trade"}
          </h3>
          <span className="chip" data-tone={draft.network === "mainnet" ? "warn" : undefined}>
            {networkName(draft.network)}
          </span>
        </div>
        <button type="button" className="icon-btn" aria-label="Close the journal form" onClick={closeJournalComposer}>
          <Icon name="close" size={16} />
        </button>
      </header>

      {fillers ? (
        <div className="av-fill" role="group" aria-label="Fill in from">
          <span className="av-fill-label">Fill in from</span>
          {positions.map((item) => (
            <button
              key={`pos-${item.position.symbol}`}
              type="button"
              className="av-fill-chip num"
              onClick={() => updateJournalDraft(draftFromPosition(item, snapshot.network))}
            >
              <InstrumentMark base={item.base} size="sm" />
              <span>
                {item.base} {item.position.side === "long" ? "long" : "short"} {item.position.leverage}x
              </span>
            </button>
          ))}
          {bots.map((bot) => (
            <button
              key={`bot-${bot.id}`}
              type="button"
              className="av-fill-chip"
              onClick={() => updateJournalDraft(draftFromGridBot(bot))}
            >
              <Icon name="grid" size={13} />
              <span>
                {bot.base} grid bot{bot.status === "running" || bot.status === "waiting" ? "" : ", stopped"}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <form className="av-form-body" noValidate onSubmit={onSubmit}>
        <div className="av-form-grid">
          <div className="field">
            <label className="field-label" htmlFor={ids.market}>
              Market
            </label>
            <select
              id={ids.market}
              className="input"
              value={draft.symbol}
              onChange={(event) => updateJournalDraft({ symbol: event.target.value })}
            >
              {markets.map((item) => (
                <option key={item.symbol} value={item.symbol}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="field av-sides">
            <legend className="field-label">Direction</legend>
            <div className="av-side-options">
              {(["long", "short"] as const).map((side) => (
                <label key={side} className="av-side" data-side={side} data-checked={draft.side === side}>
                  <input
                    type="radio"
                    name="av-journal-side"
                    className="visually-hidden"
                    value={side}
                    checked={draft.side === side}
                    onChange={() => updateJournalDraft({ side })}
                  />
                  <span>{side === "long" ? "Long" : "Short"}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label className="field-label" htmlFor={ids.leverage}>
              Leverage
            </label>
            <input
              id={ids.leverage}
              type="text"
              inputMode="numeric"
              className="input num"
              value={`${draft.leverage}`}
              onChange={(event) => {
                const parsed = Number(event.target.value.replace(/[^0-9]/g, ""));
                updateJournalDraft({ leverage: parsed >= 1 ? Math.min(50, parsed) : 1 });
              }}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={ids.outcome}>
              How it went
            </label>
            <select
              id={ids.outcome}
              className="input"
              value={draft.outcome}
              onChange={(event) => updateJournalDraft({ outcome: event.target.value as JournalOutcome })}
            >
              {OUTCOME_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor={ids.setup}>
              Setup
            </label>
            <select
              id={ids.setup}
              className="input"
              value={draft.setup}
              onChange={(event) => updateJournalDraft({ setup: event.target.value as JournalSetup })}
            >
              {JOURNAL_SETUPS.map((setup) => (
                <option key={setup} value={setup}>
                  {setupLabel(setup)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="av-form-grid av-form-numbers">
          <div className="field">
            <label className="field-label" htmlFor={ids.entry}>
              {grid ? "Range from" : "Entry price"}
            </label>
            <input
              id={ids.entry}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder={grid ? "Bottom of the range" : "62450.00"}
              value={draft.entryPrice}
              onChange={(event) => updateJournalDraft({ entryPrice: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.exit}>
              {grid ? "Range to" : draft.outcome === "open" ? "Target price" : "Exit price"}
            </label>
            <input
              id={ids.exit}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder={grid ? "Top of the range" : "64800.00"}
              value={draft.exitPrice}
              onChange={(event) => updateJournalDraft({ exitPrice: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.size}>
              Size in {base}
            </label>
            <input
              id={ids.size}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="0.25"
              value={draft.qty}
              onChange={(event) => updateJournalDraft({ qty: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.pnl}>
              Profit or loss, USDT
            </label>
            <input
              id={ids.pnl}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="240.00 or -65.00"
              value={draft.pnlUsd}
              onChange={(event) => updateJournalDraft({ pnlUsd: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.rr}>
              Planned reward to risk
            </label>
            <input
              id={ids.rr}
              type="text"
              inputMode="decimal"
              className="input num"
              placeholder="2.0"
              value={draft.rrPlanned}
              onChange={(event) => updateJournalDraft({ rrPlanned: event.target.value })}
            />
          </div>
        </div>

        <fieldset className="av-checklist">
          <legend className="field-label">Did you keep to your plan?</legend>
          <div className="av-checks">
            {check("stopRespected", "I set a stop-loss and kept to it")}
            {check("sizedWithinRisk", "I sized it within my risk limit")}
            {check("followedPlan", "I followed my plan, no impulse entry")}
          </div>
        </fieldset>

        <div className="av-form-notes">
          <div className="field">
            <label className="field-label" htmlFor={ids.thesis}>
              Why you took it
            </label>
            <textarea
              ref={thesisRef}
              id={ids.thesis}
              rows={3}
              className="input"
              placeholder="The structure, the funding, or the news that made the case."
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${ids.thesis}-problem` : undefined}
              value={draft.thesis}
              onChange={(event) => {
                if (problem) setProblem("");
                updateJournalDraft({ thesis: event.target.value });
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.lesson}>
              What you learned
            </label>
            <textarea
              id={ids.lesson}
              rows={3}
              className="input"
              placeholder="How the entry and exit went, and what to repeat or change next time."
              value={draft.lesson}
              onChange={(event) => {
                if (problem) setProblem("");
                updateJournalDraft({ lesson: event.target.value });
              }}
            />
          </div>
        </div>

        {problem ? (
          <p id={`${ids.thesis}-problem`} className="form-error" role="alert">
            {problem}
          </p>
        ) : null}

        <div className="av-form-actions">
          <button type="button" className="btn btn-secondary" onClick={closeJournalComposer}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            {editingId ? "Save changes" : "Save to journal"}
          </button>
        </div>
      </form>
    </section>
  );
}
