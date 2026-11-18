import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AssistantView } from "../../api/types";
import { Icon } from "../../components/Icon";
import { ask, navigate, stopTurn, useApp, useSnapshot } from "../../state/app";

const MAX_HEIGHT = 168;

function modelLabel(assistant: AssistantView): string {
  if (assistant.provider === "builtin") return "Built-in agents";
  if (!assistant.model) return "Choose a model";
  return assistant.model;
}

/** Where prompts are written. Enter sends; Shift+Enter starts a new line. */
export function Composer() {
  const { assistant } = useSnapshot();
  const running = useApp((state) => Boolean(state.live));
  const focusToken = useApp((state) => state.composerFocus);
  const [value, setValue] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, [focusToken]);

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  function send() {
    const text = value.trim();
    if (!text || running) return;
    setValue("");
    void ask(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          maxLength={2500}
          aria-label="Message the assistant"
          placeholder="Ask about a market, or type an order like: buy 0.01 BTC"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          <button
            type="button"
            className="model-chip"
            title="Change the model in Settings"
            onClick={() => navigate("settings")}
          >
            <Icon name="model" size={15} />
            <span>{modelLabel(assistant)}</span>
          </button>
          <span className="composer-hint">Enter to send, Shift+Enter for a new line</span>
          {running ? (
            <button type="button" className="btn btn-secondary btn-small" onClick={stopTurn}>
              <Icon name="stop" size={15} />
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-small" disabled={!value.trim()} onClick={send}>
              <Icon name="send" size={15} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
