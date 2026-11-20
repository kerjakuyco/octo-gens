import type { CSSProperties } from "react";
import type { GridBotView, Network } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { direction as tone, leverage, money, percent, price, signedMoney, units } from "../../lib/format";
import { draftFromPosition, openJournalComposer } from "../../lib/journal";
import type { EnrichedPosition } from "../../lib/portfolio";
import { ask, closePosition, focusMarket, navigate, openGrid, openTrade, prefillComposer } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { moveText, positionFunding } from "./labels";

interface PositionCardProps {
  item: EnrichedPosition;
  network: Network;
  /** The grid bot at work in this market, which shares this position. */
  bot: GridBotView | null;
  /** A model is connected, so the assistant can be asked. */
  assistant: boolean;
  busy: boolean;
  /** Place in the list, so cards arrive one after another. */
  index: number;
}

/**
 * One open position: its side and size, how it stands against its entry and its liquidation price, what
 * protects it, and what can be done with it. A grid bot trading the same market is said plainly, since
 * the bot and the trader share this one position.
 */
export function PositionCard({ item, network, bot, assistant, busy, index }: PositionCardProps) {
  const { position } = item;
  const long = position.side === "long";
  const openSide = long ? "buy" : "sell";
  const closeSide = long ? "sell" : "buy";
  const sideWord = long ? "long" : "short";
  const funding = positionFunding(item.estFunding8hUsd);

  return (
    <article className="ac-position" data-side={sideWord} style={{ "--i": index } as CSSProperties}>
      <header className="ac-position-head">
        <button type="button" className="symbol ac-position-market" onClick={() => void focusMarket(position.symbol)}>
          <InstrumentMark base={item.base} />
          <span className="symbol-name">{item.base}</span>
          <span className="muted">/ {item.quote}</span>
        </button>
        <span className="ac-position-tags">
          <span className="chip" data-tone={long ? "up" : "down"}>
            {long ? "Long" : "Short"} · {leverage(position.leverage)}
          </span>
          <span className="chip">{position.isolated ? "Isolated" : "Cross"}</span>
          {bot ? (
            <button
              type="button"
              className="chip ac-bot-chip"
              title={`Your ${item.base} grid bot trades this market`}
              onClick={() => openGrid(position.symbol)}
            >
              <Icon name="grid" size={12} />
              Grid bot
            </button>
          ) : null}
        </span>
        <span className="grow" />
        <span className={`ac-position-pnl num ${tone(position.unrealizedPnl)}`}>
          <span>
            {signedMoney(position.unrealizedPnl)} <small>{item.quote}</small>
          </span>
          <span className="ac-position-roe">{percent(position.roePct)} on margin</span>
        </span>
      </header>

      <dl className="ac-facts num">
        <div>
          <dt>Size</dt>
          <dd>
            {units(position.qty)} {item.base}
          </dd>
        </div>
        <div>
          <dt>Value</dt>
          <dd>
            {money(position.notional)} {item.quote}
          </dd>
        </div>
        <div>
          <dt>Entry</dt>
          <dd>{price(position.entryPrice)}</dd>
        </div>
        <div>
          <dt>Price now</dt>
          <dd>
            {price(position.markPrice)}
            {item.markMovePct !== null ? (
              <small className={tone(item.markMovePct)}>{moveText(item.markMovePct)}</small>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Liquidation</dt>
          <dd>
            {position.liquidationPrice ? price(position.liquidationPrice) : "None"}
            {item.liqDistancePct !== null ? (
              <small data-tone={item.liqTone}>{item.liqDistancePct.toFixed(1)}% away</small>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Margin</dt>
          <dd>
            {money(position.margin)} {item.quote}
            {funding ? <small className={tone(item.estFunding8hUsd ?? 0)}>{funding}</small> : null}
          </dd>
        </div>
      </dl>

      <div className="ac-position-foot">
        <div className="ac-guards num">
          {item.slPrice ? (
            <span className="ac-guard" data-kind="stop">
              Stop-loss {price(item.slPrice)}
              {item.slPnlUsd !== null ? <small className="down"> {signedMoney(item.slPnlUsd.toFixed(2))}</small> : null}
            </span>
          ) : (
            <span className="ac-guard" data-kind="none" title="Nothing closes this position if the price turns against it">
              <Icon name="alert" size={12} />
              No stop-loss
            </span>
          )}
          {item.tpPrice ? (
            <span className="ac-guard" data-kind="target">
              Take-profit {price(item.tpPrice)}
              {item.tpPnlUsd !== null ? <small className="up"> {signedMoney(item.tpPnlUsd.toFixed(2))}</small> : null}
            </span>
          ) : null}
          {item.plannedRr !== null ? (
            <span className="ac-guard" data-kind="ratio">
              Reward to risk {item.plannedRr.toFixed(2)}
            </span>
          ) : null}
        </div>

        <div className="ac-position-actions">
          {assistant ? (
            <Menu
              label={`Ask AI about the ${item.base} ${sideWord}`}
              triggerClass="btn btn-sm btn-ghost"
              align="end"
              side="top"
              trigger={
                <>
                  <Icon name="assistant" size={14} />
                  <span>Ask AI</span>
                </>
              }
            >
              <MenuItem
                icon="chart"
                label="How is it doing?"
                sub="Asks the assistant now"
                disabled={busy}
                onSelect={() => void ask(`How is my ${item.base} ${sideWord} doing?`)}
              />
              <MenuItem
                icon="exit"
                label="Close it with the assistant"
                sub="Fills /close for you to send"
                onSelect={() => prefillComposer("close", { market: position.symbol })}
              />
              <MenuItem
                icon="minus"
                label="Reduce it with the assistant"
                sub="Fills /reduce for you to send"
                onSelect={() => prefillComposer("reduce", { market: position.symbol })}
              />
            </Menu>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="Starts a journal entry from this position on the Activity page"
            onClick={() => {
              openJournalComposer(draftFromPosition(item, network));
              navigate("activity");
            }}
          >
            <Icon name="journal" size={14} />
            <span>Journal</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy}
            title="Opens the order form for this market, with its stop-loss and take-profit"
            onClick={() =>
              openTrade(null, {
                symbol: position.symbol,
                side: openSide,
                stopLoss: item.slPrice ?? undefined,
                takeProfit: item.tpPrice ?? undefined,
              })
            }
          >
            Trade
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy}
            title="Opens the order form to close half of the position"
            onClick={() =>
              openTrade(null, {
                symbol: position.symbol,
                side: closeSide,
                qty: item.trimHalfQty,
                reduceOnly: true,
              })
            }
          >
            Close half
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy}
            aria-label={`Close ${item.base} ${sideWord}`}
            title="Drafts a ticket that closes the whole position; nothing is sent until you confirm it"
            onClick={() => void closePosition(position.symbol)}
          >
            Close
          </button>
        </div>
      </div>

      {bot ? (
        <p className="ac-position-bot">
          <Icon name="grid" size={14} />
          <span>
            Your {item.base} grid bot trades this market, so it adds to and takes from this position. Closing the position
            leaves the bot running.
          </span>
          <button type="button" className="ac-link" onClick={() => openGrid(position.symbol)}>
            Open the bot
          </button>
        </p>
      ) : null}
    </article>
  );
}
