import { type ReactNode, useState } from "react";
import type { TicketView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { leverage, money, price, units } from "../../lib/format";
import { instrumentFor } from "../../lib/market";
import { confirmLabel, failureTitle, ticketAction, ticketStatus } from "../../lib/ticket";
import { dismissTicket, focusMarket, submitTicket, useApp, useSnapshot } from "../../state/app";

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className="num">{children}</dd>
    </div>
  );
}

/**
 * An order waiting for the trader. Nothing is sent to the exchange until the confirm
 * button is pressed, and a mainnet order also needs the box ticked.
 */
export function TicketCard({ ticket }: { ticket: TicketView }) {
  const snapshot = useSnapshot();
  const working = useApp((state) => Boolean(state.working));
  const status = ticketStatus(ticket, snapshot);
  const real = ticket.network === "mainnet";
  const instrument = instrumentFor(snapshot, ticket.symbol);
  const quote = instrument.quote || "USDT";
  const action = ticketAction(ticket);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <section className="card ticket" data-state={status.state} aria-label={`${action} ${instrument.base} order`}>
      <header className="card-head">
        <span className="ticket-title">
          <span className="chip" data-tone={ticket.side === "buy" ? "up" : "down"}>
            {action}
          </span>
          <button type="button" className="symbol" onClick={() => void focusMarket(ticket.symbol)}>
            <span className="symbol-name">
              {instrument.base}-{quote}
            </span>
          </button>
          <span className="chip">Market</span>
        </span>
        <span className="chip" data-tone={real ? "warn" : undefined}>
          {real ? "Mainnet · Live funds" : "Testnet"}
        </span>
      </header>

      <p className="ticket-effect">{ticket.effect}</p>

      <dl className="facts facts-two">
        <Line label="Order size">
          {units(ticket.qty)} {instrument.base}
        </Line>
        <Line label="Notional">
          {money(ticket.notional)} {quote}
        </Line>
        {ticket.reduceOnly ? null : (
          <>
            <Line label="Leverage">{leverage(ticket.leverage)}</Line>
            <Line label="Initial margin">
              {money(ticket.margin)} {quote}
            </Line>
          </>
        )}
        {ticket.estLiquidation ? <Line label="Est. liq. price">{price(ticket.estLiquidation)}</Line> : null}
        {ticket.stopLoss ? <Line label="Stop-loss">{price(ticket.stopLoss)}</Line> : null}
        {ticket.takeProfit ? <Line label="Take-profit">{price(ticket.takeProfit)}</Line> : null}
      </dl>

      {ticket.rationale ? <p className="ticket-why">{ticket.rationale}</p> : null}

      {status.state === "pending" ? (
        <>
          {real ? (
            <label className="check ticket-ack">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I understand this order executes with real funds on Mainnet.</span>
            </label>
          ) : null}
          <div className="ticket-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={working || (real && !acknowledged)}
              onClick={() => void submitTicket(ticket.id)}
            >
              {confirmLabel(ticket)}
            </button>
            <button type="button" className="btn btn-ghost" disabled={working} onClick={() => void dismissTicket()}>
              Discard
            </button>
          </div>
        </>
      ) : null}

      {status.state === "done" ? (
        <p className="note" data-tone="ok">
          <Icon name="check" size={16} />
          <span>{status.note}</span>
        </p>
      ) : null}
      {status.state === "failed" ? (
        <p className="note" data-tone="warn" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <strong>{failureTitle(status.note)}</strong> {status.note}
          </span>
        </p>
      ) : null}
      {status.state === "expired" ? <p className="ticket-expired">Order draft expired</p> : null}
    </section>
  );
}
