import { useEffect, useState } from "react";
import type { CandleSeries, Feed, InstrumentView, Timeframe } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { baseOf, compact, direction, money, percent, price, utcStamp } from "../../lib/format";
import { useResolvedTheme } from "../../lib/theme";
import {
  errorText,
  navigate,
  openExternal,
  request,
  selectPair,
  setPanelOpen,
  setTradeOpen,
  useApp,
  useSnapshot,
} from "../../state/app";
import { InstrumentMark } from "./InstrumentMark";
import { PriceChart } from "./PriceChart";
import { Watchlist } from "./Watchlist";

const TIMEFRAMES: SegmentOption<Timeframe>[] = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

interface CandleState {
  key: string;
  series: CandleSeries | null;
  error: string;
}

/** Loads candles for the focused pair, and keeps live ones fresh once a minute. */
function useCandles(pair: string, timeframe: Timeframe, feed: Feed) {
  const key = `${feed}|${pair}|${timeframe}`;
  const [state, setState] = useState<CandleState>({ key: "", series: null, error: "" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    request((api) => api.candles(pair, timeframe))
      .then((series) => {
        if (alive) setState({ key, series, error: "" });
      })
      .catch((error: unknown) => {
        if (alive) setState({ key, series: null, error: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [key, pair, timeframe, attempt]);

  useEffect(() => {
    if (feed === "sample") return;
    const timer = setInterval(() => {
      if (!document.hidden) setAttempt((value) => value + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, [feed]);

  const current = state.key === key;
  return {
    series: current ? state.series : null,
    error: current ? state.error : "",
    loading: !current,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function MarketPanel() {
  const snapshot = useSnapshot();
  const open = useApp((state) => state.panelOpen);
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const resolvedTheme = useResolvedTheme(snapshot.theme);

  const pair = snapshot.focus;
  const instrument: InstrumentView = snapshot.instruments.find((item) => item.pair === pair) ?? {
    pair,
    ticker: baseOf(pair),
    name: baseOf(pair),
    kind: "crypto",
    underlying: null,
    custom: false,
  };
  const quote = snapshot.quotes[pair];
  const candles = useCandles(pair, timeframe, snapshot.feed);
  const account = snapshot.account;

  let overlay = null;
  if (candles.error) {
    overlay = (
      <div className="chart-state" role="alert">
        <span>Could not load candles. {candles.error}</span>
        <button type="button" className="btn btn-secondary btn-small" onClick={candles.retry}>
          Try again
        </button>
      </div>
    );
  } else if (candles.loading) {
    overlay = (
      <div className="chart-state">
        <span className="ring-spin" />
        <span>Loading candles</span>
      </div>
    );
  }

  return (
    <aside className="panel" data-open={open} aria-label="Market">
      <section className="panel-section">
        <div className="instrument">
          <InstrumentMark instrument={instrument} />
          <div className="instrument-names">
            <h2 className="instrument-pair">
              {instrument.ticker} <span>/ USDT</span>
            </h2>
            <div className="instrument-name">
              {instrument.kind === "xstock" ? `${instrument.name}. A token, not a share.` : instrument.name}
            </div>
          </div>
          <button type="button" className="btn btn-primary btn-small" onClick={() => setTradeOpen(true)}>
            <Icon name="trade" size={15} />
            Trade
          </button>
          <button
            type="button"
            className="icon-btn panel-close"
            aria-label="Close the market panel"
            onClick={() => setPanelOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>

        {quote ? (
          <>
            <div className="price-line">
              <div className="price-now">
                {price(quote.price)}
                <span className="price-unit">USDT</span>
              </div>
              <div className={`price-change ${direction(quote.changePct)}`}>
                {percent(quote.changePct)}
                <small>{quote.sample ? "vs previous close" : "24h"}</small>
              </div>
            </div>
            {quote.high24h && quote.low24h ? (
              <dl className="day-stats">
                <div>
                  <dt>24h high</dt>
                  <dd>{price(quote.high24h)}</dd>
                </div>
                <div>
                  <dt>24h low</dt>
                  <dd>{price(quote.low24h)}</dd>
                </div>
                <div>
                  <dt>24h volume</dt>
                  <dd>{quote.quoteVolume24h ? `${compact(quote.quoteVolume24h)} USDT` : "—"}</dd>
                </div>
              </dl>
            ) : null}
            {/* The core also reports problems that leave a quote on screen, such as a live feed it could not return to. */}
            {snapshot.feedError ? (
              <p className="feed-note" role="status">
                {snapshot.feedError}
              </p>
            ) : null}
          </>
        ) : (
          <div className="feed-problem" role="alert">
            <strong>No quote for {pair}.</strong>{" "}
            {snapshot.feedError || "The feed has not returned a price for this pair yet."}
            <div>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => void selectPair(pair)}>
                Try again
              </button>
            </div>
          </div>
        )}

        <div className="chart-bar">
          <Segmented label="Chart interval" value={timeframe} options={TIMEFRAMES} onChange={setTimeframe} />
        </div>
        <PriceChart
          series={candles.series}
          themeKey={`${resolvedTheme}|${snapshot.feed}`}
          overlay={overlay}
        />

        <div className="source-line">
          {quote?.sample ? (
            <>
              <span className="tag tag-ochre">Sample data</span>
              <span>Fictional prices, dated {utcStamp(quote.asOf)}</span>
            </>
          ) : quote ? (
            <span>
              {quote.source}, as of {utcStamp(quote.asOf)}
            </span>
          ) : null}
          <button type="button" className="attribution" onClick={() => openExternal("https://www.tradingview.com/")}>
            Chart by TradingView
          </button>
        </div>
      </section>

      <Watchlist />

      <section className="panel-section" aria-label="Paper account">
        <div className="panel-heading">
          <h2 className="panel-title">Paper account</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => navigate("portfolio")}>
            Open portfolio
          </button>
        </div>
        <dl className="figures">
          <dt>Equity</dt>
          <dd>
            {money(account.equity)}
            <small>USDT</small>
          </dd>
          <dt>Cash</dt>
          <dd>
            {money(account.cash)}
            <small>USDT</small>
          </dd>
          <dt>Open positions</dt>
          <dd>{account.holdings.length}</dd>
        </dl>
      </section>
    </aside>
  );
}
