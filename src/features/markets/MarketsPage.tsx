import { useMemo, useState } from "react";
import type { MarketRow } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { compact, direction, fundingRate, percent, plural, price } from "../../lib/format";
import { usePolled } from "../../lib/hooks";
import { matchMarkets } from "../../lib/market";
import { focusMarket, request, useApp, useSnapshot, watchAdd, watchRemove } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";

type Filter = "all" | "watchlist" | "gainers" | "losers" | "funding";
type SortKey = "market" | "price" | "change" | "volume" | "funding";

interface Sort {
  key: SortKey;
  descending: boolean;
}

const FILTERS: SegmentOption<Filter>[] = [
  { value: "all", label: "All" },
  { value: "watchlist", label: "Watchlist" },
  { value: "gainers", label: "Gainers" },
  { value: "losers", label: "Losers" },
  { value: "funding", label: "Funding" },
];

/**
 * The order each filter lists markets in until a column is clicked. Every market is listed most
 * traded first: the order the exchange sends them in is its own, and says nothing a trader needs.
 */
const FILTER_SORT: Record<Filter, Sort | null> = {
  all: { key: "volume", descending: true },
  watchlist: null,
  gainers: { key: "change", descending: true },
  losers: { key: "change", descending: false },
  funding: { key: "funding", descending: true },
};

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "market", label: "Market", numeric: false },
  { key: "price", label: "Price", numeric: true },
  { key: "change", label: "24h", numeric: true },
  { key: "volume", label: "Volume", numeric: true },
  { key: "funding", label: "Funding", numeric: true },
];

/** Rows drawn at once. The exchange lists several hundred markets; the rest are one press away. */
const PAGE = 100;
const REFRESH_MS = 30_000;

function figure(row: MarketRow, key: SortKey): number {
  switch (key) {
    case "price":
      return Number(row.price);
    case "change":
      return row.changePct ?? Number.NaN;
    case "volume":
      return Number(row.quoteVolume24h ?? Number.NaN);
    case "funding":
      return row.fundingRatePct ?? Number.NaN;
    default:
      return Number.NaN;
  }
}

function sorted(rows: MarketRow[], sort: Sort): MarketRow[] {
  const way = sort.descending ? -1 : 1;
  if (sort.key === "market") {
    return [...rows].sort((left, right) => way * left.base.localeCompare(right.base));
  }
  return [...rows].sort((left, right) => {
    const a = figure(left, sort.key);
    const b = figure(right, sort.key);
    // A market with no reading sorts last whichever way the column runs.
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
    return way * (a - b);
  });
}

/** The best market by one reading, for the strip above the table. */
function leader(rows: MarketRow[], key: SortKey, descending: boolean): MarketRow | undefined {
  return sorted(rows, { key, descending }).find((row) => !Number.isNaN(figure(row, key)));
}

interface HighlightProps {
  label: string;
  row: MarketRow | undefined;
  value: string;
  tone?: string;
}

function Highlight({ label, row, value, tone }: HighlightProps) {
  return (
    <button type="button" className="highlight" disabled={!row} onClick={() => row && void focusMarket(row.symbol)}>
      <span className="highlight-label">{label}</span>
      <span className="highlight-main">
        <span className="highlight-name truncate">{row?.base ?? "—"}</span>
        <span className={`num ${tone ?? ""}`}>{row ? value : ""}</span>
      </span>
    </button>
  );
}

