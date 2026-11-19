import type { BookLevel, Network } from "../../api/types";
import { clockSeconds, compact, price, size } from "../../lib/format";
import { usePolled } from "../../lib/hooks";
import { tapePressure } from "../../lib/indicators";
import { request } from "../../state/app";
import { ShareBar } from "./Readings";

/** Levels shown on each side of the spread. */
const DEPTH = 8;
const TAPE = 14;
/** The book moves fast; it is read only while this tab is on screen. */
const FAST_MS = 4000;

interface LevelRowProps {
  level: BookLevel;
  side: "bid" | "ask";
  /** The largest running total in view, which fills the row. */
  deepest: number;
}

function LevelRow({ level, side, deepest }: LevelRowProps) {
  const share = Math.min(100, (Number(level.total) / deepest) * 100);
  return (
    <li className="book-row" data-side={side}>
      <span className="book-depth" style={{ width: `${share}%` }} aria-hidden="true" />
      <span className={side === "bid" ? "up" : "down"}>{price(level.price)}</span>
      <span>{size(level.size)}</span>
      <span className="muted">{size(level.total)}</span>
    </li>
  );
}

/** The order book around the spread, the split between buyers and sellers, and the latest trades. */
export function BookTab({ symbol, network, base }: { symbol: string; network: Network; base: string }) {
  const market = `${network}:${symbol}`;
  const book = usePolled(market, () => request((api) => api.orderBook(symbol)), FAST_MS);
  const trades = usePolled(market, () => request((api) => api.recentTrades(symbol)), FAST_MS);

  if (!book.data) {
    return book.error ? (
      <p className="note" data-tone="error" role="alert">
        {book.error}
      </p>
    ) : (
      <p className="panel-wait">
        <span className="spinner" />
      </p>
    );
  }

  const asks = book.data.asks.slice(0, DEPTH);
  const bids = book.data.bids.slice(0, DEPTH);
  const deepest = Math.max(Number(asks[asks.length - 1]?.total ?? 0), Number(bids[bids.length - 1]?.total ?? 0)) || 1;
  const flow = trades.data ? tapePressure(trades.data) : null;

  return (
    <>
      <div className="book num">
        <div className="book-cols" aria-hidden="true">
          <span>Price</span>
          <span>Size ({base})</span>
          <span>Total</span>
        </div>
        <ol className="book-side" aria-label="Asks">
          {[...asks].reverse().map((level) => (
            <LevelRow key={level.price} level={level} side="ask" deepest={deepest} />
          ))}
        </ol>
        <div className="book-mid">
          <span className="book-mid-price">{price(book.data.mid)}</span>
          <span className="muted">
            Spread {book.data.spreadBps === null ? "—" : `${book.data.spreadBps.toFixed(2)} bps`}
          </span>
        </div>
        <ol className="book-side" aria-label="Bids">
          {bids.map((level) => (
            <LevelRow key={level.price} level={level} side="bid" deepest={deepest} />
          ))}
        </ol>
      </div>

      <ShareBar bidPct={book.data.bidSharePct} />

      <div className="tape-head">
        <h3 className="panel-sub">Trades</h3>
        {flow ? (
          <span className={`tape-net num ${flow.netNotional >= 0 ? "up" : "down"}`}>
            {flow.netNotional >= 0 ? "+" : "−"}
            {compact(Math.abs(flow.netNotional))} net
          </span>
        ) : null}
      </div>

      {flow ? (
        <div className="share">
          <div className="share-bar" aria-hidden="true">
            <span className="share-bid" style={{ width: `${flow.buyPct}%` }} />
          </div>
          <div className="share-legend num">
            <span className="up">Buy flow {Math.round(flow.buyPct)}%</span>
            <span className="down">Sell {100 - Math.round(flow.buyPct)}%</span>
          </div>
        </div>
      ) : null}

      {trades.data ? (
        <ol className="tape num">
          {trades.data.slice(0, TAPE).map((trade, index) => (
            <li key={`${trade.time}:${index}`}>
              <span className="muted">{clockSeconds(trade.time)}</span>
              <span className={trade.side === "buy" ? "up" : "down"}>{price(trade.price)}</span>
              <span>{size(trade.size)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="panel-wait">{trades.error || <span className="spinner" />}</p>
      )}
    </>
  );
}
