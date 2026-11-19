import { useState } from "react";
import type { RunView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { StepList } from "../../components/StepList";
import { dayTime } from "../../lib/format";
import { networkName } from "../../lib/network";
import { useSnapshot } from "../../state/app";

const STATUS: Record<RunView["status"], { label: string; tone?: "up" | "down" | "warn" }> = {
  complete: { label: "Done", tone: "up" },
  failed: { label: "Failed", tone: "down" },
  stopped: { label: "Stopped", tone: "warn" },
  running: { label: "Running" },
};

function Entry({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[run.status];
  return (
    <li className="entry">
      <button type="button" className="entry-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="entry-time num">{dayTime(run.time)}</span>
        <span className="grow entry-title">{run.title}</span>
        {run.agent === "Execution" ? null : <span className="chip">{run.agent}</span>}
        <span className="chip">{networkName(run.network)}</span>
        <span className="chip" data-tone={status.tone}>
          {status.label}
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open ? (
        <div className="entry-body">
          <p className={run.status === "failed" ? "entry-output down" : "entry-output"}>{run.output}</p>
          {run.steps.length > 0 ? <StepList steps={run.steps} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** What the app did on the exchange for the trader: orders placed and orders cancelled. */
export function ActivityPage() {
  const { activity } = useSnapshot();
  return (
    <div className="page">
      <div className="page-inner">
        {activity.length === 0 ? (
          <p className="empty">No activity yet</p>
        ) : (
          <ul className="entries">
            {activity.map((run) => (
              <Entry key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
