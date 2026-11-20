import { useId, useMemo } from "react";
import type { Theme } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { type TabOption, Tabs } from "../../components/Tabs";
import { Markdown } from "../../lib/markdown";
import {
  type SettingsTab,
  checkForUpdates,
  closeSettings,
  downloadUpdate,
  hasVisibleUpdate,
  installUpdate,
  openExternal,
  openSettings,
  setTheme,
  skipUpdate,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { ModelsTab } from "./ModelsTab";
import { ToolsTab } from "./ToolsTab";
import { TradingTab } from "./TradingTab";
import { WalletTab } from "./WalletTab";

const RELEASES_URL = "https://github.com/kerjakuyco/octo-neo/releases";

const TABS: TabOption<SettingsTab>[] = [
  { value: "models", label: "Models", icon: "model" },
  { value: "wallet", label: "Wallet", icon: "wallet" },
  { value: "trading", label: "Trading", icon: "trade" },
  { value: "tools", label: "Tools", icon: "plug" },
  { value: "appearance", label: "Appearance", icon: "appearance" },
  { value: "about", label: "About", icon: "info" },
];

const THEMES: SegmentOption<Theme>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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

function formatCheckedTime(ts: number | null): string {
  if (!ts) return "";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(ts));
}

function AppearanceTab() {
  const { theme } = useSnapshot();
  const busy = useBusy();
  return (
    <div className="rows">
      <div className="row">
        <span className="row-name">Theme</span>
        <Segmented label="Theme" value={theme} options={THEMES} disabled={busy} onChange={(next) => void setTheme(next)} />
      </div>
    </div>
  );
}

function UpdateCard() {
  const update = useApp((state) => state.update);
  const busy = useBusy();
  const progressId = useId();
  const { info, status } = update;
  const hasTotal = typeof update.contentLength === "number" && update.contentLength > 0;
  const pct = hasTotal && update.contentLength ? Math.min(100, Math.round((update.downloaded / update.contentLength) * 100)) : null;
  const releaseDate = formatReleaseDate(info?.date ?? null);
  const checkedTime = formatCheckedTime(update.checkedAt);
  const isSkipped = Boolean(info && update.skippedVersion === info.version);

  return (
    <section className="update-card" aria-label="Software updates">
      <div className="update-head">
        <div className="update-meta">
          {status === "available" && info ? (
            <>
              <p className="update-title num">Version {info.version} available</p>
              <p className="update-sub">
                {releaseDate ? `Released ${releaseDate}` : "New GitHub release ready"}
                {isSkipped ? " · Skipped" : ""}
              </p>
            </>
          ) : status === "downloading" && info ? (
            <>
              <p className="update-title num">Downloading version {info.version}</p>
              <p className="update-sub" role="status">
                Verifies the release signature before installing.
              </p>
            </>
          ) : status === "ready" && info ? (
            <>
              <p className="update-title num" role="status">
                <span className="dot" data-tone="up" />
                Version {info.version} ready to install
              </p>
              <p className="update-sub">
                {busy ? "Wait for the active task to finish before restarting." : "Restart OctoNeo to apply the update."}
              </p>
            </>
          ) : status === "installing" && info ? (
            <p className="update-title num" role="status">
              <span className="spinner" aria-hidden="true" />
              Installing version {info.version}…
            </p>
          ) : status === "checking" ? (
            <p className="update-title" role="status">
              <span className="spinner" aria-hidden="true" />
              Checking for updates…
            </p>
          ) : status === "upToDate" ? (
            <>
              <p className="update-title" role="status">
                You are up to date
              </p>
              {checkedTime ? <p className="update-sub num">Last checked at {checkedTime}</p> : null}
            </>
          ) : status === "error" ? (
            <>
              <p className="update-title">Update check failed</p>
              <p className="update-error" role="alert">
                {update.error}
              </p>
            </>
          ) : (
            <>
              <p className="update-title">Updates</p>
              <p className="update-sub">Checks GitHub Releases for newer desktop builds.</p>
            </>
          )}
        </div>

        {status === "idle" || status === "upToDate" ? (
          <button type="button" className="btn btn-sm" onClick={() => void checkForUpdates()}>
            <Icon name="refresh" size={14} />
            Check for updates
          </button>
        ) : null}
      </div>

      {status === "downloading" ? (
        <div className="update-progress-wrap">
          <label htmlFor={progressId} className="update-progress-meta num">
            <span>{hasTotal && update.contentLength ? `${formatBytes(update.downloaded)} / ${formatBytes(update.contentLength)}` : formatBytes(update.downloaded)}</span>
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

      {info && (status === "available" || status === "ready") && info.notes ? (
        <details className="update-notes">
          <summary>Release notes</summary>
          <div className="update-notes-body">
            <Markdown text={info.notes} onOpenLink={openExternal} />
          </div>
        </details>
      ) : null}

      {status === "available" && info && !info.canInstall ? (
        <p className="update-sub">
          In-app install is not available for this build. Download the installer directly from GitHub Releases.
        </p>
      ) : null}

      {status === "available" && info ? (
        <div className="update-actions">
          {info.canInstall ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void downloadUpdate()}>
              <Icon name="download" size={14} />
              Download update
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => openExternal(info.releaseUrl)}>
              <Icon name="external" size={14} />
              Download on GitHub
            </button>
          )}
          {!isSkipped ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => skipUpdate(info.version)}>
              Skip version
            </button>
          ) : null}
          {info.canInstall ? (
            <button type="button" className="link update-ext-link" onClick={() => openExternal(info.releaseUrl)}>
              GitHub release
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void checkForUpdates()}>
              Check again
            </button>
          )}
        </div>
      ) : null}

      {status === "ready" ? (
        <div className="update-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void installUpdate()}>
            Restart to update
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={closeSettings}>
            Later
          </button>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="update-actions">
          {info?.canInstall ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void downloadUpdate()}>
              Retry download
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => void checkForUpdates()}>
              Try again
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => openExternal(info?.releaseUrl ?? RELEASES_URL)}
          >
            <Icon name="external" size={14} />
            Open GitHub Releases
          </button>
        </div>
      ) : null}
    </section>
  );
}

