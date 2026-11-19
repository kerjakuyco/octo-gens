import type { Network } from "../../api/types";
import { BusyMark } from "../../components/BusyMark";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { money } from "../../lib/format";
import { activeWallet } from "../../lib/market";
import { activeModel, isConnected, modelName } from "../../lib/models";
import { fundsNote, networkName } from "../../lib/network";
import {
  type Page,
  navigate,
  newThread,
  openSettings,
  setNetwork,
  switchModel,
  togglePanel,
  toggleSidebar,
  useApp,
  useBusy,
  useSnapshot,
} from "../../state/app";

const TITLES: Record<Exclude<Page, "chat">, string> = {
  markets: "Markets",
  account: "Account",
  activity: "Activity",
};

/** Practice first: it is where a new trader should start. */
const NETWORK_ORDER: Network[] = ["testnet", "mainnet"];

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

interface TopBarProps {
  /** The sidebar is beside the page, so its own header carries the sidebar button. */
  sidebarBeside: boolean;
  panelShown: boolean;
}

export function TopBar({ sidebarBeside, panelShown }: TopBarProps) {
  const page = useApp((state) => state.page);
  const busy = useBusy();
  return (
    <header className="topbar" data-inset={!sidebarBeside} data-tauri-drag-region>
      {sidebarBeside ? null : (
        <>
          <button type="button" className="icon-btn" aria-label="Open sidebar" onClick={toggleSidebar}>
            <Icon name="sidebar" />
          </button>
          <button type="button" className="icon-btn" aria-label="New chat" disabled={busy} onClick={() => void newThread()}>
            <Icon name="compose" />
          </button>
        </>
      )}
      {page === "chat" ? <ModelMenu /> : <h1 className="topbar-title">{TITLES[page]}</h1>}
      <span className="grow drag" data-tauri-drag-region />
      <BusyMark />
      <NetworkMenu />
      <WalletChip />
      <button
        type="button"
        className="icon-btn"
        aria-label="Market panel"
        aria-pressed={panelShown}
        onClick={togglePanel}
      >
        <Icon name="panel" />
      </button>
    </header>
  );
}
