import { useEffect, useMemo, useRef } from "react";
import type { Feed } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { baseOf, price } from "../../lib/format";
import { newThread, setFeed, setPanelOpen, useApp, useSnapshot } from "../../state/app";
import { MarketPanel } from "../market/MarketPanel";
import { TicketCard } from "../market/TicketCard";
import { Composer } from "./Composer";
import { LiveTurnView } from "./LiveTurnView";
import { RunEntry } from "./RunEntry";
import { Welcome } from "./Welcome";

const FEEDS: SegmentOption<Feed>[] = [
  { value: "sample", label: "Sample" },
  { value: "binance", label: "Binance" },
  { value: "bybit", label: "Bybit" },
  { value: "okx", label: "OKX" },
];

/** How close to the bottom still counts as "following" the conversation. */
const FOLLOW_SLACK = 80;

export function AssistantPage() {
  const snapshot = useSnapshot();
  const live = useApp((state) => state.live);
  const working = useApp((state) => state.working);
  const panelOpen = useApp((state) => state.panelOpen);
  const tradeOpen = useApp((state) => state.tradeOpen);

  const liveId = live?.run.id ?? "";
  const runs = useMemo(
    () =>
      snapshot.runs
        .filter((run) => run.thread === snapshot.thread && run.status !== "running" && run.id !== liveId)
        .reverse(),
    [snapshot.runs, snapshot.thread, liveId],
  );

  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const empty = runs.length === 0 && !live;

  // Keep the newest text in view unless the reader has scrolled up to look at something.
  useEffect(() => {
    const node = scroller.current;
    if (node && following.current && !empty) node.scrollTop = node.scrollHeight;
  }, [runs.length, live, empty]);

  const busy = Boolean(live) || snapshot.busy || Boolean(working);
  const title = runs[0]?.title ?? live?.run.title ?? "New conversation";
  const quote = snapshot.quotes[snapshot.focus];
  const draft = snapshot.draft;
  const draftShown =
    !draft || tradeOpen || live?.run.ticket?.id === draft.id || runs.some((run) => run.ticket?.id === draft.id);

  return (
    <div className="assistant">
      <section className="chat" aria-label="Conversation">
        <header className="chat-head">
          <h1 className="chat-title">{title}</h1>
          <button type="button" className="btn btn-quiet btn-small" disabled={busy || empty} onClick={() => void newThread()}>
            <Icon name="compose" size={15} />
            New chat
          </button>
          <Segmented label="Price feed" value={snapshot.feed} options={FEEDS} disabled={busy} onChange={(feed) => void setFeed(feed)} />
          <button
            type="button"
            className="btn btn-secondary btn-small panel-toggle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            <Icon name="chart" size={15} />
            {baseOf(snapshot.focus)} {quote ? price(quote.price) : ""}
          </button>
        </header>

        <div
          className="chat-scroll"
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SLACK;
          }}
        >
          {empty ? (
            <Welcome />
          ) : (
            <div className="thread">
              {runs.map((run) => (
                <RunEntry key={run.id} run={run} />
              ))}
              {live ? <LiveTurnView live={live} /> : null}
            </div>
          )}
        </div>

        {draft && !draftShown ? (
          <div className="ticket-dock">
            <div className="ticket-dock-label">A ticket is waiting for your decision.</div>
            <TicketCard ticket={draft} />
          </div>
        ) : null}
        <Composer />
      </section>

      <button
        type="button"
        className="panel-scrim"
        data-open={panelOpen}
        aria-label="Close the market panel"
        tabIndex={-1}
        onClick={() => setPanelOpen(false)}
      />
      <MarketPanel />
    </div>
  );
}
