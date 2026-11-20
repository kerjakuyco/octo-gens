import type { ReactNode } from "react";
import type {
  CardView,
  GridBotView,
  GridPreviewView,
  GridStatus,
  MarketRow,
  NewsView,
  OrderBookView,
  PlanView,
  QuoteView,
  TechnicalFrame,
} from "../../api/types";
import { Icon } from "../../components/Icon";
import {
  ago,
  compact,
  direction,
  fundingRate,
  leverage,
  money,
  percent,
  price,
  signedMoney,
  units,
} from "../../lib/format";
import { instrumentFor } from "../../lib/market";
import { useNow } from "../../lib/clock";
import { focusMarket, openExternal, openGrid, useSnapshot } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { RsiBar, ShareBar, TrendChip, macdWords } from "../market/Readings";
import { Sparkline } from "../market/Sparkline";
import { GridRange, gridDirectionLabel, perGridLabel, spacingLabel } from "./GridRange";

/** A market's name as a button that shows the market in the panel. */
function SymbolButton({ symbol, children }: { symbol: string; children?: ReactNode }) {
  const snapshot = useSnapshot();
  const instrument = instrumentFor(snapshot, symbol);
  return (
    <button type="button" className="symbol" onClick={() => void focusMarket(symbol)}>
      <InstrumentMark base={instrument.base} size="sm" />
      <span className="symbol-name">{instrument.base}</span>
      {children}
    </button>
  );
}

function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={tone ? `num ${tone}` : "num"}>{children}</dd>
    </div>
  );
}

