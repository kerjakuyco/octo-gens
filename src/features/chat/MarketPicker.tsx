import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MarketRow, Network, PositionView, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { baseOf, marketName } from "../../lib/commands";
import { direction, percent, price, signedMoney, size } from "../../lib/format";
import { usePresence } from "../../lib/hooks";
import { matchMarkets } from "../../lib/market";
import { errorText, request, useSnapshot } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { type ListSection, Listbox, stepIndex } from "./Listbox";

/* ---------------------------------------------------------------- catalog */

/** Every market on one network, read once and shared by every picker. */
export interface Catalog {
  rows: MarketRow[] | null;
  /** Why the latest read failed, or empty. */
  error: string;
  loading: boolean;
  /** When the rows were read, in ms since the epoch; 0 before the first read. */
  at: number;
}

/** How long a read of every market stays good enough for picking one. */
const FRESH_MS = 60_000;
const EMPTY: Catalog = { rows: null, error: "", loading: false, at: 0 };
const catalogs = new Map<Network, Catalog>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads every market of `network` unless a recent read is held or one is on its way. Call it from an event. */
export function loadCatalog(network: Network): void {
  const held = catalogs.get(network) ?? EMPTY;
  if (held.loading || (held.rows && Date.now() - held.at < FRESH_MS)) return;
  catalogs.set(network, { ...held, loading: true, error: "" });
  emit();
  request((api) => api.marketOverview()).then(
    (rows) => {
      catalogs.set(network, { rows, error: "", loading: false, at: Date.now() });
      emit();
    },
    (error: unknown) => {
      catalogs.set(network, { ...held, loading: false, error: errorText(error) });
      emit();
    },
  );
}

export function useCatalog(network: Network): Catalog {
  return useSyncExternalStore(
    subscribe,
    () => catalogs.get(network) ?? EMPTY,
    () => EMPTY,
  );
}

/* ---------------------------------------------------------------- options */

export interface MarketOption {
  symbol: string;
  base: string;
  quote: string;
  price: string | null;
  changePct: number | null;
  /** The open position in this market, when the list is of positions. */
  position: PositionView | null;
}

/** At most this many markets are listed; typing narrows the rest down. */
const LIMIT = 50;

function quoteOf(symbol: string): string {
  return symbol.slice(baseOf(symbol).length);
}

/**
 * The markets a picker lists. With nothing typed: the watchlist, then every other market, most traded
 * first. With something typed: the best matches among all of them. A position command lists only the
 * markets where there is a position.
 */
export function marketOptions(
  snapshot: Snapshot,
  rows: readonly MarketRow[] | null,
  query: string,
  positionsOnly: boolean,
): { items: MarketOption[]; sections: ListSection[] } {
  if (positionsOnly) {
    const held = (snapshot.account?.positions ?? []).map((position) => ({
      symbol: position.symbol,
      base: baseOf(position.symbol),
      quote: quoteOf(position.symbol),
      price: position.markPrice,
      changePct: null,
      position,
    }));
    return { items: query.trim() ? matchMarkets(held, query) : held, sections: [] };
  }

  const watched: MarketOption[] = snapshot.instruments.map((item) => {
    const quote = snapshot.quotes[item.symbol];
    return {
      symbol: item.symbol,
      base: item.base,
      quote: item.quote || quoteOf(item.symbol),
      price: quote?.price ?? null,
      changePct: quote?.changePct ?? null,
      position: null,
    };
  });
  const listed = new Set(watched.map((item) => item.symbol));
  const others = (rows ?? [])
    .filter((row) => !listed.has(row.symbol))
    .sort((left, right) => (Number(right.quoteVolume24h) || 0) - (Number(left.quoteVolume24h) || 0))
    .map((row) => ({
      symbol: row.symbol,
      base: row.base,
      quote: row.quote,
      price: row.price,
      changePct: row.changePct,
      position: null,
    }));

  if (query.trim()) return { items: matchMarkets([...watched, ...others], query).slice(0, LIMIT), sections: [] };
  const items = [...watched, ...others].slice(0, LIMIT);
  const sections: ListSection[] = watched.length > 0 ? [{ label: "Watchlist", start: 0 }] : [];
  if (items.length > watched.length) sections.push({ label: "Most traded", start: watched.length });
  return { items, sections };
}

