import { useState } from "react";
import type { TicketView, VenueId } from "../../api/types";
import { Icon } from "../../components/Icon";
import { baseOf, money, price, units } from "../../lib/format";
import { feedName, ticketNumber, ticketStatus } from "../../lib/ticket";
import { dismissTicket, submitTicket, useApp, useSnapshot } from "../../state/app";

/**
 * An order ticket: a paper slip the user confirms or dismisses. Nothing is
 * sent to a paper account or an exchange until the confirm button is pressed.
 */
export function TicketCard({ ticket }: { ticket: TicketView }) {
  const snapshot = useSnapshot();
  const working = useApp((state) => state.working);
  const status = ticketStatus(ticket, snapshot);
  const live = ticket.destination === "exchange";
  const venue = live ? feedName(ticket.feed as VenueId) : "";
  const base = baseOf(ticket.pair);
  const [acknowledged, setAcknowledged] = useState(false);
  // Stamp with a thump only when this card watched the ticket go from pending to done.
  const [mountedPending] = useState(status.state === "pending");

  return (
    <section
      className="ticket"
      data-side={ticket.side}
      data-state={status.state}
      data-live={live}
      aria-label={`${live ? "Live" : "Paper"} ticket to ${ticket.side} ${units(ticket.qty)} ${base}`}
    >
      <div className="ticket-stub">
        <div className="ticket-side">{ticket.side === "buy" ? "Buy" : "Sell"}</div>
        <div className="ticket-number">
          Ticket <b>{ticketNumber(ticket.id)}</b>
        </div>
      </div>

      <div className="ticket-body">
        {live ? (
          <div className="ticket-live-band">
            <Icon name="alert" size={16} />
            Live order. Real funds on {venue}.
          </div>
        ) : null}
        <div className="ticket-kind">{live ? `Market order on ${venue}` : "Paper trade, market order"}</div>
        <div className="ticket-amount">
          {units(ticket.qty)} {base}
        </div>

        <dl className="ticket-lines">
          <dt>Pair</dt>
          <dd>{ticket.pair}</dd>
          <dt>Reference price</dt>
          <dd>{price(ticket.price)} USDT</dd>
          <dt>Estimated value</dt>
          <dd>{money(ticket.value)} USDT</dd>
          <dt>Priced from</dt>
          <dd>{ticket.feed === "sample" ? "Sample tape, fictional prices" : `${feedName(ticket.feed)} spot`}</dd>
          <dt>Goes to</dt>
          <dd>{live ? `Your ${venue} account` : "Paper account"}</dd>
        </dl>

        {ticket.rationale ? <p className="ticket-rationale">{ticket.rationale}</p> : null}

        {status.state === "pending" ? (
          <>
            {live ? (
              <label className="ticket-confirm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand this sends a real market order on {venue} and cannot be undone.
                </span>
              </label>
            ) : null}
            <div className="ticket-actions">
              <button
                type="button"
                className="btn btn-ink"
                disabled={Boolean(working) || (live && !acknowledged)}
                onClick={() => void submitTicket(ticket.id)}
              >
                {live ? "Send live order" : "Place paper order"}
              </button>
              <button
                type="button"
                className="btn btn-paper"
                disabled={Boolean(working)}
                onClick={() => void dismissTicket()}
              >
                Dismiss
              </button>
            </div>
          </>
        ) : null}

        {status.state === "done" ? <p className="ticket-note">{status.note}</p> : null}
        {status.state === "expired" ? (
          <p className="ticket-note">This ticket is no longer valid. Draft a new one to trade.</p>
        ) : null}
      </div>

      {status.state === "done" ? (
        <div className="ticket-stamp" data-fresh={mountedPending}>
          {live ? "Sent" : "Filled"}
        </div>
      ) : null}
      {status.state === "expired" ? <div className="ticket-stamp">Expired</div> : null}
    </section>
  );
}
