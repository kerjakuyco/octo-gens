import { coinIcon } from "../../lib/coins";

/**
 * A market's mark: the coin's icon when the app has one, otherwise two letters of its name.
 * A leading multiplier is skipped, so `1000PEPE` reads `PE`.
 */
export function InstrumentMark({ base, size }: { base: string; size?: "sm" }) {
  const icon = coinIcon(base);
  if (icon) {
    return <img className="mark" data-size={size} data-icon="true" src={icon} alt="" draggable={false} />;
  }
  // `Array.from` splits by character rather than by UTF-16 unit, which matters for non-Latin symbols.
  const letters = Array.from(base.replace(/^\d+(?=\D)/, ""))
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="mark" data-size={size} aria-hidden="true">
      {letters}
    </span>
  );
}
