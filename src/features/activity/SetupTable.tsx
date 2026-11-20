import { useId, useMemo, useState } from "react";
import { direction, signedMoney } from "../../lib/format";
import { type JournalMetrics, type SetupPerformance, setupLabel } from "../../lib/journal";

type SortKey = "setup" | "total" | "winRate" | "average" | "net" | "plan";
type SortDir = "ascending" | "descending";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "setup", label: "Setup", numeric: false },
  { key: "total", label: "Trades", numeric: true },
  { key: "winRate", label: "Win rate", numeric: true },
  { key: "average", label: "Average", numeric: true },
  { key: "net", label: "Total", numeric: true },
  { key: "plan", label: "Kept to plan", numeric: true },
];

function value(row: SetupPerformance, key: SortKey): number {
  switch (key) {
    case "total":
      return row.total;
    case "winRate":
      return row.winRatePct ?? -1;
    case "average":
      return row.avgPnlUsd ?? 0;
    case "plan":
      return row.disciplinePct;
    default:
      return row.netPnlUsd;
  }
}

/** How each setup did: trades, win rate, average and total profit, and how often the plan was kept. */
export function SetupTable({ metrics }: { metrics: JournalMetrics }) {
  const titleId = useId();
  const [key, setKey] = useState<SortKey>("net");
  const [dir, setDir] = useState<SortDir>("descending");

  const rows = useMemo(() => {
    const factor = dir === "ascending" ? 1 : -1;
    return [...metrics.bySetup].sort((left, right) =>
      key === "setup"
        ? factor * collator.compare(setupLabel(left.setup), setupLabel(right.setup))
        : factor * (value(left, key) - value(right, key)),
    );
  }, [metrics.bySetup, key, dir]);

  if (rows.length === 0) return null;

  function sortBy(next: SortKey) {
    if (next === key) setDir(dir === "ascending" ? "descending" : "ascending");
    else {
      setKey(next);
      setDir(next === "setup" ? "ascending" : "descending");
    }
  }

  return (
    <section className="av-setups" aria-labelledby={titleId}>
      <h3 id={titleId} className="av-subtitle">
        How each setup did
      </h3>
      <div className="av-table-wrap" role="region" aria-labelledby={titleId} tabIndex={0}>
        <table className="av-table">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric ? "num" : undefined}
                  aria-sort={key === column.key ? dir : undefined}
                >
                  <button type="button" className="av-sort" data-active={key === column.key} onClick={() => sortBy(column.key)}>
                    <span>{column.label}</span>
                    <span className="av-sort-mark" aria-hidden="true" data-dir={key === column.key ? dir : undefined} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.setup}>
                <th scope="row">
                  <span className="av-cell-main">{setupLabel(row.setup)}</span>
                  <span className="av-cell-sub num">
                    {row.wins} won · {row.losses} lost{row.total > row.closed ? ` · ${row.total - row.closed} open` : ""}
                  </span>
                </th>
                <td className="num">{row.total}</td>
                <td className="num">{row.winRatePct !== null ? `${row.winRatePct.toFixed(0)}%` : "—"}</td>
                <td className={`num ${direction(row.avgPnlUsd ?? 0)}`}>
                  {row.avgPnlUsd !== null ? signedMoney(row.avgPnlUsd.toFixed(2)) : "—"}
                </td>
                <td className={`num ${direction(row.netPnlUsd)}`}>
                  <strong>{signedMoney(row.netPnlUsd.toFixed(2))}</strong>
                </td>
                <td className="num">
                  <span className="chip num" data-tone={row.disciplinePct >= 85 ? "up" : row.disciplinePct >= 65 ? "warn" : "down"}>
                    {row.disciplinePct.toFixed(0)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="av-note">Average and total are in USDT, from the profit or loss you logged.</p>
    </section>
  );
}
