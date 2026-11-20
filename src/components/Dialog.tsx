import { type ReactNode, useEffect, useId, useRef } from "react";
import { BusyMark } from "./BusyMark";
import { Icon } from "./Icon";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** `settings` is the large two-pane modal that renders its own pane header. */
  size?: "settings";
  /** When true, omits the default top title bar; the child must render an element with `id={titleId}` or use `ariaLabel`. */
  headless?: boolean;
  /** The dialog's content. Wrap it in `.dialog-body` unless it does its own layout. */
  children: ReactNode;
}

function isOutsideDialog(event: { clientX: number; clientY: number }, dialog: HTMLDialogElement): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

/** A modal built on the native `<dialog>`, so focus trapping and Escape come from the platform. */
export function Dialog({ open, onClose, title, size, headless = false, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  /** The press began on the backdrop, so a release there is a click outside and not the end of a drag. */
  const pressedOutside = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      // The platform focuses the first control, the close button, and may ring it. A field marked
      // for it takes the focus instead; failing that the dialog itself does, which draws nothing.
      (node.querySelector<HTMLElement>("[data-autofocus]") ?? node).focus();
    }
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      data-size={size}
      tabIndex={-1}
      aria-labelledby={headless ? undefined : titleId}
      aria-label={headless ? title : undefined}
      {...({ closedby: "any" } as Record<string, string>)}
      onClose={onClose}
      onPointerDown={(event) => {
        if ("closedBy" in HTMLDialogElement.prototype) return;
        pressedOutside.current = isOutsideDialog(event, event.currentTarget);
      }}
      onPointerUp={(event) => {
        if ("closedBy" in HTMLDialogElement.prototype) return;
        if (pressedOutside.current && isOutsideDialog(event, event.currentTarget)) {
          event.currentTarget.close();
        }
        pressedOutside.current = false;
      }}
    >
      {open ? (
        headless ? (
          children
        ) : (
          <>
            <div className="dialog-head">
              <h2 id={titleId} className="dialog-title">
                {title}
              </h2>
              <BusyMark />
              <span className="grow" />
              <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
                <Icon name="close" />
              </button>
            </div>
            {children}
          </>
        )
      ) : null}
    </dialog>
  );
}
