import { type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "./Icon";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One or two sentences under the title. */
  lead?: ReactNode;
  size?: "wide";
  children: ReactNode;
}

/** A modal built on the native `<dialog>`, so focus trapping and Escape come from the platform. */
export function Dialog({ open, onClose, title, lead, size, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      // The platform focuses the first control (the close button); prefer the field marked for it.
      node.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      data-size={size}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog-head">
            <div>
              <h2 id={titleId} className="dialog-title">
                {title}
              </h2>
              {lead ? <p className="dialog-lead">{lead}</p> : null}
            </div>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
        </>
      ) : null}
    </dialog>
  );
}
