import type { AccountView, GridBotView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { direction as tone, money, plural, signedMoney } from "../../lib/format";
import { summarizeGrids } from "../../lib/grid";
import type { PortfolioAnalytics } from "../../lib/portfolio";
import { openGrid } from "../../state/app";
import { MARGIN_USE, exposureLabel, fundingText } from "./labels";

interface AccountSummaryProps {
  account: AccountView;
  analytics: PortfolioAnalytics;
}

/** Four figures that say how the account stands: what it is worth, what is free, which way it leans, and funding. */
export function AccountSummary({ account, analytics }: AccountSummaryProps) {
  const use = MARGIN_USE[analytics.health];
  const used = Math.min(100, Math.max(0, analytics.marginRatioPct));
  const lean = exposureLabel(analytics.netBias, account.positions.length);
  const longPct = analytics.grossNotional > 0 ? analytics.longSharePct : 50;
  const funding = fundingText(account.positions.length > 0 ? analytics.estFunding8hUsd : null);
  const positions = account.positions.length;

  return (
    <section className="ac-summary" aria-label="The account at a glance">
      <div className="ac-tile">
        <span className="ac-tile-label">Equity</span>
        <span className="ac-tile-value num">
          {money(account.equity)} <small>USDT</small>
        </span>
        <span className="ac-tile-sub num">
          Balance {money(account.walletBalance)} · open{" "}
          <span className={tone(account.unrealizedPnl)}>{signedMoney(account.unrealizedPnl)}</span>
        </span>
      </div>

      <div className="ac-tile">
        <span className="ac-tile-label">
          Free margin
          <span className="chip" data-tone={use.tone}>
            {use.label}
          </span>
        </span>
        <span className="ac-tile-value num">
          {money(account.available)} <small>USDT</small>
        </span>
        <div
          className="ac-meter"
          role="meter"
          aria-label="Margin in use"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
        >
          <span className="ac-meter-fill" data-tone={use.tone} style={{ width: `${used.toFixed(1)}%` }} />
        </div>
        <span className="ac-tile-sub num">
          {money(account.marginUsed)} in use · {analytics.marginRatioPct.toFixed(0)}%
        </span>
      </div>

      <div className="ac-tile">
        <span className="ac-tile-label">
          Exposure
          <span className="chip" data-tone={lean.tone}>
            {lean.label}
          </span>
        </span>
        <span className="ac-tile-value num">
          {money(analytics.grossNotional.toFixed(2))} <small>USDT</small>
        </span>
        <div className="ac-lean" aria-hidden="true">
          {positions > 0 ? (
            <>
              <span className="ac-lean-long" style={{ width: `${longPct.toFixed(1)}%` }} />
              <span className="ac-lean-short" style={{ width: `${(100 - longPct).toFixed(1)}%` }} />
            </>
          ) : null}
        </div>
        <span className="ac-tile-sub num">
          <span className="up">Long {money(analytics.longNotional.toFixed(0))}</span> ·{" "}
          <span className="down">Short {money(analytics.shortNotional.toFixed(0))}</span>
        </span>
      </div>

      <div className="ac-tile">
        <span className="ac-tile-label">Funding, next 8 hours</span>
        <span className={`ac-tile-value num ${funding.tone === "up" ? "up" : funding.tone === "down" ? "down" : ""}`}>
          {funding.amount} <small>USDT</small>
        </span>
        <span className="ac-tile-sub">{funding.words}</span>
        <span className="ac-tile-sub">
          {positions === 0
            ? "No positions to protect"
            : `${analytics.protectedCount} of ${plural(positions, "position")} with a stop-loss`}
        </span>
      </div>
    </section>
  );
}

/** One line on the grid bots of this network, with the way to them. */
export function GridBotsLine({ bots }: { bots: GridBotView[] }) {
  const sum = summarizeGrids(bots);
  const working = sum.runningCount + sum.waitingCount;
  return (
    <section className="ac-bots" aria-label="Grid bots">
      <span className="ac-bots-icon" aria-hidden="true">
        <Icon name="grid" size={16} />
      </span>
      <p className="ac-bots-text num">
        {working > 0 ? (
          <>
            <strong>{plural(working, "grid bot")} at work</strong>
            <span className="muted"> · {money(sum.activeMargin)} USDT of margin · </span>
            <span className={tone(sum.totalPnl)}>{signedMoney(sum.totalPnl)} USDT</span>
            <span className="muted"> so far</span>
          </>
        ) : (
          <span className="muted">
            {sum.stoppedCount > 0 ? "No grid bot is running." : "No grid bot yet."} A bot buys low and sells high inside a
            price range.
          </span>
        )}
      </p>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => openGrid()}>
        {working > 0 ? "Open grid bots" : "Set one up"}
        <Icon name="chevron" size={14} />
      </button>
    </section>
  );
}
