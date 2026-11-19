/** The highest leverage limit a trader can set. The core refuses anything above it. */
export const LEVERAGE_CAP = 50;

/** Said under the field when what was typed is not a limit. */
export const LEVERAGE_RULE = `Enter a whole number from 1 to ${LEVERAGE_CAP}.`;

/** The leverage limit a typed value stands for, or null when it is not a whole number within the cap. */
export function parseLeverage(text: string): number | null {
  const typed = text.trim();
  if (!/^\d{1,3}$/.test(typed)) return null;
  const value = Number(typed);
  return value >= 1 && value <= LEVERAGE_CAP ? value : null;
}
