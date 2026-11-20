import { useEffect, useId, useRef, useState } from "react";
import { isDesktop } from "../../api";
import type { ArticleBounds, ArticleEvent, StoryView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { app, errorText, onArticle, openExternal, request, useApp } from "../../state/app";
import { siteOf } from "./news";
import { Picture } from "./Picture";
import { Age, MarketChips } from "./Stories";

/**
 * Article commands run one after another, so a move or a close never overtakes the open
 * before it, even when a story is left before it finished opening.
 */
let queue: Promise<unknown> = Promise.resolve();

/** A command that has not answered by then no longer holds back the ones after it, such as the close. */
const COMMAND_LIMIT_MS = 15_000;

function serial(task: () => Promise<void>): void {
  const run = queue.then(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((done) => {
      timer = setTimeout(done, COMMAND_LIMIT_MS);
    });
    return Promise.race([task(), limit]).finally(() => clearTimeout(timer));
  });
  queue = run.catch(() => undefined);
}

/** CSS pixels from the window's top-left corner, snapped to whole pixels so sub-pixel layout does not jitter. */
function boundsOf(node: HTMLElement): ArticleBounds {
  const rect = node.getBoundingClientRect();
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);
  return { x, y, width: Math.max(0, Math.round(rect.right) - x), height: Math.max(0, Math.round(rect.bottom) - y) };
}

function sameBounds(a: ArticleBounds, b: ArticleBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** What the article view would hide: it is drawn over the page, so nothing on the page can sit above it. */
const OVERLAYS = 'dialog[open], [role="menu"]';

function overlayOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(OVERLAYS) !== null;
}

/** Whether a dialog or a menu is open anywhere in the window. */
function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(overlayOpen);
  useEffect(() => {
    const observer = new MutationObserver(() => setOpen(overlayOpen()));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "role"] });
    return () => observer.disconnect();
  }, []);
  return open;
}

/** The narrow sidebar slides away in a fifth of a second: the article comes back once it has gone. */
const DRAWER_EXIT_MS = 220;
/** A page that never reports it finished loading stops showing that it is loading after this long. */
const LOADING_LIMIT_MS = 20_000;

interface ArticleViewProps {
  story: StoryView;
  onBack: () => void;
  onMarket: (symbol: string) => void;
}

/**
 * A story read inside the app. In the desktop app the article is a separate browser view that
 * the shell draws over `.article-host`; here the page only measures where it goes and keeps it
 * there. In a plain browser there is no such view, and a reading panel stands in for it.
 */