function QuotesCard({ quotes }: { quotes: QuoteView[] }) {
  return (
    <section className="card card-wide" aria-label="Prices">
      <ul className="rows">
        {quotes.map((quote) => (
          <li key={quote.symbol} className="row quote-row">
            <SymbolButton symbol={quote.symbol} />
            <span className="num row-price">{price(quote.price)}</span>
            <span className={`num row-change ${direction(quote.changePct)}`}>{percent(quote.changePct)}</span>
            <span className="num row-extra muted">Funding {fundingRate(quote.fundingRatePct)}</span>
            <Sparkline closes={quote.closes} price={quote.price} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TechnicalsCard({ symbol, frame }: { symbol: string; frame: TechnicalFrame }) {
  const macd = macdWords(frame.macd);
  const support = frame.support[0];
  const resistance = frame.resistance[0];
  return (
    <section className="card" aria-label="Chart reading">
      <header className="card-head">
        <SymbolButton symbol={symbol}>
          <span className="muted">{frame.timeframe}</span>
        </SymbolButton>
        <TrendChip trend={frame.trend} />
      </header>
      <dl className="facts">
        <div className="fact">
          <dt>RSI</dt>
          <dd>
            <RsiBar value={frame.rsi14} />
          </dd>
        </div>
        <Fact label="MACD" tone={macd.tone}>
          {macd.text}
        </Fact>
        <Fact label="ATR">{frame.atrPct === null ? "—" : `${frame.atrPct.toFixed(2)}%`}</Fact>
        <Fact label="Support">{support === undefined ? "—" : price(support)}</Fact>
        <Fact label="Resistance">{resistance === undefined ? "—" : price(resistance)}</Fact>
      </dl>
    </section>
  );
}

function BookCard({ book }: { book: OrderBookView }) {
  const bid = book.bids[0];
  const ask = book.asks[0];
  return (
    <section className="card" aria-label="Order book">
      <header className="card-head">
        <SymbolButton symbol={book.symbol}>
          <span className="muted">Order book</span>
        </SymbolButton>
      </header>
      <dl className="facts">
        <Fact label="Best bid" tone="up">
          {bid ? price(bid.price) : "—"}
        </Fact>
        <Fact label="Best ask" tone="down">
          {ask ? price(ask.price) : "—"}
        </Fact>
        <Fact label="Spread">{book.spreadBps === null ? "—" : `${book.spreadBps.toFixed(2)} bps`}</Fact>
      </dl>
      <ShareBar bidPct={book.bidSharePct} />
    </section>
  );
}

function MoversCard({ rows }: { rows: MarketRow[] }) {
  return (
    <section className="card card-wide" aria-label="Movers">
      <ol className="rows">
        {rows.map((row, index) => (
          <li key={row.symbol} className="row mover-row">
            <span className="rank num">{index + 1}</span>
            <SymbolButton symbol={row.symbol} />
            <span className="num row-price">{price(row.price)}</span>
            <span className={`num row-change ${direction(row.changePct)}`}>{percent(row.changePct)}</span>
            <span className="num row-extra muted">Vol {compact(row.quoteVolume24h)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PlanCard({ plan }: { plan: PlanView }) {
  const snapshot = useSnapshot();
  const quote = instrumentFor(snapshot, plan.symbol).quote || "USDT";
  const long = plan.direction === "long";
  return (
    <section className="card card-wide" aria-label="Plan">
      <header className="card-head">
        <SymbolButton symbol={plan.symbol}>
          <span className="muted">Plan</span>
        </SymbolButton>
        <span className="chip" data-tone={long ? "up" : "down"}>
          {long ? "Long" : "Short"} {leverage(plan.leverage)}
        </span>
      </header>
      <dl className="levels">
        <Fact label="Entry">{price(plan.entry)}</Fact>
        <Fact label="Stop-loss" tone="down">
          {price(plan.stop)}
        </Fact>
        <Fact label="Take-profit" tone="up">
          {plan.target ? price(plan.target) : "—"}
        </Fact>
      </dl>
      <dl className="facts facts-two">
        <Fact label="Size">
          {units(plan.qty)} {instrumentFor(snapshot, plan.symbol).base}
        </Fact>
        <Fact label="Value">
          {money(plan.notional)} {quote}
        </Fact>
        <Fact label="Margin">
          {money(plan.margin)} {quote}
        </Fact>
        <Fact label="Loss at stop">
          {money(plan.lossAtStop)} {quote}
          {plan.riskPct === null ? "" : ` (${plan.riskPct}%)`}
        </Fact>
        <Fact label="Est. liquidation">{plan.liquidation ? price(plan.liquidation) : "None"}</Fact>
        <Fact label="Reward to risk">{plan.rewardToRisk === null ? "—" : `${plan.rewardToRisk.toFixed(1)} : 1`}</Fact>
      </dl>
      {plan.stopSafe ? null : (
        <p className="note" data-tone="warn" role="alert">
          <Icon name="alert" size={16} />
          Liquidation comes before the stop-loss.
        </p>
      )}
    </section>
  );
}

/** Headlines the assistant read. Each opens in the browser; nothing loads inside the app. */
function NewsCard({ query, articles }: { query: string; articles: NewsView[] }) {
  const now = useNow();
  return (
    <section className="card card-wide" aria-label="News">
      <header className="card-head">
        <span className="news-head">
          <Icon name="news" size={16} />
          News
          {query ? <span className="muted truncate">{query}</span> : null}
        </span>
      </header>
      <ul className="rows">
        {articles.map((article) => (
          <li key={article.url} className="row news-row">
            <button
              type="button"
              className="news-title"
              title={article.url}
              aria-label={`${article.title}. Open on ${article.source} in your browser`}
              onClick={() => openExternal(article.url)}
            >
              {article.title}
            </button>
            <span className="news-source muted truncate">{article.source}</span>
            <span className="news-age num muted">{ago(article.published, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The live account, not a copy from when the assistant read it. */
function AccountCard() {
  const snapshot = useSnapshot();
  const { account } = snapshot;
  if (!account) {
    return (
      <section className="card card-wide" aria-label="Account">
        <p className="card-empty">No account to show</p>
      </section>
    );
  }
  return (
    <section className="card card-wide" aria-label="Account">
      <dl className="levels">
        <Fact label="Equity">{money(account.equity)}</Fact>
        <Fact label="Available">{money(account.available)}</Fact>
        <Fact label="Unrealized P/L" tone={direction(account.unrealizedPnl)}>
          {signedMoney(account.unrealizedPnl)}
        </Fact>
      </dl>
      {account.positions.length > 0 ? (
        <ul className="rows">
          {account.positions.map((position) => (
            <li key={position.symbol} className="row position-row">
              <SymbolButton symbol={position.symbol} />
              <span className="chip" data-tone={position.side === "long" ? "up" : "down"}>
                {position.side === "long" ? "Long" : "Short"} {leverage(position.leverage)}
              </span>
              <span className="num row-price">{units(position.qty)}</span>
              <span className={`num row-change ${direction(position.unrealizedPnl)}`}>
                {signedMoney(position.unrealizedPnl)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="card-empty">No open positions</p>
      )}
    </section>
  );
}

/**
 * Where a grid bot would be liquidated, estimated: below the range for what it buys, above it for what it
 * sells. A bot on cross margin has no estimate of its own, so nothing is shown.
 */
export function GridLiquidation({ long, short }: { long: string | null; short: string | null }) {
  if (long && short) {
    return (
      <>
        <Fact label="Est. liq. below">{price(long)}</Fact>
        <Fact label="Est. liq. above">{price(short)}</Fact>
      </>
    );
  }
  const only = long ?? short;
  return only ? <Fact label="Est. liq. price">{price(only)}</Fact> : null;
}

/** Things to know about a grid bot before starting it, as the core worded them. */
export function GridWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="grid-warnings">
      {warnings.map((warning) => (
        <li key={warning}>
          <Icon name="alert" size={14} />
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  );
}

/** A grid bot worked out as a dry run: its range, how it splits it, and what it trades with. Nothing was sent. */
function GridCard({ preview }: { preview: GridPreviewView }) {
  const label = gridDirectionLabel(preview.direction);
  const buying = preview.initialSide === "buy";
  return (
    <section className="card card-wide grid-card" aria-label={`${label.text} plan for ${preview.base}`}>
      <header className="card-head">
        <SymbolButton symbol={preview.symbol}>
          <span className="muted">Grid plan</span>
        </SymbolButton>
        <span className="chip" data-tone={label.tone}>
          {label.text}
        </span>
      </header>
      <GridRange lower={preview.lowerPrice} upper={preview.upperPrice} mark={preview.markPrice} levels={preview.levels} />
      <dl className="facts facts-two">
        <Fact label="Grids">
          {preview.grids}, {spacingLabel(preview.spacing)}
        </Fact>
        <Fact label="Earns per grid">{perGridLabel(preview.profitPerGridMinPct, preview.profitPerGridMaxPct)}</Fact>
        <Fact label="Orders">
          <span className="up">{preview.buyOrders} buy</span> · <span className="down">{preview.sellOrders} sell</span>
        </Fact>
        <Fact label="Each order">
          {units(preview.qtyPerGrid)} {preview.base}
        </Fact>
        <Fact label="Margin">
          {money(preview.margin)} {preview.quote} · {leverage(preview.leverage)}
        </Fact>
        <GridLiquidation long={preview.estLiqLong} short={preview.estLiqShort} />
      </dl>
      {preview.initialSide && preview.initialQty ? (
        <p className="grid-note">
          Starts by {buying ? "buying" : "selling"} {units(preview.initialQty)} {preview.base} at market.
        </p>
      ) : null}
      <GridWarnings warnings={preview.warnings} />
    </section>
  );
}

const GRID_STATUS: Record<GridStatus, { text: string; tone?: "up" | "warn" }> = {
  running: { text: "Running", tone: "up" },
  waiting: { text: "Waiting" },
  stopped: { text: "Stopped" },
  error: { text: "Needs attention", tone: "warn" },
};

/** The trader's grid bots as the assistant read them, each with a way to its page. */
function GridsCard({ bots }: { bots: GridBotView[] }) {
  return (
    <section className="card card-wide" aria-label="Grid bots">
      <header className="card-head">
        <span className="news-head">
          <Icon name="grid" size={16} />
          Grid bots
        </span>
      </header>
      <ul className="rows">
        {bots.map((bot) => {
          const label = gridDirectionLabel(bot.direction);
          const status = GRID_STATUS[bot.status];
          return (
            <li key={bot.id} className="row grid-bot-row">
              <div className="grid-bot-head">
                <SymbolButton symbol={bot.symbol} />
                <span className="chip" data-tone={label.tone}>
                  {label.text}
                </span>
                <span className="chip" data-tone={status.tone}>
                  {status.text}
                </span>
                <span className={`num grid-bot-pnl ${direction(bot.totalPnl)}`}>
                  {signedMoney(bot.totalPnl)} {bot.quote}
                </span>
              </div>
              <GridRange compact lower={bot.lowerPrice} upper={bot.upperPrice} mark={bot.markPrice} levels={bot.levels} />
              <div className="grid-bot-foot">
                <span className="muted num">
                  {bot.matchedTrades} completed {bot.matchedTrades === 1 ? "trade" : "trades"} · {money(bot.margin)}{" "}
                  {bot.quote} at {leverage(bot.leverage)}
                </span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openGrid(bot.symbol)}>
                  Open
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Something the assistant looked at, drawn from the data it got. */
export function Card({ card }: { card: CardView }) {
  switch (card.kind) {
    case "quotes":
      return <QuotesCard quotes={card.quotes} />;
    case "technicals":
      return <TechnicalsCard symbol={card.symbol} frame={card.frame} />;
    case "book":
      return <BookCard book={card.book} />;
    case "movers":
      return <MoversCard rows={card.rows} />;
    case "plan":
      return <PlanCard plan={card.plan} />;
    case "news":
      return <NewsCard query={card.query} articles={card.articles} />;
    case "account":
      return <AccountCard />;
    case "grid":
      return <GridCard preview={card.preview} />;
    case "grids":
      return <GridsCard bots={card.bots} />;
    default:
      // A card kind this build does not know: the answer still reads without it.
      return null;
  }
}
