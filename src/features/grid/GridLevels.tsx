import type { CSSProperties } from "react";
import type { Side } from "../../api/types";
import { money, price, units } from "../../lib/format";
import type { GridOrderEstimate } from "../../lib/grid";

interface Marker {
  key: string;
  value: number;
  label: string;
  kind: "stop" | "start";
}

interface GridLevelsProps {
  prices: number[];
  /** Which levels start as buys and which as sells; null for the level left empty beside the price. */
  sides: (Side | null)[];
  /** The price now. */
  mark: number;
  base: string;
  quote: string;
  buys: number;
  sells: number;
  /** The position a long or short grid takes first, in grids' worth. */
  initial: { side: Side; legs: number } | null;
  estimate: GridOrderEstimate | null;
  profit: { min: number; max: number };
  width: number | null;
  startPrice: number | null;
  stopBelow: number | null;
  stopAbove: number | null;
}

function at(top: number): CSSProperties {
  return { top: `${top.toFixed(3)}%` };
}

/**
 * The levels a grid would place its orders at, drawn to scale around the price: buys below in green,
 * sells above in red, the price itself, and any start or stop prices. Lines glide when the range or the
 * number of grids changes.
 */
export function GridLevels(props: GridLevelsProps) {
  const { prices, sides, mark, base, quote, buys, sells, initial, estimate, profit, width } = props;
  const ready = prices.length >= 2 && mark > 0;

  const markers: Marker[] = [];
  if (props.stopAbove) markers.push({ key: "stop-above", value: props.stopAbove, label: "Stop", kind: "stop" });
  if (props.stopBelow) markers.push({ key: "stop-below", value: props.stopBelow, label: "Stop", kind: "stop" });
  if (props.startPrice) markers.push({ key: "start", value: props.startPrice, label: "Start", kind: "start" });

  let top: (value: number) => number = () => 50;
  if (ready) {
    const lower = prices[0]!;
    const upper = prices[prices.length - 1]!;
    const values = [lower, upper, mark, ...markers.map((marker) => marker.value)];
    const low = Math.min(...values);
    const high = Math.max(...values);
    const pad = Math.max(high - low, mark * 0.002) * 0.08;
    top = (value: number) => ((high + pad - value) / (high - low + pad * 2)) * 100;
  }

  const lower = prices[0];
  const upper = prices[prices.length - 1];
  const summary = ready
    ? `${buys} buy orders below the price and ${sells} sell orders above it, between ${price(lower)} and ${price(upper)}. Price now ${price(mark)}.`
    : "";

  return (
    <section className="gb-card gb-preview" aria-labelledby="gb-preview-title">
      <div className="gb-card-head">
        <h2 id="gb-preview-title" className="gb-card-title">
          Price levels
        </h2>
        <span className="gb-legend" aria-hidden="true">
          <span className="gb-key" data-side="buy" />
          Buy
          <span className="gb-key" data-side="sell" />
          Sell
        </span>
      </div>

      {ready && lower !== undefined && upper !== undefined ? (
        <div className="gb-ladder" role="img" aria-label={summary}>
          <div
            className="gb-ladder-band"
            style={{ top: `${top(upper).toFixed(3)}%`, height: `${(top(lower) - top(upper)).toFixed(3)}%` }}
          />
          {prices.map((level, index) => (
            <div key={index} className="gb-ladder-level" data-side={sides[index] ?? "none"} style={at(top(level))} />
          ))}
          {markers.map((marker) => (
            <div key={marker.key} className="gb-ladder-marker" data-kind={marker.kind} style={at(top(marker.value))}>
              <span className="num">
                {marker.label} {price(marker.value)}
              </span>
            </div>
          ))}
          <span className="gb-ladder-edge num" style={at(top(upper))}>
            {price(upper)}
          </span>
          <span className="gb-ladder-edge num" style={at(top(lower))}>
            {price(lower)}
          </span>
          <div className="gb-ladder-now" style={at(top(mark))}>
            <span className="gb-ladder-now-label num">{price(mark)}</span>
          </div>
        </div>
      ) : (
        <p className="gb-ladder-empty">Enter a price range to see where the orders go.</p>
      )}

      <dl className="gb-facts">
        <div>
          <dt>Each order</dt>
          <dd className="num">
            {estimate ? `≈ ${units(estimate.perOrderQty.toPrecision(3))} ${base}` : "—"}
            <small>{estimate ? `${money(estimate.perOrderValue)} ${quote}` : ""}</small>
          </dd>
        </div>
        <div>
          <dt>Orders</dt>
          <dd className="num">
            {ready ? `${buys} buy · ${sells} sell` : "—"}
            <small>
              {initial
                ? `${initial.side === "buy" ? "Buys" : "Sells"} ${initial.legs} orders' worth first`
                : ready
                  ? "Starts flat"
                  : ""}
            </small>
          </dd>
        </div>
        <div>
          <dt>Profit per grid</dt>
          <dd className={`num ${ready && profit.min <= 0 ? "down" : ""}`}>
            {ready ? (profit.min === profit.max ? `${profit.min.toFixed(2)}%` : `${profit.min.toFixed(2)}–${profit.max.toFixed(2)}%`) : "—"}
            <small>after fees</small>
          </dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd className="num">
            {width !== null ? `${width.toFixed(1)}% wide` : "—"}
            <small>{estimate ? `${money(estimate.totalValue)} ${quote} in orders` : ""}</small>
          </dd>
        </div>
      </dl>
    </section>
  );
}
