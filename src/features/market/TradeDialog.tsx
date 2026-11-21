import { type CSSProperties, type FormEvent, useId, useMemo, useRef, useState } from "react";
import type { Side, TicketRequest, TicketView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { direction, money, percent, price, signedMoney, units } from "../../lib/format";
import { activeWallet, instrumentFor } from "../../lib/market";
import { networkName } from "../../lib/network";
import { ticketStatus } from "../../lib/ticket";
import {
  type AmountMode,
  type OrderFieldErrors,
  estimateOrder,
  leverageTicks,
  offsetPrice,
  sizeFromPercent,
  validateOrderFields,
} from "../../lib/trade";
import {
  type TradePrefill,
  app,
  closeTrade,
  openSettings,
  prepareTicket,
  selectSymbol,
  useApp,
  useSnapshot,
} from "../../state/app";
import { MarketChip, loadCatalog, useCatalog } from "../chat/MarketPicker";
import { InstrumentMark } from "./InstrumentMark";
import { TicketCard } from "./TicketCard";

const OPEN_PCTS = [
  { pct: 10, label: "10%" },
  { pct: 25, label: "25%" },
  { pct: 50, label: "50%" },
  { pct: 75, label: "75%" },
  { pct: 100, label: "Max" },
] as const;

const REDUCE_PCTS = [
  { pct: 25, label: "25%" },
  { pct: 50, label: "50%" },
  { pct: 75, label: "75%" },
  { pct: 100, label: "100%" },
] as const;

const SL_OFFSETS = [1, 2, 5] as const;
const TP_OFFSETS = [2, 4, 8] as const;

/** Shown instead of the order ticket while the active network has no funded trading wallet. */
function WalletNeeded() {
  const snapshot = useSnapshot();
  const wallet = activeWallet(snapshot);

  if (wallet.connected) {
    return (
      <div className="trade-empty">
        <p className="trade-empty-title">Collateral required</p>
        <p className="trade-empty-desc">
          Deposit collateral on {networkName(snapshot.network)} before placing perpetual orders.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            closeTrade();
            openSettings("wallet");
          }}
        >
          Deposit funds
        </button>
      </div>
    );
  }
  return (
    <div className="trade-empty">
      <p className="trade-empty-title">Connect a trading wallet</p>
      <p className="trade-empty-desc">
        Approve a trade-only API wallet on {networkName(snapshot.network)} to place orders.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          closeTrade();
          openSettings("wallet");
        }}
      >
        Connect wallet
      </button>
    </div>
  );
}

type TouchedField = "amount" | "leverage" | "stopLoss" | "takeProfit" | "reduceOnly";

