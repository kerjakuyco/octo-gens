import type { Trend } from "../../api/types";

/**
 * Small ways of showing a reading, shared by the market panel and by the
 * cards on an answer.
 */

const TRENDS: Record<Trend, { label: string; tone?: "up" | "down" }> = {
  uptrend: { label: "Uptrend", tone: "up" },
  downtrend: { label: "Downtrend", tone: "down" },
  mixed: { label: "Mixed" },
  unknown: { label: "No trend yet" },
};

export function TrendChip({ trend }: { trend: Trend }) {
  const { label, tone } = TRENDS[trend];
  return (
    <span className="chip" data-tone={tone}>
      {label}
    </span>
  );
}

/** Where the reading sits between 0 and 100, with the usual 30 and 70 marks. */
export function RsiBar({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  const at = Math.min(100, Math.max(0, value));
  return (
    <span className="rsi">
      <span className="rsi-track" aria-hidden="true">
        <span className="rsi-dot" style={{ left: `${at}%` }} />
      </span>
      <span className="num">{value.toFixed(1)}</span>
    </span>
  );
}

/** A MACD histogram in a word: momentum is rising above zero and falling below it. */
export function macdWords(value: number | null): { text: string; tone: string } {
  if (value === null) return { text: "—", tone: "muted" };
  if (value > 0) return { text: "Rising", tone: "up" };
  if (value < 0) return { text: "Falling", tone: "down" };
  return { text: "Flat", tone: "muted" };
}

/** The split of resting size between buyers and sellers. */
export function ShareBar({ bidPct }: { bidPct: number | null }) {
  if (bidPct === null) return null;
  const bid = Math.min(100, Math.max(0, bidPct));
  // Rounded once, so the two shares always add up to 100.
  const bids = Math.round(bid);
  return (
    <div className="share">
      <div className="share-bar" aria-hidden="true">
        <span className="share-bid" style={{ width: `${bid}%` }} />
      </div>
      <div className="share-legend num">
        <span className="up">Bids {bids}%</span>
        <span className="down">Asks {100 - bids}%</span>
      </div>
    </div>
  );
}
