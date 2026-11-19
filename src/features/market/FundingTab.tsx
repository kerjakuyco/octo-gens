import type { FundingPoint, FundingView } from "../../api/types";
import { useNow } from "../../lib/clock";
import { compact, countdown, dayTime, direction, fundingRate, percent } from "../../lib/format";
import type { Polled } from "../../lib/hooks";

const WIDTH = 368;
const HEIGHT = 84;
const GAP = 2;
const EDGE = 2;

/** Settled funding rates as bars around zero: above the line longs paid, below it shorts did. */
function FundingChart({ history }: { history: FundingPoint[] }) {
  if (history.length === 0) return null;
  const rates = history.map(([, rate]) => rate);
  // Zero sits where the range puts it: at the foot when every rate was positive, in between when both signs occur.
  const top = Math.max(0, ...rates);
  const bottom = Math.min(0, ...rates);
  const span = top - bottom || 1;
  const scale = (HEIGHT - 2 * EDGE) / span;
  const zero = EDGE + top * scale;
  const slot = WIDTH / history.length;
  const first = history[0]!;
  const latest = history[history.length - 1]!;
  return (
    <figure className="funding-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="Funding rate history">
        <line className="funding-zero" x1="0" x2={WIDTH} y1={zero} y2={zero} />
        {history.map(([time, rate], index) => {
          const tall = Math.max(1, Math.abs(rate) * scale);
          return (
            <rect
              key={time}
              className={rate >= 0 ? "funding-bar-up" : "funding-bar-down"}
              x={index * slot + GAP / 2}
              y={rate >= 0 ? zero - tall : zero}
              width={Math.max(1, slot - GAP)}
              height={tall}
              rx="1"
            >
              <title>{`${dayTime(time)}  ${fundingRate(rate)}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="funding-caption num">
        <span>{dayTime(first[0])}</span>
        <span>
          {fundingRate(bottom)} to {fundingRate(top)}
        </span>
        <span>{dayTime(latest[0])}</span>
      </figcaption>
    </figure>
  );
}

interface FundingTabProps {
  funding: Polled<FundingView>;
  base: string;
  quote: string;
}

/** What holding a position costs: the current rate, when it is next paid, and how it has moved. */
export function FundingTab({ funding, base, quote }: FundingTabProps) {
  const now = useNow();
  const view = funding.data;
  if (!view) {
    return funding.error ? (
      <p className="note" data-tone="error" role="alert">
        {funding.error}
      </p>
    ) : (
      <p className="panel-wait">
        <span className="spinner" />
      </p>
    );
  }
  const rate = view.ratePct;
  const paying = rate === null || rate === 0 ? "—" : rate > 0 ? "Longs pay" : "Shorts pay";

  return (
    <>
      <dl className="levels">
        <div className="fact">
          <dt>Rate</dt>
          <dd className={`num ${direction(rate)}`}>{fundingRate(rate)}</dd>
        </div>
        <div className="fact">
          <dt>Annualised</dt>
          <dd className="num">{percent(view.annualPct)}</dd>
        </div>
        <div className="fact">
          <dt>Next payment</dt>
          <dd className="num">{countdown(view.nextFunding, now)}</dd>
        </div>
      </dl>

      <FundingChart history={view.history} />

      <dl className="stats">
        <div className="stat">
          <dt>Interval</dt>
          <dd className="num">{view.intervalHours === null ? "—" : `${view.intervalHours}h`}</dd>
        </div>
        <div className="stat">
          <dt>Direction</dt>
          <dd>{paying}</dd>
        </div>
        <div className="stat">
          <dt>Open interest</dt>
          <dd className="num">
            {compact(view.openInterest)} {base}
          </dd>
        </div>
        <div className="stat">
          <dt>Value</dt>
          <dd className="num">
            {compact(view.openInterestValue)} {quote}
          </dd>
        </div>
      </dl>
    </>
  );
}
