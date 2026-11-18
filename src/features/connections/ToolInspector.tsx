import { type FormEvent, useEffect, useState } from "react";
import type { ToolInfo, VenueView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { plural } from "../../lib/format";
import { errorText, request, useSnapshot } from "../../state/app";

interface CatalogState {
  status: "loading" | "ready" | "failed";
  tools: ToolInfo[];
  error: string;
}

interface CallState {
  status: "idle" | "running" | "done" | "failed";
  text: string;
}

/** Starting arguments for a tool: its required fields, pre-filled where the value is obvious. */
function starterArguments(tool: ToolInfo, focus: string): string {
  const schema = tool.schema as { required?: unknown } | null;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const known: Record<string, string> = {
    pair: focus,
    symbol: focus.replace("/", ""),
    instId: focus.replace("/", "-"),
    category: "spot",
  };
  const args: Record<string, string> = {};
  for (const name of required) {
    if (typeof name === "string") args[name] = known[name] ?? "";
  }
  return JSON.stringify(args, null, 2);
}

function Inspector({ venue }: { venue: VenueView }) {
  const { focus } = useSnapshot();
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading", tools: [], error: "" });
  const [selected, setSelected] = useState("");
  const [args, setArgs] = useState("{}");
  const [call, setCall] = useState<CallState>({ status: "idle", text: "" });

  useEffect(() => {
    let alive = true;
    request((api) => api.mcpTools(venue.id))
      .then((tools) => {
        if (!alive) return;
        setCatalog({ status: "ready", tools, error: "" });
        const first = tools[0];
        if (first) {
          setSelected(first.name);
          setArgs(starterArguments(first, focus));
        }
      })
      .catch((error: unknown) => {
        if (alive) setCatalog({ status: "failed", tools: [], error: errorText(error) });
      });
    return () => {
      alive = false;
    };
    // The catalog is read once per open; a later focus change should not reset the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue.id]);

  const tool = catalog.tools.find((item) => item.name === selected);

  function choose(next: ToolInfo) {
    setSelected(next.name);
    setArgs(starterArguments(next, focus));
    setCall({ status: "idle", text: "" });
  }

  function run(event: FormEvent) {
    event.preventDefault();
    if (!tool) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.trim() || "{}");
    } catch {
      setCall({ status: "failed", text: "The arguments are not valid JSON. Check the quotes and commas." });
      return;
    }
    setCall({ status: "running", text: "" });
    request((api) => api.mcpCall(venue.id, tool.name, parsed))
      .then((output) => setCall({ status: "done", text: output }))
      .catch((error: unknown) => setCall({ status: "failed", text: errorText(error) }));
  }

  if (catalog.status === "loading") {
    return (
      <p className="empty">
        <span className="ring-spin" /> Reading the tool list
      </p>
    );
  }
  if (catalog.status === "failed") {
    return (
      <p className="form-error" role="alert">
        The server did not return its tools. {catalog.error}
      </p>
    );
  }
  if (catalog.tools.length === 0) {
    return <p className="empty">This server advertises no tools.</p>;
  }

  return (
    <form className="form-grid" onSubmit={run}>
      <div className="field">
        <span className="field-label">{plural(catalog.tools.length, "tool")} on this server</span>
        <div className="tool-list" role="radiogroup" aria-label="Tools">
          {catalog.tools.map((item) => (
            <button
              key={item.name}
              type="button"
              role="radio"
              aria-checked={item.name === selected}
              className="tool-option"
              onClick={() => choose(item)}
            >
              <span className="tool-option-name">
                {item.name}
                <span className={item.readOnly ? "tag" : "tag tag-down"}>
                  {item.readOnly ? "Read-only" : "Can change things"}
                </span>
              </span>
              <span className="tool-option-text">{item.description || "No description."}</span>
            </button>
          ))}
        </div>
      </div>

      {tool ? (
        <>
          <p className="field-help">
            {tool.readOnly
              ? "The assistant may call this tool on its own, because the server marks it read-only."
              : "The assistant cannot call this tool. It runs only when you press the button below."}
          </p>
          <details className="reveal">
            <summary>Input schema</summary>
            <pre className="code-block">{JSON.stringify(tool.schema, null, 2)}</pre>
          </details>
          <label className="field">
            <span className="field-label">Arguments, as JSON</span>
            <textarea
              className="input input-code"
              rows={5}
              spellCheck={false}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={call.status === "running"}>
              Run {tool.name}
            </button>
            {call.status === "running" ? <span className="ring-spin" role="img" aria-label="Running" /> : null}
          </div>
          {call.status === "failed" ? (
            <p className="form-error" role="alert">
              {call.text}
            </p>
          ) : null}
          {call.status === "done" ? (
            <div className="field">
              <span className="field-label">Result</span>
              <pre className="code-block">{call.text}</pre>
            </div>
          ) : null}
        </>
      ) : null}
    </form>
  );
}

export function ToolInspector({ venue, onClose }: { venue: VenueView | null; onClose: () => void }) {
  return (
    <Dialog
      open={venue !== null}
      onClose={onClose}
      size="wide"
      title={venue ? `${venue.mcp?.name ?? venue.name} tools` : "Tools"}
      lead="Run any tool yourself and see exactly what the server returns. Results shown here are not saved."
    >
      {venue ? <Inspector venue={venue} /> : null}
    </Dialog>
  );
}
