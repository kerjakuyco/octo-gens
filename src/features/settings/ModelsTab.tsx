import { useState } from "react";
import type { Effort, Provider, ProviderView } from "../../api/types";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { activeModel, isConnected, modelName, providerOf, providerPlace } from "../../lib/models";
import { closeSettings, forgetProvider, saveAssistant, switchModel, useBusy, useSnapshot } from "../../state/app";
import { ModelSetup } from "./ModelSetup";

const EFFORTS: SegmentOption<Effort>[] = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

interface ProviderRowProps {
  provider: ProviderView;
  /** The model this provider would answer with, or empty when it is not connected. */
  model: string;
  current: boolean;
  onSetup: () => void;
}

function ProviderRow({ provider, model, current, onSetup }: ProviderRowProps) {
  const busy = useBusy();
  const [leaving, setLeaving] = useState(false);

  let actions;
  if (leaving) {
    actions = (
      <>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => void forgetProvider(provider.id).then(() => setLeaving(false))}
        >
          Disconnect
        </button>
        <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setLeaving(false)}>
          Cancel
        </button>
      </>
    );
  } else if (model) {
    actions = (
      <>
        {current ? null : (
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void switchModel(provider)}>
            Use
          </button>
        )}
        <button type="button" className="btn btn-sm btn-secondary" onClick={onSetup}>
          Change
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setLeaving(true)}>
          Disconnect
        </button>
      </>
    );
  } else {
    actions = (
      <button type="button" className="btn btn-sm btn-secondary" onClick={onSetup}>
        Connect
      </button>
    );
  }

  return (
    <li className="settings-row" data-active={current || undefined}>
      <div className="settings-row-main">
        <span className="settings-row-title">
          {provider.name}
          {current ? (
            <span className="chip" data-tone="up">
              Active
            </span>
          ) : model ? (
            <span className="chip">Ready</span>
          ) : null}
        </span>
        <span className="settings-row-desc truncate">{model || providerPlace(provider)}</span>
      </div>
      <div className="row-actions">{actions}</div>
    </li>
  );
}

/**
 * The model providers. `setup` opens straight on one of them, as the tiles on
 * an empty chat do; connecting then closes Settings, so the trader lands back
 * in the chat.
 */
export function ModelsTab({ setup }: { setup: Provider | null }) {
  const { assistant } = useSnapshot();
  const busy = useBusy();
  const [editing, setEditing] = useState<Provider | null>(setup);
  const provider = editing ? providerOf(assistant, editing) : undefined;

  if (provider) {
    return (
      <ModelSetup
        provider={provider}
        onBack={() => setEditing(null)}
        onDone={() => {
          if (setup) closeSettings();
          else setEditing(null);
        }}
      />
    );
  }

  const activeProvider = providerOf(assistant, assistant.provider);
  const cloud = assistant.providers.filter((item) => !item.local);
  const local = assistant.providers.filter((item) => item.local);

  function renderGroup(title: string, hint: string, items: ProviderView[]) {
    if (items.length === 0) return null;
    return (
      <section className="settings-section" aria-label={title}>
        <div className="settings-section-head">
          <h3 className="settings-section-title">{title}</h3>
          <span className="settings-section-hint">{hint}</span>
        </div>
        <ul className="settings-card settings-list">
          {items.map((item) => {
            const current = item.id === assistant.provider;
            const model = isConnected(item) ? (current ? activeModel(assistant) : modelName(item.model)) : "";
            return (
              <ProviderRow key={item.id} provider={item} model={model} current={current} onSetup={() => setEditing(item.id)} />
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <div className="settings-stack">
      <div className="settings-hero" data-connected={assistant.ready || undefined}>
        <div className="settings-hero-main">
          <span className="settings-hero-label">Active model</span>
          {assistant.ready && activeProvider ? (
            <div className="settings-hero-value">
              <span className="dot" data-tone="up" />
              <span className="truncate">{activeModel(assistant)}</span>
              <span className="chip">{activeProvider.name}</span>
              {assistant.reasoning ? <span className="chip">Reasoning</span> : null}
            </div>
          ) : (
            <p className="settings-hero-empty">No model connected yet. Choose a cloud or local provider below.</p>
          )}
        </div>
        {assistant.ready && activeProvider ? (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(activeProvider.id)}>
            Switch model
          </button>
        ) : null}
      </div>

      {renderGroup("Cloud providers", "Hosted APIs via key or gateway", cloud)}
      {renderGroup("Local servers", "Private models on this computer", local)}

      <section className="settings-section" aria-label="Behavior">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Behavior</h3>
        </div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-title">Reasoning effort</span>
              <span className="settings-row-desc">
                {assistant.reasoning
                  ? "Controls how deeply the active model thinks before answering."
                  : "Available when a reasoning-capable model is active."}
              </span>
            </div>
            <Segmented
              label="Reasoning effort"
              value={assistant.effort}
              options={EFFORTS}
              disabled={busy || !assistant.reasoning}
              onChange={(effort) =>
                void saveAssistant({
                  provider: assistant.provider,
                  model: assistant.model,
                  effort,
                  liveTickets: assistant.liveTickets,
                })
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}
