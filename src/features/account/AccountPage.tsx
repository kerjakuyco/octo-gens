import { useEffect, useId, useMemo, useState } from "react";
import type { AccountView, BalanceView, Network, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Pagination } from "../../components/Pagination";
import {
  balance,
  clock,
  dayTime,
  direction,
  leverage,
  money,
  orderType,
  percent,
  price,
  shortAddress,
  signedMoney,
  units,
} from "../../lib/format";
import {
  type JournalEntry,
  computeJournalMetrics,
  draftFromPosition,
  openJournalComposer,
  useJournal,
} from "../../lib/journal";
import { activeWallet, instrumentFor } from "../../lib/market";
import { networkName } from "../../lib/network";
import { paginateList } from "../../lib/pagination";
import {
  type EnrichedOrder,
  type EnrichedPosition,
  type PortfolioAnalytics,
  buildExecutionHistory,
  computePortfolioAnalytics,
  enrichOrders,
  enrichPositions,
} from "../../lib/portfolio";
import {
  ask,
  cancelAllOrders,
  cancelOrder,
  closePosition,
  focusMarket,
  fundWallet,
  navigate,
  openSettings,
  openTrade,
  refreshAccount,
  reloadAccount,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";

type AccountTab = "positions" | "orders" | "collateral" | "journal";
type PositionFilter = "all" | "long" | "short";
type PositionSort = "notional" | "pnl" | "roe" | "liq";
type OrderSortKey = "symbol" | "type" | "price" | "distance" | "qty" | "time";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function formatFundingCarry(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "0.00";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

function VaultBar({
  snapshot,
  account,
  busy,
  waiting,
}: {
  snapshot: Snapshot;
  account: AccountView;
  busy: boolean;
  waiting: boolean;
}) {
  const wallet = activeWallet(snapshot);
  const { network, risk } = snapshot;
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    if (!wallet.user || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(wallet.user).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function runAiAudit() {
    navigate("chat");
    void ask("Review my current portfolio positions, margin utilization, and liquidation risk.");
  }

  const marginMode = account.multiAssets ? "Multi-Assets Cross" : risk.isolated ? "Isolated" : "Cross";

  return (
    <header className="portfolio-head">
      <div className="portfolio-identity">
        <div className="vault-pill">
          <span className="dot" data-tone="up" />
          <span className="vault-label">Vault</span>
          <span className="mono num">{shortAddress(wallet.user)}</span>
          {wallet.user ? (
            <button
              type="button"
              className="icon-btn vault-copy"
              aria-label={copied ? "Wallet address copied" : "Copy wallet address"}
              title={copied ? "Copied" : "Copy address"}
              onClick={copyAddress}
            >
              <Icon name={copied ? "check" : "copy"} size={13} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="vault-pill vault-pill-btn"
          onClick={() => openSettings("trading")}
          title="Configure margin mode and leverage ceiling (Trade-only API agent)"
        >
          <span>{marginMode}</span>
          <span className="chip num">Max {risk.maxLeverage}x</span>
          <span className="chip">Trade-only</span>
        </button>

        <span className="muted num portfolio-sync">Updated {clock(account.asOf)}</span>
      </div>

      <div className="account-actions">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={busy || waiting}
          onClick={() => void fundWallet({ network, task: "deposit" })}
        >
          Deposit
        </button>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={busy || waiting}
          onClick={() => void fundWallet({ network, task: "withdraw" })}
        >
          Withdraw
        </button>
        {snapshot.assistant.ready ? (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy}
            onClick={runAiAudit}
          >
            <Icon name="assistant" size={14} />
            AI Risk Check
          </button>
        ) : null}
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void reloadAccount()}>
          <Icon name="refresh" size={14} />
          Refresh
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => openTrade()}>
          <Icon name="plus" size={14} />
          Place Order
        </button>
      </div>
    </header>
  );
}

function PortfolioOverview({
  account,
  analytics,
}: {
  account: AccountView;
  analytics: PortfolioAnalytics;
}) {
  const healthLabel: Record<PortfolioAnalytics["health"], { text: string; tone: "up" | "warn" | "down" }> = {
    healthy: { text: "Healthy", tone: "up" },
    moderate: { text: "Moderate", tone: "warn" },
    elevated: { text: "Elevated risk", tone: "down" },
  };
  const badge = healthLabel[analytics.health];
  const marginFill = Math.min(100, Math.max(0, analytics.marginRatioPct));
  const longPct = analytics.grossNotional > 0 ? analytics.longSharePct : 50;

  return (
    <section className="portfolio-kpis" aria-label="Portfolio summary">
      {/* Card 1: Net Equity & Unrealized P&L */}
      <div className="kpi-card kpi-card-lead">
        <div className="kpi-top">
          <span className="kpi-label">Net Account Equity</span>
          <span
            className="chip num"
            data-tone={
              direction(account.unrealizedPnl) === "up"
                ? "up"
                : direction(account.unrealizedPnl) === "down"
                  ? "down"
                  : undefined
            }
          >
            {percent(analytics.unrealizedReturnPct)}
          </span>
        </div>
        <div className="kpi-value num">
          {money(account.equity)} <small>USDT</small>
        </div>
        <dl className="kpi-subgrid num">
          <div>
            <dt>Wallet balance</dt>
            <dd>{money(account.walletBalance)} USDT</dd>
          </div>
          <div>
            <dt>Unrealized P&amp;L</dt>
            <dd className={direction(account.unrealizedPnl)}>{signedMoney(account.unrealizedPnl)} USDT</dd>
          </div>
        </dl>
      </div>

      {/* Card 2: Margin Utilization & Buying Power */}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">Free Collateral &amp; Margin</span>
          <span className="chip" data-tone={badge.tone}>
            {badge.text}
          </span>
        </div>
        <div className="kpi-value num">
          {money(account.available)} <small>USDT free</small>
        </div>
        <div className="kpi-meter-wrap">
          <div
            className="kpi-meter"
            role="progressbar"
            aria-label="Margin utilization"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(marginFill)}
          >
            <span
              className="kpi-meter-fill"
              data-tone={badge.tone}
              style={{ width: `${marginFill.toFixed(1)}%` }}
            />
          </div>
          <div className="kpi-meter-labels num">
            <span>Used {money(account.marginUsed)} ({analytics.marginRatioPct.toFixed(1)}%)</span>
            <span>Eff. {analytics.effectiveLeverage.toFixed(2)}x</span>
          </div>
        </div>
      </div>

      {/* Card 3: Directional Exposure & Net Delta */}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">Directional Exposure</span>
          <span
            className="chip num"
            data-tone={analytics.netBias === "long" ? "up" : analytics.netBias === "short" ? "down" : undefined}
          >
            {analytics.netBias === "neutral"
              ? "Delta Neutral"
              : `Net ${analytics.netBias === "long" ? "Long" : "Short"}`}
          </span>
        </div>
        <div className="kpi-value num">
          {money(analytics.grossNotional.toFixed(2))} <small>USDT gross</small>
        </div>
        <div className="kpi-meter-wrap">
          <div className="exposure-bar" aria-hidden="true">
            <span className="exposure-long" style={{ width: `${longPct.toFixed(1)}%` }} />
            <span className="exposure-short" style={{ width: `${(100 - longPct).toFixed(1)}%` }} />
          </div>
          <div className="kpi-meter-labels num">
            <span className="up">L {longPct.toFixed(0)}% · {money(analytics.longNotional.toFixed(0))}</span>
            <span className="down">S {(100 - longPct).toFixed(0)}% · {money(analytics.shortNotional.toFixed(0))}</span>
          </div>
        </div>
      </div>

      {/* Card 4: Funding Carry & Downside Guards */}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">Est. Funding Carry</span>
          <span
            className="chip num"
            data-tone={
              analytics.unprotectedCount === 0 && account.positions.length > 0
                ? "up"
                : analytics.unprotectedCount > 0
                  ? "warn"
                  : undefined
            }
          >
            {account.positions.length === 0
              ? "Flat book"
              : `${analytics.protectedCount}/${account.positions.length} SL armed`}
          </span>
        </div>
        <div className={`kpi-value num ${direction(analytics.estFunding8hUsd)}`}>
          {formatFundingCarry(analytics.estFunding8hUsd)} <small>USDT / 8h</small>
        </div>
        <div className="kpi-allocations">
          {analytics.allocations.length > 0 ? (
            analytics.allocations.slice(0, 4).map((slice) => (
              <span key={slice.symbol} className="alloc-chip num">
                <span className={slice.side === "long" ? "up" : "down"}>●</span>
                {slice.base} {slice.sharePct.toFixed(0)}%
              </span>
            ))
          ) : (
            <span className="muted">No active perpetual exposure</span>
          )}
        </div>
      </div>
    </section>
  );
}

function PositionsDesk({
  items,
  network,
  busy,
}: {
  items: EnrichedPosition[];
  network: Network;
  busy: boolean;
}) {
  const [filter, setFilter] = useState<PositionFilter>("all");
  const [sortBy, setSortBy] = useState<PositionSort>("notional");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const sideCounts = useMemo(() => {
    let long = 0;
    let short = 0;
    for (const item of items) {
      if (item.position.side === "long") long += 1;
      else short += 1;
    }
    return { long, short };
  }, [items]);

  const filtered = useMemo(() => {
    const list = filter === "all" ? [...items] : items.filter((item) => item.position.side === filter);
    return list.sort((a, b) => {
      if (sortBy === "pnl") return b.pnlNum - a.pnlNum;
      if (sortBy === "roe") return (b.roePct ?? 0) - (a.roePct ?? 0);
      if (sortBy === "liq") return (a.liqDistancePct ?? 999) - (b.liqDistancePct ?? 999);
      return b.notionalNum - a.notionalNum;
    });
  }, [items, filter, sortBy]);

  const pageSlice = useMemo(() => paginateList(filtered, page, pageSize), [filtered, page, pageSize]);

  if (items.length === 0) {
    return (
      <div className="empty">
        <p>No open perpetual positions</p>
        <button type="button" className="btn btn-secondary" onClick={() => openTrade()}>
          New order
        </button>
      </div>
    );
  }

  return (
    <div className="desk-section">
      <div className="desk-toolbar">
        <div className="desk-filters" role="group" aria-label="Filter positions by side">
          {(
            [
              { id: "all", label: `All (${items.length})` },
              { id: "long", label: `Long (${sideCounts.long})` },
              { id: "short", label: `Short (${sideCounts.short})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="filter-pill"
              aria-pressed={filter === tab.id}
              onClick={() => {
                setFilter(tab.id);
                setPage(1);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="desk-sort">
          <label htmlFor="pos-sort-select" className="muted">
            Sort
          </label>
          <select
            id="pos-sort-select"
            className="input input-sm"
            value={sortBy}
            onChange={(event) => {
              setSortBy(event.target.value as PositionSort);
              setPage(1);
            }}
          >
            <option value="notional">Notional size</option>
            <option value="pnl">Unrealized P&amp;L</option>
            <option value="roe">ROE %</option>
            <option value="liq">Closest to liquidation</option>
          </select>
        </div>
      </div>

      <ul className="positions">
        {pageSlice.items.map((item) => {
          const { position } = item;
          const long = position.side === "long";
          const openSide = long ? "buy" : "sell";
          const closeSide = long ? "sell" : "buy";

          return (
            <li key={position.symbol} className="position perp-card">
              <div className="position-head">
                <button
                  type="button"
                  className="symbol"
                  onClick={() => void focusMarket(position.symbol)}
                >
                  <InstrumentMark base={item.base} size="sm" />
                  <span className="symbol-name">
                    {item.base}-{item.quote}
                  </span>
                </button>
                <span className="chip" data-tone={long ? "up" : "down"}>
                  {long ? "Long" : "Short"} {leverage(position.leverage)}
                </span>
                <span className="chip">{position.isolated ? "Isolated" : "Cross"}</span>
                <span className="muted position-mode num">{item.sharePct.toFixed(0)}% of book</span>
                <span className="grow" />
                <span className={`position-pnl num ${direction(position.unrealizedPnl)}`}>
                  {signedMoney(position.unrealizedPnl)} {item.quote}
                  <small>{percent(position.roePct)} ROE</small>
                </span>
              </div>

              <dl className="position-facts num">
                <div>
                  <dt>Size</dt>
                  <dd>
                    {units(position.qty)} {item.base}
                  </dd>
                </div>
                <div>
                  <dt>Notional</dt>
                  <dd>
                    {money(position.notional)} {item.quote}
                  </dd>
                </div>
                <div>
                  <dt>Entry price</dt>
                  <dd>{price(position.entryPrice)}</dd>
                </div>
                <div>
                  <dt>Mark price</dt>
                  <dd>
                    {price(position.markPrice)}
                    {item.markMovePct !== null ? (
                      <small className={`fact-delta ${direction(item.markMovePct)}`}>
                        {percent(item.markMovePct)} from entry
                      </small>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Liquidation</dt>
                  <dd>
                    {position.liquidationPrice ? price(position.liquidationPrice) : "None"}
                    {item.liqDistancePct !== null ? (
                      <small className="fact-delta" data-tone={item.liqTone}>
                        {item.liqDistancePct.toFixed(1)}% buffer
                      </small>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Margin used</dt>
                  <dd>
                    {money(position.margin)} {item.quote}
                    {item.estFunding8hUsd !== null ? (
                      <small className={`fact-delta ${direction(item.estFunding8hUsd)}`}>
                        {formatFundingCarry(item.estFunding8hUsd)}/8h funding
                      </small>
                    ) : null}
                  </dd>
                </div>
              </dl>

              <div className="perp-card-foot">
                <div className="perp-guards num">
                  {item.slPrice ? (
                    <span className="guard-pill" data-kind="sl">
                      Stop-loss {price(item.slPrice)}
                      {item.slPnlUsd !== null ? (
                        <small className="down">({signedMoney(item.slPnlUsd.toFixed(2))})</small>
                      ) : null}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="guard-pill guard-pill-btn"
                      data-kind="unprotected"
                      onClick={() =>
                        openTrade(null, {
                          symbol: position.symbol,
                          side: openSide,
                        })
                      }
                    >
                      No Stop-Loss · Set SL
                    </button>
                  )}

                  {item.tpPrice ? (
                    <span className="guard-pill" data-kind="tp">
                      Take-profit {price(item.tpPrice)}
                      {item.tpPnlUsd !== null ? (
                        <small className="up">({signedMoney(item.tpPnlUsd.toFixed(2))})</small>
                      ) : null}
                    </span>
                  ) : null}

                  {item.plannedRr !== null ? (
                    <span className="chip num" data-tone={item.plannedRr >= 1.5 ? "up" : undefined}>
                      R:R 1 : {item.plannedRr.toFixed(2)}
                    </span>
                  ) : null}
                </div>

                <div className="perp-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      openJournalComposer(draftFromPosition(item, network));
                      navigate("activity");
                    }}
                  >
                    <Icon name="compose" size={13} />
                    Journal
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      openTrade(null, {
                        symbol: position.symbol,
                        side: openSide,
                        stopLoss: item.slPrice ?? undefined,
                        takeProfit: item.tpPrice ?? undefined,
                      })
                    }
                  >
                    Add / TP·SL
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      openTrade(null, {
                        symbol: position.symbol,
                        side: closeSide,
                        qty: item.trimHalfQty,
                        reduceOnly: true,
                      })
                    }
                  >
                    Trim 50%
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    aria-label={`Close ${item.base} ${position.side}`}
                    onClick={() => void closePosition(position.symbol)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Pagination
        label="Open positions pagination"
        itemLabel="positions"
        slice={pageSlice}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

function OrdersDesk({ items, busy }: { items: EnrichedOrder[]; busy: boolean }) {
  const captionId = useId();
  const [sortKey, setSortKey] = useState<OrderSortKey>("time");
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");
  const [symbolFilter, setSymbolFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const symbolCounts = useMemo(() => {
    const counts = new Map<string, { base: string; count: number }>();
    for (const item of items) {
      const existing = counts.get(item.order.symbol);
      if (existing) existing.count += 1;
      else counts.set(item.order.symbol, { base: item.base, count: 1 });
    }
    return [...counts.entries()];
  }, [items]);

  const sorted = useMemo(() => {
    const scoped =
      symbolFilter === "all" ? [...items] : items.filter((item) => item.order.symbol === symbolFilter);
    const factor = sortDir === "ascending" ? 1 : -1;
    return scoped.sort((a, b) => {
      switch (sortKey) {
        case "symbol":
          return factor * collator.compare(a.base, b.base);
        case "type":
          return factor * collator.compare(a.roleLabel, b.roleLabel);
        case "price":
          return factor * ((a.effectivePriceNum ?? 0) - (b.effectivePriceNum ?? 0));
        case "distance":
          return factor * (Math.abs(a.distanceFromMarkPct ?? 0) - Math.abs(b.distanceFromMarkPct ?? 0));
        case "qty":
          return factor * (Number(a.order.qty) - Number(b.order.qty));
        case "time":
        default:
          return factor * collator.compare(a.order.time, b.order.time);
      }
    });
  }, [items, symbolFilter, sortKey, sortDir]);

  const pageSlice = useMemo(() => paginateList(sorted, page, pageSize), [sorted, page, pageSize]);

  function toggleSort(nextKey: OrderSortKey) {
    setPage(1);
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === "ascending" ? "descending" : "ascending"));
    } else {
      setSortKey(nextKey);
      setSortDir("ascending");
    }
  }

  if (items.length === 0) return <p className="empty">No open orders</p>;

  return (
    <div className="desk-section">
      <div className="desk-toolbar">
        <div className="desk-filters" role="group" aria-label="Filter orders by market">
          <button
            type="button"
            className="filter-pill"
            aria-pressed={symbolFilter === "all"}
            onClick={() => {
              setSymbolFilter("all");
              setPage(1);
            }}
          >
            All markets ({items.length})
          </button>
          {symbolCounts.map(([symbol, info]) => (
            <button
              key={symbol}
              type="button"
              className="filter-pill"
              aria-pressed={symbolFilter === symbol}
              onClick={() => {
                setSymbolFilter(symbol);
                setPage(1);
              }}
            >
              {info.base} ({info.count})
            </button>
          ))}
        </div>

        <div className="desk-batch-actions">
          {symbolCounts
            .filter(([, info]) => info.count > 1)
            .map(([symbol, info]) => (
              <button
                key={symbol}
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                aria-label={`Cancel all ${info.base} orders`}
                onClick={() => void cancelAllOrders(symbol)}
              >
                Cancel all {info.base} ({info.count})
              </button>
            ))}
        </div>
      </div>

      <div className="visually-hidden" role="status">
        Sorted by {sortKey}, {sortDir}, {sorted.length} rows
      </div>

      <div className="table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="table sortable-data-table">
          <caption id={captionId} className="visually-hidden">
            Open perpetual trigger and limit orders
          </caption>
          <thead>
            <tr>
              <th scope="col" aria-sort={sortKey === "symbol" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn" onClick={() => toggleSort("symbol")}>
                  <span>Contract</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" aria-sort={sortKey === "type" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn" onClick={() => toggleSort("type")}>
                  <span>Order &amp; Role</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col">Side</th>
              <th scope="col" className="num" aria-sort={sortKey === "price" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("price")}>
                  <span>Trigger / Limit</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "distance" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("distance")}>
                  <span>Dist. to Mark</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "qty" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("qty")}>
                  <span>Quantity</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num" aria-sort={sortKey === "time" ? sortDir : undefined}>
                <button type="button" className="th-sort-btn th-sort-num" onClick={() => toggleSort("time")}>
                  <span>Placed</span>
                  <span className="th-sort-icon" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" className="num">
                <span className="visually-hidden">Cancel</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pageSlice.items.map((item) => {
              const { order } = item;
              const trigger = order.stopPrice && Number(order.stopPrice) > 0 ? order.stopPrice : null;
              const limit = order.price && Number(order.price) > 0 ? order.price : null;
              const levelText =
                trigger && limit
                  ? `${price(trigger)} → ${price(limit)}`
                  : trigger
                    ? price(trigger)
                    : limit
                      ? price(limit)
                      : "Market";

              return (
                <tr key={order.id}>
                  <th scope="row">
                    <button
                      type="button"
                      className="symbol"
                      onClick={() => void focusMarket(order.symbol)}
                    >
                      <InstrumentMark base={item.base} size="sm" />
                      <span className="symbol-name">
                        {item.base}-{item.quote}
                      </span>
                    </button>
                  </th>
                  <td>
                    <span className="cell-main">{orderType(order.type)}</span>
                    <span className="cell-sub">
                      {item.roleLabel}
                      {order.reduceOnly ? " · Reduce-only" : ""}
                    </span>
                  </td>
                  <td>
                    <span className="chip" data-tone={order.side === "buy" ? "up" : "down"}>
                      {order.side === "buy" ? "Buy" : "Sell"}
                    </span>
                  </td>
                  <td className="num">
                    <span className="cell-main">{levelText}</span>
                    {item.markPrice !== null ? (
                      <span className="cell-sub">Mark {price(String(item.markPrice))}</span>
                    ) : null}
                  </td>
                  <td className="num">
                    {item.distanceFromMarkPct !== null ? (
                      <span className={direction(item.distanceFromMarkPct)}>
                        {percent(item.distanceFromMarkPct)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">
                    <span className="cell-main">
                      {units(order.qty)} {item.base}
                    </span>
                    {Number(order.filled) > 0 ? (
                      <span className="cell-sub">{units(order.filled)} filled</span>
                    ) : item.estNotional !== null ? (
                      <span className="cell-sub">≈ {money(item.estNotional.toFixed(2))} {item.quote}</span>
                    ) : null}
                  </td>
                  <td className="num muted">{dayTime(order.time)}</td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={busy}
                      aria-label={`Cancel ${orderType(order.type).toLowerCase()} ${order.side} on ${item.base}`}
                      onClick={() => void cancelOrder(order.symbol, order.id)}
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

      <Pagination
        label="Open orders pagination"
        itemLabel="orders"
        slice={pageSlice}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

function CollateralDesk({
  balances,
  snapshot,
  account,
  busy,
  waiting,
}: {
  balances: BalanceView[];
  snapshot: Snapshot;
  account: AccountView;
  busy: boolean;
  waiting: boolean;
}) {
  const captionId = useId();
  const wallet = activeWallet(snapshot);
  const { network, risk } = snapshot;
  const held = balances.filter((row) => Number(row.balance) !== 0 || Number(row.available) !== 0);

  return (
    <div className="collateral-layout">
      <div className="desk-section">
        {held.length === 0 ? (
          <p className="empty">No collateral balances</p>
        ) : (
          <div className="table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
            <table className="table">
              <caption id={captionId} className="visually-hidden">
                Perpetual margin collateral balances
              </caption>
              <thead>
                <tr>
                  <th scope="col">Collateral Asset</th>
                  <th scope="col" className="num">
                    Wallet Balance
                  </th>
                  <th scope="col" className="num">
                    Free Available
                  </th>
                  <th scope="col" className="num">
                    In Margin
                  </th>
                  <th scope="col" className="num">
                    Utilization
                  </th>
                </tr>
              </thead>
              <tbody>
                {held.map((row) => {
                  const total = Number(row.balance);
                  const avail = Number(row.available);
                  const locked = Math.max(0, total - avail);
                  const utilPct = total > 0 ? Math.min(100, (locked / total) * 100) : 0;
                  return (
                    <tr key={row.asset}>
                      <th scope="row">
                        <span className="cell-main">{row.asset}</span>
                        <span className="cell-sub">Perpetual margin collateral</span>
                      </th>
                      <td className="num">{balance(row.balance)}</td>
                      <td className="num">{balance(row.available)}</td>
                      <td className="num">{balance(locked.toFixed(2))}</td>
                      <td className="num">
                        <span className="chip num" data-tone={utilPct >= 75 ? "down" : utilPct >= 50 ? "warn" : "up"}>
                          {utilPct.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <aside className="vault-card" aria-label="On-chain custody and agent wallet security">
        <div className="vault-card-head">
          <h3>Self-Custody &amp; Delegated Agent</h3>
          <span className="chip" data-tone="up">
            Non-custodial
          </span>
        </div>
        <p className="muted vault-card-desc">
          Your main wallet never shares its private key. Orders are signed locally with an EIP-712 trade-only API
          agent (`canWithdraw=false`).
        </p>
        <dl className="vault-facts num">
          <div>
            <dt>Main wallet ({networkName(network)})</dt>
            <dd className="mono">{wallet.user ?? "—"}</dd>
          </div>
          <div>
            <dt>Delegated API agent</dt>
            <dd className="mono">{wallet.agent ?? "—"}</dd>
          </div>
          <div>
            <dt>Agent approval expiry</dt>
            <dd>{wallet.expires ? dayTime(wallet.expires) : "Managed on exchange"}</dd>
          </div>
          <div>
            <dt>Margin &amp; leverage policy</dt>
            <dd>
              {account.multiAssets ? "Multi-Assets Cross" : risk.isolated ? "Isolated margin" : "Cross margin"} · Max{" "}
              {risk.maxLeverage}x
            </dd>
          </div>
        </dl>
        <div className="vault-card-actions">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy || waiting}
            onClick={() => void fundWallet({ network, task: "deposit" })}
          >
            Deposit collateral
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy || waiting}
            onClick={() => void fundWallet({ network, task: "withdraw" })}
          >
            Withdraw
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openSettings("wallet")}>
            Manage wallets
          </button>
        </div>
      </aside>
    </div>
  );
}

function JournalPreviewTab({
  entries,
  snapshot,
}: {
  entries: JournalEntry[];
  snapshot: Snapshot;
}) {
  const metrics = useMemo(() => computeJournalMetrics(entries, snapshot.network), [entries, snapshot.network]);
  const executions = useMemo(() => buildExecutionHistory(snapshot), [snapshot]);
  const scopedEntries = useMemo(
    () => entries.filter((entry) => entry.network === snapshot.network).slice(0, 3),
    [entries, snapshot.network],
  );

  return (
    <div className="desk-section">
      <div className="journal-preview-banner">
        <div className="journal-preview-stats num">
          <div>
            <span className="muted">Journal Win Rate</span>
            <strong>{metrics.winRatePct !== null ? `${metrics.winRatePct.toFixed(1)}%` : "—"}</strong>
          </div>
          <div>
            <span className="muted">Logged Net P&amp;L</span>
            <strong className={direction(metrics.netPnlUsd)}>
              {signedMoney(metrics.netPnlUsd.toFixed(2))} USDT
            </strong>
          </div>
          <div>
            <span className="muted">Discipline Score</span>
            <strong>{metrics.disciplinePct.toFixed(0)}%</strong>
          </div>
          <div>
            <span className="muted">Session Executions</span>
            <strong>{executions.length}</strong>
          </div>
        </div>
        <div className="journal-preview-actions">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              openJournalComposer({ network: snapshot.network, symbol: snapshot.focus });
              navigate("activity");
            }}
          >
            <Icon name="plus" size={14} />
            Log Trade Thesis
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate("activity")}>
            Open Full Journal &amp; History
          </button>
        </div>
      </div>

      {scopedEntries.length > 0 ? (
        <ul className="journal-preview-list">
          {scopedEntries.map((entry) => {
            const instrument = instrumentFor(snapshot, entry.symbol);
            const pnl = Number(entry.pnlUsd);
            return (
              <li key={entry.id} className="journal-preview-item">
                <div className="journal-preview-head">
                  <InstrumentMark base={instrument.base} size="sm" />
                  <strong>{instrument.base}-{instrument.quote || "USDT"}</strong>
                  <span className="chip" data-tone={entry.side === "long" ? "up" : "down"}>
                    {entry.side === "long" ? "Long" : "Short"} {entry.leverage}x
                  </span>
                  <span className="chip">{entry.setup}</span>
                  <span
                    className="chip"
                    data-tone={entry.outcome === "win" ? "up" : entry.outcome === "loss" ? "down" : undefined}
                  >
                    {entry.outcome === "open" ? "Open thesis" : entry.outcome.toUpperCase()}
                  </span>
                  <span className="grow" />
                  {Number.isFinite(pnl) && entry.pnlUsd ? (
                    <span className={`num ${direction(pnl)}`}>{signedMoney(pnl.toFixed(2))} USDT</span>
                  ) : null}
                </div>
                <p className="muted">{entry.thesis}</p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** The decentralized perpetual futures portfolio, positions desk, resting orders, and collateral vault. */
export function AccountPage() {
  const snapshot = useSnapshot();
  const busy = useBusy();
  const wallet = activeWallet(snapshot);
  const { account, accountError, network } = snapshot;
  const waiting = snapshot.pendingWallet !== null;
  const { entries } = useJournal();

  const [tab, setTab] = useState<AccountTab>("positions");
  const panelId = useId();

  useEffect(() => {
    void refreshAccount();
  }, [network]);

  const enrichedPositions = useMemo(() => enrichPositions(snapshot), [snapshot]);
  const enrichedOrders = useMemo(() => enrichOrders(snapshot), [snapshot]);
  const analytics = useMemo(
    () => computePortfolioAnalytics(snapshot, enrichedPositions),
    [snapshot, enrichedPositions],
  );

  const refresh = (
    <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void reloadAccount()}>
      <Icon name="refresh" size={15} />
      Refresh
    </button>
  );

  let body;
  if (!wallet.connected) {
    body = (
      <div className="empty">
        <p>No wallet on {networkName(network)}</p>
        <button type="button" className="btn btn-primary" onClick={() => openSettings("wallet")}>
          Connect wallet
        </button>
      </div>
    );
  } else if (wallet.needsDeposit) {
    body = (
      <div className="empty">
        <p>Deposit to open this account</p>
        <div className="empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || waiting}
            onClick={() => void fundWallet({ network, task: "deposit" })}
          >
            Deposit
          </button>
          {refresh}
        </div>
      </div>
    );
  } else if (!account) {
    body = accountError ? (
      <div className="empty">
        <p className="note" data-tone="error" role="alert">
          {accountError}
        </p>
        {refresh}
      </div>
    ) : (
      <p className="empty">
        <span className="spinner" />
      </p>
    );
  } else {
    const heldBalances = account.balances.filter(
      (row) => Number(row.balance) !== 0 || Number(row.available) !== 0,
    );
    const networkJournalCount = entries.filter((entry) => entry.network === network).length;
    const tabs: { id: AccountTab; label: string; count?: number }[] = [
      { id: "positions", label: "Positions", count: account.positions.length },
      { id: "orders", label: "Open orders", count: account.orders.length },
      { id: "collateral", label: "Collateral & Vault", count: heldBalances.length },
      { id: "journal", label: "Journal & History", count: networkJournalCount },
    ];

    body = (
      <>
        <VaultBar snapshot={snapshot} account={account} busy={busy} waiting={waiting} />
        {accountError ? (
          <p className="note" data-tone="error" role="alert">
            {accountError}
          </p>
        ) : null}
        <PortfolioOverview account={account} analytics={analytics} />

        <div className="desk-tabs-bar">
          <div
            className="desk-tablist"
            role="tablist"
            aria-label="Portfolio sections"
            onKeyDown={(event) => {
              const index = tabs.findIndex((item) => item.id === tab);
              let next = -1;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              const target = tabs[next];
              if (!target) return;
              event.preventDefault();
              setTab(target.id);
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            {tabs.map((item) => {
              const selected = item.id === tab;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`tab-${item.id}`}
                  className="desk-tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTab(item.id)}
                >
                  <span>{item.label}</span>
                  {item.count !== undefined ? <span className="section-count num">{item.count}</span> : null}
                </button>
              );
            })}
          </div>
        </div>

        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="desk-tabpanel"
        >
          {tab === "positions" ? (
            <PositionsDesk items={enrichedPositions} network={network} busy={busy} />
          ) : null}
          {tab === "orders" ? <OrdersDesk items={enrichedOrders} busy={busy} /> : null}
          {tab === "collateral" ? (
            <CollateralDesk
              balances={account.balances}
              snapshot={snapshot}
              account={account}
              busy={busy}
              waiting={waiting}
            />
          ) : null}
          {tab === "journal" ? <JournalPreviewTab entries={entries} snapshot={snapshot} /> : null}
        </div>
      </>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">{body}</div>
    </div>
  );
}
