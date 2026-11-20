import { useState } from "react";
import type { GridBotView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { plural } from "../../lib/format";

interface GridStopDialogProps {
  bot: GridBotView | null;
  busy: boolean;
  onClose: () => void;
  onStop: (bot: GridBotView, closePosition: boolean) => void;
}

/** Stopping a bot cancels its orders; the trader chooses whether its position goes too. */
export function GridStopDialog({ bot, busy, onClose, onStop }: GridStopDialogProps) {
  // Drawn anew for each bot, so the choice starts from that bot's own setting.
  const [close, setClose] = useState(bot?.closeOnStop ?? true);
  const orders = bot ? bot.activeBuyOrders + bot.activeSellOrders : 0;

  return (
    <Dialog open={bot !== null} onClose={onClose} title={bot ? `Stop the ${bot.base} bot` : "Stop the bot"} size="trade">
      {bot ? (
        <div className="dialog-body gb-stop">
          <p className="gb-stop-lead">
            Stopping cancels its {plural(orders, "open order")}. What should happen to your {bot.base} position?
          </p>
          <div className="gb-stop-options" role="radiogroup" aria-label="Position">
            <label className="gb-stop-option" data-selected={close}>
              <input type="radio" name={`stop-${bot.id}`} checked={close} onChange={() => setClose(true)} />
              <span>
                <strong>Close it</strong>
                <small>
                  Closes your whole {bot.base} position at the market price, including anything you opened yourself.
                </small>
              </span>
            </label>
            <label className="gb-stop-option" data-selected={!close}>
              <input type="radio" name={`stop-${bot.id}`} checked={!close} onChange={() => setClose(false)} />
              <span>
                <strong>Keep it</strong>
                <small>Leaves the position open for you to manage.</small>
              </span>
            </label>
          </div>
          <div className="gb-review-actions">
            <button type="button" className="btn btn-secondary" data-autofocus onClick={onClose}>
              Keep running
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onStop(bot, close)}>
              {close ? "Stop and close" : "Stop the bot"}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
