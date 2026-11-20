import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { NewsFeedView, StoryView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { useMinute } from "../../lib/clock";
import { plural } from "../../lib/format";
import {
  type NewsFilter,
  focusMarket,
  setNewsFilter,
  setWebSearch,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { ArticleView } from "./ArticleView";
import { type EmptyCopy, emptyCopy, filterStories, frontPage, missingText, updatedText } from "./news";
import { closeStory, needsRead, news, openStory, readNews, rememberScroll, setPublisher, useNews } from "./store";
import { Brief, Story, type StoryActions } from "./Stories";

const FILTERS: SegmentOption<NewsFilter>[] = [
  { value: "top", label: "Top stories" },
  { value: "watchlist", label: "Watchlist" },
  { value: "crypto", label: "Crypto" },
  { value: "macro", label: "Macro" },
];

const FILTER_NAMES: Record<NewsFilter, string> = {
  top: "Top stories",
  watchlist: "Stories about your watchlist",
  crypto: "Crypto stories",
  macro: "Macro stories",
};

function goToMarket(symbol: string): void {
  void focusMarket(symbol);
}

/** The News page: a front page of the newest stories, and the article view that opens one inside the app. */
export function NewsPage() {
  const story = useNews((state) => state.story);
  return (
    <>
      <NewsFront hidden={story !== null} />
      {story ? <ArticleView key={story.url} story={story} onBack={closeStory} onMarket={goToMarket} /> : null}
    </>
  );
}

function NewsFront({ hidden }: { hidden: boolean }) {
  const snapshot = useSnapshot();
  const filter = useApp((state) => state.newsFilter);
  const feed = useNews((state) => state.feed);
  const loading = useNews((state) => state.loading);
  const error = useNews((state) => state.error);
  const publisher = useNews((state) => state.publisher);
  const scroller = useRef<HTMLDivElement>(null);
  const { webSearch } = snapshot.assistant;
  const { network } = snapshot;

  // Read when the page opens with nothing recent, when web search comes back on, and on another network.
  useEffect(() => {
    if (webSearch && needsRead(network, Date.now())) void readNews();
  }, [webSearch, network]);

  // Back from a story or a market, the page is where it was, and the story read has the focus again.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || hidden) return;
    node.scrollTop = news.get().scroll;
    const returnTo = news.get().returnTo;
    if (!returnTo) return;
    news.set({ returnTo: null });
    const target = [...node.querySelectorAll<HTMLElement>("[data-story]")].find((item) => item.dataset.story === returnTo);
    target?.focus({ preventScroll: true });
  }, [hidden]);

  useLayoutEffect(() => {
    const node = scroller.current;
    return () => {
      if (node && !node.hidden) rememberScroll(node.scrollTop);
    };
  }, []);

  const watchKey = snapshot.instruments.map((item) => item.symbol).join("\n");
  const watchlist = useMemo(() => new Set(watchKey ? watchKey.split("\n") : []), [watchKey]);
  const stories = useMemo(
    () => (feed ? filterStories(feed.stories, { filter, publisher, watchlist }) : []),
    [feed, filter, publisher, watchlist],
  );
  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const story of feed ? filterStories(feed.stories, { filter, publisher: null, watchlist }) : []) {
      tally.set(story.source, (tally.get(story.source) ?? 0) + 1);
    }
    return tally;
  }, [feed, filter, watchlist]);

  const actions: StoryActions = {
    onOpen: (story) => openStory(story, scroller.current?.scrollTop ?? 0),
    onMarket: (symbol) => {
      rememberScroll(scroller.current?.scrollTop ?? 0);
      goToMarket(symbol);
    },
  };

  let body: ReactNode;
  if (!webSearch) {
    body = <OffState />;
  } else if (!feed && error) {
    body = <ErrorState message={error} />;
  } else {
    body = (
      <>
        <NewsBar feed={feed} filter={filter} publisher={publisher} loading={loading} counts={counts} />
        {!feed ? (
          <Skeleton />
        ) : stories.length > 0 ? (
          <FrontPage stories={stories} label={FILTER_NAMES[filter]} actions={actions} />
        ) : (
          <EmptyState copy={emptyCopy(filter, publisher, feed.missing, feed.stories.length)} />
        )}
      </>
    );
  }

  return (
    <div ref={scroller} className="page news-page" hidden={hidden}>
      <div className="page-inner news-inner">{body}</div>
    </div>
  );
}

interface NewsBarProps {
  feed: NewsFeedView | null;
  filter: NewsFilter;
  publisher: string | null;
  loading: boolean;
  /** Stories per publisher under the current filter. */
  counts: Map<string, number>;
}

const EDITION = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

/** The day's edition, how fresh it is, which stories to show, and the way to read them again. */
function NewsBar({ feed, filter, publisher, loading, counts }: NewsBarProps) {
  const now = useMinute();
  const missing = feed ? missingText(feed.missing) : "";
  return (
    <header className="news-header">
      <div className="news-masthead">
        <p className="news-edition">
          <span className="news-date">{EDITION.format(now)}</span>
          <span className="news-status">{feed ? updatedText(feed.readAt, now) : "Reading the newest stories…"}</span>
        </p>
        <button
          type="button"
          className="btn btn-sm btn-ghost news-refresh"
          disabled={loading}
          aria-label={loading ? "Reading the news" : "Refresh"}
          onClick={() => void readNews()}
        >
          {loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}
          <span className="news-refresh-label">Refresh</span>
        </button>
      </div>
      <div className="news-bar">
        <Segmented label="Show" value={filter} options={FILTERS} onChange={setNewsFilter} />
        {feed ? <PublisherMenu feed={feed} publisher={publisher} counts={counts} /> : null}
      </div>
      {missing ? (
        <p className="news-missing">
          <span className="dot" data-tone="warn" aria-hidden="true" />
          {missing}
        </p>
      ) : null}
    </header>
  );
}

