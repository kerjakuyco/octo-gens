import { useId } from "react";
import type { AccountView, Snapshot } from "../../api/types";
import { balance, dayDate } from "../../lib/format";
import { activeWallet } from "../../lib/market";
import { networkName } from "../../lib/network";
import { fundWallet, openSettings } from "../../state/app";
import { marginMode } from "./labels";

interface BalancesSectionProps {
  snapshot: Snapshot;
  account: AccountView;
  busy: boolean;
  waiting: boolean;
}

/** What backs the account, asset by asset, and the wallet and key behind it. */
export function BalancesSection({ snapshot, account, busy, waiting }: BalancesSectionProps) {
  const titleId = useId();
  const captionId = useId();
  const wallet = activeWallet(snapshot);
  const { network, risk } = snapshot;
  const held = account.balances.filter((row) => Number(row.balance) !== 0 || Number(row.available) !== 0);

  return (
    <section className="ac-section" aria-labelledby={titleId}>
      <div className="ac-section-head">
        <h2 id={titleId} className="ac-section-title">
          Balances <span className="ac-count num">{held.length}</span>
        </h2>
      </div>

      <div className="ac-balances">
        {held.length === 0 ? (
          <div className="ac-empty">
            <p>Nothing is held on {networkName(network)} yet.</p>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy || waiting}
              onClick={() => void fundWallet({ network, task: "deposit" })}
            >
              Deposit
            </button>
          </div>
        ) : (
          <div className="table-wrap ac-table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
            <table className="table ac-table">
              <caption id={captionId} className="visually-hidden">
                Balances by asset
              </caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="num">
                    Balance
                  </th>
                  <th scope="col" className="num">
                    Free
                  </th>
                  <th scope="col" className="num">
                    In use
                  </th>
                </tr>
              </thead>
              <tbody>
                {held.map((row) => {
                  const total = Number(row.balance);
                  const free = Number(row.available);
                  const locked = Math.max(0, total - free);
                  const share = total > 0 ? Math.min(100, (locked / total) * 100) : 0;
                  return (
                    <tr key={row.asset}>
                      <th scope="row">
                        <span className="cell-main">{row.asset}</span>
                      </th>
                      <td className="num">{balance(row.balance)}</td>
                      <td className="num">{balance(row.available)}</td>
                      <td className="num">
                        <span className="cell-main">{balance(locked.toFixed(2))}</span>
                        <span className="cell-sub">{share.toFixed(0)}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <aside className="ac-wallet-card" aria-label="Your wallet and the app's key">
          <h3 className="ac-wallet-card-title">Your wallet on {networkName(network)}</h3>
          <dl className="ac-wallet-card-facts">
            <div>
              <dt>Wallet</dt>
              <dd className="mono">{wallet.user ?? "—"}</dd>
            </div>
            <div>
              <dt>The app's trade-only key</dt>
              <dd className="mono">{wallet.agent ?? "—"}</dd>
            </div>
            <div>
              <dt>Approved until</dt>
              <dd>{wallet.expires ? dayDate(wallet.expires) : "Set on the exchange"}</dd>
            </div>
            <div>
              <dt>New positions</dt>
              <dd>
                {marginMode(account, risk)}, up to {risk.maxLeverage}x
              </dd>
            </div>
          </dl>
          <p className="ac-wallet-card-note">
            Your wallet signs every deposit and withdrawal. The app signs orders with a key that cannot withdraw.
          </p>
          <div className="ac-wallet-card-actions">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy || waiting}
              onClick={() => void fundWallet({ network, task: "deposit" })}
            >
              Deposit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy || waiting}
              onClick={() => void fundWallet({ network, task: "withdraw" })}
            >
              Withdraw
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openSettings("wallet")}>
              Manage wallets
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
