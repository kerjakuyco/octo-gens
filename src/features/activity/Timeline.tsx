import { type CSSProperties, useId, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Pagination } from "../../components/Pagination";
import { Segmented } from "../../components/Segmented";
import { StepList } from "../../components/StepList";
import { clock, duration, money, price, signedMoney, units } from "../../lib/format";
import {
  type ActivityFilter,
  type ActivityItem,
  countActivity,
  filterActivity,
  groupByDay,
} from "../../lib/history";
import { type JournalDraft, draftFromExecution, draftFromGridBot } from "../../lib/journal";
import { networkName } from "../../lib/network";
import { paginateList } from "../../lib/pagination";
import { focusMarket, openGrid, openTrade, prefillComposer } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { FILTER_LABELS, eventStatus, eventTitle, kindIcon, kindName } from "./labels";

const FILTERS: readonly ActivityFilter[] = ["all", "orders", "grid", "account"];
const PAGE_SIZES = [15, 30, 60] as const;

/** The first line of what the app said about an event, for the line under its title. */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

function emptyText(filter: ActivityFilter): string {
  switch (filter) {
    case "orders":
      return "No orders yet. Orders you place, their stop-loss and take-profit, and cancellations show here.";
    case "grid":
      return "No grid bot activity yet. When a bot starts, places orders after fills or stops, it shows here.";
    case "account":
      return "No deposits or withdrawals yet.";
    case "all":
      return "Nothing yet. Orders, cancellations, deposits and what your grid bots do will show here, newest first.";
  }
}

interface EventProps {
  item: ActivityItem;
  index: number;
  showNetwork: boolean;
  aiReady: boolean;
  onLog: (draft: JournalDraft) => void;
}

/** One thing the app did: a line that opens to the details, the steps behind it, and what to do next. */
function TimelineEvent({ item, index, showNetwork, aiReady, onLog }: EventProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { record, grid } = item;
  const status = eventStatus(item);
  const sub = firstLine(record.summary);
  const market = record.symbol && record.base ? { symbol: record.symbol, base: record.base } : null;
  const bot = grid?.bot ?? null;
  const loggable = item.kind === "order" && record.status === "complete" && record.symbol !== null;

  const facts: { label: string; value: string }[] = [];
  if (record.qty && record.base) facts.push({ label: "Size", value: `${units(record.qty)} ${record.base}` });
  if (record.fillPrice) facts.push({ label: item.kind === "ticket" ? "Price then" : "Price", value: price(record.fillPrice) });
  if (record.notional) facts.push({ label: "Value", value: `${money(record.notional)} USDT` });
  if (record.leverage) facts.push({ label: "Leverage", value: `${record.leverage}x` });
  if (record.stopLoss) facts.push({ label: "Stop-loss", value: price(record.stopLoss) });
  if (record.takeProfit) facts.push({ label: "Take-profit", value: price(record.takeProfit) });
  if (bot) {
    facts.push({ label: "Range", value: `${price(bot.lowerPrice)} – ${price(bot.upperPrice)}` });
    facts.push({ label: "Completed trades", value: String(bot.matchedTrades) });
    facts.push({ label: "Made", value: `${signedMoney(bot.realizedPnl)} ${bot.quote}` });
  }
  if (record.orderId) facts.push({ label: "Order", value: record.orderId });
  if (record.ms > 0) facts.push({ label: "Took", value: duration(record.ms) });

  return (
    <li className="av-event" data-kind={item.kind} style={{ "--i": Math.min(index, 8) } as CSSProperties}>
      <button
        type="button"
        className="av-event-head"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="av-event-icon" data-kind={item.kind} data-tone={status.tone}>
          <Icon name={kindIcon(item)} size={15} />
        </span>
        <span className="av-event-main">
          <span className="av-event-title">{eventTitle(item)}</span>
          <span className="av-event-sub">
            <span className="av-event-kind">{kindName(item)}</span>
            {sub ? <span className="av-event-note">{sub}</span> : null}
          </span>
        </span>
        <span className="av-event-meta">
          {market ? (
            <span className="av-event-market">
              <InstrumentMark base={market.base} size="sm" />
              <span>{market.base}</span>
            </span>
          ) : null}
          {showNetwork ? (
            <span className="chip" data-tone={record.network === "mainnet" ? "warn" : undefined}>
              {networkName(record.network)}
            </span>
          ) : null}
          <span className="chip" data-tone={status.tone}>
            {status.label}
          </span>
          <span className="av-event-time num">{clock(record.time)}</span>
          <Icon name="chevron" size={14} />
        </span>
      </button>

      {open ? (
        <div id={detailId} className="av-event-detail">
          {record.summary ? <p className={record.status === "failed" ? "av-event-text down" : "av-event-text"}>{record.summary}</p> : null}
          {bot?.lastNote && bot.lastNote !== record.summary ? <p className="av-event-text muted">{bot.lastNote}</p> : null}
          {facts.length > 0 ? (
            <dl className="av-facts num">
              {facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {record.steps.length > 0 ? (
            <div className="av-steps">
              <span className="av-steps-label">{item.kind === "ticket" ? "What the assistant did" : "What the app sent"}</span>
              <StepList steps={record.steps} />
            </div>
          ) : null}
          <div className="av-event-actions">
            {item.kind === "ticket" && record.status === "pending" && record.ticket ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => openTrade(record.ticket)}>
                <span>Review the ticket</span>
              </button>
            ) : null}
            {grid ? (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => openGrid(grid.symbol)}>
                <Icon name="grid" size={14} />
                <span>Open grid bots</span>
              </button>
            ) : market ? (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => void focusMarket(market.symbol)}>
                <Icon name="chart" size={14} />
                <span>Open {market.base}</span>
              </button>
            ) : null}
            {bot ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onLog(draftFromGridBot(bot))}>
                <Icon name="compose" size={14} />
                <span>Log in journal</span>
              </button>
            ) : loggable ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onLog(draftFromExecution(record))}>
                <Icon name="compose" size={14} />
                <span>Log in journal</span>
              </button>
            ) : null}
            {grid && aiReady ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => prefillComposer("bots")}>
                <Icon name="assistant" size={14} />
                <span>Ask AI about my bots</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

