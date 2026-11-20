import { useState } from "react";
import type { GridBotView, GridPreviewView, GridRequest } from "../../api/types";
import { activeWallet } from "../../lib/market";
import { deleteGrid, errorText, previewGrid, startGrid, stopGrid, useBusy, useSnapshot } from "../../state/app";
import { GridBots, type BotsView } from "./GridBots";
import { GridBuilder } from "./GridBuilder";
import { GridLevels } from "./GridLevels";
import { GridReview } from "./GridReview";
import { GridStopDialog } from "./GridStopDialog";
import { GridSummary } from "./GridSummary";
import { useGridForm } from "./useGridForm";

interface Review {
  preview: GridPreviewView;
  request: GridRequest;
  /** Draws the dialog anew for each review. */
  key: number;
}

/** Brings the list of bots into view, smoothly unless the trader asked for less motion. */
function revealBots(): void {
  requestAnimationFrame(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("grid-bots")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  });
}

/**
 * Grid bots: the bots at work and what they made, and the form for a new one beside the price levels
 * it would use. A new bot is reviewed as a dry run before anything is sent.
 */
export function GridPage() {
  const snapshot = useSnapshot();
  const busy = useBusy();
  const form = useGridForm();
  const wallet = activeWallet(snapshot);
  const canTrade = wallet.connected && !wallet.needsDeposit;
  const available = snapshot.account ? Number(snapshot.account.available) || 0 : null;

  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [problem, setProblem] = useState("");
  /** Why the reviewed bot did not start, shown in the review beside its button. */
  const [refusal, setRefusal] = useState("");
  const [stopping, setStopping] = useState<GridBotView | null>(null);
  const [view, setView] = useState<BotsView>("running");

  async function startReview() {
    const request = form.toRequest();
    setProblem("");
    setReviewing(true);
    try {
      const preview = await previewGrid(request);
      setRefusal("");
      setReview({ preview, request, key: Date.now() });
    } catch (error: unknown) {
      setProblem(errorText(error));
    } finally {
      setReviewing(false);
    }
  }

  async function start() {
    if (!review) return;
    setRefusal("");
    const reason = await startGrid(review.request);
    if (reason) {
      setRefusal(reason);
      return;
    }
    setReview(null);
    setView("running");
    revealBots();
  }

  async function stop(bot: GridBotView, closePosition: boolean) {
    if (await stopGrid(bot.id, closePosition)) setStopping(null);
  }

  function reuse(bot: GridBotView) {
    form.reuse(bot);
    requestAnimationFrame(() => {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("grid-builder")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    });
  }

  const hasBots = snapshot.grids.length > 0;

  return (
    <div className="page">
      <div className="page-inner gb-page">
        {hasBots ? (
          <GridSummary bots={snapshot.grids} available={available} />
        ) : (
          <p className="gb-intro">
            A grid bot places buy orders below the price and sell orders above it. Each time one fills, it places the
            opposite order a level away, so it earns while the price moves back and forth inside its range.
          </p>
        )}

        {hasBots ? (
          <GridBots
            bots={snapshot.grids}
            view={view}
            onView={setView}
            busy={busy}
            onStop={setStopping}
            onRemove={(bot) => void deleteGrid(bot.id)}
            onReuse={reuse}
          />
        ) : null}

        <div className="gb-workspace" id="grid-builder">
          <GridBuilder
            form={form}
            canTrade={canTrade}
            available={available}
            maxLeverage={snapshot.risk.maxLeverage}
            reviewing={reviewing}
            busy={busy}
            error={problem}
            onReview={() => void startReview()}
          />
          <GridLevels
            prices={form.prices}
            sides={form.plan.sides}
            mark={form.mark}
            base={form.instrument.base}
            quote={form.instrument.quote || "USDT"}
            buys={form.plan.buyCount}
            sells={form.plan.sellCount}
            initial={form.plan.initialSide ? { side: form.plan.initialSide, legs: form.plan.initialLegs } : null}
            estimate={form.estimate}
            profit={form.profit}
            width={form.width}
            startPrice={form.startPrice}
            stopBelow={form.stopBelowPrice}
            stopAbove={form.stopAbovePrice}
          />
        </div>
      </div>

      <GridReview
        key={review?.key ?? 0}
        preview={review?.preview ?? null}
        busy={busy}
        error={refusal}
        onClose={() => setReview(null)}
        onStart={() => void start()}
      />
      <GridStopDialog
        key={stopping?.id ?? "none"}
        bot={stopping}
        busy={busy}
        onClose={() => setStopping(null)}
        onStop={(bot, closePosition) => void stop(bot, closePosition)}
      />
    </div>
  );
}
