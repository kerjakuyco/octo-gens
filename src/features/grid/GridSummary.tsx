import type { GridBotView } from "../../api/types";
import { direction as tone, money, signedMoney } from "../../lib/format";
import { summarizeGrids } from "../../lib/grid";

interface GridSummaryProps {
  bots: GridBotView[];
  /** Free margin on the active network, when the account is read. */
  available: number | null;
}

/** Four figures across every bot on the active network. */
export function GridSummary({ bots, available }: GridSummaryProps) {
  const sum = summarizeGrids(bots);
  const working = sum.runningCount + sum.waitingCount;
  return (
    <section className="gb-summary" aria-label="All bots">
      <div className="gb-tile">
        <span className="gb-tile-label">Running</span>
        <span className="gb-tile-value num">{working}</span>
        <span className="gb-tile-sub">
          {sum.waitingCount > 0 ? `${sum.waitingCount} waiting to start` : working === 1 ? "bot at work" : "bots at work"}
        </span>
      </div>
      <div className="gb-tile">
        <span className="gb-tile-label">Margin in use</span>
        <span className="gb-tile-value num">
          {money(sum.activeMargin)} <small>USDT</small>
        </span>
        <span className="gb-tile-sub num">{available !== null ? `${money(available)} USDT free` : "Account not read"}</span>
      </div>
      <div className="gb-tile">
        <span className="gb-tile-label">Profit and loss</span>
        <span className={`gb-tile-value num ${tone(sum.totalPnl)}`}>
          {signedMoney(sum.totalPnl)} <small>USDT</small>
        </span>
        <span className="gb-tile-sub num">
          {signedMoney(sum.totalRealizedPnl)} made · {signedMoney(sum.totalUnrealizedPnl)} open
        </span>
      </div>
      <div className="gb-tile">
        <span className="gb-tile-label">Completed trades</span>
        <span className="gb-tile-value num">{sum.totalMatchedTrades}</span>
        <span className="gb-tile-sub">each a buy and its sell</span>
      </div>
    </section>
  );
}
