/** The words the Account page uses, kept in one place so they stay plain and the same everywhere. */

import type { AccountView, RiskView } from "../../api/types";
import { money } from "../../lib/format";
import type { EnrichedOrder, ExposureBias, HealthTier } from "../../lib/portfolio";

export type Tone = "up" | "down" | "warn" | undefined;

/** What an order is for, in plain words. */
export function orderRole(item: EnrichedOrder): string {
  switch (item.roleLabel) {
    case "Stop-Loss Guard":
      return "Stop-loss";
    case "Take-Profit Target":
      return "Take-profit";
    case "Reduce Limit":
      return "Limit, reduce only";
    case "Limit Entry":
      return "Limit";
    default:
      return "Trigger";
  }
}

/** How much of the account's margin is in use, as a word and a colour. */
export const MARGIN_USE: Record<HealthTier, { label: string; tone: Tone }> = {
  healthy: { label: "Plenty free", tone: "up" },
  moderate: { label: "Over half in use", tone: "warn" },
  elevated: { label: "Mostly in use", tone: "down" },
};

/** Which way the open positions lean. */
export function exposureLabel(bias: ExposureBias, positions: number): { label: string; tone: Tone } {
  if (positions === 0) return { label: "No positions", tone: undefined };
  if (bias === "long") return { label: "Mostly long", tone: "up" };
  if (bias === "short") return { label: "Mostly short", tone: "down" };
  return { label: "Balanced", tone: undefined };
}

/** The margin mode new positions use, as Settings names it. */
export function marginMode(account: AccountView, risk: RiskView): string {
  if (account.multiAssets) return "Multi-Assets, cross margin";
  return risk.isolated ? "Isolated margin" : "Cross margin";
}

/**
 * Funding for the next eight hours, signed from the trader's side: positive is received, negative paid.
 * Amounts under half a cent read as nothing due.
 */
export function fundingText(value: number | null): { amount: string; words: string; tone: Tone } {
  if (value === null || !Number.isFinite(value) || Math.abs(value) < 0.005) {
    return { amount: "0.00", words: "Nothing due", tone: undefined };
  }
  const amount = `${value > 0 ? "+" : "−"}${money(Math.abs(value).toFixed(2))}`;
  return value > 0
    ? { amount, words: "You receive it, roughly", tone: "up" }
    : { amount, words: "You pay it, roughly", tone: "down" };
}

/** A position's funding for the next eight hours, in a few words. */
export function positionFunding(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (Math.abs(value) < 0.005) return "No funding due";
  return value > 0 ? `Receives ${money(value.toFixed(2))} per 8h` : `Pays ${money(Math.abs(value).toFixed(2))} per 8h`;
}

/** How far the price has moved since entry, from the position's side: `1.20% in your favour`. */
export function moveText(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "";
  if (Math.abs(pct) < 0.005) return "Flat since entry";
  return `${Math.abs(pct).toFixed(2)}% ${pct > 0 ? "in your favour" : "against you"}`;
}

/** Where an order's price sits against the price now: `1.20% above`. */
export function distanceText(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  if (Math.abs(pct) < 0.005) return "At the price";
  return `${Math.abs(pct).toFixed(2)}% ${pct > 0 ? "above" : "below"}`;
}
