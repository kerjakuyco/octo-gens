import { type FormEvent, useEffect, useState } from "react";
import type { Effort, Provider, Theme } from "../../api/types";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import {
  errorText,
  notify,
  openExternal,
  request,
  saveAssistant,
  setTheme,
  useApp,
  useSnapshot,
} from "../../state/app";
import { ModelBrowser, type ModelsState } from "./ModelBrowser";

const PROVIDERS: SegmentOption<Provider>[] = [
  { value: "builtin", label: "Built-in agents" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama, local" },
];

const PROVIDER_NOTES: Record<Provider, string> = {
  builtin:
    "Rule-based agents that run on this computer. They answer quote, comparison, portfolio and order commands with no model and no key.",
  openrouter:
    "Any chat model on OpenRouter. With a tool-calling model the assistant plans its own research. OpenRouter bills you for what it uses.",
  ollama:
    "A model running on this computer through Ollama. It explains the readings the built-in agents gather, and nothing leaves your machine.",
};

const EFFORTS: SegmentOption<Effort>[] = [
  { value: "auto", label: "Model default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const THEMES: SegmentOption<Theme>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsPage() {
  const snapshot = useSnapshot();
  const saved = snapshot.assistant;
  const busy = useApp((state) => Boolean(state.working) || Boolean(state.live));

  const [provider, setProvider] = useState<Provider>(saved.provider);
  const [key, setKey] = useState("");
  const [routerModel, setRouterModel] = useState(saved.provider === "openrouter" ? saved.model : "");
  const [localModel, setLocalModel] = useState(saved.provider === "ollama" ? saved.model : "");
  const [effort, setEffort] = useState<Effort>(saved.effort);
  const [liveTickets, setLiveTickets] = useState(saved.liveTickets);
  const [models, setModels] = useState<ModelsState>({ status: "idle", models: [], error: "" });
  const [attempt, setAttempt] = useState(0);

  const wantsCatalog = provider === "openrouter";
  useEffect(() => {
    if (!wantsCatalog) return;
    let alive = true;
    request((api) => api.listModels())
      .then((list) => {
        if (alive) setModels({ status: "ready", models: list, error: "" });
      })
      .catch((error: unknown) => {
        if (alive) setModels({ status: "failed", models: [], error: errorText(error) });
      });
    return () => {
      alive = false;
    };
  }, [wantsCatalog, attempt]);

  const info = models.models.find((model) => model.id === routerModel);
  const isSavedModel = saved.provider === "openrouter" && saved.model === routerModel;
  const supportsReasoning = info ? info.reasoning : isSavedModel && saved.reasoning;
  const supportsTools = info ? info.tools : !isSavedModel || saved.tools;

  let missing = "";
  if (provider === "openrouter" && !saved.hasKey && !key.trim()) missing = "Paste your OpenRouter key to save.";
  else if (provider === "openrouter" && !routerModel) missing = "Choose a model from the list to save.";
  else if (provider === "ollama" && !localModel.trim()) missing = "Enter the Ollama model tag to save.";

  const model = provider === "openrouter" ? routerModel : provider === "ollama" ? localModel.trim() : "";
  const dirty =
    provider !== saved.provider ||
    model !== saved.model ||
    liveTickets !== saved.liveTickets ||
    (supportsReasoning && effort !== saved.effort) ||
    key.trim() !== "";

  async function save(event: FormEvent) {
    event.preventDefault();
    const ok = await saveAssistant({
      provider,
      model,
      key: key.trim() || undefined,
      effort: supportsReasoning ? effort : "auto",
      liveTickets,
    });
    if (ok) {
      setKey("");
      notify("Assistant settings saved.");
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Settings</h1>
        <p className="page-lead">Choose who answers, what it is allowed to draft, and how the app looks.</p>

        <form className="section" aria-labelledby="assistant-title" onSubmit={(event) => void save(event)}>
          <div className="section-head">
            <h2 id="assistant-title" className="section-title">
              Assistant
            </h2>
          </div>

          <div className="settings-row">
            <div className="settings-label">Who answers</div>
            <div className="settings-control">
              <Segmented label="Assistant provider" value={provider} options={PROVIDERS} onChange={setProvider} />
              <p className="field-help">{PROVIDER_NOTES[provider]}</p>
            </div>
          </div>

          {provider === "openrouter" ? (
            <>
              <div className="settings-row">
                <label className="settings-label" htmlFor="openrouter-key">
                  OpenRouter key
                  <small>{saved.hasKey ? "A key is saved." : "No key saved yet."}</small>
                </label>
                <div className="settings-control">
                  <div className="key-row">
                    <input
                      id="openrouter-key"
                      className="input input-code"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={saved.hasKey ? "Paste a new key to replace the saved one" : "sk-or-…"}
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                    />
                    <button type="button" className="link" onClick={() => openExternal("https://openrouter.ai/keys")}>
                      Get a key at openrouter.ai
                    </button>
                  </div>
                  <p className="field-help">
                    The key is kept on this computer, is never shown again, and is left out of every conversation and
                    run record.
                  </p>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-label">
                  Model
                  <small>{routerModel ? routerModel : "None chosen."}</small>
                </div>
                <div className="settings-control">
                  <ModelBrowser
                    state={models}
                    selected={routerModel}
                    onSelect={(next) => setRouterModel(next.id)}
                    onReload={() => {
                      setModels({ status: "loading", models: [], error: "" });
                      setAttempt((value) => value + 1);
                    }}
                  />
                  {routerModel && !supportsTools ? (
                    <p className="field-help">
                      This model cannot call tools. The built-in agents will gather the readings and the model will
                      only explain them. Pick a tool-calling model for the full assistant.
                    </p>
                  ) : null}
                </div>
              </div>

              {supportsReasoning ? (
                <div className="settings-row">
                  <div className="settings-label">
                    Reasoning effort
                    <small>More effort means slower, costlier answers.</small>
                  </div>
                  <div className="settings-control">
                    <Segmented label="Reasoning effort" value={effort} options={EFFORTS} onChange={setEffort} />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {provider === "ollama" ? (
            <div className="settings-row">
              <label className="settings-label" htmlFor="ollama-model">
                Model tag
              </label>
              <div className="settings-control">
                <input
                  id="ollama-model"
                  className="input input-code"
                  placeholder="qwen3:4b"
                  spellCheck={false}
                  value={localModel}
                  onChange={(event) => setLocalModel(event.target.value)}
                />
                <p className="field-help">
                  Use a name from <span className="mono">ollama list</span>. Ollama must be running on this computer.
                </p>
              </div>
            </div>
          ) : null}

          <div className="settings-row">
            <div className="settings-label" id="live-tickets-label">
              Live tickets
            </div>
            <div className="settings-control">
              <div className="switch-row">
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={liveTickets}
                  aria-labelledby="live-tickets-label"
                  onClick={() => setLiveTickets((value) => !value)}
                />
                <div className="switch-text">
                  The assistant may draft live exchange tickets
                  <small>
                    Off, it drafts paper tickets only. On, it may draft a live market order for a venue that has API
                    keys. Either way nothing is sent until you confirm the ticket yourself.
                  </small>
                </div>
              </div>
            </div>
          </div>

          <div className="save-bar">
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty || Boolean(missing)}>
              Save assistant settings
            </button>
            <span className="section-note" role="status">
              {missing || (dirty ? "You have unsaved changes." : "")}
            </span>
          </div>
        </form>

        <section className="section" aria-labelledby="appearance-title">
          <div className="section-head">
            <h2 id="appearance-title" className="section-title">
              Appearance
            </h2>
          </div>
          <div className="settings-row">
            <div className="settings-label">Theme</div>
            <div className="settings-control">
              <Segmented label="Theme" value={snapshot.theme} options={THEMES} onChange={(theme) => void setTheme(theme)} />
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="about-title">
          <div className="section-head">
            <h2 id="about-title" className="section-title">
              About
            </h2>
          </div>
          <div className="settings-row">
            <div className="settings-label">Octo Gens</div>
            <div className="settings-control">
              <p>Version {snapshot.version}</p>
              <p className="field-help">
                Free software under the GPL-3.0 license. Nothing here is financial advice, and paper results do not
                predict live ones.
              </p>
              <p className="field-help">
                Charts are drawn with Lightweight Charts by{" "}
                <button type="button" className="link" onClick={() => openExternal("https://www.tradingview.com/")}>
                  TradingView
                </button>
                .
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
