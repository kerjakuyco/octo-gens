import { type FormEvent, type ReactNode, useState } from "react";
import type { AssistantRequest, ModelInfo, ProviderView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { contextSize, plural, tokenPrice } from "../../lib/format";
import { useDebounced, useRead } from "../../lib/hooks";
import { isNotRunning, startHint } from "../../lib/models";
import { openExternal, request, saveAssistant, useBusy, useSnapshot } from "../../state/app";

interface SetupProps {
  provider: ProviderView;
  onBack: () => void;
  /** Called once a model is connected. */
  onDone: () => void;
}

/** Saves a model for this provider, keeping the settings that are not the provider's own. */
function useConnect(provider: ProviderView, onDone: () => void) {
  const { assistant } = useSnapshot();
  return async (model: string, extra: Partial<AssistantRequest> = {}): Promise<void> => {
    const saved = await saveAssistant({
      provider: provider.id,
      model,
      effort: assistant.effort,
      liveTickets: assistant.liveTickets,
      ...extra,
    });
    if (saved) onDone();
  };
}

/** Context size and price, as far as the provider tells. */
function modelFacts(model: ModelInfo): string {
  const facts: string[] = [];
  if (model.context > 0) facts.push(contextSize(model.context));
  if (model.free) facts.push("Free");
  else if (model.promptPrice !== null && model.completionPrice !== null) {
    facts.push(`${tokenPrice(model.promptPrice)} / ${tokenPrice(model.completionPrice)}`);
  }
  return facts.join(" · ");
}

interface ModelListProps {
  models: ModelInfo[];
  /** The model this provider already answers with. */
  current: string;
  searchable?: boolean;
  /** What the figures on the right of each row are, said once above them. */
  caption?: string;
  /** Kept under the list while it scrolls. */
  footer?: ReactNode;
  onPick: (model: ModelInfo) => void;
}

/** Models to choose from. One that cannot call tools is listed but cannot be picked. */
function ModelList({ models, current, searchable = false, caption, footer, onPick }: ModelListProps) {
  const busy = useBusy();
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const shown = text ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(text)) : models;

  return (
    <>
      {searchable ? (
        <label className="search">
          <Icon name="search" size={16} />
          <input
            className="input"
            type="search"
            aria-label="Search models"
            placeholder="Search"
            autoComplete="off"
            spellCheck={false}
            data-autofocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      <div className="models-box">
        {caption ? <p className="models-caption">{caption}</p> : null}
        <ul className="models">
          {shown.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                className="model"
                aria-current={model.id === current ? "true" : undefined}
                disabled={busy || !model.tools}
                onClick={() => onPick(model)}
              >
                <span className="model-main">
                  <span className="model-name">
                    <span className="truncate">{model.name}</span>
                    {model.id === current ? <Icon name="check" size={16} /> : null}
                  </span>
                  {model.id === model.name ? null : <span className="model-id mono truncate">{model.id}</span>}
                </span>
                {model.tools ? <span className="model-facts num">{modelFacts(model)}</span> : <span className="chip">No tools</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 ? <li className="models-none">No model found</li> : null}
        </ul>
        {footer ? <div className="models-foot">{footer}</div> : null}
      </div>
    </>
  );
}

function Waiting() {
  return (
    <p className="panel-wait">
      <span className="spinner" />
    </p>
  );
}

/** Tool-calling models only, newest first, with the router that picks one for you on top. */
function arrangeCatalog(models: ModelInfo[]): ModelInfo[] {
  const usable = models.filter((model) => model.tools).sort((left, right) => right.created - left.created);
  const router = usable.find((model) => model.id === "openrouter/auto");
  return router ? [router, ...usable.filter((model) => model !== router)] : usable;
}

function OpenRouterSetup({ provider, onDone }: SetupProps) {
  const connect = useConnect(provider, onDone);
  const [key, setKey] = useState("");
  // Counts the listings asked for. Zero means there is no key to list with yet.
  const [asked, setAsked] = useState(provider.hasKey ? 1 : 0);
  const [changing, setChanging] = useState(false);
  const typed = key.trim();
  const catalog = useRead(asked === 0 ? null : `openrouter:${asked}`, () =>
    request((api) => api.listModels(typed ? { provider: "openrouter", key: typed } : { provider: "openrouter" })),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    setChanging(false);
    setAsked(asked + 1);
  }

  if (asked > 0 && !changing && catalog.loading) return <Waiting />;

  if (catalog.data && !changing) {
    return (
      <ModelList
        models={arrangeCatalog(catalog.data)}
        current={provider.model}
        searchable
        caption="Context · $ per 1M tokens in / out"
        footer={
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChanging(true)}>
            Change key
          </button>
        }
        onPick={(model) => void connect(model.id, typed ? { key: typed } : {})}
      />
    );
  }

  return (
    <form className="form" onSubmit={submit} autoComplete="off">
      <label className="field">
        <span className="field-label">API key</span>
        <input
          className="input input-mono"
          type="password"
          placeholder="sk-or-…"
          autoComplete="off"
          data-autofocus
          autoFocus
          required
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <span className="field-help">
          <button type="button" className="link" onClick={() => openExternal("https://openrouter.ai/keys")}>
            Get a key
          </button>
        </span>
      </label>
      {catalog.error && !changing ? (
        <p className="form-error" role="alert">
          {catalog.error}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!typed}>
          Continue
        </button>
      </div>
    </form>
  );
}

function CloudflareSetup({ provider, onDone }: SetupProps) {
  const busy = useBusy();
  const connect = useConnect(provider, onDone);
  const [account, setAccount] = useState(provider.account);
  const [token, setToken] = useState("");
  const [model, setModel] = useState(provider.model);
  const [gateway, setGateway] = useState(provider.gateway || "default");
  const [more, setMore] = useState(provider.gateway !== "" && provider.gateway !== "default");

  // Cloudflare lists its own Workers AI models once it knows the account; they are offered as suggestions.
  const typed = `${account.trim()}|${gateway.trim()}|${token.trim().length}`;
  const settled = useDebounced(typed, 500);
  const known = /^[0-9a-f]{32}$/i.test(account.trim()) && (provider.hasKey || token.trim().length >= 20);
  const listed = useRead(known && settled === typed ? `cloudflare:${settled}` : null, () =>
    request((api) =>
      api.listModels({
        provider: "cloudflare",
        account: account.trim(),
        gateway: gateway.trim() || "default",
        ...(token.trim() ? { key: token.trim() } : {}),
      }),
    ),
  );
  const wanted = model.trim().toLowerCase();
  const suggestions = (listed.data ?? [])
    .filter((item) => item.tools && item.id !== model.trim() && `${item.name} ${item.id}`.toLowerCase().includes(wanted))
    .slice(0, 4);

  function submit(event: FormEvent) {
    event.preventDefault();
    void connect(model.trim(), {
      account: account.trim(),
      gateway: gateway.trim() || "default",
      ...(token.trim() ? { key: token.trim() } : {}),
    });
  }

  return (
    <form className="form" onSubmit={submit} autoComplete="off">
      <label className="field">
        <span className="field-label">Account ID</span>
        <input
          className="input input-mono"
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          autoFocus
          required
          value={account}
          onChange={(event) => setAccount(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">API token</span>
        <input
          className="input input-mono"
          type="password"
          autoComplete="off"
          placeholder={provider.hasKey ? "Saved" : ""}
          required={!provider.hasKey}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="field-help">
          <button type="button" className="link" onClick={() => openExternal("https://dash.cloudflare.com/profile/api-tokens")}>
            Get a token
          </button>
        </span>
      </label>
      <div className="field">
        <label className="field-label" htmlFor="cloudflare-model">
          Model
        </label>
        <input
          id="cloudflare-model"
          className="input input-mono"
          placeholder="openai/gpt-4.1"
          autoComplete="off"
          spellCheck={false}
          required
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        {suggestions.length > 0 ? (
          <ul className="suggest" aria-label="Workers AI models">
            {suggestions.map((item) => (
              <li key={item.id}>
                <button type="button" className="suggest-item mono truncate" onClick={() => setModel(item.id)}>
                  {item.id}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {more ? (
        <label className="field">
          <span className="field-label">Gateway</span>
          <input
            className="input input-mono"
            autoComplete="off"
            spellCheck={false}
            value={gateway}
            onChange={(event) => setGateway(event.target.value)}
          />
        </label>
      ) : null}
      <div className="form-actions form-actions-split">
        {more ? (
          <span />
        ) : (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMore(true)}>
            More
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !account.trim() || !model.trim()}>
          Connect
        </button>
      </div>
    </form>
  );
}

function LocalSetup({ provider, onDone }: SetupProps) {
  const connect = useConnect(provider, onDone);
  const [address, setAddress] = useState(provider.url);
  // The address the server was last asked at; typing does not ask again until Retry.
  const [asked, setAsked] = useState(provider.url);
  const moved = asked.trim() !== provider.url;
  const installed = useRead(`${provider.id}:${asked}`, () =>
    request((api) => api.listModels(moved ? { provider: provider.id, url: asked.trim() } : { provider: provider.id })),
  );

  if (installed.loading) return <Waiting />;

  if (!installed.data) {
    // Nothing answered at the address: say how to start the server, once. Anything else is a fault to read.
    const down = isNotRunning(installed.error);
    return (
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          setAsked(address);
          installed.reload();
        }}
      >
        {down ? (
          <>
            <p className="status" role="status">
              <span className="dot" data-tone="down" />
              Not running
            </p>
            <p className="field-help">{startHint(provider)}</p>
          </>
        ) : (
          <p className="form-error" role="alert">
            {installed.error}
          </p>
        )}
        <label className="field">
          <span className="field-label">Server address</span>
          <input
            className="input input-mono"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Retry
          </button>
        </div>
      </form>
    );
  }

  return (
    <>
      <p className="status" role="status">
        <span className="dot" data-tone="up" />
        Running · {plural(installed.data.length, "model")}
      </p>
      <ModelList
        models={installed.data}
        current={provider.model}
        caption="Context"
        onPick={(model) => void connect(model.id, moved ? { url: asked.trim() } : {})}
      />
    </>
  );
}

/** Connecting one provider: its key or its server, then the model. */
export function ModelSetup(props: SetupProps) {
  const { provider, onBack } = props;
  return (
    <div className="setup">
      <div className="setup-head">
        <button type="button" className="icon-btn" aria-label="Back to models" onClick={onBack}>
          <Icon name="back" />
        </button>
        <h3 className="setup-title">{provider.name}</h3>
      </div>
      {provider.id === "openrouter" ? <OpenRouterSetup {...props} /> : null}
      {provider.id === "cloudflare" ? <CloudflareSetup {...props} /> : null}
      {provider.id === "ollama" || provider.id === "lmstudio" ? <LocalSetup {...props} /> : null}
    </div>
  );
}
