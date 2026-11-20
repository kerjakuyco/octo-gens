import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Theme, ThreadView } from "../../api/types";
import { Icon, type IconName } from "../../components/Icon";
import { shortAddress } from "../../lib/format";
import { activeWallet } from "../../lib/market";
import { networkName } from "../../lib/network";
import { useResolvedTheme } from "../../lib/theme";
import { filterThreads, groupThreads } from "../../lib/threads";
import {
  deleteThread,
  hasVisibleUpdate,
  navigate,
  newThread,
  openSettings,
  openThread,
  setTheme,
  toggleSidebar,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";

const THEMES: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

interface NavItemProps {
  icon: IconName;
  label: string;
  current?: boolean;
  /** A small count after the label, and what it counts. */
  count?: number;
  countLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}

function NavItem({ icon, label, current = false, count, countLabel, disabled, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={current ? "page" : undefined}
      aria-label={count ? `${label}, ${count} ${countLabel ?? ""}`.trim() : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={17} />
      <span className="grow truncate">{label}</span>
      {count ? <span className="nav-count num">{count}</span> : null}
    </button>
  );
}

interface ThemeSwitchProps {
  value: Theme;
  resolved: "light" | "dark";
  disabled: boolean;
  onChange: (theme: Theme) => void;
}

/** Compact three-state theme selector with radiogroup semantics and arrow-key navigation. */
function ThemeSwitch({ value, resolved, disabled, onChange }: ThemeSwitchProps) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    let nextIndex = -1;
    const index = THEMES.findIndex((option) => option.value === value);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % THEMES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + THEMES.length) % THEMES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = THEMES.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = THEMES[nextIndex];
    if (!next) return;
    onChange(next.value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons[nextIndex]?.focus();
  }

  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown}>
      {THEMES.map((option) => {
        const checked = option.value === value;
        const name = option.value === "system" ? `System theme (currently ${resolved})` : `${option.label} theme`;
        const hint = option.value === "system" ? `System (${resolved})` : option.label;
        return (
          <button
            key={option.value}
            type="button"
            className="theme-option"
            role="radio"
            aria-checked={checked}
            aria-label={name}
            title={hint}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            <Icon name={option.icon} size={14} />
          </button>
        );
      })}
    </div>
  );
}

function ThreadRow({ thread, current, locked }: { thread: ThreadView; current: boolean; locked: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const deleteBtn = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocus = useRef(false);

  useEffect(() => {
    if (!confirming && restoreDeleteFocus.current) {
      restoreDeleteFocus.current = false;
      deleteBtn.current?.focus();
    }
  }, [confirming]);

  function cancelConfirm() {
    restoreDeleteFocus.current = true;
    setConfirming(false);
  }

  if (confirming) {
    return (
      <li
        className="thread-row"
        data-confirm="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelConfirm();
          }
        }}
      >
        <span className="grow truncate">Delete?</span>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={locked}
          onClick={() => void deleteThread(thread.id)}
        >
          Delete
        </button>
        <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={cancelConfirm}>
          Cancel
        </button>
      </li>
    );
  }

  return (
    <li className="thread-row" data-current={current}>
      <button
        type="button"
        className="thread-link"
        aria-current={current ? "page" : undefined}
        disabled={locked && !current}
        onClick={() => void openThread(thread.id)}
      >
        <span className="truncate">{thread.title}</span>
      </button>
      <button
        ref={deleteBtn}
        type="button"
        className="icon-btn thread-delete"
        aria-label={`Delete ${thread.title}`}
        disabled={locked}
        onClick={() => setConfirming(true)}
      >
        <Icon name="trash" size={15} />
      </button>
    </li>
  );
}

interface SidebarProps {
  /** Slid over the page on a narrow window instead of docked beside it. */
  overlay: boolean;
  /** Whether the overlay drawer is currently open. Always true when docked inline. */
  open?: boolean;
}