/** One market in a picker: its mark and name, then its price and day's change, or the position held in it. */
export function MarketOptionRow({ option, current }: { option: MarketOption; current?: boolean }) {
  const { position } = option;
  return (
    <>
      <InstrumentMark base={option.base} size="sm" />
      <span className="mk-name truncate">
        {option.base}
        {option.quote && !position ? <span className="muted"> / {option.quote}</span> : null}
      </span>
      {position ? (
        <span className={`num mk-side ${position.side === "long" ? "up" : "down"}`}>
          {position.side === "long" ? "Long" : "Short"} {size(position.qty)}
        </span>
      ) : (
        <span className="num mk-price">{price(option.price)}</span>
      )}
      {position ? (
        <span className={`num mk-change ${direction(position.unrealizedPnl)}`}>{signedMoney(position.unrealizedPnl)}</span>
      ) : (
        <span className={`num mk-change ${direction(option.changePct)}`}>{percent(option.changePct)}</span>
      )}
      {current ? <Icon name="check" size={14} /> : null}
    </>
  );
}

/** What a picker says under its list while every market is still being read, or when the read failed. */
function catalogFooter(catalog: Catalog, query: string, positionsOnly: boolean) {
  if (positionsOnly || catalog.rows) return null;
  if (catalog.error) return <div className="lb-empty">{catalog.error}</div>;
  if (!catalog.loading) return null;
  return (
    <div className="lb-empty lb-loading">
      <span className="spinner" />
      <span>{query.trim() ? "Searching every market" : "Reading every market"}</span>
    </div>
  );
}

interface MarketListProps {
  id: string;
  items: readonly MarketOption[];
  sections: readonly ListSection[];
  active: number;
  query: string;
  positionsOnly: boolean;
  onActive: (index: number) => void;
  onPick: (option: MarketOption) => void;
  /** The market already chosen, marked with a tick. */
  current?: string;
}

/** The markets that match what was typed, to pick one with the keyboard or the pointer. */
export function MarketList({ id, items, sections, active, query, positionsOnly, onActive, onPick, current }: MarketListProps) {
  const snapshot = useSnapshot();
  const catalog = useCatalog(snapshot.network);
  return (
    <Listbox
      id={id}
      label={positionsOnly ? "Open positions" : "Markets"}
      items={items}
      sections={sections}
      active={active}
      onActive={onActive}
      onPick={(option) => onPick(option)}
      itemKey={(option) => option.symbol}
      itemClass="mk-option"
      renderItem={(option) => <MarketOptionRow option={option} current={option.symbol === current} />}
      empty={
        positionsOnly
          ? "No open position matches"
          : catalog.rows || query.trim() === ""
            ? "No market matches"
            : catalog.error
              ? null
              : "Looking through every market"
      }
      footer={catalogFooter(catalog, query, positionsOnly)}
    />
  );
}

/* -------------------------------------------------------------- the chip */

const GAP = 8;
const EDGE = 8;
/** Below this much room above the chip, the list opens beneath it instead. */
const ROOM = 240;

interface MarketChipProps {
  /** What the chip sets, for its name: "Market", "Compare with". */
  label: string;
  /** The symbol it shows. */
  value: string;
  /** A word before the market's name, such as "vs". */
  prefix?: string;
  positionsOnly: boolean;
  onPick: (symbol: string) => void;
  /** Hands the keyboard back to the message box once a market is picked. */
  onDone?: () => void;
  style?: CSSProperties;
  /** What the button shows instead of the chip's mark and name, for a form that draws its own field. */
  trigger?: ReactNode;
  /** The button's class, in place of the chip's. */
  triggerClass?: string;
  /** The wrapper's class, in place of the chip's slot. */
  slotClass?: string;
}

/**
 * A market, as a button that opens a searchable list of every market: the watchlist first, then the
 * rest, most traded first. The message box draws it as a chip; a form can give it its own look.
 */
