import type { CSSProperties } from "react";
import type { GridDirection, GridLevelView, GridSpacing } from "../../api/types";
import { price } from "../../lib/format";

/** Where a price sits between the ends of a range, in percent, kept on the bar. */
function place(value: number, lower: number, upper: number): number {
  if (!(upper > lower)) return 50;
  return Math.min(100, Math.max(0, ((value - lower) / (upper - lower)) * 100));
}

interface GridRangeProps {
  lower: string;
  upper: string;
  /** The price now, marked on the bar; null when unknown. */
  mark: string | null;
  /** The grid's lines, each with the order waiting on it. */
  levels?: readonly GridLevelView[];
  /** A thinner bar without the price labels, for lists. */
  compact?: boolean;
}

/**
 * A grid bot's range as a bar: its lines along it, green where it buys and red where it sells, and a
 * mark where the price is now. A price outside the range sits at the end it left by.
 */
export function GridRange({ lower, upper, mark, levels = [], compact = false }: GridRangeProps) {
  const low = Number(lower);
  const high = Number(upper);
  const now = mark === null ? null : Number(mark);
  const outside = now !== null && (now < low || now > high);
  const where =
    now === null ? "" : outside ? `, price ${price(now)} outside the range` : `, price ${price(now)} inside the range`;
  return (
    <div
      className="grid-range"
      data-compact={compact || undefined}
      role="img"
      aria-label={`Range ${price(low)} to ${price(high)}${where}`}
    >
      <div className="grid-range-track">
        {levels.map((level, index) => (
          <span
            key={level.index}
            className="grid-range-line"
            data-side={level.side ?? undefined}
            style={{ left: `${place(Number(level.price), low, high)}%`, "--i": index } as CSSProperties}
          />
        ))}
        {now !== null ? (
          <span
            className="grid-range-mark"
            data-outside={outside || undefined}
            style={{ left: `${place(now, low, high)}%` }}
          />
        ) : null}
      </div>
      {compact ? null : (
        <div className="grid-range-scale num">
          <span>{price(low)}</span>
          {now !== null ? <span className="grid-range-now">Now {price(now)}</span> : null}
          <span>{price(high)}</span>
        </div>
      )}
    </div>
  );
}

/** A grid bot's direction as a word, and the side colour that goes with it. */
export function gridDirectionLabel(direction: GridDirection): { text: string; tone?: "up" | "down" } {
  if (direction === "long") return { text: "Long grid", tone: "up" };
  if (direction === "short") return { text: "Short grid", tone: "down" };
  return { text: "Neutral grid" };
}

/** How the lines are spread over the range, in plain words. */
export function spacingLabel(spacing: GridSpacing): string {
  return spacing === "geometric" ? "equal % gaps" : "equal price gaps";
}

/** What each grid earns when the price crosses it and comes back, after fees. */
export function perGridLabel(min: number, max: number): string {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "—";
  return Math.abs(max - min) < 0.005 ? `${min.toFixed(2)}%` : `${min.toFixed(2)}% – ${max.toFixed(2)}%`;
}
