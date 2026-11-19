import type { TechnicalsView, Timeframe } from "../../api/types";
import { percent, price } from "../../lib/format";
import type { Polled } from "../../lib/hooks";
import { RsiBar, TrendChip, macdWords } from "./Readings";

interface LevelsProps {
  label: string;
  levels: number[];
  /** The current price, to show how far away each level is. */
  from: number;
}

function Levels({ label, levels, from }: LevelsProps) {
  return (
    <div className="level-group">
      <dt>{label}</dt>
      {levels.length === 0 ? (
        <dd className="muted">None nearby</dd>
      ) : (
        levels.map((level) => (
          <dd key={level} className="num">
            <span>{price(level)}</span>
            <span className="muted">{from > 0 ? percent((level / from - 1) * 100) : ""}</span>
          </dd>
        ))
      )}
    </div>
  );
}

interface TechnicalsTabProps {
  technicals: Polled<TechnicalsView>;
  /** The chart's timeframe, whose levels are listed. */
  timeframe: Timeframe;
}

/** Trend, momentum and volatility on every timeframe, then the levels drawn on the chart. */
export function TechnicalsTab({ technicals, timeframe }: TechnicalsTabProps) {
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
            return (
              <tr key={item.timeframe} data-current={item.timeframe === timeframe}>
                <th scope="row">{item.timeframe}</th>
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
          <h3 className="panel-sub">
            Levels <span className="muted">{timeframe}</span>
          </h3>
          <dl className="level-list">
            <Levels label="Resistance" levels={frame.resistance} from={Number(view.price)} />
            <Levels label="Support" levels={frame.support} from={Number(view.price)} />
          </dl>
        </>
      ) : null}
    </>
  );
}
