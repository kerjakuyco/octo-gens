import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { GridBotView, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { plural } from "../../lib/format";
import { computeJournalMetrics, openJournalComposer, useJournal } from "../../lib/journal";
import { activeWallet } from "../../lib/market";
import { networkName } from "../../lib/network";
import { computePortfolioAnalytics, enrichOrders, enrichPositions } from "../../lib/portfolio";
import {
  fundWallet,
  navigate,
  openSettings,
  refreshAccount,
  reloadAccount,
  stopGrid,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { GridStopDialog } from "../grid/GridStopDialog";
import { AccountSummary, GridBotsLine } from "./AccountSummary";
import { BalancesSection } from "./BalancesSection";
import { type BotOrderTarget, BotOrderDialog, type MarketTarget, MarketCancelDialog } from "./CancelDialogs";
import { OrdersSection } from "./OrdersSection";
import { PositionsSection } from "./PositionsSection";
import { WalletBar } from "./WalletBar";

/** The journal in one line, with the way to it: the journal itself lives on the Activity page. */
function JournalLine({ snapshot }: { snapshot: Snapshot }) {
  const { entries } = useJournal();
  const metrics = useMemo(() => computeJournalMetrics(entries, snapshot.network), [entries, snapshot.network]);
  const count = entries.filter((entry) => entry.network === snapshot.network).length;
  return (
    <section className="ac-journal" aria-label="Trading journal">
      <span className="ac-bots-icon" aria-hidden="true">
        <Icon name="journal" size={16} />
      </span>
      <p className="ac-bots-text num">
        {count > 0 ? (
          <>
            <strong>{plural(count, "journal entry", "journal entries")}</strong>
            <span className="muted">
              {" "}
              on {networkName(snapshot.network)}
              {metrics.winRatePct !== null ? ` · ${metrics.winRatePct.toFixed(0)}% of closed trades won` : ""}
            </span>
          </>
        ) : (
          <span className="muted">Your trading journal is empty. Log a trade to see your win rate and best setup.</span>
        )}
      </p>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          openJournalComposer({ network: snapshot.network, symbol: snapshot.focus });
          navigate("activity");
        }}
      >
        Log a trade
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("activity")}>
        Open the journal
        <Icon name="chevron" size={14} />
      </button>
    </section>
  );
}

/** A page-wide state with one thing to do about it: no wallet, no deposit, still reading, or a failed read. */
function AccountState({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="ac-state">
      <h2 className="ac-state-title">{title}</h2>
      {text ? <p className="ac-state-text">{text}</p> : null}
      {children ? <div className="ac-empty-actions">{children}</div> : null}
    </div>
  );
}

/**
 * The account on the active network: whose it is, how it stands, its positions and the orders waiting on
 * the exchange (a grid bot's marked as its own), and what backs it.
 */
export function AccountPage() {
  const snapshot = useSnapshot();
  const busy = useBusy();
  const wallet = activeWallet(snapshot);
  const { account, accountError, network } = snapshot;
  const waiting = snapshot.pendingWallet !== null;

  const [botOrder, setBotOrder] = useState<BotOrderTarget | null>(null);
  const [marketCancel, setMarketCancel] = useState<MarketTarget | null>(null);
  const [stopping, setStopping] = useState<GridBotView | null>(null);

  useEffect(() => {
    void refreshAccount();
  }, [network]);

  const positions = useMemo(() => enrichPositions(snapshot), [snapshot]);
  const orders = useMemo(() => enrichOrders(snapshot), [snapshot]);
  const analytics = useMemo(() => computePortfolioAnalytics(snapshot, positions), [snapshot, positions]);

  function stopInstead(bot: GridBotView) {
    setBotOrder(null);
    setMarketCancel(null);
    setStopping(bot);
  }

  const refresh = (
    <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void reloadAccount()}>
      <Icon name="refresh" size={14} />
      Try again
    </button>
  );

  let body;
  if (!wallet.connected) {
    body = (
      <AccountState
        title={`No wallet on ${networkName(network)}`}
        text="Connect a wallet to see your account here: what it is worth, your positions, the orders waiting on the exchange, and your grid bots."
      >
        <button type="button" className="btn btn-primary" onClick={() => openSettings("wallet")}>
          <Icon name="wallet" size={15} />
          Connect a wallet
        </button>
      </AccountState>
    );
  } else if (wallet.needsDeposit) {
    body = (
      <AccountState
        title="Your account opens with a first deposit"
        text={`The exchange shows an account on ${networkName(network)} only after the wallet's first deposit. Your wallet confirms it in the browser.`}
      >
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || waiting}
          onClick={() => void fundWallet({ network, task: "deposit" })}
        >
          Deposit
        </button>
        {refresh}
      </AccountState>
    );
  } else if (!account) {
    body = accountError ? (
      <AccountState title="The account could not be read">
        <p className="note" data-tone="error" role="alert">
          {accountError}
        </p>
        {refresh}
      </AccountState>
    ) : (
      <div className="ac-state" aria-busy="true">
        <span className="spinner" />
        <p className="ac-state-text">Reading the account</p>
      </div>
    );
  } else {
    body = (
      <>
        <WalletBar snapshot={snapshot} account={account} busy={busy} waiting={waiting} />
        {accountError ? (
          <p className="note" data-tone="error" role="alert">
            {accountError}
          </p>
        ) : null}
        {account.multiAssets ? (
          <p className="ac-note">
            Multi-Assets mode is on for this account: every asset backs every position, so new positions use cross
            margin whatever Settings say.
          </p>
        ) : null}
        <AccountSummary account={account} analytics={analytics} />
        <GridBotsLine bots={snapshot.grids} />
        <PositionsSection
          items={positions}
          bots={snapshot.grids}
          network={network}
          assistant={snapshot.assistant.ready}
          busy={busy}
        />
        <OrdersSection
          items={orders}
          bots={snapshot.grids}
          busy={busy}
          onCancelBotOrder={setBotOrder}
          onCancelMarket={setMarketCancel}
        />
        <BalancesSection snapshot={snapshot} account={account} busy={busy} waiting={waiting} />
        <JournalLine snapshot={snapshot} />
      </>
    );
  }

  return (
    <div className="page">
      <div className="page-inner ac-page">{body}</div>
      <BotOrderDialog target={botOrder} busy={busy} onClose={() => setBotOrder(null)} onStopBot={stopInstead} />
      <MarketCancelDialog
        key={`market:${marketCancel?.symbol ?? ""}`}
        target={marketCancel}
        busy={busy}
        onClose={() => setMarketCancel(null)}
        onStopBot={stopInstead}
      />
      <GridStopDialog
        key={`stop:${stopping?.id ?? ""}`}
        bot={stopping}
        busy={busy}
        onClose={() => setStopping(null)}
        onStop={(bot, closePosition) =>
          void stopGrid(bot.id, closePosition).then((done) => {
            if (done) setStopping(null);
          })
        }
      />
    </div>
  );
}
