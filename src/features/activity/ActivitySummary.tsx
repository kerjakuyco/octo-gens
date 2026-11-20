import { direction, signedMoney } from "../../lib/format";
import { type JournalMetrics, setupLabel } from "../../lib/journal";

/** Four figures from the trades the journal holds on the networks in view. */
export function ActivitySummary({ metrics }: { metrics: JournalMetrics }) {
  const { closedCount, winCount, lossCount, breakevenCount, bestSetup } = metrics;
  const record = [`${winCount} won`, `${lossCount} lost`, ...(breakevenCount > 0 ? [`${breakevenCount} even`] : [])].join(
    " · ",
  );

  return (
    <section className="av-summary" aria-label="Your trading at a glance">
      <div className="av-tile">
        <span className="av-tile-label">Profit and loss</span>
        <span className={`av-tile-value num ${direction(metrics.netPnlUsd)}`}>
          {signedMoney(metrics.netPnlUsd.toFixed(2))} <small>USDT</small>
        </span>
        <span className="av-tile-sub">
          {closedCount > 0 ? `from ${closedCount} closed trade${closedCount === 1 ? "" : "s"}` : "Log a closed trade to see it"}
        </span>
      </div>
      <div className="av-tile">
        <span className="av-tile-label">Win rate</span>
        <span className="av-tile-value num">
          {metrics.winRatePct !== null ? `${metrics.winRatePct.toFixed(1)}%` : "—"}
        </span>
        <span className="av-tile-sub num">{closedCount > 0 ? record : "No wins or losses yet"}</span>
      </div>
      <div className="av-tile">
        <span className="av-tile-label">Kept to the plan</span>
        <span className="av-tile-value num">{metrics.totalCount > 0 ? `${metrics.disciplinePct.toFixed(0)}%` : "—"}</span>
        <span className="av-tile-sub">
          {metrics.totalCount > 0
            ? `of the checklist, over ${metrics.totalCount} trade${metrics.totalCount === 1 ? "" : "s"}`
            : "Stop, size and plan, ticked per trade"}
        </span>
      </div>
      <div className="av-tile">
        <span className="av-tile-label">Best setup</span>
        <span className="av-tile-value av-tile-text">{bestSetup ? setupLabel(bestSetup.setup) : "—"}</span>
        <span className="av-tile-sub num">
          {bestSetup
            ? `${signedMoney(bestSetup.netPnlUsd.toFixed(2))} USDT · won ${bestSetup.wins} of ${bestSetup.closed}`
            : "Shows once a trade closes"}
        </span>
      </div>
    </section>
  );
}
