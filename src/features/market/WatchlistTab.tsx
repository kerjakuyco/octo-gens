import { type KeyboardEvent, useId, useState } from "react";
import type { MarketRow } from "../../api/types";
import { Icon } from "../../components/Icon";
import { direction, percent, price } from "../../lib/format";
import { matchMarkets } from "../../lib/market";
import { errorText, request, selectSymbol, useApp, useSnapshot, watchAdd, watchRemove } from "../../state/app";
import { InstrumentMark } from "./InstrumentMark";
import { Sparkline } from "./Sparkline";

const RESULTS = 8;

/** Finds any market on the network and puts it on the watchlist. */
function AddMarket() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<{ network: string; rows: MarketRow[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const listId = useId();

  const rows = loaded?.network === snapshot.network ? loaded.rows : null;
  const watched = new Set(snapshot.instruments.map((item) => item.symbol));
  const results = rows ? matchMarkets(rows, query).slice(0, RESULTS) : [];
  const open = focused && query.trim() !== "";

  function load() {
    if (rows) return;
    const { network } = snapshot;
    request((api) => api.marketOverview())
      .then((list) => {
        setLoaded({ network, rows: list });
        setProblem("");
      })
      .catch((error: unknown) => setProblem(errorText(error)));
  }

  function add(row: MarketRow) {
    setQuery("");
    setActive(0);
    void (watched.has(row.symbol) ? selectSymbol(row.symbol) : watchAdd(row.symbol));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (results.length > 0) setActive((active + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = results[active];
      if (row && !busy) add(row);
    } else if (event.key === "Escape") {
      // Clears the search rather than closing the panel.
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  }

  return (
    <div className="add-market">
      <label className="search">
        <Icon name="search" size={16} />
        <input
          className="input"
          type="text"
          role="combobox"
          aria-label="Add market"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          placeholder="Add market"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onFocus={() => {
            setFocused(true);
            load();
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            load();
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {open ? (
        <ul id={listId} className="results" role="listbox" aria-label="Markets">
          {results.map((row, index) => (
            <li
              key={row.symbol}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="result"
              onPointerEnter={() => setActive(index)}
              onPointerDown={(event) => {
                // Keep the field focused; the click below does the work.
                event.preventDefault();
              }}
              onClick={() => {
                if (!busy) add(row);
              }}
            >
              <InstrumentMark base={row.base} size="sm" />
              <span className="grow truncate">
                {row.base}
                <span className="muted"> / {row.quote}</span>
              </span>
              <span className="num">{price(row.price)}</span>
              <span className={`num ${direction(row.changePct)}`}>{percent(row.changePct)}</span>
              {watched.has(row.symbol) ? <Icon name="starFilled" size={14} /> : null}
            </li>
          ))}
          {results.length === 0 ? (
            <li className="result-none" role="presentation">
              {problem || (rows ? "No market found" : <span className="spinner" />)}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** The markets kept in view, and the way to add more. */
export function WatchlistTab() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));

  return (
    <>
      <AddMarket />
      <ul className="watch">
        {snapshot.instruments.map((item) => {
          const quote = snapshot.quotes[item.symbol];
          return (
            <li key={item.symbol} className="watch-row" data-current={item.symbol === snapshot.focus}>
              <button
                type="button"
                className="watch-main"
                aria-current={item.symbol === snapshot.focus ? "true" : undefined}
                onClick={() => void selectSymbol(item.symbol)}
              >
                <InstrumentMark base={item.base} size="sm" />
                <span className="grow truncate watch-name">{item.base}</span>
                {quote ? <Sparkline closes={quote.closes} price={quote.price} /> : null}
                <span className="watch-figures num">
                  <span>{quote ? price(quote.price) : "—"}</span>
                  <span className={direction(quote?.changePct)}>{percent(quote?.changePct)}</span>
                </span>
              </button>
              {item.custom ? (
                <button
                  type="button"
                  className="icon-btn watch-remove"
                  aria-label={`Remove ${item.base}`}
                  disabled={busy}
                  onClick={() => void watchRemove(item.symbol)}
                >
                  <Icon name="close" size={14} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
