import { type CSSProperties, useId } from "react";
import type { GridBotView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { direction as tone, money, percent, plural, price, signedMoney, units } from "../../lib/format";
import { gridDuration, gridRangeProgress } from "../../lib/grid";
import { ask, focusMarket } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { directionLabel, directionTone, isActive, spacingLabel, statusLabel } from "./labels";

interface GridBotCardProps {
  bot: GridBotView;
  /** Place in the list, so cards arrive one after another. */
  index: number;
  now: number;
  busy: boolean;
  onStop: (bot: GridBotView) => void;
  onRemove: (bot: GridBotView) => void;
  onReuse: (bot: GridBotView) => void;
}

const ZONES = { below: "Below the range", inside: "In range", above: "Above the range" } as const;

/** One bot: its market and state, where the price is in its range, what it has made, and what can be done. */
export function GridBotCard({ bot, index, now, busy, onStop, onRemove, onReuse }: GridBotCardProps) {
  const status = statusLabel(bot.status);
  const active = isActive(bot.status);
  const mark = bot.markPrice ? Number(bot.markPrice) : null;
  const where = gridRangeProgress(mark, Number(bot.lowerPrice), Number(bot.upperPrice));
  const detailsId = useId();

  return (
    <article className="gb-bot" data-status={bot.status} style={{ "--i": index } as CSSProperties} aria-labelledby={`${detailsId}-name`}>
      <header className="gb-bot-head">
        <InstrumentMark base={bot.base} />
        <div className="gb-bot-title">
          <button
            type="button"
            id={`${detailsId}-name`}
            className="gb-bot-market"
            onClick={() => void focusMarket(bot.symbol)}
          >
            {bot.base}
            <span className="muted"> / {bot.quote}</span>
          </button>
          <span className="gb-bot-tags">
            <span className="chip" data-tone={directionTone(bot.direction)}>
              {directionLabel(bot.direction)} · {bot.leverage}x
            </span>
            <span className="chip" data-tone={status.tone}>
              {active ? <span className="dot" data-tone={status.tone} /> : null}
              {status.label}
            </span>
            <span className="gb-bot-age num" title={active ? "Running for" : "Ran for"}>
              {gridDuration(bot.createdAt, bot.stoppedAt, now)}
            </span>
          </span>
        </div>
        <div className="gb-bot-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => void ask(`How is my ${bot.base} grid bot doing?`)}
          >
            <Icon name="assistant" size={14} />
            <span>Ask AI</span>
          </button>
          {active ? (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => onStop(bot)}>
              Stop
            </button>
          ) : null}
          <Menu label={`More for the ${bot.base} bot`} trigger={<Icon name="dots" size={16} />} triggerClass="icon-btn" align="end">
            <MenuItem icon="chart" label={`Open ${bot.base}`} onSelect={() => void focusMarket(bot.symbol)} />
            <MenuItem icon="copy" label="Use these settings" sub="Fills the form below" onSelect={() => onReuse(bot)} />
            {active ? null : (
              <MenuItem icon="trash" label="Remove" sub="From this list" tone="danger" disabled={busy} onSelect={() => onRemove(bot)} />
            )}
          </Menu>
        </div>
      </header>

      <div className="gb-bot-range">
        <div className="gb-bot-range-labels num">
          <span>{price(bot.lowerPrice)}</span>
          <span className="gb-bot-range-now">
            {mark !== null ? price(mark) : "—"}
            {where ? <span className="muted"> · {ZONES[where.zone]}</span> : null}
          </span>
          <span>{price(bot.upperPrice)}</span>
        </div>
        <div className="gb-bot-track" aria-hidden="true">
          {where ? <span className="gb-bot-mark" data-zone={where.zone} style={{ left: `${where.pct}%` }} /> : null}
        </div>
      </div>

      <dl className="gb-bot-stats">
        <div>
          <dt>Profit and loss</dt>
          <dd className={`num ${tone(bot.totalPnl)}`}>
            {signedMoney(bot.totalPnl)} <small>{bot.roiPct !== null ? percent(bot.roiPct) : bot.quote}</small>
          </dd>
        </div>
        <div>
          <dt>From completed trades</dt>
          <dd className={`num ${tone(bot.realizedPnl)}`}>
            {signedMoney(bot.realizedPnl)} <small>{plural(bot.matchedTrades, "trade")}</small>
          </dd>
        </div>
        <div>
          <dt>Open position</dt>
          <dd className={`num ${active ? tone(bot.unrealizedPnl) : ""}`}>{active ? signedMoney(bot.unrealizedPnl) : "—"}</dd>
        </div>
        <div>
          <dt>Orders</dt>
          <dd className="num">
            {active ? (
              <>
                <span className="up">{bot.activeBuyOrders} buy</span> · <span className="down">{bot.activeSellOrders} sell</span>
              </>
            ) : (
              "None"
            )}
          </dd>
        </div>
        <div>
          <dt>Margin</dt>
          <dd className="num">
            {money(bot.margin)} <small>{bot.quote} at {bot.leverage}x</small>
          </dd>
        </div>
      </dl>

      {bot.lastNote ? <p className="gb-bot-note">{bot.lastNote}</p> : null}

      <details className="gb-more gb-bot-more">
        <summary>
          <Icon name="chevron" size={14} />
          <span>Levels and settings</span>
          <span className="gb-more-hint num">
            {bot.grids} grids · {units(bot.qtyPerGrid)} {bot.base} each
          </span>
        </summary>
        <div className="gb-more-body">
          <p className="gb-bot-settings num">
            <span>{spacingLabel(bot.spacing)}</span>
            <span>Started near {price(bot.entryPrice)}</span>
            {bot.triggerPrice ? <span>Starts at {price(bot.triggerPrice)}</span> : null}
            {bot.stopLower ? <span>Stops below {price(bot.stopLower)}</span> : null}
            {bot.stopUpper ? <span>Stops above {price(bot.stopUpper)}</span> : null}
            <span>{bot.closeOnStop ? "Closes the position when it stops" : "Keeps the position when it stops"}</span>
            <span>{bot.postOnly ? "Maker orders only" : "Limit orders"}</span>
            <span>{bot.isolated ? "Isolated margin" : "Cross margin"}</span>
          </p>
          {bot.levels.length > 0 ? (
            <div className="table-wrap gb-levels-wrap">
              <table className="table gb-levels-table">
                <thead>
                  <tr>
                    <th scope="col">Level</th>
                    <th scope="col" className="r">
                      Price
                    </th>
                    <th scope="col">Order</th>
                    <th scope="col" className="r">
                      Fills
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...bot.levels].reverse().map((level) => (
                    <tr key={level.index}>
                      <td className="muted">{level.index + 1}</td>
                      <td className="num r">{price(level.price)}</td>
                      <td>
                        {level.side === "buy" ? (
                          <span className="up">Buy</span>
                        ) : level.side === "sell" ? (
                          <span className="down">Sell</span>
                        ) : (
                          <span className="muted">None</span>
                        )}
                      </td>
                      <td className="num r">{level.filledCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </details>
    </article>
  );
}
