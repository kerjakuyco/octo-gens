import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme, ThreadView } from "../../api/types";
import { Icon, type IconName } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { shortAddress } from "../../lib/format";
import { activeWallet } from "../../lib/market";
import { groupThreads } from "../../lib/threads";
import {
  deleteThread,
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

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
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
      <Icon name={icon} />
      <span className="grow truncate">{label}</span>
      {count ? <span className="nav-count num">{count}</span> : null}
    </button>
  );
}

function ThreadRow({ thread, current, locked }: { thread: ThreadView; current: boolean; locked: boolean }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <li className="thread-row" data-confirm="true">
        <span className="grow truncate">Delete chat?</span>
        <button type="button" className="btn btn-sm btn-danger" disabled={locked} onClick={() => void deleteThread(thread.id)}>
          Delete
        </button>
        <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirming(false)}>
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
      <Menu
        label={`Options for ${thread.title}`}
        triggerClass="icon-btn thread-more"
        trigger={<Icon name="dots" size={16} />}
        align="end"
      >
        <MenuItem icon="trash" tone="danger" label="Delete" onSelect={() => setConfirming(true)} />
      </Menu>
    </li>
  );
}

/** Navigation and conversations. Beside the page on a wide window, over it on a narrow one. */
export function Sidebar({ overlay }: { overlay: boolean }) {
  const snapshot = useSnapshot();
  const page = useApp((state) => state.page);
  // The core refuses to start, open or delete a conversation while a turn is running.
  const locked = useBusy();
  const root = useRef<HTMLElement>(null);
  const groups = useMemo(() => groupThreads(snapshot.threads), [snapshot.threads]);
  const wallet = activeWallet(snapshot);
  const positions = snapshot.account?.positions.length ?? 0;

  // Slid over the page, the sidebar takes focus so the keyboard lands in it.
  useEffect(() => {
    if (overlay) root.current?.querySelector<HTMLElement>(".nav-item")?.focus();
  }, [overlay]);

  return (
    <aside ref={root} className="sidebar" data-overlay={overlay} aria-label="Sidebar">
      <div className="sidebar-head" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          Octo Gens
        </span>
        <span className="grow drag" data-tauri-drag-region />
        <button type="button" className="icon-btn" aria-label="Close sidebar" onClick={toggleSidebar}>
          <Icon name="sidebar" />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        <NavItem icon="compose" label="New chat" disabled={locked} onClick={() => void newThread()} />
        <NavItem icon="chart" label="Markets" current={page === "markets"} onClick={() => navigate("markets")} />
        <NavItem
          icon="account"
          label="Account"
          current={page === "account"}
          count={positions}
          countLabel={positions === 1 ? "open position" : "open positions"}
          onClick={() => navigate("account")}
        />
        <NavItem icon="activity" label="Activity" current={page === "activity"} onClick={() => navigate("activity")} />
      </nav>

      <div className="sidebar-threads">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h2 className="thread-group">{group.label}</h2>
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
          </section>
        ))}
      </div>

      <div className="sidebar-foot">
        <Menu
          triggerClass="nav-item"
          side="top"
          trigger={
            <>
              {wallet.connected ? <span className="dot" data-tone="up" /> : <Icon name="wallet" />}
              <span className="grow truncate num">{wallet.connected ? shortAddress(wallet.user) : "Connect wallet"}</span>
              <Icon name="dots" size={16} />
            </>
          }
        >
          <MenuItem icon="wallet" label="Wallet" onSelect={() => openSettings("wallet")} />
          <MenuItem icon="settings" label="Settings" onSelect={() => openSettings("models")} />
          <div className="menu-sep" role="separator" />
          <div className="menu-label">Theme</div>
          {THEMES.map((theme) => (
            <MenuItem
              key={theme.value}
              label={theme.label}
              checked={snapshot.theme === theme.value}
              onSelect={() => {
                if (snapshot.theme !== theme.value) void setTheme(theme.value);
              }}
            />
          ))}
        </Menu>
      </div>
    </aside>
  );
}
