import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Theme, Timeframe } from "../../api/types";
import { BusyMark } from "../../components/BusyMark";
import { Dialog } from "../../components/Dialog";
import { Icon, type IconName } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { Markdown } from "../../lib/markdown";
import { activeWallet } from "../../lib/market";
import {
  type ChartOverlays,
  type SettingsTab,
  cancelQueuedRestart,
  checkForUpdates,
  closeSettings,
  deferUpdate,
  downloadUpdate,
  hasVisibleUpdate,
  installUpdate,
  openExternal,
  openSettings,
  setAutoDownload,
  setChartTimeframe,
  setTheme,
  skipUpdate,
  toggleChartOverlay,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { ModelsTab } from "./ModelsTab";
import { ToolsTab } from "./ToolsTab";
import { TradingTab } from "./TradingTab";
import { WalletTab } from "./WalletTab";

const RELEASES_URL = "https://github.com/kerjakuyco/octo-neo/releases";

interface SettingsItem {
  value: SettingsTab;
  label: string;
  heading: string;
  description: string;
  icon: IconName;
}

interface SettingsGroup {
  id: string;
  label: string;
  items: SettingsItem[];
}

const GROUPS: SettingsGroup[] = [
  {
    id: "assistant",
    label: "Assistant",
    items: [
      {
        value: "models",
        label: "Models",
        heading: "Models",
        description: "Connect cloud or local AI providers and tune reasoning depth.",
        icon: "model",
      },
      {
        value: "tools",
        label: "Tools",
        heading: "Tools & research",
        description: "Control built-in web research and read-only MCP tool servers.",
        icon: "plug",
      },
    ],
  },
  {
    id: "exchange",
    label: "Exchange",
    items: [
      {
        value: "wallet",
        label: "Wallets",
        heading: "Wallets",
        description: "Trade-only API wallets per network. Funds only move when your wallet signs.",
        icon: "wallet",
      },
      {
        value: "trading",
        label: "Risk & Trading",
        heading: "Risk & Trading",
        description: "Leverage limits, margin mode, and mainnet assistant permissions.",
        icon: "trade",
      },
    ],
  },
  {
    id: "app",
    label: "App",
    items: [
      {
        value: "appearance",
        label: "General",
        heading: "General",
        description: "Appearance theme and default Market chart configuration.",
        icon: "appearance",
      },
      {
        value: "about",
        label: "About & Updates",
        heading: "About & Updates",
        description: "Desktop version, GitHub Releases updates, and project links.",
        icon: "info",
      },
    ],
  },
];

const ALL_ITEMS: SettingsItem[] = GROUPS.flatMap((group) => group.items);

const THEME_CARDS: { value: Theme; label: string; desc: string }[] = [
  { value: "system", label: "System", desc: "Matches your OS" },
  { value: "light", label: "Light", desc: "Bright paper surface" },
  { value: "dark", label: "Dark", desc: "Low-glare charcoal" },
];

const TIMEFRAMES: SegmentOption<Timeframe>[] = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const OVERLAY_OPTIONS: { key: keyof ChartOverlays; label: string; desc: string }[] = [
  { key: "ema", label: "EMA 20 / 50", desc: "Short- and medium-term trend moving averages." },
  { key: "ema200", label: "EMA 200", desc: "Long-term macro trend baseline." },
  { key: "bollinger", label: "Bollinger Bands (20, 2σ)", desc: "Volatility envelope around the 20-bar mean." },
  { key: "levels", label: "Support & Resistance", desc: "Key pivot price levels detected from market structure." },
  { key: "orders", label: "Positions & open orders", desc: "Live entry, liquidation, stop-loss, and take-profit lines." },
];

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform ?? "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatReleaseDate(iso: string | null): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday": when the last check finished. */
export function formatCheckedAgo(ts: number | null, now: number): string {
  if (!ts) return "";
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return "just now";
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  return relative.format(-Math.floor(hours / 24), "day");
}

/** The time now, renewed every `ms`, so a relative time stays right while the dialog is open. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function GeneralTab() {
  const { theme } = useSnapshot();
  const busy = useBusy();
  const timeframe = useApp((state) => state.chartTimeframe);
  const overlays = useApp((state) => state.chartOverlays);

  function onThemeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (busy) return;
    const index = THEME_CARDS.findIndex((option) => option.value === theme);
    let nextIndex = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % THEME_CARDS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + THEME_CARDS.length) % THEME_CARDS.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = THEME_CARDS.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = THEME_CARDS[nextIndex];
    if (!next) return;
    void setTheme(next.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  }

  return (
    <div className="settings-stack">
      <section className="settings-section" aria-label="Appearance">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Appearance</h3>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label="Theme" onKeyDown={onThemeKeyDown}>
          {THEME_CARDS.map((option) => {
            const checked = option.value === theme;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className="theme-card"
                disabled={busy}
                onClick={() => {
                  if (!checked) void setTheme(option.value);
                }}
              >
                <span className="theme-preview" data-preview={option.value} aria-hidden="true">
                  <span className="theme-preview-rail" />
                  <span className="theme-preview-body">
                    <span className="theme-preview-bar" />
                    <span className="theme-preview-line" />
                    <span className="theme-preview-line short" />
                  </span>
                </span>
                <span className="theme-card-foot">
                  <span className="theme-card-name">{option.label}</span>
                  <span className="theme-card-desc">{option.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-section" aria-label="Market chart defaults">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Market chart defaults</h3>
          <span className="settings-section-hint">Saved on this device</span>
        </div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-title">Default timeframe</span>
              <span className="settings-row-desc">Candle interval opened when inspecting any market.</span>
            </div>
            <Segmented
              label="Default timeframe"
              value={timeframe}
              options={TIMEFRAMES}
              onChange={(next) => setChartTimeframe(next)}
            />
          </div>
          {OVERLAY_OPTIONS.map((item) => (
            <label key={item.key} className="switch settings-row">
              <span className="settings-row-main">
                <span className="settings-row-title">{item.label}</span>
                <span className="settings-row-desc">{item.desc}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                {...({ switch: "" } as Record<string, string>)}
                checked={overlays[item.key]}
                onChange={() => toggleChartOverlay(item.key)}
              />
              <span className="switch-track" aria-hidden="true" />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

function UpdateCard() {
  const update = useApp((state) => state.update);
  const busy = useBusy();
  const progressId = useId();
  const now = useNow(60_000);
  const { info, status } = update;
  const hasTotal = typeof update.contentLength === "number" && update.contentLength > 0;
  const pct =
    hasTotal && update.contentLength
      ? Math.min(100, Math.round((update.downloaded / update.contentLength) * 100))
      : null;
  const releaseDate = formatReleaseDate(info?.date ?? null);
  const checked = formatCheckedAgo(update.checkedAt, now);
  const isSkipped = Boolean(info && update.skippedVersion === info.version);
  const releaseUrl = info?.releaseUrl ?? RELEASES_URL;
  const selfInstall = Boolean(info?.canInstall) && update.failure !== "install";
  const canCheck = status === "idle" || status === "upToDate" || status === "available";

  return (
    <section className="update-card" aria-label="Software updates" data-status={status}>
      <div className="update-head">
        <div className="update-meta">
          {status === "available" && info ? (
            <>
              <p className="update-title num">OctoNeo {info.version} is available</p>
              <p className="update-sub">
                {releaseDate ? `Released ${releaseDate}` : "A new version is out"}
                {isSkipped ? " · Skipped" : ""}
              </p>
            </>
          ) : status === "downloading" && info ? (
            <>
              <p className="update-title num">Downloading OctoNeo {info.version}</p>
              <p className="update-sub" role="status">
                Checked against the release signature before it installs.
              </p>
            </>
          ) : status === "ready" && info ? (
            <>
              <p className="update-title num" role="status">
                <span className="dot" data-tone="up" />
                OctoNeo {info.version} is ready
              </p>
              <p className="update-sub">
                {update.restartQueued
                  ? "Restarts when the current task is done."
                  : busy
                    ? "OctoNeo can restart by itself when the current task is done."
                    : "Restart to finish. It takes a few seconds."}
              </p>
            </>
          ) : status === "installing" ? (
            <p className="update-title" role="status">
              <span className="spinner" aria-hidden="true" />
              Restarting to update…
            </p>
          ) : status === "checking" ? (
            <p className="update-title" role="status">
              <span className="spinner" aria-hidden="true" />
              Checking for updates…
            </p>
          ) : status === "upToDate" ? (
            <>
              <p className="update-title" role="status">
                OctoNeo is up to date
              </p>
              {checked ? <p className="update-sub">Last checked {checked}</p> : null}
            </>
          ) : status === "error" ? (
            <>
              <p className="update-title">Couldn’t check for updates</p>
              <p className="update-error" role="alert">
                {update.error}
              </p>
            </>
          ) : (
            <>
              <p className="update-title">Updates</p>
              <p className="update-sub">OctoNeo looks for a new version every few hours.</p>
            </>
          )}
        </div>

        {canCheck ? (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void checkForUpdates()}>
            <Icon name="refresh" size={14} />
            Check now
          </button>
        ) : null}
      </div>

      {status === "downloading" ? (
        <div className="update-progress-wrap">
          <label htmlFor={progressId} className="update-progress-meta num">
            <span>
              {hasTotal && update.contentLength
                ? `${formatBytes(update.downloaded)} / ${formatBytes(update.contentLength)}`
                : formatBytes(update.downloaded)}
            </span>
            <span>{pct !== null ? `${pct}%` : "Downloading…"}</span>
          </label>
          <progress
            id={progressId}
            className="update-progress"
            max={hasTotal && update.contentLength ? update.contentLength : undefined}
            value={hasTotal ? update.downloaded : undefined}
          />
        </div>
      ) : null}

      {status === "available" && update.error ? (
        <p className="update-error" role="alert">
          {update.error}
        </p>
      ) : null}

      {status === "available" && info && !selfInstall ? (
        <p className="update-sub">
          {info.canInstall
            ? "Download it from the release page and install it over this copy: your wallet, settings and conversations stay."
            : `This copy of OctoNeo can’t update itself. Download ${info.version} from the release page and install it over this one: your wallet, settings and conversations stay.`}
        </p>
      ) : null}

      {info && (status === "available" || status === "downloading" || status === "ready") && info.notes ? (
        <details className="update-notes">
          <summary>Release notes</summary>
          <div className="update-notes-body">
            <Markdown text={info.notes} onOpenLink={openExternal} />
          </div>
        </details>
      ) : null}

      {status === "available" && info ? (
        <div className="update-actions">
          {selfInstall ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void downloadUpdate()}>
              <Icon name={update.failure === "download" ? "refresh" : "download"} size={14} />
              {update.failure === "download" ? "Try again" : "Download update"}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => openExternal(releaseUrl)}>
              <Icon name="external" size={14} />
              Download from GitHub
            </button>
          )}
          {!selfInstall && info.canInstall ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void downloadUpdate()}>
              Try again
            </button>
          ) : null}
          {!isSkipped && update.failure === "" ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => skipUpdate(info.version)}>
              Skip version
            </button>
          ) : null}
          {selfInstall ? (
            <button type="button" className="link update-ext-link" onClick={() => openExternal(releaseUrl)}>
              Release page
            </button>
          ) : null}
        </div>
      ) : null}

      {status === "ready" ? (
        <div className="update-actions">
          {update.restartQueued ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelQueuedRestart}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void installUpdate()}>
                {busy ? "Restart when done" : "Restart to update"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  deferUpdate();
                  closeSettings();
                }}
              >
                Later
              </button>
            </>
          )}
        </div>
      ) : null}

      {status === "error" ? (
        <div className="update-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void checkForUpdates()}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => openExternal(releaseUrl)}>
            <Icon name="external" size={14} />
            Open the release page
          </button>
        </div>
      ) : null}

      {checked && status !== "upToDate" && status !== "checking" && status !== "error" ? (
        <p className="update-checked">Last checked {checked}</p>
      ) : null}
    </section>
  );
}

/** Whether new versions download by themselves. */
function AutoUpdateRow() {
  const auto = useApp((state) => state.update.auto);
  return (
    <div className="settings-card">
      <label className="switch settings-row">
        <span className="settings-row-main">
          <span className="settings-row-title">Download updates automatically</span>
          <span className="settings-row-desc">New versions download in the background. OctoNeo asks before it restarts.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          {...({ switch: "" } as Record<string, string>)}
          checked={auto}
          onChange={(event) => setAutoDownload(event.currentTarget.checked)}
        />
        <span className="switch-track" aria-hidden="true" />
      </label>
    </div>
  );
}

function AboutTab() {
  const { version } = useSnapshot();
  const links: { label: string; desc: string; url: string }[] = [
    { label: "GitHub Releases", desc: "Installers and release history", url: RELEASES_URL },
    { label: "Source code", desc: "github.com/kerjakuyco/octo-neo", url: "https://github.com/kerjakuyco/octo-neo" },
    { label: "Charts by TradingView", desc: "Lightweight Charts library", url: "https://www.tradingview.com/" },
  ];
  return (
    <div className="settings-stack">
      <div className="settings-hero">
        <div className="settings-hero-main">
          <div className="settings-hero-value">
            <span className="about-name">OctoNeo</span>
            <span className="chip num">v{version}</span>
            <span className="chip">GPL-3.0</span>
          </div>
          <p className="settings-row-desc">Desktop AI trading assistant for perpetual futures.</p>
        </div>
      </div>

      <section className="settings-section" aria-label="Updates">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Updates</h3>
        </div>
        <UpdateCard />
        <AutoUpdateRow />
      </section>

      <section className="settings-section" aria-label="Resources">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Resources</h3>
        </div>
        <ul className="settings-card settings-list">
          {links.map((item) => (
            <li key={item.url}>
              <button type="button" className="settings-link-row" onClick={() => openExternal(item.url)}>
                <span className="settings-row-main">
                  <span className="settings-row-title">{item.label}</span>
                  <span className="settings-row-desc">{item.desc}</span>
                </span>
                <Icon name="external" size={15} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Everything that is set up once, organized into Assistant, Exchange, and App sections. */
export function SettingsDialog() {
  const settings = useApp((state) => state.settings);
  const snapshot = useApp((state) => state.snapshot);
  const update = useApp((state) => state.update);
  const tabIdPrefix = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const tab = settings?.tab ?? "models";
  const activeItem = ALL_ITEMS.find((item) => item.value === tab) ?? ALL_ITEMS[0];
  const showUpdateDot = hasVisibleUpdate(update);
  const wallet = snapshot ? activeWallet(snapshot) : null;
  const serverCount = snapshot?.servers.length ?? 0;
  const modelReady = snapshot?.assistant.ready ?? false;
  const shortcut = useMemo(() => (isMacPlatform() ? "⌘," : "Ctrl+,"), []);

  // Keep the selected tab visible when the rail collapses into a horizontal scroller.
  useEffect(() => {
    if (!settings) return;
    const selected = railRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [settings, tab]);

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = ALL_ITEMS.findIndex((item) => item.value === tab);
    let nextIndex = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % ALL_ITEMS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + ALL_ITEMS.length) % ALL_ITEMS.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = ALL_ITEMS.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = ALL_ITEMS[nextIndex];
    if (!next) return;
    openSettings(next.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  }

  function indicatorFor(value: SettingsTab) {
    if (value === "models" && modelReady) {
      return <span className="settings-nav-dot" data-tone="up" aria-hidden="true" />;
    }
    if (value === "tools" && serverCount > 0) {
      return <span className="settings-nav-count num">{serverCount}</span>;
    }
    if (value === "wallet" && wallet?.connected) {
      return <span className="settings-nav-dot" data-tone={wallet.needsDeposit ? "warn" : "up"} aria-hidden="true" />;
    }
    if (value === "about" && showUpdateDot) {
      return <span className="tab-dot" aria-hidden="true" />;
    }
    return null;
  }

  return (
    <Dialog open={settings !== null} onClose={closeSettings} title="Settings" size="settings" headless>
      {settings && activeItem ? (
        <div className="settings">
          <aside className="settings-rail">
            <div className="settings-rail-head">
              <h2 className="settings-rail-title">Settings</h2>
              <kbd className="settings-kbd" aria-hidden="true">
                {shortcut}
              </kbd>
              <button
                type="button"
                className="icon-btn settings-mobile-close"
                aria-label="Close settings"
                onClick={closeSettings}
              >
                <Icon name="close" />
              </button>
            </div>

            <div
              ref={railRef}
              className="settings-tablist"
              role="tablist"
              aria-label="Settings sections"
              aria-orientation="vertical"
              {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
              onKeyDown={onTabKeyDown}
            >
              {GROUPS.map((group) => (
                <div key={group.id} className="settings-nav-group" role="presentation">
                  <p className="settings-nav-label" aria-hidden="true">
                    {group.label}
                  </p>
                  {group.items.map((item) => {
                    const selected = item.value === tab;
                    return (
                      <button
                        key={item.value}
                        id={`${tabIdPrefix}-${item.value}`}
                        type="button"
                        role="tab"
                        className="settings-tab"
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        {...(selected ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
                        onClick={() => {
                          if (!selected) openSettings(item.value);
                        }}
                      >
                        <Icon name={item.icon} size={16} />
                        <span className="truncate">{item.label}</span>
                        {indicatorFor(item.value)}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {snapshot ? (
              <div className="settings-rail-foot">
                <span className="muted num">OctoNeo v{snapshot.version}</span>
              </div>
            ) : null}
          </aside>

          <div className="settings-main">
            <header className="settings-head">
              <div className="settings-head-text">
                <h2 className="settings-head-title">{activeItem.heading}</h2>
                <p className="settings-head-desc">{activeItem.description}</p>
              </div>
              <BusyMark />
              <button
                type="button"
                className="icon-btn settings-desktop-close"
                aria-label="Close"
                onClick={closeSettings}
              >
                <Icon name="close" />
              </button>
            </header>

            <div
              role="tabpanel"
              className="settings-panel"
              aria-labelledby={`${tabIdPrefix}-${activeItem.value}`}
            >
              {tab === "models" ? <ModelsTab key={settings.setup ?? "list"} setup={settings.setup} /> : null}
              {tab === "tools" ? <ToolsTab /> : null}
              {tab === "wallet" ? <WalletTab /> : null}
              {tab === "trading" ? <TradingTab /> : null}
              {tab === "appearance" ? <GeneralTab /> : null}
              {tab === "about" ? <AboutTab /> : null}
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
