import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CandleSeries } from "../../api/types";
import { axisPrice, price, pricePrecision } from "../../lib/format";
import { ema } from "../../lib/indicators";
import { token, withAlpha } from "../../lib/theme";

const FONT = 'system-ui, -apple-system, Roboto, "Noto Sans", sans-serif';
/** Bars in view when a market opens. The rest is one drag away. */
const BARS_IN_VIEW = 90;

interface Handles {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  fast: ISeriesApi<"Line">;
  slow: ISeriesApi<"Line">;
}

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartLevels {
  support: number[];
  resistance: number[];
}

interface PriceChartProps {
  series: CandleSeries | null;
  /** Support and resistance prices to mark on the price axis. */
  levels: ChartLevels | null;
  /** Changes whenever the colours on screen change, so the canvas can be repainted. */
  themeKey: string;
  /** Loading or error message laid over the plot. */
  overlay?: ReactNode;
  /** The chart library's credit, which its licence asks to keep with the chart. */
  credit: ReactNode;
}

function lastBar(series: CandleSeries | null): Bar | null {
  const last = series?.rows[series.rows.length - 1];
  if (!last) return null;
  return { open: Number(last[1]), high: Number(last[2]), low: Number(last[3]), close: Number(last[4]) };
}

/** Open, high, low and close of the bar under the pointer, or of the latest bar. */
function Readout({ bar }: { bar: Bar | null }) {
  return (
    <dl className="chart-readout num">
      {bar ? (
        <>
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
        </>
      ) : null}
    </dl>
  );
}


/**
 * Candlesticks with a volume strip, two moving averages and the nearest
 * support and resistance, drawn by TradingView Lightweight Charts.
 */
export function PriceChart({ series, levels, themeKey, overlay, credit }: PriceChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  // Decimals the axis shows; follows the market on screen.
  const precision = useRef(2);
  // Which market and timeframe the visible range was last set for.
  const framed = useRef("");
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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, rightOffset: 3, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (value: number) => axisPrice(value, precision.current) },
    });
    const candles = chart.addSeries(CandlestickSeries, { borderVisible: false });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    const average = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    const fast = chart.addSeries(LineSeries, average);
    const slow = chart.addSeries(LineSeries, average);

    chart.subscribeCrosshairMove((event) => {
      const bar = event.seriesData.get(candles);
      setHovered(bar && "open" in bar ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close } : null);
    });

    handles.current = { chart, candles, volume, fast, slow };
    return () => {
      handles.current = null;
      lines.current = [];
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
    const label = token("--surface-strong");
    current.chart.applyOptions({
      layout: { textColor: muted },
      grid: { horzLines: { color: token("--border") } },
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
    current.fast.applyOptions({ color: token("--line-a") });
    current.slow.applyOptions({ color: token("--line-b") });
  }, [themeKey]);

  useEffect(() => {
    const current = handles.current;
    if (!current) return;
    const rows = series?.rows ?? [];
    const up = withAlpha(token("--up"), 0.4);
    const down = withAlpha(token("--down"), 0.4);
    const times = rows.map(([time]) => Math.floor(time / 1000) as UTCTimestamp);
    const closes = rows.map((row) => Number(row[4]));
    current.candles.setData(
      rows.map(([, open, high, low, close], index) => ({
        time: times[index]!,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
      })),
    );
    current.volume.setData(
      rows.map(([, open, , , close, traded], index) => ({
        time: times[index]!,
        value: Number(traded),
        color: Number(close) >= Number(open) ? up : down,
      })),
    );
    const average = (period: number) =>
      ema(closes, period).flatMap((value, index) => (value === null ? [] : [{ time: times[index]!, value }]));
    current.fast.setData(average(20));
    current.slow.setData(average(50));

    const last = rows[rows.length - 1];
    if (last) {
      const decimals = pricePrecision(last[4]);
      precision.current = decimals;
      const format = { type: "price", precision: decimals, minMove: 10 ** -decimals } as const;
      current.candles.applyOptions({ priceFormat: format });
      current.fast.applyOptions({ priceFormat: format });
      current.slow.applyOptions({ priceFormat: format });
    }
    current.chart.applyOptions({ timeScale: { timeVisible: series?.timeframe !== "1d" } });
    // Frame the latest bars when another market or timeframe arrives. A refresh of the same one leaves the
    // view where the trader scrolled it.
    const view = series ? `${series.source}:${series.symbol}:${series.timeframe}` : "";
    if (view === framed.current || rows.length === 0) return;
    framed.current = view;
    if (rows.length > BARS_IN_VIEW) {
      current.chart.timeScale().setVisibleLogicalRange({ from: rows.length - BARS_IN_VIEW, to: rows.length + 2 });
    } else {
      current.chart.timeScale().fitContent();
    }
  }, [series, themeKey]);

  useEffect(() => {
    const current = handles.current;
    if (!current) return;
    for (const line of lines.current) current.candles.removePriceLine(line);
    lines.current = [];
    if (!levels) return;
    const plate = token("--surface-strong");
    // The nearest level on each side is named on the axis; the next one is only a line, so labels do not pile up.
    const draw = (values: number[], color: string) => {
      for (const [index, value] of values.slice(0, 2).entries()) {
        lines.current.push(
          current.candles.createPriceLine({
            price: value,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: index === 0,
            axisLabelColor: plate,
            axisLabelTextColor: color,
          }),
        );
      }
    };
    draw(levels.support, token("--up"));
    draw(levels.resistance, token("--down"));
  }, [levels, themeKey]);

  return (
    <>
      <div className="chart">
        <div className="chart-canvas" ref={host} />
        <span className="chart-credit">{credit}</span>
        {overlay}
      </div>
      <Readout bar={hovered ?? lastBar(series)} />
    </>
  );
}
