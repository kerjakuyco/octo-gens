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
    <li className="row" data-lines={2}>
      <div className="row-main">
        <span className="row-name">
          {provider.name}
          {current ? (
            <span className="chip" data-tone="up">
              In use
            </span>
          ) : null}
        </span>
        <span className="row-sub truncate">{model || providerPlace(provider)}</span>
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

  return (
    <div className="rows">
      <ul className="row-list">
        {assistant.providers.map((item) => {
          const current = item.id === assistant.provider;
          const model = isConnected(item) ? (current ? activeModel(assistant) : modelName(item.model)) : "";
          return (
            <ProviderRow key={item.id} provider={item} model={model} current={current} onSetup={() => setEditing(item.id)} />
          );
        })}
      </ul>
      {assistant.reasoning ? (
        <div className="row">
          <span className="row-name">Reasoning effort</span>
          <Segmented
            label="Reasoning effort"
            value={assistant.effort}
            options={EFFORTS}
            disabled={busy}
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
      ) : null}
    </div>
  );
}
