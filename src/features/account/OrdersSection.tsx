import { useId, useMemo, useState } from "react";
import type { GridBotView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { Pagination } from "../../components/Pagination";
import { Segmented } from "../../components/Segmented";
import { dayTime, money, orderType, price, units } from "../../lib/format";
import { activeBotFor, botForOrder } from "../../lib/grid";
import { paginateList } from "../../lib/pagination";
import type { EnrichedOrder } from "../../lib/portfolio";
import { cancelAllOrders, cancelOrder, focusMarket, openGrid } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import type { BotOrderTarget, MarketTarget } from "./CancelDialogs";
import { distanceText, orderRole } from "./labels";

type Owner = "all" | "mine" | "bots";
type SortKey = "market" | "order" | "price" | "distance" | "size" | "time";
type SortDir = "ascending" | "descending";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** An order with the bot that placed it, when a grid bot did. */
interface Row {
  item: EnrichedOrder;
  bot: GridBotView | null;
}

interface OrdersSectionProps {
  items: EnrichedOrder[];
  bots: GridBotView[];
  busy: boolean;
  /** Ask before cancelling one of a bot's orders. */
  onCancelBotOrder: (target: BotOrderTarget) => void;
  /** Ask before cancelling every order in a market where a bot is at work. */
  onCancelMarket: (target: MarketTarget) => void;
}

/** The exchange's order type when it says more than the role does, and whether the order only reduces. */
function typeNote(item: EnrichedOrder): string {
  const role = orderRole(item).toLowerCase();
  const type = orderType(item.order.type);
  const parts = role.startsWith(type.toLowerCase()) ? [] : [type];
  if (item.order.reduceOnly && !role.includes("reduce") && item.roleLabel !== "Stop-Loss Guard" && item.roleLabel !== "Take-Profit Target") {
    parts.push("reduce only");
  }
  return parts.join(" · ");
}

function priceText(item: EnrichedOrder): string {
  const { order } = item;
  const trigger = order.stopPrice && Number(order.stopPrice) > 0 ? order.stopPrice : null;
  const limit = order.price && Number(order.price) > 0 ? order.price : null;
  if (trigger && limit) return `${price(trigger)} → ${price(limit)}`;
  if (trigger) return price(trigger);
  if (limit) return price(limit);
  return "At market";
}

/**
 * The orders waiting on the exchange: the trader's own, and those a grid bot placed, each marked as the
 * bot's. Cancelling a bot's order, or every order in a market where a bot is at work, asks first, because
 * it changes what the bot does.
 */
export function OrdersSection({ items, bots, busy, onCancelBotOrder, onCancelMarket }: OrdersSectionProps) {
  const titleId = useId();
  const captionId = useId();
  const marketId = useId();
  const [owner, setOwner] = useState<Owner>("all");
  const [market, setMarket] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("descending");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const rows: Row[] = useMemo(
    () => items.map((item) => ({ item, bot: botForOrder(bots, item.order) })),
    [items, bots],
  );
  const botCount = rows.filter((row) => row.bot !== null).length;

  const markets = useMemo(() => {
    const counts = new Map<string, { base: string; count: number }>();
    for (const { item } of rows) {
      const held = counts.get(item.order.symbol);
      if (held) held.count += 1;
      else counts.set(item.order.symbol, { base: item.base, count: 1 });
    }
    return [...counts.entries()].sort((a, b) => collator.compare(a[1].base, b[1].base));
  }, [rows]);

  const shown = useMemo(() => {
    const factor = sortDir === "ascending" ? 1 : -1;
    return rows
      .filter((row) => (owner === "all" ? true : owner === "bots" ? row.bot !== null : row.bot === null))
      .filter((row) => market === "all" || row.item.order.symbol === market)
      .sort((a, b) => {
        const left = a.item;
        const right = b.item;
        switch (sortKey) {
          case "market":
            return factor * collator.compare(left.base, right.base);
          case "order":
            return factor * collator.compare(orderRole(left), orderRole(right));
          case "price":
            return factor * ((left.effectivePriceNum ?? 0) - (right.effectivePriceNum ?? 0));
          case "distance":
            return factor * (Math.abs(left.distanceFromMarkPct ?? 0) - Math.abs(right.distanceFromMarkPct ?? 0));
          case "size":
            return factor * (Number(left.order.qty) - Number(right.order.qty));
          default:
            return factor * collator.compare(left.order.time, right.order.time);
        }
      });
  }, [rows, owner, market, sortKey, sortDir]);

  const slice = useMemo(() => paginateList(shown, page, pageSize), [shown, page, pageSize]);

  function sortBy(key: SortKey) {
    setPage(1);
    if (sortKey === key) setSortDir((dir) => (dir === "ascending" ? "descending" : "ascending"));
    else {
      setSortKey(key);
      setSortDir(key === "time" ? "descending" : "ascending");
    }
  }

  /** Cancels a market's orders, asking first when a bot is at work there. */
  function cancelMarket(symbol: string) {
    const inMarket = rows.filter((row) => row.item.order.symbol === symbol);
    const bot = activeBotFor(bots, symbol);
    const botOrders = inMarket.filter((row) => row.bot !== null).map((row) => row.item);
    const first = inMarket[0];
    if (bot && botOrders.length > 0 && first) {
      onCancelMarket({
        symbol,
        base: first.item.base,
        mine: inMarket.filter((row) => row.bot === null).map((row) => row.item),
        botOrders,
        bot,
      });
      return;
    }
    void cancelAllOrders(symbol);
  }

  function cancel(row: Row) {
    const { order } = row.item;
    if (row.bot && (row.bot.status === "running" || row.bot.status === "waiting")) {
      onCancelBotOrder({ item: row.item, bot: row.bot });
      return;
    }
    void cancelOrder(order.symbol, order.id);
  }

  function header(key: SortKey, label: string, numeric = false, extra = "") {
    const className = [numeric ? "num" : "", extra].filter(Boolean).join(" ") || undefined;
    return (
      <th scope="col" className={className} aria-sort={sortKey === key ? sortDir : undefined}>
        <button type="button" className={`ac-sort-btn${numeric ? " ac-sort-num" : ""}`} onClick={() => sortBy(key)}>
          <span>{label}</span>
          <span className="ac-sort-icon" aria-hidden="true" />
        </button>
      </th>
    );
  }

  const selected = markets.find(([symbol]) => symbol === market)?.[1];
  const several = markets.filter(([, info]) => info.count > 1);

  return (
    <section className="ac-section" aria-labelledby={titleId}>
      <div className="ac-section-head">
        <h2 id={titleId} className="ac-section-title">
          Open orders <span className="ac-count num">{items.length}</span>
        </h2>
        {items.length > 0 && botCount > 0 ? (
          <Segmented
            label="Whose orders"
            value={owner}
            options={[
              { value: "all", label: `All ${items.length}` },
              { value: "mine", label: `Yours ${items.length - botCount}` },
              { value: "bots", label: `Grid bots ${botCount}` },
            ]}
            onChange={(next) => {
              setOwner(next);
              setPage(1);
            }}
          />
        ) : null}
        <span className="grow" />
        {markets.length > 1 ? (
          <label className="ac-sort" htmlFor={marketId}>
            <span className="muted">Market</span>
            <select
              id={marketId}
              className="ac-select"
              value={market}
              onChange={(event) => {
                setMarket(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All markets</option>
              {markets.map(([symbol, info]) => (
                <option key={symbol} value={symbol}>
                  {info.base} ({info.count})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {selected && selected.count > 1 ? (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => cancelMarket(market)}>
            Cancel all {selected.base} ({selected.count})
          </button>
        ) : market === "all" && several.length > 0 ? (
          <Menu label="Cancel every order in a market" triggerClass="btn btn-sm btn-ghost" align="end" trigger={<span>Cancel all…</span>}>
            {several.map(([symbol, info]) => (
              <MenuItem
                key={symbol}
                label={`Cancel all ${info.base} orders`}
                sub={`${info.count} orders${activeBotFor(bots, symbol) ? ", some the grid bot's" : ""}`}
                disabled={busy}
                onSelect={() => cancelMarket(symbol)}
              />
            ))}
          </Menu>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="ac-empty">No orders are waiting on the exchange.</p>
      ) : shown.length === 0 ? (
        <p className="ac-empty">No orders match.</p>
      ) : (
        <>
          <div className="visually-hidden" role="status">
            {shown.length} orders, sorted by {sortKey}, {sortDir}
          </div>
          <div className="table-wrap ac-table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
            <table className="table ac-table">
              <caption id={captionId} className="visually-hidden">
                Orders waiting on the exchange
              </caption>
              <thead>
                <tr>
                  {header("market", "Market")}
                  {header("order", "Order")}
                  <th scope="col">Side</th>
                  {header("price", "Price", true)}
                  {header("distance", "From the price now", true, "ac-wide-only")}
                  {header("size", "Size", true)}
                  {header("time", "Placed", true, "ac-wide-only")}
                  <th scope="col" className="num">
                    <span className="visually-hidden">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {slice.items.map((row) => {
                  const { item, bot } = row;
                  const { order } = item;
                  return (
                    <tr key={order.id} data-owner={bot ? "bot" : "mine"}>
                      <th scope="row">
                        <button type="button" className="symbol" onClick={() => void focusMarket(order.symbol)}>
                          <InstrumentMark base={item.base} size="sm" />
                          <span className="symbol-name">{item.base}</span>
                        </button>
                      </th>
                      <td>
                        <span className="cell-main ac-order-kind">
                          {orderRole(item)}
                          {bot ? (
                            <button
                              type="button"
                              className="chip ac-bot-chip"
                              title={`Placed by your ${bot.base} grid bot`}
                              onClick={() => openGrid(order.symbol)}
                            >
                              <Icon name="grid" size={11} />
                              Grid bot
                            </button>
                          ) : null}
                        </span>
                        {typeNote(item) ? <span className="cell-sub">{typeNote(item)}</span> : null}
                      </td>
                      <td>
                        <span className="chip" data-tone={order.side === "buy" ? "up" : "down"}>
                          {order.side === "buy" ? "Buy" : "Sell"}
                        </span>
                      </td>
                      <td className="num">
                        <span className="cell-main">{priceText(item)}</span>
                        {item.markPrice !== null ? <span className="cell-sub">Now {price(String(item.markPrice))}</span> : null}
                      </td>
                      <td className="num muted ac-wide-only">{distanceText(item.distanceFromMarkPct)}</td>
                      <td className="num">
                        <span className="cell-main">
                          {units(order.qty)} {item.base}
                        </span>
                        {Number(order.filled) > 0 ? (
                          <span className="cell-sub">{units(order.filled)} filled</span>
                        ) : item.estNotional !== null ? (
                          <span className="cell-sub">
                            ≈ {money(item.estNotional.toFixed(2))} {item.quote}
                          </span>
                        ) : null}
                      </td>
                      <td className="num muted ac-wide-only">{dayTime(order.time)}</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          aria-label={`Cancel the ${orderRole(item).toLowerCase()} ${order.side} on ${item.base}${bot ? ", placed by the grid bot" : ""}`}
                          onClick={() => cancel(row)}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {shown.length > 10 ? (
            <Pagination
              label="Orders pages"
              itemLabel="orders"
              slice={slice}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