function TradeForm({
  review,
  prefill,
  onStepChange,
}: {
  review: TicketView | null;
  prefill?: TradePrefill;
  onStepChange: (reviewing: boolean) => void;
}) {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const { risk, account } = snapshot;

  const [symbol, setSymbol] = useState(prefill?.symbol ?? snapshot.focus);
  const [side, setSide] = useState<Side>(prefill?.side ?? "buy");
  const [mode, setMode] = useState<AmountMode>(prefill?.qty ? "units" : "value");
  const [amount, setAmount] = useState(prefill?.qty ?? "");
  const [leverage, setLeverage] = useState(Math.min(risk.maxLeverage, 3));
  const [stopLoss, setStopLoss] = useState(prefill?.stopLoss ?? "");
  const [takeProfit, setTakeProfit] = useState(prefill?.takeProfit ?? "");
  const [reduceOnly, setReduceOnly] = useState(prefill?.reduceOnly ?? false);
  const [ticket, setTicket] = useState<TicketView | null>(review);
  const [touched, setTouched] = useState<Partial<Record<TouchedField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);

  const amountRef = useRef<HTMLInputElement>(null);
  const slRef = useRef<HTMLInputElement>(null);
  const tpRef = useRef<HTMLInputElement>(null);
  const leverageRef = useRef<HTMLInputElement>(null);
  const reduceRef = useRef<HTMLInputElement>(null);

  const ids = {
    market: useId(),
    sideName: useId(),
    amount: useId(),
    amountErr: useId(),
    leverage: useId(),
    leverageErr: useId(),
    sl: useId(),
    slErr: useId(),
    tp: useId(),
    tpErr: useId(),
    reduceErr: useId(),
  };

  const wallet = activeWallet(snapshot);
  const instrument = instrumentFor(snapshot, symbol);
  const quote = instrument.quote || "USDT";
  // A market off the watchlist has no quote until it is loaded; the list of every market has its price meanwhile.
  const catalogRow = useCatalog(snapshot.network).rows?.find((item) => item.symbol === symbol) ?? null;
  const quoteRow = snapshot.quotes[symbol] ?? catalogRow;
  const markPrice = Number(quoteRow?.markPrice ?? quoteRow?.price ?? 0);
  const hasMark = Number.isFinite(markPrice) && markPrice > 0;
  const available = Number(account?.available ?? 0);
  const hasAvailable = Number.isFinite(available) && available > 0;
  const position = account?.positions.find((item) => item.symbol === symbol) ?? null;
  const marginMode = account?.multiAssets ? "Cross" : risk.isolated ? "Isolated" : "Cross";
  const isMainnet = snapshot.network === "mainnet";

  const ticks = useMemo(() => leverageTicks(risk.maxLeverage), [risk.maxLeverage]);
  const clampedLeverage = Math.min(Math.max(1, leverage), risk.maxLeverage);

  const estimate = useMemo(
    () =>
      estimateOrder({
        side,
        markPrice,
        amount,
        mode,
        leverage: clampedLeverage,
        stopLoss,
        takeProfit,
        reduceOnly,
      }),
    [side, markPrice, amount, mode, clampedLeverage, stopLoss, takeProfit, reduceOnly],
  );

  const allErrors: OrderFieldErrors = useMemo(
    () =>
      validateOrderFields({
        side,
        markPrice,
        amount,
        mode,
        leverage: clampedLeverage,
        maxLeverage: risk.maxLeverage,
        stopLoss,
        takeProfit,
        reduceOnly,
        position,
      }),
    [side, markPrice, amount, mode, clampedLeverage, risk.maxLeverage, stopLoss, takeProfit, reduceOnly, position],
  );

  const shownError = (field: TouchedField): string =>
    submitted || touched[field] ? (allErrors[field] ?? "") : "";

  function markTouched(field: TouchedField) {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }

  function applyPercent(pct: number) {
    const next = sizeFromPercent({
      pct,
      mode,
      markPrice,
      available,
      leverage: clampedLeverage,
      reduceOnly,
      position,
    });
    if (!next) return;
    setAmount(next);
    setTouched((prev) => ({ ...prev, amount: false }));
  }

  function prefillReduce() {
    if (!position) return;
    const closeSide: Side = position.side === "long" ? "sell" : "buy";
    setSide(closeSide);
    setReduceOnly(true);
    setMode("units");
    setAmount(position.qty);
    setTouched({});
    setSubmitted(false);
  }

  async function draftTicket(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);

    if (Object.keys(allErrors).length > 0) {
      if (allErrors.amount) amountRef.current?.focus();
      else if (allErrors.reduceOnly) reduceRef.current?.focus();
      else if (allErrors.leverage) leverageRef.current?.focus();
      else if (allErrors.stopLoss) slRef.current?.focus();
      else if (allErrors.takeProfit) tpRef.current?.focus();
      return;
    }

    const text = amount.trim();
    const request: TicketRequest = { symbol, side, ...(mode === "units" ? { qty: text } : { notional: text }) };
    if (reduceOnly) {
      request.reduceOnly = true;
    } else {
      request.leverage = clampedLeverage;
      if (stopLoss.trim()) request.stopLoss = stopLoss.trim();
      if (takeProfit.trim()) request.takeProfit = takeProfit.trim();
    }
    if (await prepareTicket(request)) {
      const next = app.get().snapshot?.draft ?? null;
      setTicket(next);
      onStepChange(next !== null);
    }
  }

  if (ticket) {
    const pending = ticketStatus(ticket, snapshot).state === "pending";
    let after = null;
    if (!pending) {
      after = (
        <button type="button" className="btn btn-secondary" onClick={closeTrade}>
          Done
        </button>
      );
    } else if (!review) {
      after = (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setTicket(null);
            onStepChange(false);
          }}
        >
          Edit order
        </button>
      );
    }
    return (
      <div className="form">
        <TicketCard ticket={ticket} />
        {after ? <div className="form-actions">{after}</div> : null}
      </div>
    );
  }

  if (!wallet.connected || wallet.needsDeposit) return <WalletNeeded />;

  const amountError = shownError("amount");
  const leverageError = shownError("leverage");
  const slError = shownError("stopLoss");
  const tpError = shownError("takeProfit");
  const reduceError = shownError("reduceOnly");

  const actionVerb = reduceOnly ? (side === "buy" ? "Buy to Reduce" : "Sell to Reduce") : side === "buy" ? "Long" : "Short";
  const ctaLabel =
    estimate.notional && estimate.notional > 0
      ? `Review ${actionVerb} ${instrument.base} · ${money(estimate.notional)} ${quote}`
      : `Review ${actionVerb} ${instrument.base}`;

  const sliderStyle = {
    "--attr-min": 1,
    "--attr-max": risk.maxLeverage,
    "--control-value": clampedLeverage,
  } as CSSProperties;

  const pctButtons = reduceOnly ? REDUCE_PCTS : OPEN_PCTS;
  const canSizeByPct = reduceOnly ? Boolean(position) : hasAvailable;

  return (
    <form className="trade-form" onSubmit={(event) => void draftTicket(event)} noValidate>
      <div className="trade-scroll">
        {/* Market selector & live mark context */}
        <div className="trade-contract">
          <div className="trade-market-pick">
            <InstrumentMark base={instrument.base} size="sm" />
            <MarketChip
              label="Contract"
              value={symbol}
              positionsOnly={false}
              slotClass="trade-market-slot"
              triggerClass="trade-market-select trade-market-trigger"
              trigger={
                <>
                  <span className="truncate">
                    {instrument.base}-{quote} Perp
                  </span>
                  <Icon name="chevronDown" size={14} />
                </>
              }
              onPick={(next) => {
                setSymbol(next);
                setStopLoss("");
                setTakeProfit("");
                setTouched({});
                setSubmitted(false);
                loadCatalog(snapshot.network);
                // Its own quote and limits come once it is the market in focus, as on its page.
                if (!snapshot.quotes[next]) void selectSymbol(next);
              }}
            />
            {hasMark ? (
              <div className="trade-mark-meta num">
                <span className="trade-mark-price">{price(markPrice)}</span>
                {quoteRow?.changePct !== null && quoteRow?.changePct !== undefined ? (
                  <span className={direction(quoteRow.changePct)}>{percent(quoteRow.changePct)}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="trade-badges">
            <span className="chip">Market</span>
            <span className="chip">{marginMode}</span>
            <span className="chip" data-tone={isMainnet ? "warn" : undefined}>
              {isMainnet ? "Mainnet" : "Testnet"}
            </span>
          </div>
        </div>

        {/* Open position banner when trading a contract with an active position */}
        {position ? (
          <div className="trade-pos-strip">
            <span className="chip" data-tone={position.side === "long" ? "up" : "down"}>
              {position.side === "long" ? "Long" : "Short"}
            </span>
            <span className="trade-pos-info num truncate">
              {units(position.qty)} {instrument.base} · Entry {price(position.entryPrice)} ·{" "}
              <span className={direction(position.unrealizedPnl)}>{signedMoney(position.unrealizedPnl)}</span>
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={prefillReduce}>
              Reduce
            </button>
          </div>
        ) : null}

        {/* Buy/Long vs Sell/Short native radio group */}
        <fieldset className="trade-sides">
          <legend className="visually-hidden">Order side</legend>
          <label className="trade-side" data-side="buy" data-checked={side === "buy" || undefined}>
            <input
              type="radio"
              className="visually-hidden"
              name={ids.sideName}
              value="buy"
              checked={side === "buy"}
              onChange={() => {
                setSide("buy");
                setTouched((prev) => ({ ...prev, stopLoss: false, takeProfit: false, reduceOnly: false }));
              }}
            />
            <span className="trade-side-label">{reduceOnly ? "Buy to Close" : "Buy / Long"}</span>
          </label>
          <label className="trade-side" data-side="sell" data-checked={side === "sell" || undefined}>
            <input
              type="radio"
              className="visually-hidden"
              name={ids.sideName}
              value="sell"
              checked={side === "sell"}
              onChange={() => {
                setSide("sell");
                setTouched((prev) => ({ ...prev, stopLoss: false, takeProfit: false, reduceOnly: false }));
              }}
            />
            <span className="trade-side-label">{reduceOnly ? "Sell to Close" : "Sell / Short"}</span>
          </label>
        </fieldset>

        {/* Order size & quick percentage buttons */}
        <div className="trade-section">
          <div className="trade-label-row">
            <label className="field-label" htmlFor={ids.amount}>
              {mode === "units" ? "Order size" : "Order value"}
            </label>
            <span className="trade-avail num">
              {reduceOnly
                ? position
                  ? `Position: ${units(position.qty)} ${instrument.base}`
                  : "No open position"
                : `Avail. margin: ${money(account?.available)} ${quote}`}
            </span>
          </div>
          <div className="input-group">
            <input
              ref={amountRef}
              id={ids.amount}
              name="amount"
              className="input num"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              spellCheck={false}
              placeholder={mode === "units" ? "0.01" : "500"}
              data-autofocus
              required
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? ids.amountErr : undefined}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                if (touched.amount) setTouched((prev) => ({ ...prev, amount: false }));
              }}
              onBlur={() => markTouched("amount")}
            />
            <Segmented
              label="Size denomination"
              value={mode}
              options={[
                { value: "value", label: quote },
                { value: "units", label: instrument.base },
              ]}
              onChange={(next) => {
                setMode(next);
                setTouched((prev) => ({ ...prev, amount: false }));
              }}
            />
          </div>
          {amountError ? (
            <p id={ids.amountErr} className="form-error" role="alert">
              {amountError}
            </p>
          ) : hasMark && (estimate.qty !== null || estimate.notional !== null) ? (
            <p className="trade-convert num">
              {mode === "value" && estimate.qty !== null
                ? `≈ ${units(estimate.qty)} ${instrument.base} at mark`
                : mode === "units" && estimate.notional !== null
                  ? `≈ ${money(estimate.notional)} ${quote} notional`
                  : null}
            </p>
          ) : null}
          <div className="trade-pcts" role="group" aria-label={reduceOnly ? "Position size percentage" : "Margin percentage"}>
            {pctButtons.map((item) => (
              <button
                key={item.pct}
                type="button"
                className="trade-pct-btn num"
                disabled={!canSizeByPct}
                onClick={() => applyPercent(item.pct)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Leverage slider & quick presets */}
        {reduceOnly ? null : (
          <div className="trade-section">
            <div className="trade-label-row">
              <label className="field-label" htmlFor={ids.leverage}>
                Leverage
              </label>
              <span className="trade-lev-readout">
                <span className="chip num" data-tone={clampedLeverage >= 10 ? "warn" : undefined}>
                  {clampedLeverage}x
                </span>
                <span className="trade-avail num">Cap {risk.maxLeverage}x</span>
              </span>
            </div>
            {risk.maxLeverage > 1 ? (
              <input
                ref={leverageRef}
                id={ids.leverage}
                name="leverage"
                type="range"
                className="trade-slider"
                min={1}
                max={risk.maxLeverage}
                step={1}
                value={clampedLeverage}
                aria-valuetext={`${clampedLeverage}x`}
                aria-invalid={leverageError ? true : undefined}
                aria-describedby={leverageError ? ids.leverageErr : undefined}
                style={sliderStyle}
                onChange={(event) => setLeverage(Number(event.target.value))}
              />
            ) : null}
            <div className="trade-ticks" role="group" aria-label="Leverage presets">
              {ticks.map((tick) => (
                <button
                  key={tick}
                  type="button"
                  className="trade-tick-btn num"
                  aria-pressed={clampedLeverage === tick}
                  onClick={() => setLeverage(tick)}
                >
                  {tick}x
                </button>
              ))}
            </div>
            {leverageError ? (
              <p id={ids.leverageErr} className="form-error" role="alert">
                {leverageError}
              </p>
            ) : null}
          </div>
        )}

        {/* TP / SL bracket protection */}
        {reduceOnly ? null : (
          <fieldset className="trade-tpsl">
            <legend className="trade-tpsl-legend">
              <span>TP / SL protection</span>
              {estimate.rrRatio !== null ? (
                <span className="chip num">R:R 1 : {estimate.rrRatio.toFixed(1)}</span>
              ) : (
                <span className="trade-avail">Optional</span>
              )}
            </legend>
            <div className="trade-tpsl-card">
              <div className="form-row">
                <div className="field">
                  <div className="trade-label-row">
                    <label className="field-label" htmlFor={ids.sl}>
                      Stop-loss
                    </label>
                    {!slError && estimate.slPnl !== null ? (
                      <span className="trade-payoff down num">{signedMoney(estimate.slPnl)}</span>
                    ) : !slError && estimate.slPct !== null ? (
                      <span className="trade-payoff down num">{percent(estimate.slPct)}</span>
                    ) : null}
                  </div>
                  <input
                    ref={slRef}
                    id={ids.sl}
                    name="stopLoss"
                    className="input num"
                    inputMode="decimal"
                    enterKeyHint="next"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Trigger price"
                    aria-invalid={slError ? true : undefined}
                    aria-describedby={slError ? ids.slErr : undefined}
                    value={stopLoss}
                    onChange={(event) => {
                      setStopLoss(event.target.value);
                      if (touched.stopLoss) setTouched((prev) => ({ ...prev, stopLoss: false }));
                    }}
                    onBlur={() => markTouched("stopLoss")}
                  />
                  {hasMark ? (
                    <div className="trade-offsets">
                      {SL_OFFSETS.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className="trade-offset-btn num"
                          onClick={() => {
                            setStopLoss(offsetPrice(markPrice, side, "sl", pct));
                            setTouched((prev) => ({ ...prev, stopLoss: false }));
                          }}
                        >
                          {side === "buy" ? `−${pct}%` : `+${pct}%`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {slError ? (
                    <p id={ids.slErr} className="form-error" role="alert">
                      {slError}
                    </p>
                  ) : null}
                </div>

                <div className="field">
                  <div className="trade-label-row">
                    <label className="field-label" htmlFor={ids.tp}>
                      Take-profit
                    </label>
                    {!tpError && estimate.tpPnl !== null ? (
                      <span className="trade-payoff up num">{signedMoney(estimate.tpPnl)}</span>
                    ) : !tpError && estimate.tpPct !== null ? (
                      <span className="trade-payoff up num">{percent(estimate.tpPct)}</span>
                    ) : null}
                  </div>
                  <input
                    ref={tpRef}
                    id={ids.tp}
                    name="takeProfit"
                    className="input num"
                    inputMode="decimal"
                    enterKeyHint="done"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Trigger price"
                    aria-invalid={tpError ? true : undefined}
                    aria-describedby={tpError ? ids.tpErr : undefined}
                    value={takeProfit}
                    onChange={(event) => {
                      setTakeProfit(event.target.value);
                      if (touched.takeProfit) setTouched((prev) => ({ ...prev, takeProfit: false }));
                    }}
                    onBlur={() => markTouched("takeProfit")}
                  />
                  {hasMark ? (
                    <div className="trade-offsets">
                      {TP_OFFSETS.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className="trade-offset-btn num"
                          onClick={() => {
                            setTakeProfit(offsetPrice(markPrice, side, "tp", pct));
                            setTouched((prev) => ({ ...prev, takeProfit: false }));
                          }}
                        >
                          {side === "buy" ? `+${pct}%` : `−${pct}%`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {tpError ? (
                    <p id={ids.tpErr} className="form-error" role="alert">
                      {tpError}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </fieldset>
        )}

        {/* Reduce-only switch */}
        <div className="trade-reduce-wrap">
          <label className="switch trade-reduce">
            <span className="trade-reduce-text">
              <span className="trade-reduce-title">Reduce-only</span>
              <span className="trade-reduce-desc">Only trims or closes an open position</span>
            </span>
            <input
              ref={reduceRef}
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
              name="reduceOnly"
              checked={reduceOnly}
              aria-invalid={reduceError ? true : undefined}
              aria-describedby={reduceError ? ids.reduceErr : undefined}
              onChange={(event) => {
                const checked = event.target.checked;
                setReduceOnly(checked);
                if (checked && position) {
                  setSide(position.side === "long" ? "sell" : "buy");
                }
                setTouched((prev) => ({ ...prev, reduceOnly: false }));
              }}
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
          {reduceError ? (
            <p id={ids.reduceErr} className="form-error" role="alert">
              {reduceError}
            </p>
          ) : null}
        </div>

        {/* Live pre-review summary */}
        <dl className="trade-summary" aria-label="Order summary">
          <div>
            <dt>Est. entry (mark)</dt>
            <dd className="num">{hasMark ? price(markPrice) : "—"}</dd>
          </div>
          <div>
            <dt>Notional value</dt>
            <dd className="num">{estimate.notional !== null ? `${money(estimate.notional)} ${quote}` : "—"}</dd>
          </div>
          {reduceOnly ? null : (
            <>
              <div>
                <dt>Est. initial margin</dt>
                <dd className="num">
                  {estimate.margin !== null ? `${money(estimate.margin)} ${quote}` : "—"}
                </dd>
              </div>
              <div>
                <dt>Est. liq. price</dt>
                <dd className="num">{estimate.estLiqPrice !== null ? price(estimate.estLiqPrice) : "—"}</dd>
              </div>
            </>
          )}
        </dl>
      </div>

      {/* Pinned action footer */}
      <div className="trade-footer">
        <button type="button" className="btn btn-ghost" onClick={closeTrade}>
          Cancel
        </button>
        <button
          type="submit"
          className={reduceOnly ? "btn btn-primary grow" : side === "buy" ? "btn btn-long grow" : "btn btn-short grow"}
          disabled={busy}
        >
          {ctaLabel}
        </button>
      </div>
    </form>
  );
}

/** The order ticket modal: drafts a manual market order and reviews tickets before signing. */
export function TradeDialog() {
  const trade = useApp((state) => state.trade);
  const review = trade?.ticket ?? null;
  const [reviewing, setReviewing] = useState(false);
  const isReview = review !== null || reviewing;

  return (
    <Dialog
      open={trade !== null}
      onClose={() => {
        setReviewing(false);
        closeTrade();
      }}
      title={isReview ? "Confirm Order" : "Place Order"}
      size="trade"
    >
      {trade ? (
        <div className="trade-shell">
          <TradeForm
            key={review?.id ?? `${trade.prefill?.symbol ?? ""}-${trade.prefill?.side ?? ""}-${trade.prefill?.stopLoss ?? ""}-${trade.prefill?.takeProfit ?? ""}`}
            review={review}
            prefill={trade.prefill}
            onStepChange={setReviewing}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
