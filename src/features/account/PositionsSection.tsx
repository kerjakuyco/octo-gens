import { useId, useMemo, useState } from "react";
import type { GridBotView, Network } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Pagination } from "../../components/Pagination";
import { Segmented } from "../../components/Segmented";
import { activeBotFor } from "../../lib/grid";
import { paginateList } from "../../lib/pagination";
import type { EnrichedPosition } from "../../lib/portfolio";
import { openTrade, prefillComposer } from "../../state/app";
import { PositionCard } from "./PositionCard";

type SideFilter = "all" | "long" | "short";
type PositionSort = "value" | "pnl" | "roe" | "liquidation";

const SORTS: { value: PositionSort; label: string }[] = [
  { value: "value", label: "Largest first" },
  { value: "pnl", label: "Profit and loss" },
  { value: "roe", label: "Return on margin" },
  { value: "liquidation", label: "Nearest to liquidation" },
];

interface PositionsSectionProps {
  items: EnrichedPosition[];
  bots: GridBotView[];
  network: Network;
  assistant: boolean;
  busy: boolean;
}

/** The open positions, largest first, to filter by side and sort by what matters now. */
export function PositionsSection({ items, bots, network, assistant, busy }: PositionsSectionProps) {
  const titleId = useId();
  const sortId = useId();
  const [side, setSide] = useState<SideFilter>("all");
  const [sort, setSort] = useState<PositionSort>("value");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const counts = useMemo(() => {
    let long = 0;
    for (const item of items) if (item.position.side === "long") long += 1;
    return { long, short: items.length - long };
  }, [items]);

  const shown = useMemo(() => {
    const list = side === "all" ? [...items] : items.filter((item) => item.position.side === side);
    return list.sort((a, b) => {
      if (sort === "pnl") return b.pnlNum - a.pnlNum;
      if (sort === "roe") return (b.roePct ?? 0) - (a.roePct ?? 0);
      if (sort === "liquidation") return (a.liqDistancePct ?? Infinity) - (b.liqDistancePct ?? Infinity);
      return b.notionalNum - a.notionalNum;
    });
  }, [items, side, sort]);

  const slice = useMemo(() => paginateList(shown, page, pageSize), [shown, page, pageSize]);

  return (
    <section className="ac-section" aria-labelledby={titleId}>
      <div className="ac-section-head">
        <h2 id={titleId} className="ac-section-title">
          Positions <span className="ac-count num">{items.length}</span>
        </h2>
        {items.length > 1 ? (
          <>
            <Segmented
              label="Show"
              value={side}
              options={[
                { value: "all", label: `All ${items.length}` },
                { value: "long", label: `Long ${counts.long}` },
                { value: "short", label: `Short ${counts.short}` },
              ]}
              onChange={(next) => {
                setSide(next);
                setPage(1);
              }}
            />
            <span className="grow" />
            <label className="ac-sort" htmlFor={sortId}>
              <span className="muted">Sort</span>
              <select
                id={sortId}
                className="ac-select"
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as PositionSort);
                  setPage(1);
                }}
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="ac-empty">
          <p>No open positions on {network === "mainnet" ? "mainnet" : "testnet"}.</p>
          <div className="ac-empty-actions">
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => openTrade()}>
              <Icon name="plus" size={14} />
              New order
            </button>
            {assistant ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                title="Puts /long in the message box, sized from your risk with a stop-loss"
                onClick={() => prefillComposer("long")}
              >
                <Icon name="assistant" size={14} />
                Plan one with AI
              </button>
            ) : null}
          </div>
        </div>
      ) : shown.length === 0 ? (
        <p className="ac-empty">No {side} positions.</p>
      ) : (
        <div className="ac-list">
          {slice.items.map((item, index) => (
            <PositionCard
              key={item.position.symbol}
              item={item}
              network={network}
              bot={activeBotFor(bots, item.position.symbol)}
              assistant={assistant}
              busy={busy}
              index={index}
            />
          ))}
          {shown.length > 10 ? (
            <Pagination
              label="Positions pages"
              itemLabel="positions"
              slice={slice}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
