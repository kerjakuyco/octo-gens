import { type CSSProperties, type FormEvent, type KeyboardEvent, useId } from "react";
import type { GridDirection } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { direction as tone, fundingRate, money, percent, price } from "../../lib/format";
import { GRID_MAX_COUNT, GRID_MIN_COUNT } from "../../lib/grid";
import { focusMarket, openSettings, prefillComposer, useSnapshot } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { DIRECTIONS, SPACINGS, directionTone } from "./labels";
import type { GridForm } from "./useGridForm";

const BANDS = [3, 5, 10, 15] as const;
const MARGIN_SHARES = [10, 25, 50, 100] as const;

interface GridBuilderProps {
  form: GridForm;
  /** The wallet of the active network can trade. */
  canTrade: boolean;
  /** Free margin on the active network, when the account is read. */
  available: number | null;
  maxLeverage: number;
  /** A dry run is being worked out. */
  reviewing: boolean;
  busy: boolean;
  /** Why the last review failed, shown above the button. */
  error: string;
  onReview: () => void;
}

/** Direction as three cards in a radio group; the arrow keys move between them. */
function DirectionChoice({
  labelledBy,
  value,
  onChange,
}: {
  labelledBy: string;
  value: GridDirection;
  onChange: (next: GridDirection) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = DIRECTIONS.findIndex((item) => item.value === value);
    const next = DIRECTIONS[(index + step + DIRECTIONS.length) % DIRECTIONS.length];
    if (!next) return;
    onChange(next.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[DIRECTIONS.indexOf(next)]?.focus();
  }

  return (
    <div className="gb-directions" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {DIRECTIONS.map((item) => {
        const checked = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="gb-direction"
            data-tone={directionTone(item.value)}
            onClick={() => onChange(item.value)}
          >
            <span className="gb-direction-name">{item.label}</span>
            <span className="gb-direction-detail">{item.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A number field with its unit inside the box. */
function Amount({
  id,
  value,
  unit,
  placeholder,
  invalid,
  onChange,
}: {
  id: string;
  value: string;
  unit: string;
  placeholder?: string;
  invalid?: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className="gb-amount">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className="input num"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="gb-amount-unit" aria-hidden="true">
        {unit}
      </span>
    </div>
  );
}

/** The form for a new grid bot. Reviewing it works out a dry run first; nothing is sent from here. */
export function GridBuilder({ form, canTrade, available, maxLeverage, reviewing, busy, error, onReview }: GridBuilderProps) {
  const ids = {
    market: useId(),
    direction: useId(),
    range: useId(),
    lower: useId(),
    upper: useId(),
    grids: useId(),
    margin: useId(),
    leverage: useId(),
    start: useId(),
    stopBelow: useId(),
    stopAbove: useId(),
  };
  const { instrument } = form;
  const quoteAsset = instrument.quote || "USDT";
  const quote = form.mark > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canTrade) onReview();
    else openSettings("wallet");
  }

  return (
    <form className="gb-card gb-builder" onSubmit={submit} noValidate>
      <div className="gb-card-head">
        <h2 className="gb-card-title">New grid bot</h2>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => prefillComposer("grid", { market: form.symbol })}
        >
          <Icon name="assistant" size={15} />
          <span>Plan with AI</span>
        </button>
      </div>

      <div className="gb-market">
        <InstrumentMark base={instrument.base} />
        <div className="gb-market-pick">
          <label htmlFor={ids.market} className="visually-hidden">
            Market
          </label>
          <select
            id={ids.market}
            className="input gb-market-select"
            value={form.symbol}
            onChange={(event) => form.setSymbol(event.target.value)}
          >
            {form.markets.map((item) => (
              <option key={item.symbol} value={item.symbol}>
                {item.base} / {item.quote || "USDT"}
              </option>
            ))}
          </select>
          <p className="gb-market-facts num">
            <span>
              <span className="muted">Price</span> {quote ? price(form.mark) : "—"}
            </span>
            <QuoteFacts symbol={form.symbol} />
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Open ${instrument.base}`}
          title={`Open ${instrument.base}`}
          onClick={() => void focusMarket(form.symbol)}
        >
          <Icon name="chart" size={17} />
        </button>
      </div>

      <div className="gb-field">
        <span className="gb-label" id={ids.direction}>
          Direction
        </span>
        <DirectionChoice labelledBy={ids.direction} value={form.direction} onChange={form.setDirection} />
      </div>

      <div className="gb-field" role="group" aria-labelledby={ids.range}>
        <div className="gb-field-head">
          <span className="gb-label" id={ids.range}>
            Price range
          </span>
          <span className="gb-quick" role="group" aria-label="Range around the price">
            {BANDS.map((pct) => (
              <button key={pct} type="button" className="gb-quick-btn num" disabled={!quote} onClick={() => form.applyBand(pct)}>
                ±{pct}%
              </button>
            ))}
          </span>
        </div>
        <div className="gb-pair">
          <div className="gb-subfield">
            <label htmlFor={ids.lower} className="gb-sublabel">
              Lower
            </label>
            <Amount id={ids.lower} value={form.lower} unit={quoteAsset} onChange={form.setLower} />
          </div>
          <div className="gb-subfield">
            <label htmlFor={ids.upper} className="gb-sublabel">
              Upper
            </label>
            <Amount id={ids.upper} value={form.upper} unit={quoteAsset} onChange={form.setUpper} />
          </div>
        </div>
        {form.suggestions.length > 0 ? (
          <div className="gb-suggestions" role="group" aria-label="Suggested ranges">
            <span className="gb-sublabel">Suggested ranges</span>
            {form.suggestions.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="gb-suggestion"
                aria-pressed={form.suggestion === item.id}
                title={item.basis}
                style={{ "--i": index } as CSSProperties}
                onClick={() => form.applySuggestion(item)}
              >
                <span className="gb-suggestion-name">{item.label}</span>
                <span className="gb-suggestion-detail">{item.detail}</span>
                <span className="gb-suggestion-range num">
                  {price(item.lowerPrice)} – {price(item.upperPrice)}
                </span>
                <span className="gb-suggestion-meta num">
                  {item.grids} grids · {item.profitMinPct.toFixed(2)}% a grid
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="gb-field">
        <div className="gb-field-head">
          <label htmlFor={ids.grids} className="gb-label">
            Grids
          </label>
          <span className="gb-hint num">
            {form.prices.length >= 2
              ? `${form.profit.min.toFixed(2)}% profit a grid, after fees`
              : `${GRID_MIN_COUNT} to ${GRID_MAX_COUNT}`}
          </span>
        </div>
        <div className="gb-slider-row">
          <input
            type="range"
            className="gb-slider"
            min={GRID_MIN_COUNT}
            max={GRID_MAX_COUNT}
            step={1}
            value={form.grids}
            aria-label="Grids"
            aria-valuetext={`${form.grids} grids`}
            onChange={(event) => form.setGrids(Number(event.target.value))}
          />
          <input
            id={ids.grids}
            type="number"
            className="input num gb-count"
            min={GRID_MIN_COUNT}
            max={GRID_MAX_COUNT}
            value={form.grids}
            onChange={(event) => form.setGrids(Number(event.target.value) || GRID_MIN_COUNT)}
          />
        </div>
        <Segmented
          label="Spacing"
          value={form.spacing}
          options={SPACINGS.map((item) => ({ value: item.value, label: item.label }))}
          onChange={form.setSpacing}
          fill
        />
      </div>

      <div className="gb-field">
        <div className="gb-field-head">
          <label htmlFor={ids.margin} className="gb-label">
            Margin
          </label>
          <span className="gb-hint num">{available !== null ? `${money(available)} ${quoteAsset} free` : "Connect a wallet to see what is free"}</span>
        </div>
        <Amount id={ids.margin} value={form.margin} unit={quoteAsset} onChange={form.setMargin} />
        {available !== null && available > 0 ? (
          <span className="gb-quick" role="group" aria-label="Share of free margin">
            {MARGIN_SHARES.map((pct) => (
              <button key={pct} type="button" className="gb-quick-btn num" onClick={() => form.applyMarginShare(pct)}>
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </span>
        ) : null}

        <div className="gb-field-head gb-leverage-head">
          <label htmlFor={ids.leverage} className="gb-sublabel">
            Leverage <strong className="num">{form.leverage}x</strong>
          </label>
          <button type="button" className="gb-link" onClick={() => openSettings("trading")}>
            Your limit is {maxLeverage}x
          </button>
        </div>
        <input
          id={ids.leverage}
          type="range"
          className="gb-slider"
          min={1}
          max={Math.max(1, maxLeverage)}
          step={1}
          value={form.leverage}
          disabled={maxLeverage <= 1}
          aria-valuetext={`${form.leverage}x`}
          onChange={(event) => form.setLeverage(Number(event.target.value))}
        />
      </div>

      <details className="gb-more">
        <summary>
          <Icon name="chevron" size={14} />
          <span>More settings</span>
          <span className="gb-more-hint">Start price, stops, order type</span>
        </summary>
        <div className="gb-more-body">
          <div className="gb-subfield">
            <label htmlFor={ids.start} className="gb-sublabel">
              Start when the price reaches
            </label>
            <Amount id={ids.start} value={form.start} unit={quoteAsset} placeholder="Start now" onChange={form.setStart} />
          </div>
          <div className="gb-pair">
            <div className="gb-subfield">
              <label htmlFor={ids.stopBelow} className="gb-sublabel">
                Stop below
              </label>
              <Amount id={ids.stopBelow} value={form.stopBelow} unit={quoteAsset} placeholder="None" onChange={form.setStopBelow} />
            </div>
            <div className="gb-subfield">
              <label htmlFor={ids.stopAbove} className="gb-sublabel">
                Stop above
              </label>
              <Amount id={ids.stopAbove} value={form.stopAbove} unit={quoteAsset} placeholder="None" onChange={form.setStopAbove} />
            </div>
          </div>
          <label className="check gb-check">
            <input type="checkbox" checked={form.closeOnStop} onChange={(event) => form.setCloseOnStop(event.target.checked)} />
            <span>
              Close the position when it stops
              <small>At a stop price, the bot closes what it holds in this market at the market price.</small>
            </span>
          </label>
          <label className="check gb-check">
            <input type="checkbox" checked={form.makerOnly} onChange={(event) => form.setMakerOnly(event.target.checked)} />
            <span>
              Maker orders only
              <small>Orders rest on the book for the lower maker fee. One that would fill at once is not placed.</small>
            </span>
          </label>
        </div>
      </details>

      {error || form.problem ? (
        <p className="note gb-problem" data-tone={error ? "error" : undefined} role={error ? "alert" : undefined}>
          {error || form.problem}
        </p>
      ) : null}

      <button
        type="submit"
        className="btn btn-primary gb-review-btn"
        disabled={busy || reviewing || (canTrade && form.problem !== "")}
      >
        {!canTrade ? (
          <>
            <Icon name="wallet" size={16} />
            <span>Connect a wallet</span>
          </>
        ) : reviewing ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>Working it out</span>
          </>
        ) : (
          <span>Review grid bot</span>
        )}
      </button>
    </form>
  );
}

/** The day's change and the funding rate of the market picked, from the latest quote. */
function QuoteFacts({ symbol }: { symbol: string }) {
  const quote = useSnapshot().quotes[symbol];
  return (
    <>
      <span>
        <span className="muted">24h</span> <span className={tone(quote?.changePct)}>{percent(quote?.changePct)}</span>
      </span>
      <span>
        <span className="muted">Funding</span>{" "}
        <span className={tone(quote?.fundingRatePct)}>{fundingRate(quote?.fundingRatePct)}</span>
      </span>
    </>
  );
}
