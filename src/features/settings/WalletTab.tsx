import { type FormEvent, useRef, useState } from "react";
import type { Network, PendingWalletView, WalletView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { useNow } from "../../lib/clock";
import { dayDate, plural, shortAddress } from "../../lib/format";
import { useFlash } from "../../lib/hooks";
import { apiWalletPage, fundsNote, networkName } from "../../lib/network";
import {
  cancelWalletPage,
  connectWalletBrowser,
  connectWalletKey,
  disconnectWallet,
  fundWallet,
  notify,
  openExternal,
  useBusy,
  useSnapshot,
} from "../../state/app";

type Method = "browser" | "key";
type Days = "7" | "30" | "90" | "180";

const METHODS: SegmentOption<Method>[] = [
  { value: "browser", label: "Browser wallet" },
  { value: "key", label: "API wallet key" },
];

const DURATIONS: SegmentOption<Days>[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
];

const DAY_MS = 86_400_000;
/** Practice first, like the network menu. */
const ORDER: Network[] = ["testnet", "mainnet"];

/** When the API wallet's approval ends, said more urgently as the date comes close. */
function Expiry({ at }: { at: string | null }) {
  const now = useNow();
  if (!at) return null;
  const left = Date.parse(at) - now;
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return <span className="down">Expired {dayDate(at)}</span>;
  if (left < 7 * DAY_MS) {
    return <span className="chip" data-tone="warn">Expires in {plural(Math.max(1, Math.ceil(left / DAY_MS)), "day")}</span>;
  }
  return <span className="muted">Expires {dayDate(at)}</span>;
}

/** What the trader is doing in the browser, in the words of the button that started it. */
const WAITING: Record<PendingWalletView["task"], string> = {
  connect: "Waiting for your wallet to approve",
  deposit: "Waiting for your wallet to deposit",
  withdraw: "Waiting for your wallet to withdraw",
};

/** The wallet page that is open in the browser: what it waits for, its address, and a way out. */
function Pending({ page }: { page: PendingWalletView }) {
  const { url } = page;
  const busy = useBusy();
  const field = useRef<HTMLInputElement>(null);
  const [copied, flash] = useFlash(2400);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      flash();
    } catch {
      field.current?.select();
      notify("Selected. Copy it with your keyboard.");
    }
  }

  return (
    <div className="wallet-pending" role="status">
      <p className="status">
        <span className="spinner" />
        {WAITING[page.task]}
      </p>
      <div className="copy-row">
        <input
          ref={field}
          className="input input-mono"
          aria-label="Wallet page"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void cancelWalletPage()}>
          Cancel
        </button>
      </div>
      <p className="field-help">
        {page.task === "connect"
          ? "Open this page in the browser that has your wallet."
          : "Open this page in the browser that has your wallet. Your wallet confirms every step there."}
      </p>
    </div>
  );
}

