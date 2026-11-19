import type { TechnicalsView, Timeframe } from "../../api/types";
import { percent, price } from "../../lib/format";
import type { Polled } from "../../lib/hooks";
import { RsiBar, TrendChip, macdWords } from "./Readings";

interface LevelsProps {
  label: string;
  kind: "support" | "resistance";
  levels: number[];
  /** The current price, to show how far away each level is. */
  from: number;
  onPickLevel?: (kind: "support" | "resistance", level: number) => void;
}

function Levels({ label, kind, levels, from, onPickLevel }: LevelsProps) {
  const hint = kind === "support" ? "SL" : "TP";
  const purpose = kind === "support" ? "stop-loss" : "take-profit";
  return (
    <div className="level-group">
      <dt>{label}</dt>
      {levels.length === 0 ? (
        <dd className="muted">None nearby</dd>
      ) : (
        levels.map((level) => {
          const text = price(level);
          const dist = from > 0 ? percent((level / from - 1) * 100) : "";
          return (
            <dd key={level} className="num">
              {onPickLevel ? (
                <button
                  type="button"
                  className="level-pick"
                  aria-label={`Use ${text} as ${purpose} in order form`}
                  onClick={() => onPickLevel(kind, level)}
                >
                  <span>{text}</span>
                  <span className="level-meta">
                    <span className="muted">{dist}</span>
                    <span className="level-hint" aria-hidden="true">
                      {hint}
                    </span>
                  </span>
                </button>
              ) : (
                <>
                  <span>{text}</span>
                  <span className="muted">{dist}</span>
                </>
              )}
            </dd>
          );
        })
      )}
    </div>
  );
}

interface TechnicalsTabProps {
  technicals: Polled<TechnicalsView>;
  /** The chart's timeframe, whose levels are listed. */
  timeframe: Timeframe;
  /** Switches the chart's timeframe when a row is chosen. */
  onSelectTimeframe?: (timeframe: Timeframe) => void;
  /** Prefills the manual order form from a clicked support or resistance level. */
  onPickLevel?: (kind: "support" | "resistance", level: number) => void;
}

/** Trend, momentum and volatility on every timeframe, then the levels drawn on the chart. */
export function TechnicalsTab({ technicals, timeframe, onSelectTimeframe, onPickLevel }: TechnicalsTabProps) {
  const view = technicals.data;
  if (!view) {
    return technicals.error ? (
      <p className="note" data-tone="error" role="alert">
        {technicals.error}
      </p>
    ) : (
      <p className="panel-wait">
        <span className="spinner" />
      </p>
    );
  }
  const frame = view.frames.find((item) => item.timeframe === timeframe);

  return (
    <>
      <table className="table tech-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Timeframe</span>
            </th>
            <th scope="col">Trend</th>
            <th scope="col">RSI</th>
            <th scope="col">MACD</th>
            <th scope="col" className="num">
              ATR
            </th>
          </tr>
        </thead>
        <tbody>
          {view.frames.map((item) => {
            const momentum = macdWords(item.macd);
            const active = item.timeframe === timeframe;
            return (
              <tr
                key={item.timeframe}
                data-current={active}
                onClick={onSelectTimeframe ? () => onSelectTimeframe(item.timeframe) : undefined}
              >
                <th scope="row">
                  {onSelectTimeframe ? (
                    <button
                      type="button"
                      className="tech-tf"
                      aria-pressed={active}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectTimeframe(item.timeframe);
                      }}
                    >
                      {item.timeframe}
                    </button>
                  ) : (
                    item.timeframe
                  )}
                </th>
                <td>
                  <TrendChip trend={item.trend} />
                </td>
                <td>
                  <RsiBar value={item.rsi14} />
                </td>
                <td className={momentum.tone}>{momentum.text}</td>
                <td className="num">{item.atrPct === null ? "—" : `${item.atrPct.toFixed(2)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {frame ? (
        <>
          <div className="levels-head">
            <h3 className="panel-sub">
              Levels <span className="muted">{timeframe}</span>
            </h3>
            {onPickLevel ? <span className="levels-tip">Click level to set SL / TP</span> : null}
          </div>
          <dl className="level-list">
            <Levels
              label="Resistance"
              kind="resistance"
              levels={frame.resistance}
              from={Number(view.price)}
              onPickLevel={onPickLevel}
            />
            <Levels
              label="Support"
              kind="support"
              levels={frame.support}
              from={Number(view.price)}
              onPickLevel={onPickLevel}
            />
          </dl>
        </>
      ) : null}
    </>
  );
}
