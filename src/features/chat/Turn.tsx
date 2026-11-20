import { useState } from "react";
import type { RunView, UsageView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { StepList } from "../../components/StepList";
import { followUps } from "../../lib/commands";
import { count, duration, usd } from "../../lib/format";
import { useFlash } from "../../lib/hooks";
import { Markdown } from "../../lib/markdown";
import { modelName } from "../../lib/models";
import { activityNow, activitySummary } from "../../lib/steps";
import { type LiveTurn, ask, notify, openExternal, useApp, useSnapshot } from "../../state/app";
import { TicketCard } from "../market/TicketCard";
import { Card } from "./Cards";
import { GridDraftCard } from "./GridDraftCard";
import { Suggestions } from "./Suggestions";

function usageText(usage: UsageView): string {
  const tokens = `${count(usage.promptTokens)} in, ${count(usage.completionTokens)} out`;
  return usage.cost === null ? tokens : `${tokens}, ${usd(usage.cost)}`;
}

interface ActivityProps {
  run: RunView;
  running: boolean;
  /** The model is writing: text is arriving and no tool is at work. */
  writing: boolean;
  reasoning: string;
}

/** What the assistant did for this answer, in one line. Opens to the steps behind it. */
function Activity({ run, running, writing, reasoning }: ActivityProps) {
  const [open, setOpen] = useState(false);
  const { steps } = run;
  const done = activitySummary(steps);
  // While it writes, the line says what has been checked so far; otherwise what is being checked now.
  const summary = running && !writing ? activityNow(steps) : done;
  const hasDetail = steps.length > 0 || reasoning !== "";
  if (running ? writing && !done : !hasDetail) return null;
  const problem = !running && steps.some((step) => step.status === "error");

  return (
    <div className="activity">
      <button
        type="button"
        className="activity-line"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
      >
        {problem ? <Icon name="alert" size={15} /> : null}
        <span className="activity-text truncate" data-running={running && !writing}>
          {summary || "Thought it through"}
        </span>
        {running ? null : <span className="activity-time num">{duration(run.ms)}</span>}
        {hasDetail ? <Icon name="chevron" size={14} /> : null}
      </button>
      {open ? (
        <div className="activity-detail">
          {reasoning ? <p className="reasoning">{reasoning}</p> : null}
          {steps.length > 0 ? <StepList steps={steps} /> : null}
          {running ? null : (
            <p className="activity-meta num">
              {[run.model ? modelName(run.model) : "", run.usage ? usageText(run.usage) : ""].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Actions({ run }: { run: RunView }) {
  const busy = useApp((state) => state.live !== null);
  const [copied, flash] = useFlash();

  async function copy() {
    try {
      await navigator.clipboard.writeText(run.output);
      flash();
    } catch {
      notify("Copying is blocked here. Select the text instead.", "error");
    }
  }

  return (
    <div className="turn-actions">
      {run.status === "complete" && run.output ? (
        <button type="button" className="icon-btn" aria-label={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
          <Icon name={copied ? "check" : "copy"} size={16} />
        </button>
      ) : null}
      <button type="button" className="icon-btn" aria-label="Retry" disabled={busy} onClick={() => void ask(run.title)}>
        <Icon name="refresh" size={16} />
      </button>
    </div>
  );
}

interface TurnProps {
  run: RunView;
  /** Set while this turn is the one being streamed. */
  live: LiveTurn | null;
  /** The newest turn of the conversation. */
  latest: boolean;
}

/** What to do next, under the newest answer once it is done. Hidden while any answer is being written. */
function FollowUps({ run }: { run: RunView }) {
  const snapshot = useSnapshot();
  const answering = useApp((state) => state.live !== null);
  if (answering || snapshot.busy) return null;
  return <Suggestions items={followUps(run, snapshot)} label="Follow-ups" variant="follow" />;
}

/** One exchange: the trader's message, then what the assistant did, saw and said. */
export function Turn({ run, live, latest }: TurnProps) {
  const network = useSnapshot().network;
  // The account card shows the account as it is now. Under an earlier answer, or one given on the other
  // network, that would read as what the assistant saw then, so it is shown with the newest answer only.
  const cards = run.cards.filter((card) => card.kind !== "account" || (latest && run.network === network));
  const running = live !== null && run.status === "running";
  const text = running ? (live?.text ?? "") : run.output;
  const failed = run.status === "failed";
  const toolAtWork = run.steps.some((step) => step.status === "running" && step.name !== "model");

  return (
    <article className="turn" data-live={running} data-latest={latest}>
      <div className="said">
        <p className="bubble">{run.title}</p>
      </div>
      <div className="answer" aria-busy={running}>
        <Activity
          run={run}
          running={running}
          writing={running && text !== "" && !toolAtWork}
          reasoning={live ? live.reasoning : run.reasoning}
        />
        {cards.length > 0 ? (
          <div className="cards">
            {cards.map((card, index) => (
              <Card key={index} card={card} />
            ))}
          </div>
        ) : null}
        {failed ? (
          <p className="note" data-tone="error" role="alert">
            {run.output}
          </p>
        ) : text ? (
          <Markdown text={text} streaming={running} onOpenLink={openExternal} />
        ) : null}
        {run.status === "stopped" ? <p className="turn-stopped">Stopped</p> : null}
        {run.ticket ? <TicketCard ticket={run.ticket} /> : null}
        {run.grid ? <GridDraftCard draft={run.grid} /> : null}
        {running ? null : <Actions run={run} />}
        {latest && !running ? <FollowUps run={run} /> : null}
      </div>
    </article>
  );
}
