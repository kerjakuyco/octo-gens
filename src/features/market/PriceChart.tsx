import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CandleSeries } from "../../api/types";
import { price, pricePrecision } from "../../lib/format";
import { token, withAlpha } from "../../lib/theme";

const FONT = 'system-ui, -apple-system, Roboto, "Noto Sans", sans-serif';

interface Handles {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
}

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PriceChartProps {
  series: CandleSeries | null;
  /** Changes whenever the colours on screen change, so the canvas can be repainted. */
  themeKey: string;
  /** Loading or error message laid over the plot. */
  overlay?: ReactNode;
}

function lastBar(series: CandleSeries | null): Bar | null {
  const last = series?.rows[series.rows.length - 1];
  if (!last) return null;
  return { open: Number(last[1]), high: Number(last[2]), low: Number(last[3]), close: Number(last[4]) };
}

/** Open, high, low and close of the bar under the pointer, or of the latest bar. */
function Readout({ bar }: { bar: Bar | null }) {
  if (!bar) return <dl className="chart-readout" />;
  return (
    <dl className="chart-readout">
      <div>
        <dt title="Open">O</dt>
        <dd>{price(bar.open)}</dd>
      </div>
      <div>
        <dt title="High">H</dt>
        <dd>{price(bar.high)}</dd>
      </div>
      <div>
        <dt title="Low">L</dt>
        <dd>{price(bar.low)}</dd>
      </div>
      <div>
        <dt title="Close">C</dt>
        <dd className={bar.close >= bar.open ? "up" : "down"}>{price(bar.close)}</dd>
      </div>
    </dl>
  );
}

/** Candlesticks with a volume strip, drawn by TradingView Lightweight Charts. */
export function PriceChart({ series, themeKey, overlay }: PriceChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  const [hovered, setHovered] = useState<Bar | null>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const chart = createChart(node, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        fontFamily: FONT,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderVisible: false, rightOffset: 3, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (value: number) => price(value) },
    });
    const candles = chart.addSeries(CandlestickSeries, { borderVisible: false });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    chart.subscribeCrosshairMove((event) => {
      const bar = event.seriesData.get(candles);
      setHovered(bar && "open" in bar ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close } : null);
    });

    handles.current = { chart, candles, volume };
    return () => {
      handles.current = null;
      chart.remove();
    };
  }, []);

  // Colours come from the design tokens, so both themes paint correctly.
  useEffect(() => {
    const current = handles.current;
    if (!current) return;
    const up = token("--up");
    const down = token("--down");
    const muted = token("--muted");
    const label = token("--raised");
    current.chart.applyOptions({
      layout: { textColor: muted },
      grid: { horzLines: { color: token("--line-soft") } },
      crosshair: {
        vertLine: { color: muted, labelBackgroundColor: label },
        horzLine: { color: muted, labelBackgroundColor: label },
      },
    });
    current.candles.applyOptions({
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      priceLineColor: muted,
    });
  }, [themeKey]);

  useEffect(() => {
    const current = handles.current;
    if (!current) return;
    const rows = series?.rows ?? [];
    const up = withAlpha(token("--up"), 0.45);
    const down = withAlpha(token("--down"), 0.45);
    current.candles.setData(
      rows.map(([time, open, high, low, close]) => ({
        time: Math.floor(time / 1000) as UTCTimestamp,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
      })),
    );
    current.volume.setData(
      rows.map(([time, open, , , close, traded]) => ({
        time: Math.floor(time / 1000) as UTCTimestamp,
        value: Number(traded),
        color: Number(close) >= Number(open) ? up : down,
      })),
    );
    const last = rows[rows.length - 1];
    if (last) {
      const precision = pricePrecision(last[4]);
      current.candles.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
    }
    current.chart.applyOptions({ timeScale: { timeVisible: series?.timeframe !== "1d" } });
    current.chart.timeScale().fitContent();
  }, [series, themeKey]);

  return (
    <>
      <div className="chart">
        <div className="chart-canvas" ref={host} />
        {overlay}
      </div>
      <Readout bar={hovered ?? lastBar(series)} />
    </>
  );
}
