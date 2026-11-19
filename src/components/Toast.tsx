import { useEffect, useRef } from "react";
import { type Notice, dismissNotice, useApp } from "../state/app";
import { Icon } from "./Icon";

function Message({ notice }: { notice: Notice }) {
  const node = useRef<HTMLDivElement>(null);

  // Shown as a popover so it sits above an open dialog, which would otherwise cover and dim it.
  useEffect(() => {
    const element = node.current;
    if (!element || typeof element.showPopover !== "function") return;
    try {
      element.showPopover();
    } catch {
      // Already showing.
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(dismissNotice, notice.tone === "error" ? 9000 : 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div
      ref={node}
      className="toast"
      popover="manual"
      data-tone={notice.tone}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <span className="toast-text">{notice.text}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismissNotice}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** The latest notice. Errors stay longer and are announced assertively. */
export function Toast() {
  const notice = useApp((state) => state.notice);
  return notice ? <Message key={notice.id} notice={notice} /> : null;
}
