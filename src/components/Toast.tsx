import { useEffect } from "react";
import { dismissNotice, useApp } from "../state/app";
import { Icon } from "./Icon";

/** The latest notice. Errors stay longer and are announced assertively. */
export function Toast() {
  const notice = useApp((state) => state.notice);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, notice.tone === "error" ? 9000 : 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className="toast" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
      <span className="toast-text">{notice.text}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismissNotice}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
