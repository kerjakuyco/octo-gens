import { useMemo, useState } from "react";
import type { ModelInfo } from "../../api/types";
import { contextSize, count, tokenPrice } from "../../lib/format";

export interface ModelsState {
  status: "idle" | "loading" | "ready" | "failed";
  models: ModelInfo[];
  error: string;
}

type SortOrder = "newest" | "price" | "name";

const VISIBLE = 60;

function priceText(model: ModelInfo): string {
  if (model.free) return "Free";
  if (model.promptPrice === null || model.completionPrice === null) return "Price varies";
  return `${tokenPrice(model.promptPrice)} in, ${tokenPrice(model.completionPrice)} out`;
}

function compare(order: SortOrder) {
  return (left: ModelInfo, right: ModelInfo): number => {
    if (order === "name") return left.name.localeCompare(right.name);
    if (order === "price") {
      const a = left.promptPrice ?? Number.POSITIVE_INFINITY;
      const b = right.promptPrice ?? Number.POSITIVE_INFINITY;
      return a - b || left.name.localeCompare(right.name);
    }
    return right.created - left.created;
  };
}

interface ModelBrowserProps {
  state: ModelsState;
  selected: string;
  onSelect: (model: ModelInfo) => void;
  onReload: () => void;
}

/** Searchable list of OpenRouter models, with the capabilities that matter for trading research. */
export function ModelBrowser({ state, selected, onSelect, onReload }: ModelBrowserProps) {
  const [query, setQuery] = useState("");
  const [toolsOnly, setToolsOnly] = useState(true);
  const [freeOnly, setFreeOnly] = useState(false);
  const [order, setOrder] = useState<SortOrder>("newest");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.models
      .filter((model) => {
        if (toolsOnly && !model.tools) return false;
        if (freeOnly && !model.free) return false;
        return !needle || `${model.name} ${model.id}`.toLowerCase().includes(needle);
      })
      .sort(compare(order));
  }, [state.models, query, toolsOnly, freeOnly, order]);

  return (
    <div className="model-browser">
      <div className="model-tools">
        <input
          className="input"
          type="search"
          aria-label="Search models"
          placeholder="Search by name or id"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={toolsOnly} onChange={(event) => setToolsOnly(event.target.checked)} />
          <span>Tool calling</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={freeOnly} onChange={(event) => setFreeOnly(event.target.checked)} />
          <span>Free</span>
        </label>
        <select
          className="input"
          aria-label="Sort models"
          value={order}
          onChange={(event) => setOrder(event.target.value as SortOrder)}
        >
          <option value="newest">Newest first</option>
          <option value="price">Cheapest first</option>
          <option value="name">By name</option>
        </select>
      </div>

      {state.status === "loading" || state.status === "idle" ? (
        <p className="model-state">
          <span className="ring-spin" /> Loading the model list from OpenRouter
        </p>
      ) : null}

      {state.status === "failed" ? (
        <div className="model-state" role="alert">
          <p className="form-error">The model list did not load. {state.error}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={onReload}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" && matches.length === 0 ? (
        <p className="model-state">
          No model matches. {toolsOnly ? "Clear the search, or untick Tool calling to see every chat model." : "Clear the search to see every model."}
        </p>
      ) : null}

      {state.status === "ready" && matches.length > 0 ? (
        <div className="model-list" role="radiogroup" aria-label="Models">
          {matches.slice(0, VISIBLE).map((model) => (
            <button
              key={model.id}
              type="button"
              role="radio"
              aria-checked={model.id === selected}
              className="model-option"
              onClick={() => onSelect(model)}
            >
              <span className="model-name">
                {model.name}
                {model.tools ? null : <span className="tag tag-down">No tool calling</span>}
                {model.reasoning ? <span className="tag">Reasoning</span> : null}
                {model.free ? <span className="tag tag-ochre">Free</span> : null}
              </span>
              <span className="model-figures">
                <b>{priceText(model)}</b>
                <br />
                {model.free || model.promptPrice === null ? "" : "per million tokens, "}
                {contextSize(model.context)} context
              </span>
              <span className="model-id">{model.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {state.status === "ready" ? (
        <div className="model-footer">
          {matches.length > VISIBLE
            ? `Showing ${VISIBLE} of ${count(matches.length)} models. Search to narrow the list.`
            : `${count(matches.length)} of ${count(state.models.length)} models shown.`}
        </div>
      ) : null}
    </div>
  );
}
