import type { CSSProperties } from "react";
import type { Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { dayTime, direction, leverage, price, signedMoney, units } from "../../lib/format";
import { type JournalEntry, deleteJournalEntry, openJournalComposer, setupLabel } from "../../lib/journal";
import { instrumentFor } from "../../lib/market";
import { networkName } from "../../lib/network";
import { ask, focusMarket, navigate, openGrid, openTrade } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { OUTCOMES, planKept } from "./labels";

/** The message that asks the assistant about one entry, with its numbers and notes. */
function reviewMessage(entry: JournalEntry, base: string): string {
  return [
    `Review my ${base} ${entry.side} (${entry.leverage}x, ${setupLabel(entry.setup)}, ${entry.outcome === "open" ? "still open" : entry.outcome}) journal entry:`,
    `- Entry ${entry.entryPrice || "—"}, exit or target ${entry.exitPrice || "—"}, size ${entry.qty || "—"}, profit or loss ${entry.pnlUsd || "—"} USDT, planned reward to risk ${entry.rrPlanned || "—"}`,
    `- Why: ${entry.thesis || "—"}`,
    `- What I learned: ${entry.lesson || "—"}`,
    "Tell me briefly how good the setup and the risk management were, and what to watch on the chart now.",
  ].join("\n");
}

interface JournalEntryCardProps {
  entry: JournalEntry;
  snapshot: Snapshot;
  index: number;
  busy: boolean;
  /** Show the entry's network: the page shows both. */
  showNetwork: boolean;
}

/** One logged trade: what it was, how it went, why it was taken and what it taught. */
export function JournalEntryCard({ entry, snapshot, index, busy, showNetwork }: JournalEntryCardProps) {
  const instrument = instrumentFor(snapshot, entry.symbol);
  const quote = instrument.quote || "USDT";
  const outcome = OUTCOMES[entry.outcome];
  const pnl = entry.pnlUsd.trim() ? Number(entry.pnlUsd) : Number.NaN;
  const passed =
    (entry.checklist.stopRespected ? 1 : 0) + (entry.checklist.sizedWithinRisk ? 1 : 0) + (entry.checklist.followedPlan ? 1 : 0);
  const plan = planKept(passed);
  const grid = entry.setup === "Grid Bot";

  return (
    <li className="av-entry" style={{ "--i": Math.min(index, 8) } as CSSProperties}>
      <header className="av-entry-head">
        <button type="button" className="symbol" onClick={() => void focusMarket(entry.symbol)}>
          <InstrumentMark base={instrument.base} size="sm" />
          <span className="symbol-name">
            {instrument.base}-{quote}
          </span>
        </button>
        <span className="chip" data-tone={entry.side === "long" ? "up" : "down"}>
          {entry.side === "long" ? "Long" : "Short"} {leverage(entry.leverage)}
        </span>
        <span className="chip">{setupLabel(entry.setup)}</span>
        <span className="chip" data-tone={outcome.tone}>
          {outcome.label}
        </span>
        <span className="chip num" data-tone={plan.tone} title="Stop-loss kept, sized within risk, plan followed">
          {plan.label}
        </span>
        <span className="grow" />
        {Number.isFinite(pnl) ? (
          <span className={`av-entry-pnl num ${direction(pnl)}`}>
            {signedMoney(pnl.toFixed(2))} {quote}
          </span>
        ) : null}
      </header>

      {entry.thesis || entry.lesson ? (
        <div className="av-entry-notes">
          {entry.thesis ? (
            <div>
              <span className="av-entry-label">Why</span>
              <p>{entry.thesis}</p>
            </div>
          ) : null}
          {entry.lesson ? (
            <div>
              <span className="av-entry-label">What I learned</span>
              <p>{entry.lesson}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="av-entry-foot">
        <div className="av-entry-meta num">
          {grid ? (
            <span>
              Range {entry.entryPrice ? price(entry.entryPrice) : "—"} – {entry.exitPrice ? price(entry.exitPrice) : "—"}
            </span>
          ) : (
            <span>
              {entry.entryPrice ? price(entry.entryPrice) : "—"} → {entry.exitPrice ? price(entry.exitPrice) : "—"}
              {entry.outcome === "open" ? " target" : ""}
            </span>
          )}
          {entry.qty ? (
            <span>
              {units(entry.qty)} {instrument.base}
            </span>
          ) : null}
          {entry.rrPlanned ? <span>Aimed for {entry.rrPlanned}× the risk</span> : null}
          {showNetwork ? (
            <span className="chip" data-tone={entry.network === "mainnet" ? "warn" : undefined}>
              {networkName(entry.network)}
            </span>
          ) : null}
          <span>{dayTime(entry.createdAt)}</span>
        </div>

        <div className="av-entry-actions">
          {snapshot.assistant.ready ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => {
                navigate("chat");
                void ask(reviewMessage(entry, instrument.base));
              }}
            >
              <Icon name="assistant" size={13} />
              <span>Ask AI</span>
            </button>
          ) : null}
          {grid ? (
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => openGrid(entry.symbol)}>
              <Icon name="grid" size={13} />
              <span>Grid bots</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => openTrade(null, { symbol: entry.symbol, side: entry.side === "long" ? "buy" : "sell" })}
            >
              Trade {instrument.base}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => openJournalComposer(entry, entry.id)}>
            Edit
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete the ${instrument.base} entry`}
            onClick={() => deleteJournalEntry(entry.id)}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </footer>
    </li>
  );
}
