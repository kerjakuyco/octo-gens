import type { StepView } from "../api/types";
import { duration } from "../lib/format";
import { stepLabel } from "../lib/steps";
import { Icon } from "./Icon";

/** The steps behind an answer or an order: what was called, with what, and what came back. */
export function StepList({ steps }: { steps: StepView[] }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={index} className="step" data-status={step.status}>
          <span className="step-mark">
            {step.status === "running" ? (
              <span className="spinner" />
            ) : (
              <Icon name={step.status === "ok" ? "check" : "alert"} size={14} />
            )}
          </span>
          <span className="step-body">
            <span className="step-head">
              <span className="step-name">{stepLabel(step.name)}</span>
              <span className="muted truncate">{step.detail}</span>
              {step.status === "running" ? null : <span className="step-time num">{duration(step.ms)}</span>}
            </span>
            {step.preview ? <span className="step-preview">{step.preview}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
