import { type FormEvent, useState } from "react";
import type { Side, TicketRequest, TicketView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Segmented } from "../../components/Segmented";
import { activeWallet, instrumentFor } from "../../lib/market";
import { exchangeSite, networkName } from "../../lib/network";
import { ticketStatus } from "../../lib/ticket";
import { app, closeTrade, openExternal, openSettings, prepareTicket, useApp, useSnapshot } from "../../state/app";
import { TicketCard } from "./TicketCard";

type AmountMode = "units" | "value";

/** Shown instead of the form while the active network has no wallet that can trade. */
function WalletNeeded() {
  const snapshot = useSnapshot();
  const wallet = activeWallet(snapshot);

  if (wallet.connected) {
    return (
      <div className="empty">
        <p>Deposit to start trading</p>
        <button type="button" className="btn btn-primary" onClick={() => openExternal(exchangeSite(snapshot.network))}>
          Open deposit page
        </button>
      </div>
    );
  }
  return (
    <div className="empty">
      <p>No wallet on {networkName(snapshot.network)}</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          closeTrade();
          openSettings("wallet");
        }}
      >
        Connect wallet
      </button>
    </div>
  );
}

function TradeForm({ review }: { review: TicketView | null }) {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const { risk } = snapshot;
  const [symbol, setSymbol] = useState(snapshot.focus);
  const [side, setSide] = useState<Side>("buy");
  const [mode, setMode] = useState<AmountMode>("units");
  const [amount, setAmount] = useState("");
  const [leverage, setLeverage] = useState(String(Math.min(risk.maxLeverage, 3)));
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [ticket, setTicket] = useState<TicketView | null>(review);

  const wallet = activeWallet(snapshot);
  const instrument = instrumentFor(snapshot, symbol);
  const quote = instrument.quote || "USDT";
  const markets = snapshot.instruments.some((item) => item.symbol === snapshot.focus)
    ? snapshot.instruments
    : [instrumentFor(snapshot, snapshot.focus), ...snapshot.instruments];
  const leverageValue = Number(leverage);
  const leverageOk = Number.isInteger(leverageValue) && leverageValue >= 1 && leverageValue <= risk.maxLeverage;

  async function draftTicket(event: FormEvent) {
    event.preventDefault();
    const text = amount.trim();
    const request: TicketRequest = { symbol, side, ...(mode === "units" ? { qty: text } : { notional: text }) };
    if (reduceOnly) {
      request.reduceOnly = true;
    } else {
      request.leverage = leverageValue;
      if (stopLoss.trim()) request.stopLoss = stopLoss.trim();
      if (takeProfit.trim()) request.takeProfit = takeProfit.trim();
    }
    if (await prepareTicket(request)) setTicket(app.get().snapshot?.draft ?? null);
  }

  if (ticket) {
    const pending = ticketStatus(ticket, snapshot).state === "pending";
    // The ticket has its own buttons while it waits; the dialog only adds the way back to the form, or out.
    let after = null;
    if (!pending) {
      after = (
        <button type="button" className="btn btn-secondary" onClick={closeTrade}>
          Done
        </button>
      );
    } else if (!review) {
      after = (
        <button type="button" className="btn btn-ghost" onClick={() => setTicket(null)}>
          Edit
        </button>
      );
    }
    return (
      <div className="form">
        <TicketCard ticket={ticket} />
        {after ? <div className="form-actions">{after}</div> : null}
      </div>
    );
  }

  if (!wallet.connected || wallet.needsDeposit) return <WalletNeeded />;

  return (
    <form className="form" onSubmit={(event) => void draftTicket(event)}>
      <label className="field">
        <span className="field-label">Market</span>
        <select className="input" value={symbol} onChange={(event) => setSymbol(event.target.value)}>
          {markets.map((item) => (
            <option key={item.symbol} value={item.symbol}>
              {item.base} / {item.quote}
            </option>
          ))}
        </select>
      </label>

      <Segmented
        label="Direction"
        value={side}
        fill
        options={[
          { value: "buy", label: reduceOnly ? "Buy" : "Long" },
          { value: "sell", label: reduceOnly ? "Sell" : "Short" },
        ]}
        onChange={setSide}
      />

      <div className="form-row">
        <div className="field">
          <label className="field-label" htmlFor="trade-amount">
            {mode === "units" ? "Quantity" : "Order value"}
          </label>
          <div className="input-group">
            <input
              id="trade-amount"
              className="input num"
              inputMode="decimal"
              autoComplete="off"
              placeholder={mode === "units" ? "0.01" : "500"}
              data-autofocus
              required
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Segmented
              label="Amount in"
              value={mode}
              options={[
                { value: "units", label: instrument.base },
                { value: "value", label: quote },
              ]}
              onChange={setMode}
            />
          </div>
        </div>
        {reduceOnly ? null : (
          <label className="field field-narrow">
            <span className="field-label">Leverage</span>
            <input
              className="input num"
              type="number"
              inputMode="numeric"
              min={1}
              max={risk.maxLeverage}
              step={1}
              required
              value={leverage}
              onChange={(event) => setLeverage(event.target.value)}
            />
            <span className="field-help">Up to {risk.maxLeverage}x</span>
          </label>
        )}
      </div>

      {reduceOnly ? null : (
        <div className="form-row">
          <label className="field">
            <span className="field-label">Stop-loss</span>
            <input
              className="input num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="Optional"
              value={stopLoss}
              onChange={(event) => setStopLoss(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Take-profit</span>
            <input
              className="input num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="Optional"
              value={takeProfit}
              onChange={(event) => setTakeProfit(event.target.value)}
            />
          </label>
        </div>
      )}

      <label className="check">
        <input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} />
        <span>
          Reduce only
          <span className="field-help"> · can only shrink a position</span>
        </span>
      </label>

      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={closeTrade}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !amount.trim() || (!reduceOnly && !leverageOk)}>
          Review
        </button>
      </div>
    </form>
  );
}

/** The order form, and the place a ticket drafted elsewhere is reviewed. */
export function TradeDialog() {
  const trade = useApp((state) => state.trade);
  const review = trade?.ticket ?? null;
  return (
    <Dialog open={trade !== null} onClose={closeTrade} title={review ? "Review order" : "New order"}>
      {trade ? (
        <div className="dialog-body">
          <TradeForm review={review} />
        </div>
      ) : null}
    </Dialog>
  );
}
