import type { InstrumentView } from "../../api/types";

/** Two-letter mark. Circles are crypto; rounded squares are tokenized stocks. */
export function InstrumentMark({ instrument }: { instrument: Pick<InstrumentView, "ticker" | "kind"> }) {
  return (
    <span className="mark" data-kind={instrument.kind} aria-hidden="true">
      {instrument.ticker.slice(0, 2).toUpperCase()}
    </span>
  );
}
