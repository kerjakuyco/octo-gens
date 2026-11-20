import { useId, useMemo, useState } from "react";
import type { GridBotView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Pagination } from "../../components/Pagination";
import { Segmented } from "../../components/Segmented";
import { useNow } from "../../lib/clock";
import { paginateList } from "../../lib/pagination";
import { syncGrids } from "../../state/app";
import { GridBotCard } from "./GridBotCard";
import { isActive } from "./labels";

export type BotsView = "running" | "stopped";

const PAGE_SIZE = 5;

interface GridBotsProps {
  bots: GridBotView[];
  view: BotsView;
  onView: (view: BotsView) => void;
  busy: boolean;
  onStop: (bot: GridBotView) => void;
  onRemove: (bot: GridBotView) => void;
  onReuse: (bot: GridBotView) => void;
}

/** The trader's bots on the active network: those at work, and those that stopped. */
export function GridBots({ bots, view, onView, busy, onStop, onRemove, onReuse }: GridBotsProps) {
  const now = useNow();
  const titleId = useId();
  const [page, setPage] = useState(1);
  const running = useMemo(() => bots.filter((bot) => isActive(bot.status)), [bots]);
  const stopped = useMemo(() => bots.filter((bot) => !isActive(bot.status)), [bots]);
  const shown = view === "running" ? running : stopped;
  const slice = useMemo(() => paginateList(shown, page, PAGE_SIZE), [shown, page]);

  return (
    <section className="gb-section" aria-labelledby={titleId} id="grid-bots">
      <div className="gb-section-head">
        <h2 id={titleId} className="gb-section-title">
          Your bots
        </h2>
        <Segmented
          label="Show"
          value={view}
          options={[
            { value: "running", label: `Running ${running.length}` },
            { value: "stopped", label: `Stopped ${stopped.length}` },
          ]}
          onChange={(next) => {
            onView(next);
            setPage(1);
          }}
        />
        <span className="grow" />
        {running.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            title="Bots are checked every 15 seconds while the app is open"
            onClick={() => void syncGrids()}
          >
            <Icon name="refresh" size={14} />
            <span>Check now</span>
          </button>
        ) : null}
      </div>

      {slice.items.length > 0 ? (
        <div className="gb-bot-list">
          {slice.items.map((bot, index) => (
            <GridBotCard
              key={bot.id}
              bot={bot}
              index={index}
              now={now}
              busy={busy}
              onStop={onStop}
              onRemove={onRemove}
              onReuse={onReuse}
            />
          ))}
          {shown.length > PAGE_SIZE ? (
            <Pagination label="Bots pages" itemLabel="bots" slice={slice} onPageChange={setPage} />
          ) : null}
        </div>
      ) : (
        <p className="gb-empty">
          {view === "running"
            ? "No bot is running. Set one up below."
            : "Bots you stop stay here with what they made, until you remove them."}
        </p>
      )}
    </section>
  );
}
