/**
 * Moving averages drawn over the chart. They are for display only: every
 * reading the assistant quotes is computed by the core.
 */

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values. Entries before the first full window are null.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  let sum = 0;
  for (let index = 0; index < period; index += 1) sum += values[index]!;
  let level = sum / period;
  out[period - 1] = level;
  const weight = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    level += (values[index]! - level) * weight;
    out[index] = level;
  }
  return out;
}
