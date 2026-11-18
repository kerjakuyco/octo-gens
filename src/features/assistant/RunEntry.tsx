import { useId, useState } from "react";
import type { RunView } from "../../api/types";
import { BrandMark } from "../../components/BrandMark";
import { Icon } from "../../components/Icon";
import { clock, count, duration, plural, usd } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { ask, openExternal, useApp } from "../../state/app";
import { TicketCard } from "../market/TicketCard";
import { StepTrace } from "./StepTrace";

export function usageText(run: RunView): string {
  if (!run.usage) return "";
  const { promptTokens, completionTokens, cost } = run.usage;
  const spend = cost === null ? "" : `, ${usd(cost)}`;
  return `${count(promptTokens)} tokens in, ${count(completionTokens)} out${spend}`;
}

/** One finished turn: the question, the answer, and how the answer was produced. */
export function RunEntry({ run }: { run: RunView }) {
  const [traceOpen, setTraceOpen] = useState(false);
  const traceId = useId();
  const busy = useApp((state) => Boolean(state.live));
  const usage = usageText(run);

  return (
    <article className="turn">
      <header className="turn-head">
        <h2 className="turn-question">{run.title}</h2>
        <time className="turn-time" dateTime={run.time}>
          {clock(run.time)}
        </time>
      </header>

      <div className="turn-byline">
        <BrandMark size={14} />
        <span className="turn-agent">{run.agent || "Assistant"}</span>
        {run.model ? <span className="turn-model">{run.model}</span> : null}
      </div>

      {run.status === "failed" ? (
        <div className="turn-problem" role="alert">
          <div className="turn-problem-title">This run failed</div>
          <div>{run.output || "No reason was reported."}</div>
          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void ask(run.title)}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {run.output ? <Markdown text={run.output} onOpenLink={openExternal} /> : null}
          {run.status === "stopped" ? (
            <div className="turn-stopped">
              <span>You stopped this before it finished.</span>
              <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void ask(run.title)}>
                Ask again
              </button>
            </div>
          ) : null}
        </>
      )}

      {run.ticket ? <TicketCard ticket={run.ticket} /> : null}

      <footer className="turn-foot">
        {run.steps.length > 0 ? (
          <button
            type="button"
            className="disclosure"
            aria-expanded={traceOpen}
            aria-controls={traceId}
            onClick={() => setTraceOpen((open) => !open)}
          >
            <Icon name="chevron" size={14} />
            {plural(run.steps.length, "step")}, {duration(run.ms)}
          </button>
        ) : (
          <span>{duration(run.ms)}</span>
        )}
        {usage ? <span>{usage}</span> : null}
      </footer>

      {traceOpen ? (
        <div id={traceId}>
          <StepTrace steps={run.steps} />
          {run.reasoning ? (
            <p className="thinking">
              <span className="thinking-label">Reasoning</span>
              <span>{run.reasoning}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
