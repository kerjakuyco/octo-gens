import { clock } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { type LiveTurn, openExternal } from "../../state/app";
import { TicketCard } from "../market/TicketCard";
import { StepTrace } from "./StepTrace";

const TAIL = 120;

/** The end of the reasoning stream, on one line. */
function reasoningTail(reasoning: string): string {
  const text = reasoning.replace(/\s+/g, " ").trim();
  return text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
}

/** The turn that is being streamed right now. */
export function LiveTurnView({ live }: { live: LiveTurn }) {
  const { run, text, reasoning } = live;
  const quiet = run.steps.length === 0 && !reasoning && !text;

  return (
    <article className="turn" aria-busy="true">
      <header className="turn-head">
        <h2 className="turn-question">{run.title}</h2>
        <time className="turn-time" dateTime={run.time}>
          {clock(run.time)}
        </time>
      </header>

      <div className="turn-byline" role="status">
        <span className="ring-spin" />
        <span className="turn-agent">{run.agent || "Assistant"}</span>
        <span className="visually-hidden">is working</span>
        {run.model ? <span className="turn-model">{run.model}</span> : null}
      </div>

      {run.steps.length > 0 ? <StepTrace steps={run.steps} /> : null}
      {reasoning && !text ? (
        <p className="thinking">
          <span className="thinking-label">Thinking</span>
          <span className="thinking-text">{reasoningTail(reasoning)}</span>
        </p>
      ) : null}
      {quiet ? <p className="muted">Reading your request.</p> : null}
      {text ? <Markdown text={text} streaming onOpenLink={openExternal} /> : null}
      {run.ticket ? <TicketCard ticket={run.ticket} /> : null}
    </article>
  );
}
