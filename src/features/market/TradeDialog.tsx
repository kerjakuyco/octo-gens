import { type FormEvent, useState } from "react";
import type { Destination, Side, TicketView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Segmented } from "../../components/Segmented";
import { baseOf } from "../../lib/format";
import { ticketStatus } from "../../lib/ticket";
import { app, navigate, prepareTicket, setTradeOpen, useApp, useSnapshot } from "../../state/app";
import { TicketCard } from "./TicketCard";

type AmountMode = "units" | "usdt";

function TradeForm() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const [pair, setPair] = useState(snapshot.focus);
  const [side, setSide] = useState<Side>("buy");
  const [mode, setMode] = useState<AmountMode>("units");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState<Destination>("paper");
  const [ticket, setTicket] = useState<TicketView | null>(null);

  const venue = snapshot.venues.find((item) => item.id === snapshot.feed);
  const canGoLive = Boolean(venue?.credentials);
  const base = baseOf(pair);

  async function preview(event: FormEvent) {
    event.preventDefault();
    const text = amount.trim();
    const ok = await prepareTicket({
      pair,
      side,
      destination: canGoLive ? destination : "paper",
      ...(mode === "units" ? { qty: text } : { quoteAmount: text }),
    });
    if (ok) setTicket(app.get().snapshot?.draft ?? null);
  }

  if (ticket) {
    const pending = ticketStatus(ticket, snapshot).state === "pending";
    return (
      <>
        <TicketCard ticket={ticket} />
        <div className="dialog-actions">
          {pending ? (
            <button type="button" className="btn btn-quiet" onClick={() => setTicket(null)}>
              Change the order
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={() => setTradeOpen(false)}>
            {pending ? "Decide later" : "Close"}
          </button>
        </div>
      </>
    );
  }

  return (
    <form className="form-grid" onSubmit={(event) => void preview(event)}>
      <label className="field">
        <span className="field-label">Instrument</span>
        <select className="input" value={pair} onChange={(event) => setPair(event.target.value)}>
          {snapshot.instruments.map((instrument) => (
            <option key={instrument.pair} value={instrument.pair}>
              {instrument.ticker} / USDT, {instrument.name}
            </option>
          ))}
        </select>
      </label>

      <div className="form-row">
        <div className="field">
          <span className="field-label">Side</span>
          <Segmented
            label="Side"
            value={side}
            options={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" },
            ]}
            onChange={setSide}
          />
        </div>
        <div className="field">
          <span className="field-label">Enter the amount in</span>
          <Segmented
            label="Amount unit"
            value={mode}
            options={[
              { value: "units", label: base },
              { value: "usdt", label: "USDT" },
            ]}
            onChange={setMode}
          />
        </div>
      </div>

      <label className="field">
        <span className="field-label">{mode === "units" ? `Quantity in ${base}` : "Amount in USDT"}</span>
        <input
          className="input"
          inputMode="decimal"
          autoComplete="off"
          placeholder={mode === "units" ? "0.5" : "500"}
          data-autofocus
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">Send it to</span>
        <select
          className="input"
          value={canGoLive ? destination : "paper"}
          disabled={!canGoLive}
          onChange={(event) => setDestination(event.target.value as Destination)}
        >
          <option value="paper">Paper account</option>
          {canGoLive && venue ? <option value="exchange">{venue.name}, live with real funds</option> : null}
        </select>
        {!canGoLive ? (
          <span className="field-help">
            {venue ? (
              <>
                Live orders on {venue.name} need API keys.{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setTradeOpen(false);
                    navigate("connections");
                  }}
                >
                  Add them in Connections
                </button>
                .
              </>
            ) : (
              "You are on the sample tape, so this ticket goes to the paper account. Live orders need a live feed and API keys."
            )}
          </span>
        ) : null}
      </label>

      <div className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={() => setTradeOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !amount.trim()}>
          Preview ticket
        </button>
      </div>
    </form>
  );
}

export function TradeDialog() {
  const open = useApp((state) => state.tradeOpen);
  return (
    <Dialog
      open={open}
      onClose={() => setTradeOpen(false)}
      title="New order ticket"
      lead="A market order. You review the ticket before anything is placed."
    >
      <TradeForm />
    </Dialog>
  );
}
