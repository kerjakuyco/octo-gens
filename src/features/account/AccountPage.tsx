import { type ReactNode, useEffect } from "react";
import type { AccountView, BalanceView, OpenOrderView, PositionView } from "../../api/types";
import { Icon } from "../../components/Icon";
import {
  balance,
  clock,
  direction,
  leverage,
  money,
  orderType,
  percent,
  price,
  signedMoney,
  units,
} from "../../lib/format";
import { activeWallet, instrumentFor } from "../../lib/market";
import { networkName } from "../../lib/network";
import {
  cancelAllOrders,
  cancelOrder,
  closePosition,
  focusMarket,
  fundWallet,
  openSettings,
  openTrade,
  refreshAccount,
  reloadAccount,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";

/** A price level the exchange actually set; it reports zero for the ones that do not apply. */
function level(value: string | null): string | null {
  return value !== null && Number(value) > 0 ? value : null;
}

function orderLevel(order: OpenOrderView): string {
  const trigger = level(order.stopPrice);
  const limit = level(order.price);
  if (trigger && limit) return `${price(trigger)} → ${price(limit)}`;
  if (trigger) return price(trigger);
  return limit ? price(limit) : "Market";
}

function Figures({ account }: { account: AccountView }) {
  return (
    <dl className="figures">
      <div className="figure figure-lead">
        <dt>Equity</dt>
        <dd className="num">
          {money(account.equity)} <small>USDT</small>
        </dd>
      </div>
      <div className="figure">
        <dt>Available</dt>
        <dd className="num">{money(account.available)}</dd>
      </div>
      <div className="figure">
        <dt>Margin used</dt>
        <dd className="num">{money(account.marginUsed)}</dd>
      </div>
      <div className="figure">
        <dt>Unrealized P/L</dt>
        <dd className={`num ${direction(account.unrealizedPnl)}`}>{signedMoney(account.unrealizedPnl)}</dd>
      </div>
      <div className="figure">
        <dt>Wallet balance</dt>
        <dd className="num">{money(account.walletBalance)}</dd>
      </div>
    </dl>
  );
}

function Positions({ positions }: { positions: PositionView[] }) {
  const snapshot = useSnapshot();
  const busy = useBusy();

  if (positions.length === 0) {
    return (
      <div className="empty">
        <p>No open positions</p>
        <button type="button" className="btn btn-secondary" onClick={() => openTrade()}>
          New order
        </button>
      </div>
    );
  }

  return (
    <ul className="positions">
      {positions.map((position) => {
        const instrument = instrumentFor(snapshot, position.symbol);
        const long = position.side === "long";
        return (
          <li key={position.symbol} className="position">
            <div className="position-head">
              <button type="button" className="symbol" onClick={() => void focusMarket(position.symbol)}>
                <InstrumentMark base={instrument.base} size="sm" />
                <span className="symbol-name">{instrument.base}</span>
              </button>
              <span className="chip" data-tone={long ? "up" : "down"}>
                {long ? "Long" : "Short"} {leverage(position.leverage)}
              </span>
              <span className="muted position-mode">{position.isolated ? "Isolated" : "Cross"}</span>
              <span className="grow" />
              <span className={`position-pnl num ${direction(position.unrealizedPnl)}`}>
                {signedMoney(position.unrealizedPnl)}
                <small>{percent(position.roePct)}</small>
              </span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={busy}
                aria-label={`Close ${instrument.base} ${position.side}`}
                onClick={() => void closePosition(position.symbol)}
              >
                Close
              </button>
            </div>
            <dl className="position-facts num">
              <div>
                <dt>Size</dt>
                <dd>{units(position.qty)}</dd>
              </div>
              <div>
                <dt>Value</dt>
                <dd>{money(position.notional)}</dd>
              </div>
              <div>
                <dt>Entry</dt>
                <dd>{price(position.entryPrice)}</dd>
              </div>
              <div>
                <dt>Mark</dt>
                <dd>{price(position.markPrice)}</dd>
              </div>
              <div>
                <dt>Liquidation</dt>
                <dd>{position.liquidationPrice ? price(position.liquidationPrice) : "None"}</dd>
              </div>
              <div>
                <dt>Margin</dt>
                <dd>{money(position.margin)}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function Orders({ orders }: { orders: OpenOrderView[] }) {
  const snapshot = useSnapshot();
  const busy = useBusy();

  if (orders.length === 0) return <p className="empty">No open orders</p>;

  const groups = new Map<string, OpenOrderView[]>();
  for (const order of orders) {
    const group = groups.get(order.symbol);
    if (group) group.push(order);
    else groups.set(order.symbol, [order]);
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Side</th>
            <th scope="col" className="num">
              Price
            </th>
            <th scope="col" className="num">
              Quantity
            </th>
            <th scope="col">
              <span className="visually-hidden">Cancel</span>
            </th>
          </tr>
        </thead>
        {[...groups].map(([symbol, group]) => {
          const instrument = instrumentFor(snapshot, symbol);
          return (
            <tbody key={symbol}>
              <tr className="group-row">
                <th scope="rowgroup" colSpan={4}>
                  {instrument.base} / {instrument.quote || "USDT"}
                </th>
                <td className="num">
                  {group.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      aria-label={`Cancel all ${instrument.base} orders`}
                      onClick={() => void cancelAllOrders(symbol)}
                    >
                      Cancel all
                    </button>
                  ) : null}
                </td>
              </tr>
              {group.map((order) => (
                <tr key={order.id}>
                  <td>
                    <span className="cell-main">{orderType(order.type)}</span>
                    {order.reduceOnly ? <span className="cell-sub">Reduce only</span> : null}
                  </td>
                  <td>
                    <span className="chip" data-tone={order.side === "buy" ? "up" : "down"}>
                      {order.side === "buy" ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="num">{orderLevel(order)}</td>
                  <td className="num">
                    <span className="cell-main">{units(order.qty)}</span>
                    {Number(order.filled) > 0 ? <span className="cell-sub">{units(order.filled)} filled</span> : null}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={busy}
                      aria-label={`Cancel ${orderType(order.type).toLowerCase()} ${order.side} on ${instrument.base}`}
                      onClick={() => void cancelOrder(order.symbol, order.id)}
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function Balances({ balances }: { balances: BalanceView[] }) {
  // The exchange lists every asset it accepts as collateral; only the ones actually held are worth a row.
  const held = balances.filter((row) => Number(row.balance) !== 0 || Number(row.available) !== 0);
  if (held.length === 0) return <p className="empty">No balances</p>;
  return (
    <div className="table-wrap">
      <table className="table table-narrow">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col" className="num">
              Balance
            </th>
            <th scope="col" className="num">
              Available
            </th>
          </tr>
        </thead>
        <tbody>
          {held.map((row) => (
            <tr key={row.asset}>
              <td>
                <span className="cell-main">{row.asset}</span>
              </td>
              <td className="num">{balance(row.balance)}</td>
              <td className="num">{balance(row.available)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="section" aria-label={title}>
      <h2 className="section-title">
        {title}
        {count ? <span className="section-count num">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** The futures account on the active network: what it is worth, what is open, what is resting. */
export function AccountPage() {
  const snapshot = useSnapshot();
  const busy = useBusy();
  const wallet = activeWallet(snapshot);
  const { account, accountError, network } = snapshot;
  // One wallet page at a time: while one waits in the browser, another cannot start.
  const waiting = snapshot.pendingWallet !== null;

  // Read the account as the page opens and whenever the network changes; the shell keeps it fresh after that.
  useEffect(() => {
    void refreshAccount();
  }, [network]);

  const refresh = (
    <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void reloadAccount()}>
      <Icon name="refresh" size={15} />
      Refresh
    </button>
  );

  let body;
  if (!wallet.connected) {
    body = (
      <div className="empty">
        <p>No wallet on {networkName(network)}</p>
        <button type="button" className="btn btn-primary" onClick={() => openSettings("wallet")}>
          Connect wallet
        </button>
      </div>
    );
  } else if (wallet.needsDeposit) {
    body = (
      <div className="empty">
        <p>Deposit to open this account</p>
        <div className="empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || waiting}
            onClick={() => void fundWallet({ network, task: "deposit" })}
          >
            Deposit
          </button>
          {refresh}
        </div>
      </div>
    );
  } else if (!account) {
    body = accountError ? (
      <div className="empty">
        <p className="note" data-tone="error" role="alert">
          {accountError}
        </p>
        {refresh}
      </div>
    ) : (
      <p className="empty">
        <span className="spinner" />
      </p>
    );
  } else {
    body = (
      <>
        <div className="account-bar">
          <span className="muted num">Updated {clock(account.asOf)}</span>
          <span className="account-actions">
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
            {refresh}
          </span>
        </div>
        {accountError ? (
          <p className="note" data-tone="error" role="alert">
            {accountError}
          </p>
        ) : null}
        <Figures account={account} />
        <Section title="Positions" count={account.positions.length}>
          <Positions positions={account.positions} />
        </Section>
        <Section title="Open orders" count={account.orders.length}>
          <Orders orders={account.orders} />
        </Section>
        <Section title="Balances">
          <Balances balances={account.balances} />
        </Section>
      </>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">{body}</div>
    </div>
  );
}
