import type { StepView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { duration } from "../../lib/format";

/** What the assistant did, in order: each tool call or stage with its outcome. */
export function StepTrace({ steps }: { steps: StepView[] }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={index} className="step">
          <span className="step-status" data-status={step.status}>
            {step.status === "running" ? (
              <span className="ring-spin" role="img" aria-label="Running" />
            ) : (
              <>
                <Icon name={step.status === "ok" ? "check" : "close"} size={14} />
                <span className="visually-hidden">{step.status === "ok" ? "Done" : "Failed"}</span>
              </>
            )}
          </span>
          <span className="step-line">
            <span className="step-name">{step.name}</span>
            {step.detail ? <span className="step-detail">{step.detail}</span> : null}
          </span>
          <span className="step-ms">{step.status === "running" ? "" : duration(step.ms)}</span>
          {step.preview ? <span className="step-preview">{step.preview}</span> : null}
        </li>
      ))}
    </ol>
  );
}
