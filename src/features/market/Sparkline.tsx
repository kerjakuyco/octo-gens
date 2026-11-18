const WIDTH = 56;
const HEIGHT = 22;
const PAD = 2;

/** The last thirty daily closes plus the current price, as a single stroke. */
export function Sparkline({ closes, price }: { closes: string[]; price: string }) {
  const values = [...closes.slice(-29), price].map(Number).filter((value) => Number.isFinite(value));
  if (values.length < 2) return <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" />;

  const low = Math.min(...values);
  const high = Math.max(...values);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * WIDTH;
      const y = high === low ? HEIGHT / 2 : PAD + (1 - (value - low) / (high - low)) * (HEIGHT - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = values[values.length - 1]! >= values[0]!;

  return (
    <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
      <polyline points={points} stroke={rising ? "var(--up)" : "var(--down)"} />
    </svg>
  );
}