/** Every market on the network: search, filter, sort, watch, and open one in the panel. */
export function MarketsPage() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const overview = usePolled(snapshot.network, () => request((api) => api.marketOverview()), REFRESH_MS);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort | null>(null);
  const [shown, setShown] = useState(PAGE);

  const all = overview.data;
  const custom = useMemo(
    () => new Map(snapshot.instruments.map((item) => [item.symbol, item.custom])),
    [snapshot.instruments],
  );

  const rows = useMemo(() => {
    if (!all) return [];
    let list = query.trim() ? matchMarkets(all, query) : all;
    if (filter === "watchlist") list = list.filter((row) => custom.has(row.symbol));
    else if (filter === "gainers") list = list.filter((row) => (row.changePct ?? 0) > 0);
    else if (filter === "losers") list = list.filter((row) => (row.changePct ?? 0) < 0);
    const order = sort ?? FILTER_SORT[filter];
    return order ? sorted(list, order) : list;
  }, [all, query, filter, sort, custom]);

  const order = sort ?? FILTER_SORT[filter];

  function sortBy(key: SortKey) {
    setShown(PAGE);
    // The first press sorts numbers largest first and names from A; the next one turns it around.
    setSort(order?.key === key ? { key, descending: !order.descending } : { key, descending: key !== "market" });
  }

  if (!all) {
    return (
      <div className="page">
        <div className="page-inner">
          {overview.error ? (
            <p className="note" data-tone="error" role="alert">
              {overview.error}
            </p>
          ) : (
            <p className="empty">
              <span className="spinner" />
            </p>
          )}
        </div>
      </div>
    );
  }

  const gainer = leader(all, "change", true);
  const loser = leader(all, "change", false);
  const funding = leader(all, "funding", true);
  const traded = leader(all, "volume", true);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="highlights">
          <Highlight label="Top gainer" row={gainer} value={percent(gainer?.changePct)} tone="up" />
          <Highlight label="Top loser" row={loser} value={percent(loser?.changePct)} tone="down" />
          <Highlight label="Highest funding" row={funding} value={fundingRate(funding?.fundingRatePct)} />
          <Highlight label="Most traded" row={traded} value={compact(traded?.quoteVolume24h)} />
        </div>

        <div className="screener-bar">
          <label className="search screener-search">
            <Icon name="search" size={16} />
            <input
              className="input"
              type="search"
              aria-label="Search markets"
              placeholder="Search"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setShown(PAGE);
              }}
            />
          </label>
          <Segmented
            label="Show"
            value={filter}
            options={FILTERS}
            onChange={(next) => {
              setFilter(next);
              setSort(null);
              setShown(PAGE);
            }}
          />
          <span className="screener-count num">{plural(rows.length, "market")}</span>
        </div>

        <div className="table-wrap">
          <table className="table screener">
            <thead>
              <tr>
                <th scope="col" className="col-star">
                  <span className="visually-hidden">Watchlist</span>
                </th>
                {COLUMNS.map((column) => {
                  const current = order?.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      className={column.numeric ? "num" : undefined}
                      aria-sort={current ? (order?.descending ? "descending" : "ascending") : undefined}
                    >
                      <button type="button" className="sort" data-current={current} onClick={() => sortBy(column.key)}>
                        {column.label}
                        <span className="sort-arrow" data-way={current ? (order?.descending ? "down" : "up") : undefined} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((row) => {
                const watched = custom.has(row.symbol);
                const pinned = watched && custom.get(row.symbol) === false;
                return (
                  <tr
                    key={row.symbol}
                    data-current={row.symbol === snapshot.focus}
                    onClick={() => void focusMarket(row.symbol)}
                  >
                    <td className="col-star">
                      <button
                        type="button"
                        className="icon-btn star"
                        aria-label={watched ? `Remove ${row.base} from watchlist` : `Add ${row.base} to watchlist`}
                        aria-pressed={watched}
                        disabled={busy || pinned}
                        onClick={(event) => {
                          event.stopPropagation();
                          void (watched ? watchRemove(row.symbol) : watchAdd(row.symbol));
                        }}
                      >
                        <Icon name={watched ? "starFilled" : "star"} size={16} />
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="symbol"
                        onClick={(event) => {
                          event.stopPropagation();
                          void focusMarket(row.symbol);
                        }}
                      >
                        <InstrumentMark base={row.base} size="sm" />
                        <span className="symbol-name">{row.base}</span>
                        <span className="muted">{row.quote}</span>
                      </button>
                    </td>
                    <td className="num">{price(row.price)}</td>
                    <td className={`num ${direction(row.changePct)}`}>{percent(row.changePct)}</td>
                    <td className="num">{compact(row.quoteVolume24h)}</td>
                    <td className={`num ${direction(row.fundingRatePct)}`}>{fundingRate(row.fundingRatePct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length === 0 ? <p className="empty">No market found</p> : null}
        {rows.length > shown ? (
          <div className="more">
            <button type="button" className="btn btn-secondary" onClick={() => setShown(shown + PAGE)}>
              Show more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