function Connect({ network, onClose }: { network: Network; onClose: () => void }) {
  const busy = useBusy();
  const [method, setMethod] = useState<Method>("browser");
  const [days, setDays] = useState<Days>("30");
  const [user, setUser] = useState("");
  const [agentKey, setAgentKey] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok =
      method === "browser"
        ? await connectWalletBrowser({ network, days: Number(days) })
        : await connectWalletKey({ network, user: user.trim(), agentKey: agentKey.trim() });
    if (ok) onClose();
  }

  return (
    <div className="setup">
      <div className="setup-head">
        <button type="button" className="icon-btn" aria-label="Back to wallets" onClick={onClose}>
          <Icon name="back" />
        </button>
        <h3 className="setup-title">Connect · {networkName(network)}</h3>
      </div>
      <form className="form" onSubmit={(event) => void submit(event)} autoComplete="off">
        <Segmented label="How to connect" value={method} options={METHODS} onChange={setMethod} fill />
        {method === "browser" ? (
          <>
            <div className="field">
              <span className="field-label">Approval lasts</span>
              <Segmented label="Approval lasts" value={days} options={DURATIONS} onChange={setDays} fill />
              <span className="field-help">Your wallet approves a trade-only key. It cannot withdraw.</span>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Wallet address</span>
              <input
                className="input input-mono"
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                required
                value={user}
                onChange={(event) => setUser(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">API wallet private key</span>
              <input
                className="input input-mono"
                type="password"
                autoComplete="off"
                required
                value={agentKey}
                onChange={(event) => setAgentKey(event.target.value)}
              />
              <span className="field-help">
                Never paste your main wallet's key or seed phrase here.{" "}
                <button type="button" className="link" onClick={() => openExternal(apiWalletPage(network))}>
                  Create an API wallet
                </button>
              </span>
            </label>
          </>
        )}
        {network === "mainnet" ? (
          <p className="note" data-tone="warn">
            <Icon name="alert" size={16} />
            Real funds. You still confirm every order.
          </p>
        ) : null}
        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || (method === "key" && (!user.trim() || !agentKey.trim()))}
          >
            {method === "browser" ? "Open browser" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface WalletCardProps {
  wallet: WalletView;
  active: boolean;
  /** The wallet page this network is waiting on in the browser, if any. */
  pending: PendingWalletView | null;
  /** Another wallet page is waiting, so a new one cannot start. */
  blocked: boolean;
  onConnect: () => void;
}

function WalletCard({ wallet, active, pending, blocked, onConnect }: WalletCardProps) {
  const busy = useBusy();
  const [leaving, setLeaving] = useState(false);
  const { network } = wallet;

  return (
    <section className="wallet" aria-label={`${networkName(network)} wallet`}>
      <header className="wallet-head">
        <h3 className="wallet-name">{networkName(network)}</h3>
        <span className="chip" data-tone={network === "mainnet" ? "warn" : undefined}>
          {fundsNote(network)}
        </span>
        {active ? <span className="chip">Active</span> : null}
      </header>

      {pending ? <Pending page={pending} /> : null}

      {wallet.connected ? (
        <>
          <dl className="wallet-lines">
            <div>
              <dt>Wallet</dt>
              <dd className="mono" title={wallet.user ?? undefined}>
                {shortAddress(wallet.user)}
              </dd>
            </div>
            <div>
              <dt>API wallet</dt>
              <dd>
                <span className="mono" title={wallet.agent ?? undefined}>
                  {shortAddress(wallet.agent)}
                </span>
                <Expiry at={wallet.expires} />
              </dd>
            </div>
          </dl>
          {wallet.needsDeposit ? (
            <p className="note" data-tone="warn">
              <Icon name="alert" size={16} />
              <span>Deposit to start trading. Your wallet sends it; this app never holds your funds.</span>
            </p>
          ) : null}
          <div className="wallet-actions">
            {leaving ? (
              <>
                <span className="grow muted">Positions stay open.</span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => void disconnectWallet(network).then(() => setLeaving(false))}
                >
                  Disconnect
                </button>
                <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setLeaving(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={wallet.needsDeposit ? "btn btn-sm btn-primary" : "btn btn-sm btn-secondary"}
                  disabled={busy || blocked}
                  onClick={() => void fundWallet({ network, task: "deposit" })}
                >
                  Deposit
                </button>
                {/* Nothing can be taken out of an account that has had nothing put in. */}
                {wallet.needsDeposit ? null : (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={busy || blocked}
                    onClick={() => void fundWallet({ network, task: "withdraw" })}
                  >
                    Withdraw
                  </button>
                )}
                <span className="grow" />
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy || blocked} onClick={onConnect}>
                  Replace
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setLeaving(true)}>
                  Disconnect
                </button>
              </>
            )}
          </div>
        </>
      ) : pending ? null : (
        <div className="wallet-actions">
          <span className="grow muted">Not connected</span>
          {/* Only the network in use asks for attention. */}
          <button
            type="button"
            className={active ? "btn btn-sm btn-primary" : "btn btn-sm btn-secondary"}
            disabled={busy || blocked}
            onClick={onConnect}
          >
            Connect wallet
          </button>
        </div>
      )}
    </section>
  );
}

/** One trading wallet per network. The app only ever holds a trade-only key; funds move by the wallet's own hand. */
export function WalletTab() {
  const snapshot = useSnapshot();
  const [connecting, setConnecting] = useState<Network | null>(null);
  const { pendingWallet } = snapshot;

  if (connecting) return <Connect network={connecting} onClose={() => setConnecting(null)} />;

  return (
    <div className="wallets">
      {ORDER.map((network) => {
        const wallet = snapshot.wallets.find((item) => item.network === network);
        if (!wallet) return null;
        return (
          <WalletCard
            key={network}
            wallet={wallet}
            active={network === snapshot.network}
            pending={pendingWallet?.network === network ? pendingWallet : null}
            blocked={pendingWallet !== null}
            onConnect={() => setConnecting(network)}
          />
        );
      })}
    </div>
  );
}
