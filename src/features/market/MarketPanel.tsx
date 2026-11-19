import { type ReactNode, Suspense, lazy, useEffect, useId, useRef, useState } from "react";
import type { Timeframe } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { type TabOption, Tabs } from "../../components/Tabs";
import { useNow } from "../../lib/clock";
import { compact, countdown, direction, fundingRate, percent, price } from "../../lib/format";
import { usePolled } from "../../lib/hooks";
import { instrumentFor } from "../../lib/market";
import { useResolvedTheme } from "../../lib/theme";
import {
  type PanelTab,
  closeDrawer,
  openExternal,
  openTrade,
  request,
  setPanelTab,
  useApp,
  useSnapshot,
  watchAdd,
  watchRemove,
} from "../../state/app";
import { BookTab } from "./BookTab";
import { FundingTab } from "./FundingTab";
import { InstrumentMark } from "./InstrumentMark";
import { TechnicalsTab } from "./TechnicalsTab";
import { WatchlistTab } from "./WatchlistTab";

const TIMEFRAMES: SegmentOption<Timeframe>[] = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const TABS: TabOption<PanelTab>[] = [
  { value: "book", label: "Book" },
  { value: "funding", label: "Funding" },
  { value: "technicals", label: "Technicals" },
  { value: "watchlist", label: "Watchlist" },
];

/** How often slow-moving readings are read again. */
const SLOW_MS = 60_000;

// The chart library is the largest thing in the app, so it loads apart from the rest of the interface.
const PriceChart = lazy(() => import("./PriceChart").then((module) => ({ default: module.PriceChart })));

/** Chip colour for a change: green up, red down, plain when flat or unknown. */
function tone(value: number | null): "up" | "down" | undefined {
  const way = direction(value);
  return way === "flat" ? undefined : way;
}

function Countdown({ at }: { at: string | null }) {
  const now = useNow();
  return <>{countdown(at, now)}</>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd className="num">{children}</dd>
    </div>
  );
}

/** Everything about one market: price, chart, book, funding and technical readings. */
export function MarketPanel({ overlay }: { overlay: boolean }) {
  const snapshot = useSnapshot();
  const tab = useApp((state) => state.panelTab);
  const busy = useApp((state) => Boolean(state.working));
  const { focus: symbol, network } = snapshot;
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const resolved = useResolvedTheme(snapshot.theme);
  const root = useRef<HTMLElement>(null);
  const panelId = useId();

  const instrument = instrumentFor(snapshot, symbol);
  const quote = snapshot.quotes[symbol];
  const market = `${network}:${symbol}`;
  const candles = usePolled(`${market}:${timeframe}`, () => request((api) => api.candles(symbol, timeframe)), SLOW_MS);
  const technicals = usePolled(market, () => request((api) => api.marketTechnicals(symbol)), SLOW_MS);
  const funding = usePolled(market, () => request((api) => api.marketFunding(symbol)), SLOW_MS);
  const frame = technicals.data?.frames.find((item) => item.timeframe === timeframe) ?? null;

  const watched = snapshot.instruments.find((item) => item.symbol === symbol);
  const pinned = watched !== undefined && !watched.custom;

  // Slid over the page, the panel takes focus so the keyboard lands in it.
  useEffect(() => {
    if (overlay) root.current?.querySelector<HTMLElement>("button")?.focus();
  }, [overlay]);

  let chartOverlay = null;
  if (!candles.data) {
    chartOverlay = candles.error ? (
      <p className="chart-overlay" role="alert">
        {candles.error}
      </p>
    ) : (
      <p className="chart-overlay">
        <span className="spinner" />
      </p>
    );
  }

  return (
    <aside ref={root} className="panel" data-overlay={overlay} aria-label="Market">
      <header className="panel-head" data-tauri-drag-region>
        <InstrumentMark base={instrument.base} />
        <h2 className="panel-name">
          {instrument.base}
          <span className="muted"> / {instrument.quote || "USDT"}</span>
        </h2>
        <span className="grow drag" data-tauri-drag-region />
        <button
          type="button"
          className="icon-btn"
          aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
          aria-pressed={watched !== undefined}
          title={pinned ? "Always on the watchlist" : undefined}
          disabled={busy || pinned}
          onClick={() => void (watched ? watchRemove(symbol) : watchAdd(symbol))}
        >
          <Icon name={watched ? "starFilled" : "star"} />
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => openTrade()}>
          Trade
        </button>
        {overlay ? (
          <button type="button" className="icon-btn" aria-label="Close market panel" onClick={closeDrawer}>
            <Icon name="close" />
          </button>
        ) : null}
      </header>

      <div className="panel-body">
        <div className="panel-price">
          <span className="price-now num">{quote ? price(quote.price) : "—"}</span>
          {quote ? (
            <span className="chip num" data-tone={tone(quote.changePct)}>
              {percent(quote.changePct)}
            </span>
          ) : null}
          <span className="price-note">24h</span>
        </div>
        {snapshot.feedError ? (
          <p className="note" data-tone="error" role="alert">
            {snapshot.feedError}
          </p>
        ) : null}

        <dl className="stats">
          <Stat label="Mark">{price(quote?.markPrice)}</Stat>
          <Stat label="Index">{price(quote?.indexPrice)}</Stat>
          <Stat label="Funding">
            <span className={direction(quote?.fundingRatePct)}>{fundingRate(quote?.fundingRatePct)}</span>
          </Stat>
          <Stat label="Next funding">
            <Countdown at={quote?.nextFunding ?? null} />
          </Stat>
          <Stat label="Open interest">{compact(funding.data?.openInterestValue)}</Stat>
          <Stat label="24h volume">{compact(quote?.quoteVolume24h)}</Stat>
          <Stat label="24h high">{price(quote?.high24h)}</Stat>
          <Stat label="24h low">{price(quote?.low24h)}</Stat>
        </dl>

        <section className="chart-block" aria-label="Chart">
          <div className="chart-bar">
            <Segmented label="Timeframe" value={timeframe} options={TIMEFRAMES} onChange={setTimeframe} />
            <span className="chart-legend">
              <span className="legend-key" data-line="a">
                EMA 20
              </span>
              <span className="legend-key" data-line="b">
                EMA 50
              </span>
            </span>
          </div>
          <Suspense
            fallback={
              <div className="chart">
                <p className="chart-overlay">
                  <span className="spinner" />
                </p>
              </div>
            }
          >
            <PriceChart
              series={candles.data}
              levels={frame}
              themeKey={`${resolved}:${network}`}
              overlay={chartOverlay}
              credit={
                <button type="button" onClick={() => openExternal("https://www.tradingview.com/")}>
                  Chart by TradingView
                </button>
              }
            />
          </Suspense>
        </section>

        <Tabs label="Market data" value={tab} options={TABS} onChange={setPanelTab} panelId={panelId} />
        <div id={panelId} role="tabpanel" className="panel-tab" aria-label={TABS.find((item) => item.value === tab)?.label}>
          {tab === "book" ? <BookTab symbol={symbol} network={network} base={instrument.base} /> : null}
          {tab === "funding" ? <FundingTab funding={funding} quote={instrument.quote || "USDT"} base={instrument.base} /> : null}
          {tab === "technicals" ? <TechnicalsTab technicals={technicals} timeframe={timeframe} /> : null}
          {tab === "watchlist" ? <WatchlistTab /> : null}
        </div>
      </div>
    </aside>
  );
}
