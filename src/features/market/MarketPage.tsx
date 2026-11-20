import { type FocusEvent, type KeyboardEvent, type ReactNode, Suspense, lazy, useEffect, useId, useMemo, useRef } from "react";
import type { OpenOrderView, TechnicalFrame, Timeframe } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { type TabOption, Tabs } from "../../components/Tabs";
import { useNow } from "../../lib/clock";
import { compact, countdown, direction, fundingRate, leverage, percent, price, signedMoney, units } from "../../lib/format";
import { usePolled } from "../../lib/hooks";
import { basisBps, candleAnalytics, rangePositionPct, trendConfluence } from "../../lib/indicators";
import { instrumentFor } from "../../lib/market";
import { useResolvedTheme } from "../../lib/theme";
import {
  type ChartOverlays,
  type MarketTab,
  ask,
  cancelAllOrders,
  cancelOrder,
  closePosition,
  openExternal,
  openGrid,
  openTrade,
  prefillComposer,
  request,
  setChartTimeframe,
  setMarketTab,
  toggleChartOverlay,
  useApp,
  useBusy,
  useSnapshot,
  watchAdd,
  watchRemove,
} from "../../state/app";
import { BookTab } from "./BookTab";
import { FundingTab } from "./FundingTab";
import { TechnicalsTab } from "./TechnicalsTab";
import { WatchlistTab } from "./WatchlistTab";

