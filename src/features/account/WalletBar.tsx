import type { AccountView, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { clock, dayDate, shortAddress } from "../../lib/format";
import { useFlash } from "../../lib/hooks";
import { activeWallet } from "../../lib/market";
import { fundWallet, notify, openSettings, openTrade, prefillComposer, reloadAccount } from "../../state/app";
import { marginMode } from "./labels";

interface WalletBarProps {
  snapshot: Snapshot;
  account: AccountView;
  busy: boolean;
  /** A wallet page is open in the browser, so another cannot start. */
  waiting: boolean;
}

/**
 * Whose account this is and on which network, how new positions are margined, and what can be done
 * with it: move funds, read it again, ask the assistant about it, or place an order.
 */
export function WalletBar({ snapshot, account, busy, waiting }: WalletBarProps) {
  const wallet = activeWallet(snapshot);
  const { network, risk } = snapshot;
  const mainnet = network === "mainnet";
  const [copied, flash] = useFlash();

  async function copy() {
    if (!wallet.user) return;
    try {
      await navigator.clipboard.writeText(wallet.user);
      flash();
    } catch {
      notify("Copying is blocked here. Select the address in Balances instead.", "error");
    }
  }

  return (
    <header className="ac-wallet">
      <div className="ac-wallet-id">
        <div className="ac-wallet-line">
          <span className="dot" data-tone="up" aria-hidden="true" />
          <span className="ac-wallet-label">Wallet</span>
          <span className="mono num" title={wallet.user ?? undefined}>
            {shortAddress(wallet.user)}
          </span>
          {wallet.user ? (
            <button
              type="button"
              className="icon-btn ac-copy"
              aria-label={copied ? "Address copied" : "Copy the wallet address"}
              title={copied ? "Copied" : "Copy address"}
              onClick={() => void copy()}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />
            </button>
          ) : null}
          <span className="chip" data-tone={mainnet ? "warn" : undefined}>
            {mainnet ? "Mainnet · real funds" : "Testnet · test funds"}
          </span>
        </div>
        <div className="ac-wallet-facts">
          <button
            type="button"
            className="ac-link"
            title="Change how new positions are margined, and the highest leverage, in Settings"
            onClick={() => openSettings("trading")}
          >
            {marginMode(account, risk)} · up to {risk.maxLeverage}x
          </button>
          <span>{wallet.expires ? `Trade-only key approved until ${dayDate(wallet.expires)}` : "Trade-only key approved"}</span>
          <span className="num">Updated {clock(account.asOf)}</span>
        </div>
      </div>

      <div className="ac-wallet-actions">
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
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={busy}
          aria-label="Read the account again"
          onClick={() => void reloadAccount()}
        >
          <Icon name="refresh" size={14} />
          <span className="ac-hide-narrow">Refresh</span>
        </button>
        {snapshot.assistant.ready ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="Puts /portfolio in the message box for you to send"
            onClick={() => prefillComposer("portfolio")}
          >
            <Icon name="assistant" size={14} />
            <span>Ask AI</span>
          </button>
        ) : null}
        <button type="button" className="btn btn-sm btn-primary" onClick={() => openTrade()}>
          <Icon name="plus" size={14} />
          <span>New order</span>
        </button>
      </div>
    </header>
  );
}
