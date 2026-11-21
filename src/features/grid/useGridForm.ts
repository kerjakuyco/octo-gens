import { useMemo, useState } from "react";
import type { GridBotView, GridDirection, GridRequest, GridSpacing, InstrumentView, Network } from "../../api/types";
import { loadCatalog, useCatalog } from "../chat/MarketPicker";
import {
  GRID_MAX_COUNT,
  GRID_MIN_COUNT,
  type GridOrderEstimate,
  type GridSuggestion,
  type LadderPlan,
  computeGridPrices,
  computeProfitPerGridPct,
  estimateGridOrders,
  planLadderSides,
  roundGridPrice,
  suggestGridRanges,
} from "../../lib/grid";
import { usePolled } from "../../lib/hooks";
import { instrumentFor } from "../../lib/market";
import { request, selectSymbol, useApp, useSnapshot } from "../../state/app";

/** How far either side of the price a new range starts. */
const DEFAULT_HALF_RANGE = 0.06;
/** How often the reading behind the suggested ranges is taken again. */
const READING_MS = 90_000;

function clampGrids(value: number): number {
  return Math.max(GRID_MIN_COUNT, Math.min(GRID_MAX_COUNT, Math.round(value)));
}

function optional(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface GridForm {
  /** Markets that can be picked: the watchlist, and the market the page was opened for. */
  markets: InstrumentView[];
  symbol: string;
  instrument: InstrumentView;
  /** The price the levels are drawn around: the mark price, else the last trade. */
  mark: number;

  direction: GridDirection;
  spacing: GridSpacing;
  lower: string;
  upper: string;
  grids: number;
  margin: string;
  leverage: number;
  start: string;
  stopBelow: string;
  stopAbove: string;
  closeOnStop: boolean;
  makerOnly: boolean;
  /** The suggested range last applied, until something is changed by hand. */
  suggestion: GridSuggestion["id"] | null;
  suggestions: GridSuggestion[];

  prices: number[];
  plan: LadderPlan;
  profit: { min: number; max: number };
  estimate: GridOrderEstimate | null;
  /** How wide the range is, as a percent of its lower price. */
  width: number | null;
  startPrice: number | null;
  stopBelowPrice: number | null;
  stopAbovePrice: number | null;

  setSymbol: (symbol: string) => void;
  setDirection: (direction: GridDirection) => void;
  setSpacing: (spacing: GridSpacing) => void;
  setLower: (text: string) => void;
  setUpper: (text: string) => void;
  setGrids: (count: number) => void;
  setMargin: (text: string) => void;
  setLeverage: (value: number) => void;
  setStart: (text: string) => void;
  setStopBelow: (text: string) => void;
  setStopAbove: (text: string) => void;
  setCloseOnStop: (on: boolean) => void;
  setMakerOnly: (on: boolean) => void;
  /** Sets the range to this many percent either side of the price. */
  applyBand: (pct: number) => void;
  /** Sets the margin to this share of what is free, or nearly all of it for 100. */
  applyMarginShare: (pct: number) => void;
  applySuggestion: (suggestion: GridSuggestion) => void;
  /** Puts an earlier bot's settings back in the form. */
  reuse: (bot: GridBotView) => void;
  /** Why the form cannot be reviewed yet, or empty when it can. */
  problem: string;
  toRequest: () => GridRequest;
}

/** The new-bot form: what was typed, what follows from it, and what a review sends. */
export function useGridForm(): GridForm {
  const snapshot = useSnapshot();
  const preferred = useApp((state) => state.gridSymbol);
  const maxLeverage = snapshot.risk.maxLeverage;

  const markets = useMemo(() => {
    const list = [...snapshot.instruments];
    if (preferred && !list.some((item) => item.symbol === preferred)) list.unshift(instrumentFor(snapshot, preferred));
    return list;
  }, [snapshot, preferred]);

  // Any market the exchange lists can be picked, not only the watchlist. A pick belongs to its network:
  // after a switch it stays only if the watchlist there has it, so the form never shows a market not listed.
  const [picked, setPicked] = useState<{ symbol: string; network: Network } | null>(null);
  const kept =
    picked && (picked.network === snapshot.network || markets.some((item) => item.symbol === picked.symbol))
      ? picked.symbol
      : null;
  const symbol = kept ?? preferred ?? (snapshot.focus || markets[0]?.symbol || "BTCUSDT");
  const instrument = instrumentFor(snapshot, symbol);
  const quote = snapshot.quotes[symbol];
  // A market off the watchlist has no quote until it is loaded; the list of every market has its price meanwhile.
  const catalog = useCatalog(snapshot.network);
  const row = catalog.rows?.find((item) => item.symbol === symbol);
  const mark = Number(quote?.markPrice ?? quote?.price ?? row?.markPrice ?? row?.price ?? 0) || 0;

  const [direction, setDirectionRaw] = useState<GridDirection>("neutral");
  const [spacing, setSpacingRaw] = useState<GridSpacing>("arithmetic");
  // A range typed by hand stays as typed; until then it follows the price.
  const [lowerDraft, setLowerDraft] = useState<string | null>(null);
  const [upperDraft, setUpperDraft] = useState<string | null>(null);
  const [grids, setGridsRaw] = useState(10);
  const [marginDraft, setMarginDraft] = useState<string | null>(null);
  const [leverageRaw, setLeverageRaw] = useState(() => Math.min(3, maxLeverage));
  const [start, setStart] = useState("");
  const [stopBelow, setStopBelow] = useState("");
  const [stopAbove, setStopAbove] = useState("");
  const [closeOnStop, setCloseOnStop] = useState(true);
  const [makerOnly, setMakerOnly] = useState(true);
  const [suggestion, setSuggestion] = useState<GridSuggestion["id"] | null>(null);

  const available = Number(snapshot.account?.available ?? 0) || 0;
  const lower = lowerDraft ?? (mark > 0 ? roundGridPrice(mark * (1 - DEFAULT_HALF_RANGE), mark) : "");
  const upper = upperDraft ?? (mark > 0 ? roundGridPrice(mark * (1 + DEFAULT_HALF_RANGE), mark) : "");
  const margin = marginDraft ?? (available > 0 ? String(Math.max(10, Math.floor((available * 0.1) / 10) * 10)) : "100");
  const leverage = Math.max(1, Math.min(maxLeverage, leverageRaw));

  const reading = usePolled(
    `${snapshot.network}:${symbol}:grid-reading`,
    () => request((api) => api.marketTechnicals(symbol)),
    READING_MS,
  );
  const suggestions = useMemo(() => suggestGridRanges(mark, reading.data, maxLeverage), [mark, reading.data, maxLeverage]);

  const lowerNum = Number(lower);
  const upperNum = Number(upper);
  const startPrice = optional(start);
  const stopBelowPrice = optional(stopBelow);
  const stopAbovePrice = optional(stopAbove);
  const prices = useMemo(() => computeGridPrices(lowerNum, upperNum, grids, spacing), [lowerNum, upperNum, grids, spacing]);
  const profit = useMemo(() => computeProfitPerGridPct(prices), [prices]);
  const plan = useMemo(
    () => planLadderSides(direction, prices, startPrice ?? mark),
    [direction, prices, startPrice, mark],
  );
  const estimate = estimateGridOrders(Number(margin), leverage, grids, startPrice ?? mark);
  const width = lowerNum > 0 && upperNum > lowerNum ? ((upperNum - lowerNum) / lowerNum) * 100 : null;

  // Editing by hand leaves the suggested range that was applied.
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setSuggestion(null);
    };

  let problem = "";
  if (!(lowerNum > 0) || !(upperNum > 0)) problem = "Enter a lower and an upper price.";
  else if (upperNum <= lowerNum) problem = "The upper price must be above the lower price.";
  else if (prices.length === 0) problem = `Use between ${GRID_MIN_COUNT} and ${GRID_MAX_COUNT} grids.`;
  else if (!(Number(margin) > 0)) problem = "Enter the margin the bot may use.";
  else if (stopBelowPrice !== null && stopBelowPrice >= lowerNum) problem = "Stop below must be under the lower price.";
  else if (stopAbovePrice !== null && stopAbovePrice <= upperNum) problem = "Stop above must be over the upper price.";

  return {
    markets,
    symbol,
    instrument,
    mark,
    direction,
    spacing,
    lower,
    upper,
    grids,
    margin,
    leverage,
    start,
    stopBelow,
    stopAbove,
    closeOnStop,
    makerOnly,
    suggestion,
    suggestions,
    prices,
    plan,
    profit,
    estimate,
    width,
    startPrice,
    stopBelowPrice,
    stopAbovePrice,

    setSymbol: (next) => {
      setPicked({ symbol: next, network: snapshot.network });
      loadCatalog(snapshot.network);
      // The market's own quote, funding and levels come once it is the one in focus, as on its page.
      if (!snapshot.quotes[next]) void selectSymbol(next);
      setLowerDraft(null);
      setUpperDraft(null);
      setStart("");
      setStopBelow("");
      setStopAbove("");
      setSuggestion(null);
    },
    setDirection: edited(setDirectionRaw),
    setSpacing: edited(setSpacingRaw),
    setLower: edited(setLowerDraft),
    setUpper: edited(setUpperDraft),
    setGrids: edited((count: number) => setGridsRaw(clampGrids(count))),
    setMargin: setMarginDraft,
    setLeverage: edited(setLeverageRaw),
    setStart,
    setStopBelow: edited(setStopBelow),
    setStopAbove: edited(setStopAbove),
    setCloseOnStop,
    setMakerOnly,
    applyBand: (pct) => {
      if (!(mark > 0)) return;
      setLowerDraft(roundGridPrice(mark * (1 - pct / 100), mark));
      setUpperDraft(roundGridPrice(mark * (1 + pct / 100), mark));
      setSuggestion(null);
    },
    applyMarginShare: (pct) => {
      if (!(available > 0)) return;
      // All of it would leave nothing for fees, so "Max" keeps a little back.
      const amount = pct >= 100 ? available * 0.98 : (available * pct) / 100;
      setMarginDraft(String(Math.max(1, Math.floor(amount))));
    },
    applySuggestion: (next) => {
      setDirectionRaw(next.direction);
      setSpacingRaw(next.spacing);
      setLowerDraft(next.lowerPrice);
      setUpperDraft(next.upperPrice);
      setGridsRaw(next.grids);
      setLeverageRaw(next.leverage);
      setStopBelow(next.stopLower);
      setStopAbove(next.stopUpper);
      setStart("");
      setSuggestion(next.id);
    },
    reuse: (bot) => {
      setPicked({ symbol: bot.symbol, network: bot.network });
      setDirectionRaw(bot.direction);
      setSpacingRaw(bot.spacing);
      setLowerDraft(bot.lowerPrice);
      setUpperDraft(bot.upperPrice);
      setGridsRaw(clampGrids(bot.grids));
      setMarginDraft(bot.margin);
      setLeverageRaw(bot.leverage);
      setStart(bot.triggerPrice ?? "");
      setStopBelow(bot.stopLower ?? "");
      setStopAbove(bot.stopUpper ?? "");
      setCloseOnStop(bot.closeOnStop);
      setMakerOnly(bot.postOnly);
      setSuggestion(null);
    },
    problem,
    toRequest: () => ({
      symbol,
      direction,
      spacing,
      lowerPrice: lower.trim(),
      upperPrice: upper.trim(),
      grids,
      margin: margin.trim(),
      leverage,
      ...(start.trim() ? { triggerPrice: start.trim() } : {}),
      ...(stopAbove.trim() ? { stopUpper: stopAbove.trim() } : {}),
      ...(stopBelow.trim() ? { stopLower: stopBelow.trim() } : {}),
      closeOnStop,
      postOnly: makerOnly,
    }),
  };
}