const TIMEFRAMES: SegmentOption<Timeframe>[] = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const TABS: TabOption<MarketTab>[] = [
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

function Metric({ label, children, sub, footer }: { label: string; children: ReactNode; sub?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="market-metric">
      <dt>{label}</dt>
      <dd className="num">
        <span>{children}</span>
        {sub ? <small className="muted">{sub}</small> : null}
      </dd>
      {footer}
    </div>
  );
}

function orderLabel(order: OpenOrderView): string {
  const type = order.type.toUpperCase();
  if (type.includes("TAKE_PROFIT")) return "Take-profit";
  if (type.includes("STOP")) return "Stop-loss";
  return order.type.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

interface OverlayToolbarProps {
  overlays: ChartOverlays;
  hasTradeLines: boolean;
  onToggle: (key: keyof ChartOverlays) => void;
}

/** Single-tab-stop toolbar for chart overlays using native `focusgroup` with a roving-tabindex fallback. */
function OverlayToolbar({ overlays, hasTradeLines, onToggle }: OverlayToolbarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof HTMLElement === "undefined" || "focusGroup" in HTMLElement.prototype) return;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
    if (!buttons.some((button) => button.tabIndex === 0)) {
      buttons.forEach((button, index) => {
        button.tabIndex = index === 0 ? 0 : -1;
      });
    }
  }, [hasTradeLines]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) return;
    const bar = barRef.current;
    if (!bar) return;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || buttons.length === 0) return;
    const rtl = getComputedStyle(bar).direction === "rtl";
    let next = -1;
    if (event.key === "ArrowRight") next = (index + (rtl ? -1 : 1) + buttons.length) % buttons.length;
    else if (event.key === "ArrowLeft") next = (index + (rtl ? 1 : -1) + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    buttons.forEach((button, i) => {
      button.tabIndex = i === next ? 0 : -1;
    });
    buttons[next]?.focus();
  }

  function onFocusIn(event: FocusEvent<HTMLDivElement>) {
    if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) return;
    const bar = barRef.current;
    if (!bar || !(event.target instanceof HTMLButtonElement)) return;
    for (const button of bar.querySelectorAll<HTMLButtonElement>("button")) {
      button.tabIndex = button === event.target ? 0 : -1;
    }
  }

  const controls: { key: keyof ChartOverlays; label: string; title: string; swatch?: string }[] = [
    { key: "ema", label: "EMA 20/50", title: "Toggle EMA 20 and EMA 50", swatch: "ema" },
    { key: "ema200", label: "EMA 200", title: "Toggle EMA 200", swatch: "ema200" },
    { key: "bollinger", label: "BB", title: "Toggle Bollinger Bands (20, 2)", swatch: "bb" },
    { key: "levels", label: "S/R", title: "Toggle support and resistance lines", swatch: "sr" },
  ];
  if (hasTradeLines) {
    controls.push({ key: "orders", label: "Orders", title: "Toggle entry, liquidation, SL and TP lines" });
  }

  return (
    <div
      ref={barRef}
      className="overlay-toolbar"
      role="toolbar"
      aria-label="Chart overlays"
      onKeyDown={onKeyDown}
      onFocus={onFocusIn}
      {...({ focusgroup: "toolbar wrap" } as Record<string, string>)}
    >
      {controls.map((item) => (
        <button
          key={item.key}
          type="button"
          className="overlay-pill"
          aria-pressed={overlays[item.key]}
          title={item.title}
          onClick={() => onToggle(item.key)}
        >
          {item.swatch ? <span className="overlay-swatch" data-kind={item.swatch} aria-hidden="true" /> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Distance from `spot` to an EMA level, formatted cleanly. */
function MaRow({ label, value, spot, swatch }: { label: string; value: number | null; spot: number; swatch: string }) {
  const diffPct = value !== null && value > 0 && spot > 0 ? (spot / value - 1) * 100 : null;
  return (
    <div className="struct-row">
      <dt className="struct-label">
        <span className="overlay-swatch" data-kind={swatch} aria-hidden="true" />
        {label}
      </dt>
      <dd className="num">
        <span>{value === null ? "—" : price(value)}</span>
        <span className={diffPct === null ? "muted" : direction(diffPct)}>
          {diffPct === null ? "" : percent(diffPct)}
        </span>
      </dd>
    </div>
  );
}

/** Multi-timeframe confluence + moving averages + volatility/range analytics beneath the chart. */
function MarketStructure({
  frames,
  activeFrame,
  timeframe,
  spot,
  analytics,
  onSelectTimeframe,
}: {
  frames: TechnicalFrame[];
  activeFrame: TechnicalFrame | null;
  timeframe: Timeframe;
  spot: number;
  analytics: ReturnType<typeof candleAnalytics>;
  onSelectTimeframe: (tf: Timeframe) => void;
}) {
  const confluence = useMemo(() => trendConfluence(frames), [frames]);
  const bbClamped = analytics.bbPositionPct === null ? null : Math.min(100, Math.max(0, analytics.bbPositionPct));

  return (
    <div className="structure-grid">
      <section className="structure-card" aria-label="Trend and moving averages">
        <div className="structure-head">
          <h2 className="structure-title">Trend &amp; MAs</h2>
          <span className="chip" data-tone={confluence.tone}>
            {confluence.label}
          </span>
        </div>

        <div className="tf-strip" role="group" aria-label="Timeframe bias">
          {frames.map((item) => {
            const dotTone = item.trend === "uptrend" ? "up" : item.trend === "downtrend" ? "down" : undefined;
            return (
              <button
                key={item.timeframe}
                type="button"
                className="tf-pill"
                aria-pressed={item.timeframe === timeframe}
                onClick={() => onSelectTimeframe(item.timeframe)}
              >
                <span className="tf-pill-top">
                  <span className="dot" data-tone={dotTone} />
                  <span>{item.timeframe}</span>
                </span>
                <span className={`num tf-pill-chg ${direction(item.changePct)}`}>{percent(item.changePct)}</span>
              </button>
            );
          })}
        </div>

        <dl className="struct-rows">
          <MaRow label="EMA 20" value={activeFrame?.ema20 ?? null} spot={spot} swatch="ema-a" />
          <MaRow label="EMA 50" value={activeFrame?.ema50 ?? null} spot={spot} swatch="ema-b" />
          <MaRow label="EMA 200" value={activeFrame?.ema200 ?? null} spot={spot} swatch="ema200" />
        </dl>
      </section>

      <section className="structure-card" aria-label="Volatility and volume">
        <div className="structure-head">
          <h2 className="structure-title">
            Volatility &amp; Flow <span className="muted">{timeframe}</span>
          </h2>
          {analytics.rvol !== null ? (
            <span className="chip num" data-tone={analytics.rvol >= 1.5 ? "warn" : undefined}>
              RVOL {analytics.rvol.toFixed(2)}×
            </span>
          ) : null}
        </div>

        <div className="band-meter">
          <div className="band-meter-head">
            <span className="muted">Bollinger (20, 2σ)</span>
            <span className="num muted">
              {analytics.bbWidthPct === null ? "—" : `Width ${analytics.bbWidthPct.toFixed(2)}%`}
            </span>
          </div>
          <div className="gauge-track" aria-hidden="true">
            <span className="gauge-mid" />
            {bbClamped !== null ? <span className="gauge-dot" style={{ left: `${bbClamped}%` }} /> : null}
          </div>
          <div className="band-meter-bounds num muted">
            <span>{analytics.bbLower === null ? "—" : price(analytics.bbLower)}</span>
            <span>{analytics.bbMiddle === null ? "" : price(analytics.bbMiddle)}</span>
            <span>{analytics.bbUpper === null ? "—" : price(analytics.bbUpper)}</span>
          </div>
        </div>

        <dl className="struct-rows">
          <div className="struct-row">
            <dt className="struct-label">ATR (14)</dt>
            <dd className="num">
              {activeFrame?.atrPct === null || activeFrame?.atrPct === undefined ? "—" : `${activeFrame.atrPct.toFixed(2)}%`}
            </dd>
          </div>
          <div className="struct-row">
            <dt className="struct-label">Realised vol (30-bar)</dt>
            <dd className="num">{analytics.volatilityPct === null ? "—" : `${analytics.volatilityPct.toFixed(1)}%`}</dd>
          </div>
          <div className="struct-row">
            <dt className="struct-label">20-bar range</dt>
            <dd className="num">
              {analytics.range20Low !== null && analytics.range20High !== null
                ? `${price(analytics.range20Low)} – ${price(analytics.range20High)}`
                : "—"}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

/** Full-width workspace for one market: live price, key metrics, interactive chart, structure cards, and detail tabs. */
export function MarketPage() {
  const snapshot = useSnapshot();
  const tab = useApp((state) => state.marketTab);
  const timeframe = useApp((state) => state.chartTimeframe);
  const overlays = useApp((state) => state.chartOverlays);
  const busy = useBusy();
  const { focus: symbol, network } = snapshot;
  const resolved = useResolvedTheme(snapshot.theme);
  const panelId = useId();

  const instrument = instrumentFor(snapshot, symbol);
  const quote = snapshot.quotes[symbol];
  const position = snapshot.account?.positions.find((item) => item.symbol === symbol) ?? null;
  const openOrders = useMemo(
    () => (snapshot.account?.orders ?? []).filter((order) => order.symbol === symbol),
    [snapshot.account?.orders, symbol],
  );
  const market = `${network}:${symbol}`;
  const candles = usePolled(`${market}:${timeframe}`, () => request((api) => api.candles(symbol, timeframe)), SLOW_MS);
  const technicals = usePolled(market, () => request((api) => api.marketTechnicals(symbol)), SLOW_MS);
  const funding = usePolled(market, () => request((api) => api.marketFunding(symbol)), SLOW_MS);
  const frames = technicals.data?.frames ?? [];
  const frame = frames.find((item) => item.timeframe === timeframe) ?? null;

  const spot = Number(quote?.price ?? technicals.data?.price ?? 0);
  const analytics = useMemo(
    () => candleAnalytics(candles.data?.rows ?? [], timeframe, spot),
    [candles.data?.rows, timeframe, spot],
  );
  const basis = basisBps(quote?.markPrice, quote?.indexPrice);
  const dayPos = rangePositionPct(quote?.price, quote?.low24h, quote?.high24h);

  const watched = snapshot.instruments.find((item) => item.symbol === symbol);
  const pinned = watched !== undefined && !watched.custom;
  const hasTradeLines = Boolean(position) || openOrders.length > 0;

  function pickLevel(kind: "support" | "resistance", level: number) {
    openTrade(null, {
      symbol,
      side: "buy",
      ...(kind === "support" ? { stopLoss: String(level) } : { takeProfit: String(level) }),
    });
  }

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
    <div className="page">
      <div className="page-inner market-page">
        <div className="market-hero">
          <div className="market-price-row">
            <span className="market-price num">{quote ? price(quote.price) : "—"}</span>
            {quote ? (
              <span className="chip num" data-tone={tone(quote.changePct)}>
                {percent(quote.changePct)}
              </span>
            ) : null}
            <span className="price-note">24h</span>
          </div>

          <div className="market-actions">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
              aria-pressed={watched !== undefined}
              title={pinned ? "Always on the watchlist" : undefined}
              disabled={busy || pinned}
              onClick={() => void (watched ? watchRemove(symbol) : watchAdd(symbol))}
            >
              <Icon name={watched ? "starFilled" : "star"} size={15} />
              <span>{watched ? "Watching" : "Watch"}</span>
            </button>

            {snapshot.assistant.ready ? (
              <Menu
                triggerClass="btn btn-sm btn-secondary"
                align="end"
                label={`Ask AI about ${instrument.base}`}
                disabled={busy}
                trigger={
                  <>
                    <Icon name="assistant" size={15} />
                    <span>Ask AI</span>
                    <Icon name="chevronDown" size={14} />
                  </>
                }
              >
                <MenuItem
                  icon="chart"
                  label={`${instrument.base} outlook`}
                  sub="Price, technicals, funding and key levels"
                  onSelect={() => void ask(`${instrument.base} outlook`)}
                />
                <MenuItem
                  icon="news"
                  label="Why is it moving?"
                  sub="Check recent news and catalysts"
                  onSelect={() => void ask(`Why is ${instrument.base} moving? Check recent news.`)}
                />
                <div className="menu-sep" role="separator" />
                <MenuItem
                  icon="trade"
                  label="Plan 1% risk long"
                  sub="Size position with a technical stop-loss"
                  onSelect={() => void ask(`Plan a long on ${instrument.base} with 1% risk and a technical stop-loss.`)}
                />
                <MenuItem
                  icon="trade"
                  label="Plan 1% risk short"
                  sub="Size position with a technical stop-loss"
                  onSelect={() => void ask(`Plan a short on ${instrument.base} with 1% risk and a technical stop-loss.`)}
                />
                <MenuItem
                  icon="grid"
                  label="Plan a grid bot"
                  sub="Buys low and sells high between support and resistance"
                  onSelect={() => prefillComposer("grid", { market: instrument.symbol })}
                />
              </Menu>
            ) : null}

            <button
              type="button"
              className="btn btn-sm btn-secondary"
              title={`Build a futures grid bot for ${instrument.base}`}
              onClick={() => openGrid(symbol)}
            >
              <Icon name="grid" size={15} />
              <span>Grid</span>
            </button>

            <button type="button" className="btn btn-sm btn-primary" onClick={() => openTrade()}>
              Trade
            </button>
          </div>
        </div>

        {snapshot.feedError ? (
          <p className="note" data-tone="error" role="alert">
            {snapshot.feedError}
          </p>
        ) : null}

        {position || openOrders.length > 0 ? (
          <div className="market-desk">
            {position ? (
              <div className="market-position">
                <span className="chip" data-tone={position.side === "long" ? "up" : "down"}>
                  {position.side === "long" ? "Long" : "Short"} {leverage(position.leverage)}
                </span>
                <span className="muted">{position.isolated ? "Isolated" : "Cross"}</span>
                <span className="num">
                  {units(position.qty)} {instrument.base}
                </span>
                <span className="muted num">Entry {price(position.entryPrice)}</span>
                {position.liquidationPrice ? (
                  <span className="muted num">Liq {price(position.liquidationPrice)}</span>
                ) : null}
                <span className="grow" />
                <span className={`position-pnl num ${direction(position.unrealizedPnl)}`}>
                  {signedMoney(position.unrealizedPnl)}
                  <small>{percent(position.roePct)}</small>
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy}
                  aria-label={`Close ${instrument.base} ${position.side}`}
                  onClick={() => void closePosition(position.symbol)}
                >
                  Close
                </button>
              </div>
            ) : null}

            {openOrders.length > 0 ? (
              <div className="market-orders">
                <div className="market-orders-head">
                  <span className="muted">
                    Open orders <span className="num">({openOrders.length})</span>
                  </span>
                  {openOrders.length > 1 ? (
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      onClick={() => void cancelAllOrders(symbol)}
                    >
                      Cancel all
                    </button>
                  ) : null}
                </div>
                <ul className="market-orders-list">
                  {openOrders.map((order) => (
                    <li key={order.id} className="market-order-row num">
                      <span className="chip" data-tone={order.side === "buy" ? "up" : "down"}>
                        {orderLabel(order)}
                      </span>
                      <span>
                        {order.side === "buy" ? "Buy" : "Sell"} {units(order.qty)} {instrument.base}
                      </span>
                      <span className="muted">
                        @ {price(order.stopPrice ?? order.price)}
                        {order.reduceOnly ? " · Reduce-only" : ""}
                      </span>
                      <span className="grow" />
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        aria-label={`Cancel ${orderLabel(order)} at ${price(order.stopPrice ?? order.price)}`}
                        onClick={() => void cancelOrder(symbol, order.id)}
                      >
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <dl className="market-metrics">
          <Metric
            label="Mark"
            sub={
              basis !== null ? (
                <span className={basis > 0 ? "up" : basis < 0 ? "down" : "muted"}>
                  {basis >= 0 ? "+" : ""}
                  {basis.toFixed(1)} bps
                </span>
              ) : undefined
            }
          >
            {price(quote?.markPrice)}
          </Metric>
          <Metric label="Index">{price(quote?.indexPrice)}</Metric>
          <Metric
            label="Funding"
            sub={
              quote?.nextFunding ? (
                <>
                  <Countdown at={quote.nextFunding} />
                  {funding.data?.annualPct !== null && funding.data?.annualPct !== undefined
                    ? ` · ${percent(funding.data.annualPct)}/yr`
                    : ""}
                </>
              ) : undefined
            }
          >
            <span className={direction(quote?.fundingRatePct)}>{fundingRate(quote?.fundingRatePct)}</span>
          </Metric>
          <Metric
            label="Open interest"
            sub={funding.data?.openInterest ? `${compact(funding.data.openInterest)} ${instrument.base}` : undefined}
          >
            {compact(funding.data?.openInterestValue)}
          </Metric>
          <Metric
            label="24h volume"
            sub={quote?.volume24h ? `${compact(quote.volume24h)} ${instrument.base}` : undefined}
          >
            {compact(quote?.quoteVolume24h)}
          </Metric>
          <Metric
            label="24h range"
            footer={
              dayPos !== null ? (
                <div className="gauge-track range-gauge" aria-hidden="true">
                  <span className="gauge-dot" style={{ left: `${dayPos}%` }} />
                </div>
              ) : null
            }
          >
            {quote?.low24h && quote?.high24h ? `${price(quote.low24h)} – ${price(quote.high24h)}` : "—"}
          </Metric>
        </dl>

        <div className="market-grid">
          <div className="market-main-col">
            <section className="market-chart-card" aria-label="Chart">
              <div className="chart-bar">
                <Segmented label="Timeframe" value={timeframe} options={TIMEFRAMES} onChange={setChartTimeframe} />
                <OverlayToolbar overlays={overlays} hasTradeLines={hasTradeLines} onToggle={toggleChartOverlay} />
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
                  position={position}
                  orders={openOrders}
                  overlays={overlays}
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

            <MarketStructure
              frames={frames}
              activeFrame={frame}
              timeframe={timeframe}
              spot={spot}
              analytics={analytics}
              onSelectTimeframe={setChartTimeframe}
            />
          </div>

          <section className="market-detail-card" aria-label="Market details">
            <Tabs label="Market data" value={tab} options={TABS} onChange={setMarketTab} panelId={panelId} />
            <div id={panelId} role="tabpanel" className="panel-tab" aria-label={TABS.find((item) => item.value === tab)?.label}>
              {tab === "book" ? <BookTab symbol={symbol} network={network} base={instrument.base} /> : null}
              {tab === "funding" ? <FundingTab funding={funding} quote={instrument.quote || "USDT"} base={instrument.base} /> : null}
              {tab === "technicals" ? (
                <TechnicalsTab
                  technicals={technicals}
                  timeframe={timeframe}
                  onSelectTimeframe={setChartTimeframe}
                  onPickLevel={pickLevel}
                />
              ) : null}
              {tab === "watchlist" ? <WatchlistTab /> : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
