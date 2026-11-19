import { useEffect, useId, useRef, useState } from "react";
import type { RiskRequest } from "../../api/types";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { LEVERAGE_CAP, LEVERAGE_RULE, parseLeverage } from "../../lib/risk";
import { app, notify, saveAssistant, saveRisk, useBusy, useSnapshot } from "../../state/app";

type Margin = "isolated" | "cross";
type Limit = "leverage" | "margin";

const MARGINS: SegmentOption<Margin>[] = [
  { value: "isolated", label: "Isolated" },
  { value: "cross", label: "Cross" },
];

/**
 * Limits every ticket is held to, and whether the assistant may draft tickets
 * for real money. Each one applies as it is changed; there is nothing to save.
 */
export function TradingTab() {
  const { risk, assistant, account } = useSnapshot();
  // In the exchange's Multi-Assets mode a position can only be cross-margined, so there is nothing to choose.
  const crossOnly = account?.multiAssets === true;
  const busy = useBusy();
  const noteId = useId();
  // What is being typed, until it is saved or refused. Null shows the saved limit.
  const [typed, setTyped] = useState<string | null>(null);
  // The margin mode just picked, shown while it is saved.
  const [picked, setPicked] = useState<Margin | null>(null);
  const [problem, setProblem] = useState<{ limit: Limit; text: string } | null>(null);
  // Saves waiting or running. A second change made meanwhile is kept and sent after the first.
  const [saving, setSaving] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  // Something other than these limits is running, and the core would refuse a change.
  const locked = busy && saving === 0;

  /** Sends one changed limit, after any save already on its way. `settle` puts the control back on the saved value. */
  function save(limit: Limit, change: Partial<RiskRequest>, settle: () => void) {
    setProblem(null);
    setSaving((count) => count + 1);
    queue.current = queue.current.then(async () => {
      // Read here, not when the change was made: an earlier save may have moved the other limit.
      const before = app.get().snapshot?.risk;
      const wanted = before ? { ...before, ...change } : null;
      const differs = before && wanted && (wanted.maxLeverage !== before.maxLeverage || wanted.isolated !== before.isolated);
      const reason = wanted && differs ? await saveRisk(wanted) : "";
      if (!shown.current) {
        // Settings was closed meanwhile. A refusal still has to be seen.
        if (reason) notify(reason, "error");
        return;
      }
      setSaving((count) => count - 1);
      settle();
      if (reason) setProblem({ limit, text: reason });
    });
  }

  function commitLeverage() {
    if (typed === null || locked) return;
    const text = typed;
    const value = parseLeverage(text);
    if (value === null) {
      setProblem({ limit: "leverage", text: LEVERAGE_RULE });
      return;
    }
    // Typing may have gone on while this was saved; only what was sent is cleared.
    save("leverage", { maxLeverage: value }, () => setTyped((now) => (now === text ? null : now)));
  }

  function pickMargin(next: Margin) {
    setPicked(next);
    save("margin", { isolated: next === "isolated" }, () => setPicked((now) => (now === next ? null : now)));
  }

  const leverageProblem = problem?.limit === "leverage" ? problem.text : "";
  const marginProblem = problem?.limit === "margin" ? problem.text : "";

  return (
    <div className="rows">
      <div className="row">
        <label className="row-name" htmlFor="max-leverage">
          Max leverage
        </label>
        <span className="leverage-field">
          <input
            id="max-leverage"
            className="input num"
            type="number"
            inputMode="numeric"
            min={1}
            max={LEVERAGE_CAP}
            step={1}
            disabled={locked}
            aria-invalid={leverageProblem ? true : undefined}
            aria-describedby={leverageProblem ? noteId : undefined}
            value={typed ?? String(risk.maxLeverage)}
            onChange={(event) => {
              setTyped(event.target.value);
              if (leverageProblem) setProblem(null);
            }}
            onBlur={commitLeverage}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitLeverage();
            }}
          />
          <span className="leverage-unit" aria-hidden="true">
            x
          </span>
        </span>
        {leverageProblem ? (
          <p id={noteId} className="row-note form-error" role="alert">
            {leverageProblem}
          </p>
        ) : null}
      </div>

      <div className="row" data-lines={crossOnly ? 2 : undefined}>
        <span className="row-main">
          <span className="row-name">Margin for new positions</span>
          {crossOnly ? <span className="row-sub">Multi-Assets mode: cross only</span> : null}
        </span>
        <Segmented
          label="Margin for new positions"
          value={crossOnly ? "cross" : (picked ?? (risk.isolated ? "isolated" : "cross"))}
          options={MARGINS}
          disabled={crossOnly || locked}
          onChange={pickMargin}
        />
        {marginProblem ? (
          <p className="row-note form-error" role="alert">
            {marginProblem}
          </p>
        ) : null}
      </div>

      <label className="switch row" data-lines={2}>
        <span className="row-main">
          <span className="row-name">Let the assistant draft mainnet tickets</span>
          <span className="row-sub">{assistant.ready ? "You still confirm every order." : "Connect a model first."}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={assistant.liveTickets}
          disabled={busy || !assistant.ready}
          onChange={(event) =>
            void saveAssistant({
              provider: assistant.provider,
              model: assistant.model,
              effort: assistant.effort,
              liveTickets: event.target.checked,
            })
          }
        />
        <span className="switch-track" aria-hidden="true" />
      </label>
    </div>
  );
}
