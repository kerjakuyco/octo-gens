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

const LEVERAGE_PRESETS = [2, 3, 5, 10, 20] as const;

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

  function pickPreset(value: number) {
    if (locked || risk.maxLeverage === value) return;
    setTyped(String(value));
    save("leverage", { maxLeverage: value }, () => setTyped((now) => (now === String(value) ? null : now)));
  }

  function pickMargin(next: Margin) {
    setPicked(next);
    save("margin", { isolated: next === "isolated" }, () => setPicked((now) => (now === next ? null : now)));
  }

  const leverageProblem = problem?.limit === "leverage" ? problem.text : "";
  const marginProblem = problem?.limit === "margin" ? problem.text : "";
  const activeLeverage = typed !== null ? Number(typed) : risk.maxLeverage;

  return (
    <div className="settings-stack">
      <section className="settings-section" aria-label="Order guardrails">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Order guardrails</h3>
          <span className="settings-section-hint">Applied immediately</span>
        </div>
        <div className="settings-card">
          <div className="settings-row settings-row-block">
            <div className="settings-row-top">
              <div className="settings-row-main">
                <label className="settings-row-title" htmlFor="max-leverage">
                  Max leverage
                </label>
                <span className="settings-row-desc">Caps every drafted or manual ticket (1–{LEVERAGE_CAP}x).</span>
              </div>
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
            </div>
            <div className="leverage-presets" role="group" aria-label="Quick leverage caps">
              {LEVERAGE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="preset-pill num"
                  aria-pressed={activeLeverage === preset}
                  disabled={locked}
                  onClick={() => pickPreset(preset)}
                >
                  {preset}x
                </button>
              ))}
            </div>
            {leverageProblem ? (
              <p id={noteId} className="form-error" role="alert">
                {leverageProblem}
              </p>
            ) : null}
          </div>

          <div className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-title">Margin for new positions</span>
              <span className="settings-row-desc">
                {crossOnly
                  ? "Multi-Assets mode requires cross margin."
                  : "Isolated limits risk per position; Cross shares account margin."}
              </span>
            </div>
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
        </div>
      </section>

      <section className="settings-section" aria-label="Assistant permissions">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Assistant permissions</h3>
        </div>
        <div className="settings-card">
          <label className="switch settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">
                Draft mainnet tickets
                <span className="chip" data-tone={assistant.liveTickets ? "warn" : undefined}>
                  {assistant.liveTickets ? "Mainnet enabled" : "Testnet only"}
                </span>
              </span>
              <span className="settings-row-desc">
                {assistant.ready
                  ? "Allows the assistant to draft real-money tickets. You still confirm every order."
                  : "Connect a model first to enable mainnet ticket drafts."}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
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
      </section>
    </div>
  );
}
