import { useState } from "react";
import type { GridDraftView, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { leverage, money, price, units } from "../../lib/format";
import { dismissGridDraft, openGrid, startGridDraft, useApp, useSnapshot } from "../../state/app";
import { GridLiquidation, GridWarnings } from "./Cards";
import { GridRange, gridDirectionLabel, perGridLabel, spacingLabel } from "./GridRange";

export type GridDraftStatus =
  | { state: "pending" }
  /** Started. `note` says how the bot began. */
  | { state: "started"; note: string }
  /** The trader asked to start it and it was refused. `note` says why. */
  | { state: "refused"; note: string }
  /** Replaced, discarded, or let go by a network change. */
  | { state: "expired" };

/** Where a drafted grid bot stands, from the latest snapshot. */
export function gridDraftStatus(draft: GridDraftView, snapshot: Snapshot): GridDraftStatus {
  const receipt = snapshot.receipts[draft.id];
  if (receipt) return { state: "started", note: receipt };
  const failure = snapshot.failures[draft.id];
  if (failure) return { state: "refused", note: failure };
  if (snapshot.gridDraft?.id === draft.id) return { state: "pending" };
  return { state: "expired" };
}

/**
 * A grid bot the assistant drafted, waiting for the trader. Nothing reaches the exchange until "Start grid
 * bot" is pressed, and on mainnet the box must be ticked first. Once started, it lives on the Grid bots page.
 */
export function GridDraftCard({ draft }: { draft: GridDraftView }) {
  const snapshot = useSnapshot();
  const working = useApp((state) => Boolean(state.working) || state.live !== null);
  const [acknowledged, setAcknowledged] = useState(false);
  const status = gridDraftStatus(draft, snapshot);
  const { preview } = draft;
  const real = draft.network === "mainnet";
  const label = gridDirectionLabel(preview.direction);
  const buying = preview.initialSide === "buy";

  return (
    <section className="card ticket grid-ticket" data-state={status.state} aria-label={`${label.text} on ${preview.base}`}>
      <header className="card-head">
        <span className="ticket-title">
          <span className="chip" data-tone={label.tone}>
            {label.text}
          </span>
          <span className="symbol-name">
            {preview.base}-{preview.quote}
          </span>
          <span className="chip">Grid bot</span>
        </span>
        <span className="chip" data-tone={real ? "warn" : undefined}>
          {real ? "Mainnet · Live funds" : "Testnet"}
        </span>
      </header>

      <p className="ticket-effect">
        {preview.grids} grids from {price(preview.lowerPrice)} to {price(preview.upperPrice)}, with{" "}
        {money(preview.margin)} {preview.quote} at {leverage(preview.leverage)}
      </p>

      <GridRange lower={preview.lowerPrice} upper={preview.upperPrice} mark={preview.markPrice} levels={preview.levels} />

      <dl className="facts facts-two">
        <div className="fact">
          <dt>Orders</dt>
          <dd className="num">
            <span className="up">{preview.buyOrders} buy</span> · <span className="down">{preview.sellOrders} sell</span>
          </dd>
        </div>
        <div className="fact">
          <dt>Each order</dt>
          <dd className="num">
            {units(preview.qtyPerGrid)} {preview.base}
          </dd>
        </div>
        <div className="fact">
          <dt>Earns per grid</dt>
          <dd className="num">{perGridLabel(preview.profitPerGridMinPct, preview.profitPerGridMaxPct)}</dd>
        </div>
        <div className="fact">
          <dt>Spacing</dt>
          <dd>{spacingLabel(preview.spacing)}</dd>
        </div>
        <GridLiquidation long={preview.estLiqLong} short={preview.estLiqShort} />
        {preview.initialSide && preview.initialQty ? (
          <div className="fact">
            <dt>Starts with</dt>
            <dd className="num">
              {buying ? "Buy" : "Sell"} {units(preview.initialQty)} {preview.base}
            </dd>
          </div>
        ) : null}
        {preview.stopLower ? (
          <div className="fact">
            <dt>Stops below</dt>
            <dd className="num">{price(preview.stopLower)}</dd>
          </div>
        ) : null}
        {preview.stopUpper ? (
          <div className="fact">
            <dt>Stops above</dt>
            <dd className="num">{price(preview.stopUpper)}</dd>
          </div>
        ) : null}
      </dl>

      {draft.rationale ? <p className="ticket-why">{draft.rationale}</p> : null}
      {status.state === "pending" ? <GridWarnings warnings={preview.warnings} /> : null}

      {status.state === "pending" ? (
        <>
          {real ? (
            <label className="check ticket-ack">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I understand this places live orders with real funds.</span>
            </label>
          ) : null}
          <div className="ticket-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={working || (real && !acknowledged)}
              onClick={() => void startGridDraft(draft.id)}
            >
              {real ? "Start live grid bot" : "Start grid bot"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={working} onClick={() => void dismissGridDraft()}>
              Discard
            </button>
          </div>
          <p className="grid-note">It places its next orders while OctoNeo is open.</p>
        </>
      ) : null}

      {status.state === "started" ? (
        <div className="grid-started">
          <p className="note" data-tone="ok">
            <Icon name="check" size={16} />
            <span>{status.note}</span>
          </p>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => openGrid(preview.symbol)}>
            Open grid bots
          </button>
        </div>
      ) : null}
      {status.state === "refused" ? (
        <p className="note" data-tone="warn" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <strong>Not started.</strong> {status.note}
          </span>
        </p>
      ) : null}
      {status.state === "expired" ? <p className="ticket-expired">Grid bot draft expired</p> : null}
    </section>
  );
}