export function ArticleView({ story, onBack, onMarket }: ArticleViewProps) {
  const native = isDesktop();
  const [page, setPage] = useState<ArticleEvent | null>(null);
  const [problem, setProblem] = useState("");
  const [stalled, setStalled] = useState(false);
  /** Counts tries at opening the view, so a failed open can be tried again. */
  const [attempt, setAttempt] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const drawer = useApp((state) => state.drawer === "sidebar");
  const overlay = useOverlayOpen();
  const covered = drawer || overlay;
  const shown = useRef(true);
  const lastCover = useRef<"drawer" | "overlay" | null>(null);

  const url = page?.url || story.url;
  /** Only `https` pages open in the browser; anywhere else, the story's own address does. */
  const external = /^https:\/\//i.test(url) ? url : story.url;
  const title = page?.title?.trim() || story.title;
  const loading = native && !problem && !stalled && (page ? page.loading : true);

  // The keyboard lands on the way back, so Enter or Escape returns to the news.
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!native) return;
    return onArticle((event) => {
      setPage(event);
      setStalled(false);
    });
  }, [native]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setStalled(true), LOADING_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  // Open the view where the host is, keep it there, and close it on the way out.
  useEffect(() => {
    const node = host.current;
    const toolbar = bar.current;
    if (!node || !toolbar) return;
    const root = document.documentElement;
    let alive = true;
    let opened = false;
    let frame = 0;
    let sent = boundsOf(node);

    const place = () => {
      frame = 0;
      // Notices cannot show over the article, so they sit over its toolbar instead (see news.css).
      const edge = toolbar.getBoundingClientRect();
      root.style.setProperty("--article-toast-bottom", `${Math.round(window.innerHeight - edge.bottom + 6)}px`);
      root.style.setProperty("--article-toast-x", `${Math.round(edge.left + edge.width / 2)}px`);
      root.style.setProperty("--article-toast-width", `${Math.max(240, Math.round(edge.width - 32))}px`);
      if (!native || !opened) return;
      const next = boundsOf(node);
      if (sameBounds(next, sent)) return;
      sent = next;
      serial(() => request((api) => api.moveArticle(next)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };

    root.dataset.article = "open";
    place();
    if (native) {
      const first = sent;
      serial(async () => {
        try {
          await request((api) => api.openArticle(story.url, first));
          opened = true;
          // A dialog may have opened meanwhile; and anything may have moved.
          if (!shown.current) await request((api) => api.showArticle(false));
          schedule();
        } catch (error) {
          if (alive) setProblem(errorText(error));
        }
      });
    }

    // The sidebar (Ctrl/Cmd+B), the window and the toolbar all move or resize the host.
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    observer.observe(toolbar);
    window.addEventListener("resize", schedule);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      delete root.dataset.article;
      for (const name of ["--article-toast-bottom", "--article-toast-x", "--article-toast-width"]) {
        root.style.removeProperty(name);
      }
      if (native) serial(() => request((api) => api.closeArticle()));
    };
  }, [native, story.url, attempt]);

  /** Reloads the page, or tries the open again when the view could not be opened. */
  function reload() {
    if (problem) {
      setProblem("");
      setStalled(false);
      setAttempt((count) => count + 1);
    } else {
      serial(() => request((api) => api.reloadArticle()));
    }
  }

  // Step aside while a dialog, a menu or the narrow sidebar is open, and come back after.
  useEffect(() => {
    if (drawer) lastCover.current = "drawer";
    else if (overlay) lastCover.current = "overlay";
    if (!native) return;
    const show = !covered;
    if (shown.current === show) return;
    const wait = show && lastCover.current === "drawer" ? DRAWER_EXIT_MS : 0;
    const timer = setTimeout(() => {
      shown.current = show;
      serial(() => request((api) => api.showArticle(show)));
    }, wait);
    return () => clearTimeout(timer);
  }, [covered, drawer, overlay, native]);

  // Escape returns to the news, unless something else that is open takes it first.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || overlayOpen() || app.get().drawer) return;
      event.preventDefault();
      onBack();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const Title = native ? "h2" : "p";
  const site = siteOf(url);

  return (
    <div className="article-view">
      <div ref={bar} className="article-bar">
        <button ref={back} type="button" className="article-back" aria-label="Back to News" onClick={onBack}>
          <Icon name="back" size={16} />
          <span>News</span>
        </button>
        <span className="article-sep" aria-hidden="true" />
        <div className="article-heading">
          <Title className="article-title truncate" title={title}>
            {title}
          </Title>
          <p className="article-where">
            <span className="article-publisher">{story.source}</span>
            {site ? <span className="article-site truncate">{site}</span> : null}
          </p>
        </div>
        <div className="article-actions">
          {native ? (
            <button type="button" className="icon-btn" aria-label="Reload" title="Reload" onClick={reload}>
              <Icon name="refresh" size={16} />
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-secondary article-external"
            aria-label="Open in browser"
            title={external}
            onClick={() => openExternal(external)}
          >
            <Icon name="external" size={15} />
            <span className="article-external-label">Open in browser</span>
          </button>
        </div>
        <span className="article-progress" data-active={loading} aria-hidden="true" />
      </div>
      <div ref={host} className="article-host" data-native={native} aria-busy={loading || undefined}>
        {native ? (
          <Standby story={story} problem={problem} url={external} loading={loading} onRetry={reload} />
        ) : (
          <Reader story={story} onMarket={onMarket} />
        )}
      </div>
    </div>
  );
}

/**
 * What the host shows where the article view is not drawn: before it first paints, while it
 * steps aside for a dialog, or when it could not open.
 */
interface StandbyProps {
  story: StoryView;
  problem: string;
  url: string;
  loading: boolean;
  onRetry: () => void;
}

function Standby({ story, problem, url, loading, onRetry }: StandbyProps) {
  if (problem) {
    return (
      <div className="article-standby" role="alert">
        <p className="article-standby-title">This article could not be opened here</p>
        <p className="article-standby-text">{problem}</p>
        <div className="article-standby-actions">
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            <Icon name="refresh" size={15} />
            Try again
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => openExternal(url)}>
            <Icon name="external" size={15} />
            Open in browser
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="article-standby" aria-hidden="true">
      <p className="article-standby-source">{story.source}</p>
      <p className="article-standby-title">{story.title}</p>
      {loading ? <span className="spinner" /> : null}
    </div>
  );
}

/** The browser stand-in for the article view: the story as the feed describes it, and the way to the full text. */
function Reader({ story, onMarket }: { story: StoryView; onMarket: (symbol: string) => void }) {
  const titleId = useId();
  return (
    <article className="reader" aria-labelledby={titleId}>
      {/* Unlike the front page, the panel needs no tile to keep a rhythm: without a picture it starts with the text. */}
      {story.image ? <Picture image={story.image} source={story.source} className="reader-pic" eager /> : null}
      <div className="reader-text">
        <p className="reader-source">{story.source}</p>
        <h2 id={titleId} className="reader-title">
          {story.title}
        </h2>
        {story.summary ? <p className="reader-summary">{story.summary}</p> : null}
        <div className="reader-meta">
          <Age iso={story.published} className="story-time" />
          <MarketChips markets={story.markets} onMarket={onMarket} />
        </div>
        <div className="reader-actions">
          <button type="button" className="btn btn-primary" onClick={() => openExternal(story.url)}>
            <Icon name="external" size={15} />
            Open in browser
          </button>
        </div>
        <p className="reader-note">
          <Icon name="info" size={16} />
          <span>This is a preview. In the desktop app the full article opens right here, without leaving OctoNeo.</span>
        </p>
      </div>
    </article>
  );
}
