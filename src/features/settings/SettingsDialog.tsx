import { useId } from "react";
import type { Theme } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { type TabOption, Tabs } from "../../components/Tabs";
import {
  type SettingsTab,
  closeSettings,
  openExternal,
  openSettings,
  setTheme,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";
import { ModelsTab } from "./ModelsTab";
import { ToolsTab } from "./ToolsTab";
import { TradingTab } from "./TradingTab";
import { WalletTab } from "./WalletTab";

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

function AboutTab() {
  const { version } = useSnapshot();
  const links: [label: string, url: string][] = [
    ["Source code", "https://github.com/kerjakuyco/octo-neo"],
    ["Charts by TradingView", "https://www.tradingview.com/"],
  ];
  return (
    <div className="about">
      <div>
        <p className="about-name">OctoNeo</p>
        <p className="muted num">Version {version}</p>
      </div>
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
  const panelId = useId();
  const tab = settings?.tab ?? "models";

  return (
    <Dialog open={settings !== null} onClose={closeSettings} title="Settings" size="settings">
      {settings ? (
        <div className="settings">
          <Tabs
            vertical
            label="Settings"
            value={tab}
            options={TABS}
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
