import { type ReactNode, useState } from "react";
import type { GridPreviewView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { money, price, units } from "../../lib/format";
import { networkName } from "../../lib/network";
import { InstrumentMark } from "../market/InstrumentMark";
import { directionLabel, directionTone, spacingLabel } from "./labels";

interface GridReviewProps {
  /** The dry run to review; the dialog is closed without one. */
  preview: GridPreviewView | null;
  busy: boolean;
  /** Why starting it was refused, or empty. */
  error: string;
  onClose: () => void;
  onStart: () => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gb-review-row">
      <dt>{label}</dt>
      <dd className="num">{children}</dd>
    </div>
  );
}

function profitText(min: number, max: number): string {
  return min === max ? `${min.toFixed(2)}%` : `${min.toFixed(2)}–${max.toFixed(2)}%`;
}

/**
 * The bot as the core worked it out, before anything is sent: where its orders go, how big they are,
 * what it buys or sells first, and where it stops. Starting it is the only step that signs orders.
 */
export function GridReview({ preview, busy, error, onClose, onStart }: GridReviewProps) {
  // The dialog is drawn anew for each review, so a tick from an earlier one never carries over.
  const [understood, setUnderstood] = useState(false);
  const mainnet = preview?.network === "mainnet";

  return (
    <Dialog open={preview !== null} onClose={onClose} title="Review grid bot" size="trade">
      {preview ? (
        <div className="dialog-body gb-review">
          <div className="gb-review-head">
            <InstrumentMark base={preview.base} />
            <div className="gb-review-name">
              <p className="gb-review-market">
                {preview.base} <span className="muted">/ {preview.quote}</span>
              </p>
              <p className="gb-review-sub">
                <span className="chip" data-tone={directionTone(preview.direction)}>
                  {directionLabel(preview.direction)} · {preview.leverage}x
                </span>
                <span className="muted">
                  {preview.grids} grids, {spacingLabel(preview.spacing).toLowerCase()}
                </span>
              </p>
            </div>
            <span className="chip" data-tone={mainnet ? "warn" : undefined}>
              {networkName(preview.network)}
            </span>
          </div>

          <dl className="gb-review-facts">
            <Row label="Price range">
              {price(preview.lowerPrice)} – {price(preview.upperPrice)}
            </Row>
            <Row label="Price now">{price(preview.markPrice)}</Row>
            <Row label="Orders">
              {preview.buyOrders} buy below · {preview.sellOrders} sell above
            </Row>
            <Row label="Each order">
              {units(preview.qtyPerGrid)} {preview.base} <span className="muted">· {money(preview.notionalPerGrid)} {preview.quote}</span>
            </Row>
            <Row label="Profit per grid">
              {profitText(preview.profitPerGridMinPct, preview.profitPerGridMaxPct)} <span className="muted">after fees</span>
            </Row>
            <Row label="Margin">
              {money(preview.margin)} {preview.quote} <span className="muted">at {preview.leverage}x, {preview.isolated ? "isolated" : "cross"}</span>
            </Row>
            <Row label="All orders">
              {money(preview.totalNotional)} {preview.quote}
            </Row>
            <Row label="First">
              {preview.initialSide && preview.initialQty
                ? `${preview.initialSide === "buy" ? "Buys" : "Sells"} ${units(preview.initialQty)} ${preview.base} at the market price`
                : "Nothing: it starts flat"}
            </Row>
            {preview.estLiqLong || preview.estLiqShort ? (
              <Row label="Estimated liquidation">
                {[
                  preview.estLiqLong ? `long ${price(preview.estLiqLong)}` : "",
                  preview.estLiqShort ? `short ${price(preview.estLiqShort)}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Row>
            ) : null}
            <Row label="Starts">{preview.triggerPrice ? `When the price reaches ${price(preview.triggerPrice)}` : "Now"}</Row>
            <Row label="Stops">
              {preview.stopLower || preview.stopUpper
                ? `${[
                    preview.stopLower ? `below ${price(preview.stopLower)}` : "",
                    preview.stopUpper ? `above ${price(preview.stopUpper)}` : "",
                  ]
                    .filter(Boolean)
                    .join(" or ")}, then ${preview.closeOnStop ? "closes the position" : "keeps the position"}`
                : "Only when you stop it"}
            </Row>
            <Row label="Order type">{preview.postOnly ? "Maker orders only" : "Limit orders"}</Row>
          </dl>

          {preview.warnings.length > 0 ? (
            <ul className="note gb-review-warnings" data-tone="warn">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          <p className="gb-review-runtime">
            The bot places its next orders and watches its stop prices while OctoNeo is open. Its resting orders stay on
            the exchange when you close the app.
          </p>

          {mainnet ? (
            <label className="check gb-check">
              <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
              <span>I understand this places live orders with real funds.</span>
            </label>
          ) : null}

          {error ? (
            <p className="note" data-tone="error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="gb-review-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Back
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || (mainnet && !understood)} onClick={onStart}>
              Start grid bot
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
