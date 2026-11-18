import { type FormEvent, useId, useState } from "react";
import type { RunView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { dayTime, duration, plural } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { feedName } from "../../lib/ticket";
import { openExternal, runPattern, startWatch, stopWatch, useApp, useSnapshot } from "../../state/app";
import { usageText } from "../assistant/RunEntry";
import { StepTrace } from "../assistant/StepTrace";

const STATUS_WORDS: Record<RunView["status"], string> = {
  complete: "Complete",
  failed: "Failed",
  stopped: "Stopped",
  running: "Running",
};

function JournalRow({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const usage = usageText(run);

  return (
    <li className="journal-row">
      <button
        type="button"
        className="journal-summary"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevron" size={14} />
        <span>
          <span className="journal-title">{run.title}</span>
          <span className="journal-meta">
            {run.agent}, {feedName(run.feed)}, {dayTime(run.time)}
          </span>
        </span>
        <span className="journal-side">
          <span className={`status-${run.status}`}>{STATUS_WORDS[run.status]}</span>
          <span>{duration(run.ms)}</span>
        </span>
      </button>
      {open ? (
        <div className="journal-detail" id={detailId}>
          {run.steps.length > 0 ? <StepTrace steps={run.steps} /> : null}
          {run.status === "failed" ? (
            <p className="form-error">{run.output}</p>
          ) : (
            <Markdown text={run.output} onOpenLink={openExternal} />
          )}
          {usage ? <p className="section-note">{usage}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function ActivityPage() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const [pair, setPair] = useState(snapshot.focus);
  const [budget, setBudget] = useState("250");
  const { watch } = snapshot;

  function runOnce(event: FormEvent) {
    event.preventDefault();
    void runPattern(pair, budget.trim());
  }

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Activity</h1>
        <p className="page-lead">
          Everything the agents have done, with the steps behind each result, and the pattern agent that can paper
          trade on its own.
        </p>

        <section className="section" aria-labelledby="pattern-title">
          <div className="section-head">
            <h2 id="pattern-title" className="section-title">
              Pattern agent
            </h2>
            <span className="section-note">Paper account only</span>
          </div>
          <div className="section-body">
            <p className="section-text">
              It compares the last three daily moves with five earlier stretches that looked the same. When at least
              four of them agree it places one paper trade, never larger than the limit you set, and never on a live
              account.
            </p>
            <form className="pattern-form" onSubmit={runOnce}>
              <label className="field">
                <span className="field-label">Instrument</span>
                <select className="input" value={pair} onChange={(event) => setPair(event.target.value)}>
                  {snapshot.instruments.map((instrument) => (
                    <option key={instrument.pair} value={instrument.pair}>
                      {instrument.ticker} / USDT
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Largest trade, in USDT</span>
                <input
                  className="input"
                  inputMode="decimal"
                  required
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
              </label>
              <div className="actions">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Run once
                </button>
                {watch ? (
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void stopWatch()}>
                    Stop watching
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void startWatch(pair, budget.trim())}
                  >
                    Watch every 15 min
                  </button>
                )}
              </div>
            </form>
            <div className="pattern-status" role="status">
              {watch ? (
                <>
                  <span className="tag tag-ring">Watching</span>
                  <span>
                    {watch.pair} on the {watch.feed === "sample" ? "sample tape" : `${feedName(watch.feed)} feed`}, up
                    to {watch.budget} USDT a trade. It runs while Octo Gens is open.
                  </span>
                </>
              ) : (
                <span>Not watching anything right now.</span>
              )}
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="journal-title">
          <div className="section-head">
            <h2 id="journal-title" className="section-title">
              Run journal
            </h2>
            <span className="section-note">
              {snapshot.runs.length > 0 ? `${plural(snapshot.runs.length, "run")}, newest first` : ""}
            </span>
          </div>
          {snapshot.runs.length === 0 ? (
            <p className="empty">
              Nothing has run yet. Ask the assistant a question and the steps it took will be recorded here.
            </p>
          ) : (
            <ul>
              {snapshot.runs.map((run) => (
                <JournalRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