interface TimelineProps {
  /** Every event on the networks in view, newest first. */
  items: ActivityItem[];
  /** Show each event's network: the page shows both. */
  showNetwork: boolean;
  aiReady: boolean;
  /** Opens the journal form with an entry drafted from an event. */
  onLog: (draft: JournalDraft) => void;
}

/** What the app did, newest first and grouped by day, filtered to orders, grid bots or funds. */
export function Timeline({ items, showNetwork, aiReady, onLog }: TimelineProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const counts = useMemo(() => countActivity(items), [items]);
  const shown = useMemo(() => filterActivity(items, filter), [items, filter]);
  const slice = useMemo(() => paginateList(shown, page, pageSize), [shown, page, pageSize]);
  const days = useMemo(() => groupByDay(slice.items), [slice.items]);

  return (
    <div className="av-timeline">
      <div className="av-toolbar">
        <Segmented
          label="Show"
          value={filter}
          options={FILTERS.map((value) => ({ value, label: `${FILTER_LABELS[value]} ${counts[value]}` }))}
          onChange={(next) => {
            setFilter(next);
            setPage(1);
          }}
        />
        <span className="grow" />
        {filter === "grid" || (filter === "all" && counts.grid > 0) ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openGrid()}>
            <Icon name="grid" size={14} />
            <span>Grid bots</span>
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className="av-empty">{emptyText(filter)}</p>
      ) : (
        <>
          {days.map((day) => (
            <section key={day.key} className="av-day" aria-label={day.label}>
              <h3 className="av-day-label">{day.label}</h3>
              <ol className="av-events">
                {day.items.map((item, index) => (
                  <TimelineEvent
                    key={item.record.id}
                    item={item}
                    index={index}
                    showNetwork={showNetwork}
                    aiReady={aiReady}
                    onLog={onLog}
                  />
                ))}
              </ol>
            </section>
          ))}
          <Pagination
            label="Activity pages"
            itemLabel="events"
            slice={slice}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            pageSizeOptions={PAGE_SIZES}
          />
        </>
      )}
    </div>
  );
}