/** Navigation, conversations and footer controls. Docked beside the page on a wide window, animated drawer on a narrow one. */
export function Sidebar({ overlay, open = true }: SidebarProps) {
  const snapshot = useSnapshot();
  const page = useApp((state) => state.page);
  const update = useApp((state) => state.update);
  // The core refuses to start, open or delete a conversation while a turn is running.
  const locked = useBusy();
  const resolvedTheme = useResolvedTheme(snapshot.theme);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchInputId = useId();

  const hasThreads = snapshot.threads.length > 0;
  const activeQuery = searchOpen && hasThreads ? query : "";
  const visibleThreads = useMemo(() => filterThreads(snapshot.threads, activeQuery), [snapshot.threads, activeQuery]);
  const groups = useMemo(() => groupThreads(visibleThreads), [visibleThreads]);
  const wallet = activeWallet(snapshot);
  const positions = snapshot.account?.positions.length ?? 0;

  // When opened as a drawer, move keyboard focus straight to the close control without scrolling.
  useEffect(() => {
    if (overlay && open) closeButton.current?.focus({ preventScroll: true });
  }, [overlay, open]);

  useEffect(() => {
    if (searchOpen && hasThreads) searchInput.current?.focus();
  }, [searchOpen, hasThreads]);

  const hidden = overlay && !open;
  const walletTone = wallet.connected ? (wallet.needsDeposit ? "warn" : "up") : undefined;
  const showUpdate = hasVisibleUpdate(update);
  const downloadPct =
    update.status === "downloading" && update.contentLength && update.contentLength > 0
      ? Math.min(100, Math.round((update.downloaded / update.contentLength) * 100))
      : null;

  return (
    <aside
      id="app-sidebar"
      className="sidebar"
      data-overlay={overlay}
      data-open={open}
      role={overlay && open ? "dialog" : undefined}
      aria-modal={overlay && open ? true : undefined}
      aria-hidden={hidden ? true : undefined}
      aria-label="Sidebar"
      inert={hidden ? true : undefined}
    >
      <div className="sidebar-head" data-tauri-drag-region>
        <span className="grow drag" data-tauri-drag-region />
        <button
          ref={closeButton}
          type="button"
          className="icon-btn"
          aria-label="Close sidebar"
          onClick={toggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      <div className="sidebar-primary">
        <button type="button" className="sidebar-cta" disabled={locked} onClick={() => void newThread()}>
          <Icon name="compose" size={16} />
          <span className="truncate">New chat</span>
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Workspace">
        <ul>
          <li>
            <NavItem
              icon="chart"
              label="Markets"
              current={page === "markets" || page === "market"}
              onClick={() => navigate("markets")}
            />
          </li>
          <li>
            <NavItem
              icon="account"
              label="Account"
              current={page === "account"}
              count={positions}
              countLabel={positions === 1 ? "open position" : "open positions"}
              onClick={() => navigate("account")}
            />
          </li>
          <li>
            <NavItem icon="activity" label="Activity" current={page === "activity"} onClick={() => navigate("activity")} />
          </li>
        </ul>
      </nav>

      <div className="sidebar-threads-wrap">
        <div className="threads-head">
          <h2 className="threads-title">Chats</h2>
          {hasThreads ? (
            <button
              ref={searchToggle}
              type="button"
              className="icon-btn threads-search-btn"
              aria-label={searchOpen ? "Close chat filter" : "Filter chats"}
              aria-expanded={searchOpen}
              aria-controls={searchOpen ? searchInputId : undefined}
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false);
                  setQuery("");
                } else {
                  setSearchOpen(true);
                }
              }}
            >
              <Icon name={searchOpen ? "close" : "search"} size={15} />
            </button>
          ) : null}
        </div>

        {searchOpen && hasThreads ? (
          <div className="threads-filter">
            <Icon name="search" size={14} />
            <input
              ref={searchInput}
              id={searchInputId}
              type="search"
              className="threads-filter-input"
              placeholder="Filter chats"
              aria-label="Filter chats"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                if (query) {
                  setQuery("");
                } else {
                  setSearchOpen(false);
                  searchToggle.current?.focus();
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="threads-filter-clear"
                aria-label="Clear filter"
                onClick={() => {
                  setQuery("");
                  searchInput.current?.focus();
                }}
              >
                <Icon name="close" size={13} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="sidebar-threads">
          {groups.length > 0 ? (
            groups.map((group) => (
              <div key={group.label} className="thread-section">
                <h3 className="thread-group">{group.label}</h3>
                <ul>
                  {group.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      current={page === "chat" && thread.id === snapshot.thread}
                      locked={locked}
                    />
                  ))}
                </ul>
              </div>
            ))
          ) : !hasThreads ? (
            <p className="threads-empty">No conversations yet</p>
          ) : (
            <div className="threads-empty">
              <p>No matching chats</p>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setQuery("");
                  searchInput.current?.focus();
                }}
              >
                Clear filter
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="sidebar-foot">
        {showUpdate ? (
          <button
            type="button"
            className="foot-update"
            data-status={update.status}
            onClick={() => openSettings("about")}
          >
            {update.status === "downloading" || update.status === "installing" ? (
              <span className="spinner" aria-hidden="true" />
            ) : update.status === "ready" ? (
              <span className="dot" data-tone="up" />
            ) : (
              <Icon name="download" size={15} />
            )}
            <span className="grow truncate num">
              {update.status === "downloading"
                ? downloadPct !== null
                  ? `Downloading ${downloadPct}%`
                  : "Downloading update"
                : update.status === "installing"
                  ? "Installing update"
                  : update.status === "ready"
                    ? `Restart for v${update.info?.version ?? ""}`
                    : `Update v${update.info?.version ?? ""}`}
            </span>
            {update.status === "available" ? (
              <span className="foot-badge" data-tone="info">
                New
              </span>
            ) : (
              <Icon name="chevron" size={14} />
            )}
          </button>
        ) : null}

        <button type="button" className="foot-wallet" onClick={() => openSettings("wallet")}>
          {wallet.connected ? <span className="dot" data-tone={walletTone} /> : <Icon name="wallet" size={16} />}
          <span className="grow truncate num">{wallet.connected ? shortAddress(wallet.user) : "Connect wallet"}</span>
          {wallet.connected ? (
            <span className="foot-badge" data-tone={wallet.needsDeposit ? "warn" : undefined}>
              {wallet.needsDeposit ? "Deposit" : networkName(snapshot.network)}
            </span>
          ) : (
            <Icon name="chevron" size={14} />
          )}
        </button>

        <div className="foot-bar">
          <button type="button" className="foot-btn" onClick={() => openSettings("models")}>
            <Icon name="settings" size={16} />
            <span className="truncate">Settings</span>
          </button>

          <ThemeSwitch
            value={snapshot.theme}
            resolved={resolvedTheme}
            disabled={locked}
            onChange={(next) => {
              if (snapshot.theme !== next) void setTheme(next);
            }}
          />
        </div>
      </footer>
    </aside>
  );
}