export function MarketChip({
  label,
  value,
  prefix,
  positionsOnly,
  onPick,
  onDone = () => {},
  style,
  trigger,
  triggerClass = "cmd-chip",
  slotClass = "cmd-chip-slot",
}: MarketChipProps) {
  const snapshot = useSnapshot();
  const catalog = useCatalog(snapshot.network);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The highlighted option; null keeps it on the market already chosen. */
  const [active, setActive] = useState<number | null>(null);
  const presence = usePresence(open, 120);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popId = useId();
  const listId = useId();

  const { items, sections } = useMemo(
    () => marketOptions(snapshot, catalog.rows, query, positionsOnly),
    [snapshot, catalog.rows, query, positionsOnly],
  );
  // A market off the watchlist is only listed once every market is read, which may be after the list opens.
  // Until then nothing is highlighted, so Enter cannot swap it for another market.
  const chosen = active === null ? items.findIndex((option) => option.symbol === value) : -1;
  const waiting = active === null && chosen < 0 && catalog.loading;
  const index = items.length > 0 && !waiting ? Math.min(active ?? Math.max(0, chosen), items.length - 1) : -1;
  const name = marketName(value);

  function close(refocus: "chip" | "field" | "none") {
    setOpen(false);
    setQuery("");
    setActive(null);
    if (refocus === "chip") button.current?.focus();
    else if (refocus === "field") onDone();
  }

  function show() {
    loadCatalog(snapshot.network);
    setActive(null);
    setQuery("");
    setOpen(true);
  }

  function pick(option: MarketOption) {
    onPick(option.symbol);
    close("field");
  }

  // Placed against the window, beside the chip: above it while there is room, so it grows away from the box.
  useLayoutEffect(() => {
    const anchor = button.current;
    const node = pop.current;
    if (!open || !anchor || !node) return;
    const at = anchor.getBoundingClientRect();
    const above = at.top - GAP - EDGE;
    const below = window.innerHeight - at.bottom - GAP - EDGE;
    const up = above >= ROOM || above >= below;
    node.dataset.side = up ? "top" : "bottom";
    node.style.maxHeight = `${Math.round(Math.max(160, Math.min(440, up ? above : below)))}px`;
    node.style.top = up ? "auto" : `${Math.round(at.bottom + GAP)}px`;
    node.style.bottom = up ? `${Math.round(window.innerHeight - at.top + GAP)}px` : "auto";
    const width = node.offsetWidth;
    node.style.left = `${Math.round(Math.max(EDGE, Math.min(at.left, window.innerWidth - width - EDGE)))}px`;
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!pop.current?.contains(target) && !button.current?.contains(target)) {
        setOpen(false);
        setQuery("");
      }
    }
    // Pinned to where the chip was: once the window changes size, it no longer is.
    const away = () => {
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length > 0) setActive(stepIndex(index, items.length, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = items[index];
      if (chosen) pick(chosen);
    } else if (event.key === "Escape") {
      // Handled here: the window's own Escape, which stops an answer, must not fire too.
      event.preventDefault();
      event.stopPropagation();
      close("chip");
    } else if (event.key === "Tab") {
      close("none");
    }
  }

  return (
    <span className={slotClass} style={style}>
      <button
        ref={button}
        type="button"
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`${label}: ${name}`}
        onClick={() => (open ? close("none") : show())}
      >
        {trigger ?? (
          <>
            {prefix ? <span className="cmd-chip-prefix">{prefix}</span> : null}
            <InstrumentMark base={baseOf(value)} size="sm" />
            <span className="truncate">{name}</span>
            <Icon name="chevronDown" size={13} />
          </>
        )}
      </button>
      {presence.mounted ? (
        <div ref={pop} id={popId} className="mk-pop" data-state={presence.closing ? "closing" : "open"}>
          <div className="switcher-search">
            <Icon name="search" size={15} />
            <input
              ref={input}
              type="text"
              role="combobox"
              className="switcher-input"
              aria-label={positionsOnly ? "Search your positions" : "Search markets"}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={index >= 0 ? `${listId}-${index}` : undefined}
              placeholder={positionsOnly ? "Your positions" : "Search markets"}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                loadCatalog(snapshot.network);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <MarketList
            id={listId}
            items={items}
            sections={sections}
            active={index}
            query={query}
            positionsOnly={positionsOnly}
            onActive={setActive}
            onPick={pick}
            current={value}
          />
        </div>
      ) : null}
    </span>
  );
}
