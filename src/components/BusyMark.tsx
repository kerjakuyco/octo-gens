import { useApp } from "../state/app";

/**
 * A small spinner while a command is on its way to the core. It waits a moment
 * before showing, so a command that answers at once does not flash it.
 */
export function BusyMark() {
  const working = useApp((state) => state.working);
  if (!working) return null;
  return <span className="spinner busy-mark" role="status" aria-label={working} title={working} />;
}
