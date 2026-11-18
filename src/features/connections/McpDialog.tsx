import { type FormEvent, useState } from "react";
import type { McpConnectRequest, VenueView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Segmented, type SegmentOption } from "../../components/Segmented";
import { mcpConnect, openExternal, useApp, useSnapshot } from "../../state/app";

type Transport = McpConnectRequest["transport"];
type OkxProfile = "market" | "demo" | "live";

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

function McpForm({ venue, onClose }: { venue: VenueView; onClose: () => void }) {
  const { nodeRuntime } = useSnapshot();
  const busy = useApp((state) => Boolean(state.working));
  const transports: SegmentOption<Transport>[] = [
    ...(venue.officialPackage ? [{ value: "official" as const, label: "Official server" }] : []),
    { value: "stdio", label: "Custom command" },
    { value: "http", label: "Remote URL" },
  ];
  const [transport, setTransport] = useState<Transport>(venue.officialPackage ? "official" : "stdio");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [testnet, setTestnet] = useState(false);
  const [profile, setProfile] = useState<OkxProfile>("market");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState("");

  const blocked = transport === "official" && !nodeRuntime;

  function build(): McpConnectRequest {
    if (transport === "official") {
      return venue.id === "okx"
        ? { venue: venue.id, transport, profile }
        : { venue: venue.id, transport, key: key.trim() || undefined, secret: secret.trim() || undefined, testnet };
    }
    if (transport === "stdio") {
      return {
        venue: venue.id,
        transport,
        command: command.trim(),
        args: parseJson(args, isStringList, 'Arguments must be a JSON list of text values, for example ["server.js"].'),
        env: parseJson(env, isStringMap, 'Environment must be a JSON object of text values, for example {"API_KEY": "abc"}.'),
      };
    }
    return { venue: venue.id, transport, url: url.trim(), token: token.trim() || undefined };
  }

  async function attach(event: FormEvent) {
    event.preventDefault();
    setProblem("");
    let request: McpConnectRequest;
    try {
      request = build();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    if (await mcpConnect(request)) onClose();
  }

  return (
    <form className="form-grid" onSubmit={(event) => void attach(event)} autoComplete="off">
      <div className="field">
        <span className="field-label">Where the server runs</span>
        <Segmented label="Server type" value={transport} options={transports} onChange={setTransport} />
      </div>

      {transport === "official" ? (
        <>
          <p className="field-help">
            Starts <span className="mono">{venue.officialPackage}</span>, published by {venue.name}, on this computer
            through Node.js. The first start downloads the package and can take a minute.
          </p>
          {!nodeRuntime ? (
            <p className="form-error" role="alert">
              Node.js 20 or newer is not installed, so this server cannot start.{" "}
              <button type="button" className="link" onClick={() => openExternal("https://nodejs.org/")}>
                Get Node.js
              </button>
              , restart Octo Gens, then attach it again.
            </p>
          ) : null}
          {venue.id === "okx" ? (
            <label className="field">
              <span className="field-label">OKX profile</span>
              <select className="input" value={profile} onChange={(event) => setProfile(event.target.value as OkxProfile)}>
                <option value="market">Market data tools only</option>
                <option value="demo">My existing demo profile</option>
                <option value="live">My existing live profile</option>
              </select>
              <span className="field-help">
                Demo and live profiles read the OKX config file already on this computer. Octo Gens does not write it.
              </span>
            </label>
          ) : (
            <>
              <div className="form-row">
                <label className="field">
                  <span className="field-label">API key, optional</span>
                  <input className="input input-code" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">API secret, optional</span>
                  <input className="input input-code" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
                </label>
              </div>
              <p className="field-help">
                Leave both empty for market data. Keys are handed to the server process only and are not saved.
              </p>
              <label className="check">
                <input type="checkbox" checked={testnet} onChange={(event) => setTestnet(event.target.checked)} />
                <span>Use the {venue.name} testnet</span>
              </label>
            </>
          )}
        </>
      ) : null}

      {transport === "stdio" ? (
        <>
          <label className="field">
            <span className="field-label">Program</span>
            <input
              className="input input-code"
              placeholder="node, or the full path to a program"
              spellCheck={false}
              required
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <span className="field-help">A real executable. Shell scripts and .cmd launchers cannot speak MCP.</span>
          </label>
          <label className="field">
            <span className="field-label">Arguments, as a JSON list</span>
            <textarea className="input input-code" rows={2} spellCheck={false} value={args} onChange={(event) => setArgs(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Environment, as a JSON object</span>
            <textarea className="input input-code" rows={2} spellCheck={false} value={env} onChange={(event) => setEnv(event.target.value)} />
            <span className="field-help">Passed to this process only and forgotten when it stops.</span>
          </label>
        </>
      ) : null}

      {transport === "http" ? (
        <>
          <label className="field">
            <span className="field-label">Server URL</span>
            <input
              className="input input-code"
              type="url"
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <span className="field-help">Must use https. Plain http is accepted only for a server on this computer.</span>
          </label>
          <label className="field">
            <span className="field-label">Bearer token, optional</span>
            <input className="input input-code" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
          </label>
        </>
      ) : null}

      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || blocked}>
          Attach server
        </button>
      </div>
    </form>
  );
}

export function McpDialog({ venue, onClose }: { venue: VenueView | null; onClose: () => void }) {
  return (
    <Dialog
      open={venue !== null}
      onClose={onClose}
      title={venue ? `Attach a server to ${venue.name}` : "Attach a server"}
      lead="An MCP server adds tools the assistant can read from, such as funding rates or account history. Prices and tickets work without one."
    >
      {venue ? <McpForm venue={venue} onClose={onClose} /> : null}
    </Dialog>
  );
}
