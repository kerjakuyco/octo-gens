import { useState } from "react";
import type { GridBotView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { price, units } from "../../lib/format";
import type { EnrichedOrder } from "../../lib/portfolio";
import { cancelAllOrders, cancelOrder } from "../../state/app";

/** One order of a grid bot that the trader asked to cancel. */
export interface BotOrderTarget {
  item: EnrichedOrder;
  bot: GridBotView;
}

/** Every order in a market where a grid bot is at work. */
export interface MarketTarget {
  symbol: string;
  base: string;
  /** The trader's own orders in the market. */
  mine: EnrichedOrder[];
  /** The bot's orders in the market. */
  botOrders: EnrichedOrder[];
  bot: GridBotView;
}

interface BotOrderDialogProps {
  target: BotOrderTarget | null;
  busy: boolean;
  onClose: () => void;
  /** Stop the whole bot instead, where the trader also chooses what happens to the position. */
  onStopBot: (bot: GridBotView) => void;
}

/**
 * Cancelling one of a bot's orders is allowed, but it changes the bot: that price level stays empty until
 * the bot is started again. The dialog says so, and offers to stop the bot instead.
 */
export function BotOrderDialog({ target, busy, onClose, onStopBot }: BotOrderDialogProps) {
  const item = target?.item;
  const bot = target?.bot;

  async function cancel() {
    if (!item) return;
    if (await cancelOrder(item.order.symbol, item.order.id)) onClose();
  }

  return (
    <Dialog open={target !== null} onClose={onClose} title={bot ? `Cancel one of the ${bot.base} bot's orders?` : "Cancel the order?"} size="trade">
      {item && bot ? (
        <div className="dialog-body ac-dialog">
          <p>
            This {item.order.side} order for {units(item.order.qty)} {item.base} at{" "}
            <span className="num">{price(item.effectivePrice ?? item.order.price ?? "")}</span> belongs to your {bot.base} grid
            bot.
          </p>
          <p className="muted">
            Cancelling it leaves its price level empty, and the bot keeps running with its other orders. A bot whose
            orders are all cancelled stops. You can also{" "}
            <button type="button" className="ac-link" disabled={busy} onClick={() => onStopBot(bot)}>
              stop the bot instead
            </button>
            , and choose what happens to its position.
          </p>
          <div className="ac-dialog-actions">
            <button type="button" className="btn btn-secondary" data-autofocus onClick={onClose}>
              Keep it
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void cancel()}>
              Cancel the order
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/** Whose the orders in the market are, in one sentence. */
function whose(target: MarketTarget, total: number): string {
  const bots = target.botOrders.length;
  const mine = target.mine.length;
  if (mine === 0) return `${total === 1 ? "The order belongs" : `All ${total} orders belong`} to your ${target.base} grid bot.`;
  const theirs = `${bots} of these ${total} orders ${bots === 1 ? "belongs" : "belong"} to your ${target.base} grid bot`;
  return `${theirs}, and ${mine} ${mine === 1 ? "is" : "are"} yours.`;
}

interface MarketDialogProps {
  target: MarketTarget | null;
  busy: boolean;
  onClose: () => void;
  onStopBot: (bot: GridBotView) => void;
}

/**
 * Cancelling every order in a market where a bot is at work would stop the bot, so the trader is shown
 * which orders are whose, and can cancel only their own.
 */
export function MarketCancelDialog({ target, busy, onClose, onStopBot }: MarketDialogProps) {
  const [working, setWorking] = useState(false);
  const total = target ? target.mine.length + target.botOrders.length : 0;

  async function cancelMine() {
    if (!target) return;
    setWorking(true);
    // One at a time: each cancellation is its own request, and the first that fails says why and stops the rest.
    for (const item of target.mine) {
      if (!(await cancelOrder(item.order.symbol, item.order.id))) break;
    }
    setWorking(false);
    onClose();
  }

  async function cancelAll() {
    if (!target) return;
    setWorking(true);
    const done = await cancelAllOrders(target.symbol);
    setWorking(false);
    if (done) onClose();
  }

  return (
    <Dialog open={target !== null} onClose={onClose} title={target ? `Cancel all ${target.base} orders?` : "Cancel all orders?"} size="trade">
      {target ? (
        <div className="dialog-body ac-dialog">
          <p>{whose(target, total)}</p>
          <p className="muted">
            A bot whose orders are all cancelled stops, and sends nothing more until you start it again. You can also{" "}
            <button type="button" className="ac-link" disabled={busy || working} onClick={() => onStopBot(target.bot)}>
              stop the bot instead
            </button>
            , and choose what happens to its position.
          </p>
          <div className="ac-dialog-actions">
            <button type="button" className="btn btn-secondary" data-autofocus onClick={onClose}>
              Keep them
            </button>
            {target.mine.length > 0 ? (
              <button type="button" className="btn btn-secondary" disabled={busy || working} onClick={() => void cancelMine()}>
                Cancel only mine ({target.mine.length})
              </button>
            ) : null}
            <button type="button" className="btn btn-danger" disabled={busy || working} onClick={() => void cancelAll()}>
              Cancel all {total}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
