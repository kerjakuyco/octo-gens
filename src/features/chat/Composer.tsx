import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ask, stopTurn, useApp } from "../../state/app";

const MAX_HEIGHT = 200;

/** The message box: one field and one button, which sends, or stops the turn that is running. */
export function Composer() {
  const running = useApp((state) => state.live !== null);
  const focusTick = useApp((state) => state.composerFocus);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, [focusTick]);

  // Grow with the message, up to a point.
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  function send() {
    const message = text.trim();
    if (!message) return;
    setText("");
    void ask(message).then((accepted) => {
      // A message the core would not take is handed back, so it is not typed twice.
      if (!accepted) setText((current) => current || message);
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (running) stopTurn();
    else send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!running) send();
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        ref={field}
        rows={1}
        placeholder="Ask anything"
        aria-label="Message"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="send"
        data-state={running ? "stop" : "send"}
        aria-label={running ? "Stop" : "Send"}
        disabled={!running && !text.trim()}
      >
        <Icon name={running ? "stop" : "send"} size={18} />
      </button>
    </form>
  );
}
