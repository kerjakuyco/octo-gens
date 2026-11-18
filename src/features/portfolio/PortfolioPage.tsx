import { useState } from "react";
import type { BalanceRow, VenueView } from "../../api/types";
import { dayTime, direction, money, plural, price, signedMoney, sumAmounts, units } from "../../lib/format";
import { feedName } from "../../lib/ticket";
import { errorText, navigate, request, setTradeOpen, useSnapshot } from "../../state/app";

interface BalanceState {
  status: "idle" | "loading" | "ready" | "failed";
  rows: BalanceRow[];
  error: string;
}

function VenueBalances({ venue }: { venue: VenueView }) {
  const [state, setState] = useState<BalanceState>({ status: "idle", rows: [], error: "" });

  function load() {
    setState({ status: "loading", rows: [], error: "" });
    request((api) => api.balances(venue.id))
      .then((rows) => setState({ status: "ready", rows, error: "" }))
      .catch((error: unknown) => setState({ status: "failed", rows: [], error: errorText(error) }));
  }

  return (
    <div className="balance-block">
      <div className="balance-head">
        <h3>{venue.name}</h3>
        <button type="button" className="btn btn-secondary btn-small" disabled={state.status === "loading"} onClick={load}>
          {state.status === "ready" ? "Reload balances" : "Load balances"}
        </button>
      </div>
      {state.status === "loading" ? (
        <p className="empty">
          <span className="ring-spin" /> Asking {venue.name}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <p className="form-error" role="alert">
          {venue.name} did not return balances. {state.error}
        </p>
      ) : null}
      {state.status === "ready" && state.rows.length === 0 ? (
        <p className="empty">This account holds no assets.</p>
      ) : null}
      {state.status === "ready" && state.rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.asset}>
                  <td className="strong">{row.asset}</td>
                  <td className="num">{units(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function PortfolioPage() {
  const snapshot = useSnapshot();
  const { account, feed } = snapshot;
  const unrealized = sumAmounts(account.holdings.map((holding) => holding.pnl));
  const keyed = snapshot.venues.filter((venue) => venue.credentials);

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Portfolio</h1>
        <p className="page-lead">
          {feed === "sample"
            ? "Your paper account on the sample tape. Its prices are fictional, so are these results."
            : `Your paper account, valued at ${feedName(feed)} spot prices. No real funds are involved.`}
        </p>

        <dl className="headline-figures">
          <div className="headline-figure">
            <dt>Equity</dt>
            <dd>
              {money(account.equity)}
              <small>USDT</small>
            </dd>
          </div>
          <div className="headline-figure">
            <dt>Cash</dt>
            <dd>
              {money(account.cash)}
              <small>USDT</small>
            </dd>
          </div>
          <div className="headline-figure">
            <dt>Unrealized profit or loss</dt>
            <dd className={direction(unrealized)}>
              {signedMoney(unrealized)}
              <small>USDT</small>
            </dd>
          </div>
        </dl>

        <section className="section" aria-labelledby="positions-title">
          <div className="section-head">
            <h2 id="positions-title" className="section-title">
              Positions
            </h2>
            <span className="section-note">
              {account.holdings.length > 0 ? plural(account.holdings.length, "open position") : ""}
            </span>
          </div>
          {account.holdings.length === 0 ? (
            <div className="empty">
              <strong>No open positions</strong>
              Ask the assistant to draft a ticket, or write one yourself.
              <div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    navigate("assistant");
                    setTradeOpen(true);
                  }}
                >
                  Write a ticket
                </button>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Pair</th>
                    <th scope="col" className="num">
                      Units
                    </th>
                    <th scope="col" className="num">
                      Cost basis
                    </th>
                    <th scope="col" className="num">
                      Market value
                    </th>
                    <th scope="col" className="num">
                      Unrealized
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {account.holdings.map((holding) => (
                    <tr key={holding.pair}>
                      <td className="strong">{holding.pair}</td>
                      <td className="num">{units(holding.qty)}</td>
                      <td className="num">{money(holding.cost)}</td>
                      <td className="num">{money(holding.value)}</td>
                      <td className={`num strong ${direction(holding.pnl)}`}>{signedMoney(holding.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" aria-labelledby="fills-title">
          <div className="section-head">
            <h2 id="fills-title" className="section-title">
              Recent fills
            </h2>
            <span className="section-note">Paper orders fill at the quoted price</span>
          </div>
          {account.orders.length === 0 ? (
            <p className="empty">Confirmed paper tickets are listed here, newest first.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Pair</th>
                    <th scope="col">Side</th>
                    <th scope="col" className="num">
                      Units
                    </th>
                    <th scope="col" className="num">
                      Fill price
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {account.orders.map((order) => (
                    <tr key={order.id}>
                      <td className="muted">{dayTime(order.submitted)}</td>
                      <td className="strong">{order.pair}</td>
                      <td className={order.side === "buy" ? "side-buy" : "side-sell"}>
                        {order.side === "buy" ? "Buy" : "Sell"}
                      </td>
                      <td className="num">{units(order.qty)}</td>
                      <td className="num">{price(order.price)}</td>
                      <td className="muted">{order.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" aria-labelledby="balances-title">
          <div className="section-head">
            <h2 id="balances-title" className="section-title">
              Exchange balances
            </h2>
            <span className="section-note">Read on request, never stored</span>
          </div>
          <div className="section-body">
            {keyed.length === 0 ? (
              <div className="empty">
                <strong>No exchange is connected with API keys</strong>
                Add keys for Binance, Bybit or OKX to read your real balances here. They stay on this computer.
                <div>
                  <button type="button" className="btn btn-secondary" onClick={() => navigate("connections")}>
                    Open Connections
                  </button>
                </div>
              </div>
            ) : (
              keyed.map((venue) => <VenueBalances key={venue.id} venue={venue} />)
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
