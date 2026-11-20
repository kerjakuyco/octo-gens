import { type FormEvent, useState } from "react";
import type { McpConnectRequest, McpView, ToolInfo } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { plural } from "../../lib/format";
import { useRead } from "../../lib/hooks";
import { instrumentFor } from "../../lib/market";
import { errorText, mcpConnect, mcpDisconnect, request, setWebSearch, useBusy, useSnapshot } from "../../state/app";

type Transport = McpConnectRequest["transport"];

const TRANSPORTS: SegmentOption<Transport>[] = [
  { value: "stdio", label: "Local command" },
  { value: "http", label: "URL" },
];

/** Parses a JSON field, or explains what is wrong with it. */
function parseJson<T>(text: string, check: (value: unknown) => value is T, problem: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() || "null");
  } catch {
    throw new Error(problem);
  }
  if (!check(value)) throw new Error(problem);
  return value;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

function Head({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="setup-head">
      <button type="button" className="icon-btn" aria-label="Back to tool servers" onClick={onBack}>
        <Icon name="back" />
      </button>
      <h3 className="setup-title">{title}</h3>
    </div>
  );
}

function AddServer({ onClose }: { onClose: () => void }) {
  const busy = useBusy();
  const [id, setId] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState("");

  function build(): McpConnectRequest {
    const name = id.trim();
    if (transport === "stdio") {
      return {
        id: name,
        transport,
        command: command.trim(),
        args: parseJson(args, isStringList, 'Arguments are a JSON list, for example ["server.js"].'),
        env: parseJson(env, isStringMap, 'Environment is a JSON object, for example {"API_KEY": "abc"}.'),
      };
    }
    return { id: name, transport, url: url.trim(), token: token.trim() || undefined };
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem("");
    let server: McpConnectRequest;
    try {
      server = build();
    } catch (error) {
      setProblem(errorText(error));
      return;
    }
    if (await mcpConnect(server)) onClose();
  }

  return (
    <div className="setup">
      <Head title="Add server" onBack={onClose} />
      <form className="form" onSubmit={(event) => void add(event)} autoComplete="off">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input input-mono"
            placeholder="news"
            spellCheck={false}
            autoCapitalize="none"
            autoFocus
            required
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <Segmented label="Server type" value={transport} options={TRANSPORTS} onChange={setTransport} fill />
        {transport === "stdio" ? (
          <>
            <label className="field">
              <span className="field-label">Program</span>
              <input
                className="input input-mono"
                placeholder="node"
                spellCheck={false}
                required
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <div className="form-row">
              <label className="field">
                <span className="field-label">Arguments</span>
                <textarea
                  className="input input-mono"
                  rows={2}
                  spellCheck={false}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Environment</span>
                <textarea
                  className="input input-mono"
                  rows={2}
                  spellCheck={false}
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                />
              </label>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">URL</span>
              <input
                className="input input-mono"
                type="url"
                placeholder="https://mcp.example.com/mcp"
                spellCheck={false}
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Token</span>
              <input
                className="input input-mono"
                type="password"
                autoComplete="off"
                placeholder="Optional"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
          </>
        )}
        {problem ? (
          <p className="form-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !id.trim()}>
            Add server
          </button>
        </div>
      </form>
    </div>
  );
}

/** Starting arguments for a tool: its required fields, pre-filled where the value is obvious. */
function starterArguments(tool: ToolInfo, symbol: string, base: string): string {
  const schema = tool.schema as { required?: unknown } | null;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const known: Record<string, string> = { symbol, asset: base, token: base, query: base };
  const args: Record<string, string> = {};
  for (const name of required) {
    if (typeof name === "string") args[name] = known[name] ?? "";
  }
  return JSON.stringify(args, null, 2);
}

interface CallState {
  status: "idle" | "running" | "done" | "failed";
  text: string;
}

/** Runs a server's tools by hand, to see exactly what they return. */
function Inspector({ server, onClose }: { server: McpView; onClose: () => void }) {
  const snapshot = useSnapshot();
  const symbol = snapshot.focus;
  const base = instrumentFor(snapshot, symbol).base;
  const catalog = useRead(`tools:${server.id}`, () => request((api) => api.mcpTools(server.id)));
  // What the trader picked and typed; until then the first tool and its starter arguments stand in.
  const [picked, setPicked] = useState<{ name: string; args: string } | null>(null);
  const [call, setCall] = useState<CallState>({ status: "idle", text: "" });

  const tools = catalog.data ?? [];
  const tool = tools.find((item) => item.name === picked?.name) ?? tools[0];
  const args = picked && tool && picked.name === tool.name ? picked.args : tool ? starterArguments(tool, symbol, base) : "{}";

  function run(event: FormEvent) {
    event.preventDefault();
    if (!tool) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.trim() || "{}");
    } catch {
      setCall({ status: "failed", text: "The arguments are not valid JSON." });
      return;
    }
    setCall({ status: "running", text: "" });
    request((api) => api.mcpCall(server.id, tool.name, parsed))
      .then((output) => setCall({ status: "done", text: output }))
      .catch((error: unknown) => setCall({ status: "failed", text: errorText(error) }));
  }

  let body;
  if (catalog.loading) {
    body = (
      <p className="panel-wait">
        <span className="spinner" />
      </p>
    );
  } else if (catalog.error) {
    body = (
      <p className="form-error" role="alert">
        {catalog.error}
      </p>
    );
  } else if (!tool) {
    body = <p className="empty">No tools</p>;
  } else {
    body = (
      <form className="form" onSubmit={run}>
        <div className="tool-list" role="radiogroup" aria-label="Tools">
          {tools.map((item) => (
            <button
              key={item.name}
              type="button"
              role="radio"
              aria-checked={item.name === tool.name}
              className="tool"
              onClick={() => {
                setPicked({ name: item.name, args: starterArguments(item, symbol, base) });
                setCall({ status: "idle", text: "" });
              }}
            >
              <span className="tool-name">
                <span className="mono truncate">{item.name}</span>
                <span className="chip" data-tone={item.readOnly ? undefined : "warn"}>
                  {item.readOnly ? "Read-only" : "Can change things"}
                </span>
              </span>
              {item.description ? <span className="tool-text">{item.description}</span> : null}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Arguments</span>
          <textarea
            className="input input-mono"
            rows={4}
            spellCheck={false}
            value={args}
            onChange={(event) => setPicked({ name: tool.name, args: event.target.value })}
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={call.status === "running"}>
            Run
          </button>
        </div>
        {call.status === "failed" ? (
          <p className="form-error" role="alert">
            {call.text}
          </p>
        ) : null}
        {call.status === "done" ? <pre className="code-block">{call.text}</pre> : null}
      </form>
    );
  }

  return (
    <div className="setup">
      <Head title={server.name} onBack={onClose} />
      {body}
    </div>
  );
}

function ServerRow({
  server,
  onInspect,
}: {
  server: McpView;
  onInspect: () => void;
}) {
  const busy = useBusy();
  const [removing, setRemoving] = useState(false);

  return (
    <li className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-title">
          <span className="mono truncate">{server.id}</span>
          <span className="chip">{server.transport === "stdio" ? "Local" : "HTTP"}</span>
        </span>
        <span className="settings-row-desc truncate">
          {server.name} · {plural(server.tools, "tool")}
        </span>
      </div>
      <div className="row-actions">
        {removing ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => void mcpDisconnect(server.id).then(() => setRemoving(false))}
            >
              Remove
            </button>
            <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setRemoving(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-sm btn-secondary" onClick={onInspect}>
              Inspect
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoving(true)}>
              Remove
            </button>
          </>
        )}
      </div>
    </li>
  );
}

type View = { kind: "list" } | { kind: "add" } | { kind: "inspect"; id: string };

/**
 * What the assistant may read beyond the exchange: the news and web pages, and
 * tool servers. It may only call the tools a server marks read-only.
 */
export function ToolsTab() {
  const { servers, assistant } = useSnapshot();
  const busy = useBusy();
  const [view, setView] = useState<View>({ kind: "list" });
  const back = () => setView({ kind: "list" });

  if (view.kind === "add") return <AddServer onClose={back} />;
  const inspected = view.kind === "inspect" ? servers.find((server) => server.id === view.id) : undefined;
  if (inspected) return <Inspector server={inspected} onClose={back} />;

  return (
    <div className="settings-stack">
      <section className="settings-section" aria-label="Built-in research">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Built-in research</h3>
        </div>
        <div className="settings-card">
          <label className="switch settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">
                Web search
                <span className="chip" data-tone={assistant.webSearch ? "up" : undefined}>
                  {assistant.webSearch ? "On" : "Off"}
                </span>
              </span>
              <span className="settings-row-desc">Allow the assistant to read news feeds and web pages you share.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              {...({ switch: "" } as Record<string, string>)}
              checked={assistant.webSearch}
              disabled={busy}
              onChange={(event) => void setWebSearch(event.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>
      </section>

      <section className="settings-section" aria-label="MCP tool servers">
        <div className="settings-section-head">
          <h3 className="settings-section-title">MCP tool servers</h3>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setView({ kind: "add" })}>
            <Icon name="plus" size={14} />
            Add server
          </button>
        </div>
        {servers.length === 0 ? (
          <div className="settings-empty">
            <p className="settings-empty-title">No tool servers attached</p>
            <p className="settings-empty-desc">
              Connect local command or HTTPS MCP servers for extra market data or notes. Only read-only tools are called.
            </p>
          </div>
        ) : (
          <ul className="settings-card settings-list" aria-label="Tool servers">
            {servers.map((server) => (
              <ServerRow key={server.id} server={server} onInspect={() => setView({ kind: "inspect", id: server.id })} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