function AboutTab() {
  const { version } = useSnapshot();
  const links: [label: string, url: string][] = [
    ["Releases", RELEASES_URL],
    ["Source code", "https://github.com/kerjakuyco/octo-neo"],
    ["Charts by TradingView", "https://www.tradingview.com/"],
  ];
  return (
    <div className="about">
      <div>
        <p className="about-name">OctoNeo</p>
        <p className="muted num">Version {version}</p>
      </div>
      <UpdateCard />
      <ul className="about-links">
        {links.map(([label, url]) => (
          <li key={url}>
            <button type="button" className="link" onClick={() => openExternal(url)}>
              {label}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">GPL-3.0</p>
    </div>
  );
}

/** Everything that is set up once: models, wallets, limits, tool servers and the theme. */
export function SettingsDialog() {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.update);
  const panelId = useId();
  const tab = settings?.tab ?? "models";
  const showUpdateDot = hasVisibleUpdate(update);
  const tabs = useMemo(
    () => TABS.map((item) => (item.value === "about" && showUpdateDot ? { ...item, dot: true } : item)),
    [showUpdateDot],
  );

  return (
    <Dialog open={settings !== null} onClose={closeSettings} title="Settings" size="settings">
      {settings ? (
        <div className="settings">
          <Tabs
            vertical
            label="Settings"
            value={tab}
            options={tabs}
            onChange={(next) => openSettings(next)}
            panelId={panelId}
          />
          <div
            id={panelId}
            role="tabpanel"
            className="settings-panel"
            aria-label={TABS.find((item) => item.value === tab)?.label}
          >
            {tab === "models" ? <ModelsTab key={settings.setup ?? "list"} setup={settings.setup} /> : null}
            {tab === "wallet" ? <WalletTab /> : null}
            {tab === "trading" ? <TradingTab /> : null}
            {tab === "tools" ? <ToolsTab /> : null}
            {tab === "appearance" ? <AppearanceTab /> : null}
            {tab === "about" ? <AboutTab /> : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
