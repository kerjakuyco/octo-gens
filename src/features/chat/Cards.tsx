import type { ReactNode } from "react";
import type {
  CardView,
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
import { focusMarket, openExternal, useSnapshot } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { RsiBar, ShareBar, TrendChip, macdWords } from "../market/Readings";
import { Sparkline } from "../market/Sparkline";

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
    default:
      // A card kind this build does not know: the answer still reads without it.
      return null;
  }
}
