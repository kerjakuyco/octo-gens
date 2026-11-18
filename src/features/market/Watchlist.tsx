import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon";
import { direction, percent, price } from "../../lib/format";
import { selectPair, useApp, useSnapshot, watchAdd, watchRemove } from "../../state/app";
import { InstrumentMark } from "./InstrumentMark";
import { Sparkline } from "./Sparkline";

export function Watchlist() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const [adding, setAdding] = useState(false);
  const [symbol, setSymbol] = useState("");

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await watchAdd(symbol)) {
      setSymbol("");
      setAdding(false);
    }
  }

  return (
    <section className="panel-section" aria-label="Watchlist">
      <div className="panel-heading">
        <h2 className="panel-title">Watchlist</h2>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          aria-expanded={adding}
          onClick={() => setAdding((value) => !value)}
        >
          <Icon name={adding ? "close" : "plus"} size={15} />
          {adding ? "Cancel" : "Add symbol"}
        </button>
      </div>

      {adding ? (
        <form className="add-symbol" onSubmit={(event) => void add(event)}>
          <input
            className="input"
            aria-label="Token symbol"
            placeholder="Symbol, for example ARB"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
          />
          <button type="submit" className="btn btn-secondary" disabled={!symbol.trim() || busy}>
            Add
          </button>
        </form>
      ) : null}

      <ul className="watchlist">
        {snapshot.instruments.map((instrument) => {
          const quote = snapshot.quotes[instrument.pair];
          const current = instrument.pair === snapshot.focus;
          return (
            <li key={instrument.pair} className="watch-item">
              <button
                type="button"
                className="watch-row"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  if (!current) void selectPair(instrument.pair);
                }}
              >
                <InstrumentMark instrument={instrument} />
                <span>
                  <span className="watch-ticker">{instrument.ticker}</span>
                  <span className="watch-name">{instrument.name}</span>
                </span>
                {quote ? <Sparkline closes={quote.closes} price={quote.price} /> : <span />}
                {quote ? (
                  <span className="watch-figures">
                    <span className="watch-price">{price(quote.price)}</span>
                    <span className={`watch-change ${direction(quote.changePct)}`}>{percent(quote.changePct)}</span>
                  </span>
                ) : (
                  <span className="watch-figures watch-name">No quote yet</span>
                )}
              </button>
              {instrument.custom ? (
                <button
                  type="button"
                  className="icon-btn watch-remove"
                  aria-label={`Remove ${instrument.ticker} from the watchlist`}
                  onClick={() => void watchRemove(instrument.pair)}
                >
                  <Icon name="close" size={15} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
