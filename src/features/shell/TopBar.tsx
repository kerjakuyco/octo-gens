import { type KeyboardEvent, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { MarketRow, Network } from "../../api/types";
import { BusyMark } from "../../components/BusyMark";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { direction, money, percent, price } from "../../lib/format";
import { activeWallet, instrumentFor, matchMarkets } from "../../lib/market";
import { activeModel, isConnected, modelName } from "../../lib/models";
import { fundsNote, networkName } from "../../lib/network";
import {
  type Page,
  errorText,
  leaveMarket,
  navigate,
  newThread,
  openSettings,
  request,
  selectSymbol,
  setNetwork,
  switchModel,
  toggleSidebar,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";

const TITLES: Record<Exclude<Page, "chat" | "market">, string> = {
  markets: "Markets",
  grid: "Grid bots",
  news: "News",
  account: "Account",
  activity: "Activity",
};

const BACK_LABELS: Record<Exclude<Page, "market">, string> = {
  chat: "Chat",
  markets: "Markets",
  grid: "Grid bots",
  news: "News",
  account: "Account",
  activity: "Activity",
};

/** Practice first: it is where a new trader should start. */
const NETWORK_ORDER: Network[] = ["testnet", "mainnet"];
const SWITCHER_LIMIT = 10;

/** The model in use. Opens the connected models for one-click switching. */
function ModelMenu() {
  const { assistant } = useSnapshot();
  const busy = useBusy();
  const connected = assistant.providers.filter(isConnected);

  return (
    <Menu
      triggerClass="model-btn"
      trigger={
        <>
          <span className="truncate">{assistant.ready ? activeModel(assistant) : "Connect a model"}</span>
          <Icon name="chevronDown" size={16} />
        </>
      }
    >
      {connected.map((provider) => {
        const current = provider.id === assistant.provider;
        return (
          <MenuItem
            key={provider.id}
            label={current ? activeModel(assistant) : provider.label || modelName(provider.model)}
            sub={provider.name}
            checked={current}
            disabled={busy && !current}
            onSelect={() => {
              if (!current) void switchModel(provider);
            }}
          />
        );
      })}
      {connected.length > 0 ? <div className="menu-sep" role="separator" /> : null}
      <MenuItem icon="plus" label="Add model" onSelect={() => openSettings("models")} />
    </Menu>
  );
}

function NetworkMenu() {
  const { network } = useSnapshot();
  const busy = useBusy();
  const real = network === "mainnet";

  return (
    <Menu
      triggerClass="pill"
      align="end"
      label={`Network: ${networkName(network)}`}
      trigger={
        <>
          <span className="dot" data-tone={real ? "warn" : undefined} />
          {networkName(network)}
          {real ? <span className="pill-note">Real funds</span> : null}
          <Icon name="chevronDown" size={14} />
        </>
      }
    >
      {NETWORK_ORDER.map((option) => (
        <MenuItem
          key={option}
          label={networkName(option)}
          sub={fundsNote(option)}
          checked={option === network}
          disabled={busy && option !== network}
          onSelect={() => {
            if (option !== network) void setNetwork(option);
          }}
        />
      ))}
    </Menu>
  );
}

/** What the wallet can open positions with, or the way to connect one. */
function WalletChip() {
  const snapshot = useSnapshot();
  const wallet = activeWallet(snapshot);

  if (!wallet.connected) {
    return (
      <button type="button" className="pill" onClick={() => openSettings("wallet")}>
        <Icon name="wallet" size={16} />
        <span className="pill-text">Connect wallet</span>
      </button>
    );
  }
  let text = "Account";
  if (wallet.needsDeposit) text = "Deposit needed";
  else if (snapshot.account) text = `${money(snapshot.account.available)} USDT`;
  return (
    <button type="button" className="pill" aria-label={`Available: ${text}. Open account`} onClick={() => navigate("account")}>
      <Icon name="wallet" size={16} />
      <span className="pill-text num">{text}</span>
    </button>
  );
}

interface SwitcherOption {
  symbol: string;
  base: string;
  quote: string;
  price: string | null;
  changePct: number | null;
  watched: boolean;
}

/** Searchable coin switcher anchored to the focused market in TopBar. */
function MarketSwitcher() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const instrument = instrumentFor(snapshot, snapshot.focus);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<{ network: Network; rows: MarketRow[] } | null>(null);
  const [problem, setProblem] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const popupId = useId();

  const rows = catalog?.network === snapshot.network ? catalog.rows : null;
  const watchedSet = new Set(snapshot.instruments.map((item) => item.symbol));

  const options: SwitcherOption[] = query.trim()
    ? (rows ? matchMarkets(rows, query) : []).slice(0, SWITCHER_LIMIT).map((row) => ({
        symbol: row.symbol,
        base: row.base,
        quote: row.quote,
        price: row.price,
        changePct: row.changePct,
        watched: watchedSet.has(row.symbol),
      }))
    : snapshot.instruments.map((item) => {
        const q = snapshot.quotes[item.symbol];
        return {
          symbol: item.symbol,
          base: item.base,
          quote: item.quote || "USDT",
          price: q?.price ?? null,
          changePct: q?.changePct ?? null,
          watched: true,
        };
      });

  const clampedActive = options.length > 0 ? Math.min(active, options.length - 1) : 0;

  function loadCatalog() {
    if (rows) return;
    const { network } = snapshot;
    request((api) => api.marketOverview())
      .then((list) => {
        setCatalog({ network, rows: list });
        setProblem("");
      })
      .catch((error: unknown) => setProblem(errorText(error)));
  }

  function closeSwitcher(returnFocus = false) {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (returnFocus) triggerRef.current?.focus();
  }

  function pick(symbol: string) {
    closeSwitcher(true);
    if (symbol !== snapshot.focus) void selectSymbol(symbol);
  }

  useLayoutEffect(() => {
    const anchor = triggerRef.current;
    const popup = popupRef.current;
    if (!open || !anchor || !popup) return;
    const rect = anchor.getBoundingClientRect();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - height - 8));
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    popup.style.top = `${Math.round(top)}px`;
    popup.style.left = `${Math.round(left)}px`;
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
        setQuery("");
        setActive(0);
      }
    }
    const dismiss = () => {
      setOpen(false);
      setQuery("");
      setActive(0);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSwitcher(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((clampedActive + step + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[clampedActive];
      if (chosen && !busy) pick(chosen.symbol);
    }
  }

  return (
    <span className="menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="topbar-switcher"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={`Switch market, currently ${instrument.base} / ${instrument.quote || "USDT"}`}
        onClick={() => {
          if (open) {
            closeSwitcher();
          } else {
            setOpen(true);
            setActive(0);
            loadCatalog();
          }
        }}
      >
        <InstrumentMark base={instrument.base} size="sm" />
        <h1 className="topbar-title topbar-symbol">
          {instrument.base}
          <span className="muted"> / {instrument.quote || "USDT"}</span>
        </h1>
        <Icon name="chevronDown" size={15} />
      </button>

      {open ? (
        <div ref={popupRef} id={popupId} className="market-switcher">
          <div className="switcher-search">
            <Icon name="search" size={15} />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              className="switcher-input"
              aria-label="Search markets"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={options[clampedActive] ? `${listId}-${clampedActive}` : undefined}
              placeholder="Switch market…"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                loadCatalog();
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>

          <div className="switcher-caption">{query.trim() ? "Markets" : "Watchlist"}</div>
          <ul id={listId} className="switcher-list" role="listbox" aria-label="Markets">
            {options.map((option, index) => {
              const current = option.symbol === snapshot.focus;
              return (
                <li
                  key={option.symbol}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === clampedActive}
                  data-current={current}
                  className="result"
                  onPointerEnter={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!busy) pick(option.symbol);
                  }}
                >
                  <InstrumentMark base={option.base} size="sm" />
                  <span className="grow truncate">
                    {option.base}
                    <span className="muted"> / {option.quote}</span>
                  </span>
                  <span className="num">{option.price ? price(option.price) : "—"}</span>
                  <span className={`num switcher-chg ${direction(option.changePct)}`}>{percent(option.changePct)}</span>
                  {current ? <Icon name="check" size={14} /> : null}
                </li>
              );
            })}
            {options.length === 0 ? (
              <li className="result-none" role="presentation">
                {problem || (rows ? "No market found" : <span className="spinner" />)}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

interface TopBarProps {
  /** The sidebar is beside the page, so its own header carries the sidebar button. */
  sidebarBeside: boolean;
  sidebarShown: boolean;
  sidebarTriggerRef?: RefObject<HTMLButtonElement | null>;
}

function MarketHeader() {
  const previous = useApp((state) => state.previousPage);
  const backLabel = BACK_LABELS[previous];

  return (
    <div className="topbar-market">
      <button type="button" className="topbar-back" aria-label={`Back to ${backLabel}`} onClick={leaveMarket}>
        <Icon name="back" size={16} />
        <span>{backLabel}</span>
      </button>
      <span className="topbar-sep" aria-hidden="true" />
      <MarketSwitcher />
    </div>
  );
}

export function TopBar({ sidebarBeside, sidebarShown, sidebarTriggerRef }: TopBarProps) {
  const page = useApp((state) => state.page);
  const busy = useBusy();
  return (
    <header className="topbar" data-inset={!sidebarBeside} data-tauri-drag-region>
      {sidebarBeside ? null : (
        <>
          <button
            ref={sidebarTriggerRef}
            type="button"
            className="icon-btn"
            aria-label="Open sidebar"
            aria-expanded={sidebarShown}
            aria-controls="app-sidebar"
            onClick={toggleSidebar}
          >
            <Icon name="sidebar" />
          </button>
          <button type="button" className="icon-btn" aria-label="New chat" disabled={busy} onClick={() => void newThread()}>
            <Icon name="compose" />
          </button>
        </>
      )}
      {page === "chat" ? (
        <ModelMenu />
      ) : page === "market" ? (
        <MarketHeader />
      ) : (
        <h1 className="topbar-title">{TITLES[page]}</h1>
      )}
      <span className="grow drag" data-tauri-drag-region />
      <BusyMark />
      <NetworkMenu />
      <WalletChip />
    </header>
  );
}
