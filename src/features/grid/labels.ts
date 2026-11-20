/** The words the grid bot pages use for directions, spacing and status, kept in one place. */

import type { GridDirection, GridSpacing, GridStatus } from "../../api/types";

export interface Choice<T extends string> {
  value: T;
  label: string;
  detail: string;
}

export const DIRECTIONS: readonly Choice<GridDirection>[] = [
  { value: "neutral", label: "Neutral", detail: "Starts flat. Buys below the price and sells above it." },
  { value: "long", label: "Long", detail: "Buys a position first, then sells it in steps as the price rises." },
  { value: "short", label: "Short", detail: "Sells a position first, then buys it back in steps as the price falls." },
];

export const SPACINGS: readonly Choice<GridSpacing>[] = [
  { value: "arithmetic", label: "Even price steps", detail: "The same distance in price between levels." },
  { value: "geometric", label: "Even percentage steps", detail: "The same percentage between levels." },
];

export function directionLabel(direction: GridDirection): string {
  return DIRECTIONS.find((item) => item.value === direction)?.label ?? direction;
}

export function spacingLabel(spacing: GridSpacing): string {
  return SPACINGS.find((item) => item.value === spacing)?.label ?? spacing;
}

/** A long reads as up and a short as down; neutral keeps no colour. */
export function directionTone(direction: GridDirection): "up" | "down" | undefined {
  if (direction === "long") return "up";
  if (direction === "short") return "down";
  return undefined;
}

export function statusLabel(status: GridStatus): { label: string; tone?: "up" | "down" | "warn" } {
  switch (status) {
    case "running":
      return { label: "Running", tone: "up" };
    case "waiting":
      return { label: "Waiting to start", tone: "warn" };
    case "error":
      return { label: "Needs attention", tone: "down" };
    default:
      return { label: "Stopped" };
  }
}

/** Whether a bot is still at work: running, or waiting for its start price. */
export function isActive(status: GridStatus): boolean {
  return status === "running" || status === "waiting";
}
