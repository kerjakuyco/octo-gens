import { useLayoutEffect, useRef } from "react";
import type { Provider, RunView } from "../../api/types";
import { type LiveTurn, ask, openSettings, useApp, useSnapshot } from "../../state/app";
import { Composer } from "./Composer";
import { Turn } from "./Turn";

const NEWS = "Market news";
const SUGGESTIONS = ["BTC outlook", NEWS, "Top movers", "Long ETH, 1% risk"];

const PROVIDER_TILES: { id: Provider; name: string; kind: string }[] = [
  { id: "openrouter", name: "OpenRouter", kind: "Cloud" },
  { id: "cloudflare", name: "Cloudflare", kind: "Cloud" },
  { id: "ollama", name: "Ollama", kind: "Local" },
  { id: "lmstudio", name: "LM Studio", kind: "Local" },
];

/** How close to the end counts as "reading the latest", so new text keeps the view pinned there. */
const NEAR_END = 96;

interface Item {
  run: RunView;
  live: LiveTurn | null;
}

export function ChatPage() {
  const snapshot = useSnapshot();
  const live = useApp((state) => state.live);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // A turn the core already lists is drawn from the snapshot; the streamed copy is only for what it does not list yet.
  const items: Item[] = snapshot.turns
    .filter((run) => !live || run.id !== live.run.id)
    .map((run) => ({ run, live: null }));
  if (live) items.push({ run: live.run, live });
  const empty = items.length === 0;
  const { ready, webSearch } = snapshot.assistant;

  // Another conversation, or one more message, starts from the end. Text that streams in follows only while the
  // reader is already there.
  const view = `${snapshot.thread}:${items.length}`;
  const lastView = useRef("");
  useLayoutEffect(() => {
    if (lastView.current !== view) {
      lastView.current = view;
      pinned.current = true;
    }
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  });

  return (
    <div className="chat" data-empty={empty}>
      {empty ? (
        <div className="chat-hello">
          <h1 className="chat-title">{ready ? "Ask about any market" : "Connect a model"}</h1>
          {ready ? null : (
            <div className="tiles">
              {PROVIDER_TILES.map((tile) => (
                <button key={tile.id} type="button" className="tile" onClick={() => openSettings("models", tile.id)}>
                  <span className="tile-name">{tile.name}</span>
                  <span className="tile-kind">{tile.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          ref={scroller}
          className="thread"
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_END;
          }}
        >
          <div className="thread-inner">
            {items.map((item, index) => (
              <Turn
                key={item.run.id || "pending"}
                run={item.run}
                live={item.live}
                latest={index === items.length - 1}
              />
            ))}
          </div>
        </div>
      )}

      <div className="chat-foot">
        <Composer />
        {empty && ready ? (
          <div className="suggestions">
            {SUGGESTIONS.filter((prompt) => prompt !== NEWS || webSearch).map((prompt) => (
              <button key={prompt} type="button" className="suggestion" onClick={() => void ask(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