function PublisherMenu({ feed, publisher, counts }: { feed: NewsFeedView; publisher: string | null; counts: Map<string, number> }) {
  const current = publisher ?? "All publishers";
  return (
    <Menu
      triggerClass="news-publisher"
      align="end"
      label={`Publisher: ${current}`}
      trigger={
        <>
          <span className="truncate">{current}</span>
          <Icon name="chevronDown" size={14} />
        </>
      }
    >
      <MenuItem label="All publishers" checked={publisher === null} onSelect={() => setPublisher(null)} />
      <div className="menu-sep" role="separator" />
      {feed.publishers.map((name) => {
        const count = counts.get(name) ?? 0;
        return (
          <MenuItem
            key={name}
            label={name}
            sub={feed.missing.includes(name) ? "Could not be reached" : count > 0 ? plural(count, "story", "stories") : "Nothing here"}
            checked={publisher === name}
            onSelect={() => setPublisher(name)}
          />
        );
      })}
    </Menu>
  );
}

/** The stories laid out like a front page: a lead and two beside it, a grid of cards, then the rest in brief. */
function FrontPage({ stories, label, actions }: { stories: StoryView[]; label: string; actions: StoryActions }) {
  const { lead, rail, grid, brief } = useMemo(() => frontPage(stories), [stories]);
  const topId = useId();
  const gridId = useId();
  const briefId = useId();
  return (
    <>
      {lead ? (
        <section className="front-top" aria-labelledby={topId}>
          <h2 id={topId} className="visually-hidden">
            {label}
          </h2>
          <Story story={lead} variant="lead" {...actions} />
          {rail.length > 0 ? (
            <div className="front-rail">
              {rail.map((story) => (
                <Story key={story.url} story={story} variant="rail" {...actions} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {grid.length > 0 ? (
        <section className="front-section" aria-labelledby={gridId}>
          <h2 id={gridId} className="front-section-title">
            More stories
          </h2>
          <div className="front-grid">
            {grid.map((story) => (
              <Story key={story.url} story={story} variant="card" {...actions} />
            ))}
          </div>
        </section>
      ) : null}
      {brief.length > 0 ? (
        <section className="front-section" aria-labelledby={briefId}>
          <h2 id={briefId} className="front-section-title">
            In brief
          </h2>
          <ul className="front-brief">
            {brief.map((story) => (
              <Brief key={story.url} story={story} {...actions} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** The shape of the front page while the first read is under way. */
function Skeleton() {
  return (
    <div className="news-skeleton" aria-busy="true">
      <p className="visually-hidden" role="status">
        Reading the news
      </p>
      <div className="front-top" aria-hidden="true">
        <div className="story story-lead">
          <span className="pic story-pic skel" />
          <span className="skel skel-line" data-width="short" />
          <span className="skel skel-title" />
          <span className="skel skel-title" data-width="most" />
          <span className="skel skel-line" />
          <span className="skel skel-line" data-width="most" />
        </div>
        <div className="front-rail">
          {[0, 1].map((key) => (
            <div key={key} className="story story-rail">
              <span className="pic story-pic skel" />
              <span className="skel skel-line" data-width="short" />
              <span className="skel skel-line" />
              <span className="skel skel-line" data-width="most" />
            </div>
          ))}
        </div>
      </div>
      <div className="front-section" aria-hidden="true">
        <span className="front-section-title skel-rule" />
        <div className="front-grid">
          {[0, 1, 2].map((key) => (
            <div key={key} className="story story-card">
              <span className="pic story-pic skel" />
              <span className="skel skel-line" data-width="short" />
              <span className="skel skel-line" />
              <span className="skel skel-line" data-width="most" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StateBlock({
  icon,
  title,
  children,
  action,
  alert = false,
}: {
  icon: "magazine" | "alert" | "search";
  title: string;
  children: ReactNode;
  action: ReactNode;
  alert?: boolean;
}) {
  const titleId = useId();
  return (
    <section className="news-state" aria-labelledby={titleId} role={alert ? "alert" : undefined}>
      <span className="news-state-mark" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h2 id={titleId} className="news-state-title">
        {title}
      </h2>
      <p className="news-state-text">{children}</p>
      <div className="news-state-actions">{action}</div>
    </section>
  );
}

/** While web search is off the core reads no feed; turning it on here is the same switch as in Settings. */
function OffState() {
  const busy = useBusy();
  return (
    <StateBlock
      icon="magazine"
      title="Web search is off"
      action={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void setWebSearch(true)}>
          Turn on web search
        </button>
      }
    >
      The News page reads publishers&rsquo; feeds from the web, so it needs web search. Turning it on also lets the
      assistant search the news and read pages you share.
    </StateBlock>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <StateBlock
      icon="alert"
      title="The news could not be read"
      alert
      action={
        <button type="button" className="btn btn-secondary" onClick={() => void readNews()}>
          <Icon name="refresh" size={15} />
          Try again
        </button>
      }
    >
      {message}
    </StateBlock>
  );
}

function EmptyState({ copy }: { copy: EmptyCopy }) {
  const act = () => {
    if (copy.action.kind === "top") setNewsFilter("top");
    else if (copy.action.kind === "publisher") setPublisher(null);
    else void readNews();
  };
  return (
    <StateBlock
      icon="search"
      title={copy.title}
      action={
        <button type="button" className="btn btn-secondary" onClick={act}>
          {copy.action.label}
        </button>
      }
    >
      {copy.text}
    </StateBlock>
  );
}
