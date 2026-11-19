import {
  type KeyboardEvent,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon, type IconName } from "./Icon";

const MenuContext = createContext<() => void>(() => {});

const GAP = 6;
const EDGE = 8;

interface MenuProps {
  /** Accessible name of the button, when what it shows is not text. */
  label?: string;
  /** What the button shows. */
  trigger: ReactNode;
  triggerClass: string;
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
  /** Opens above the button instead of below it. */
  side?: "bottom" | "top";
  disabled?: boolean;
  children: ReactNode;
}

/**
 * A button that opens a small menu. The menu is placed against the window, so
 * a scrolling list or a narrow bar never clips it.
 */
export function Menu({ label, trigger, triggerClass, align = "start", side = "bottom", disabled, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Set when the keyboard opened the menu, so focus moves into it. */
  const byKeyboard = useRef(false);
  const menuId = useId();

  const close = () => setOpen(false);

  useLayoutEffect(() => {
    const anchor = button.current;
    const node = menu.current;
    if (!open || !anchor || !node) return;
    const at = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = node;
    let top = side === "top" ? at.top - height - GAP : at.bottom + GAP;
    if (top + height > window.innerHeight - EDGE) top = at.top - height - GAP;
    if (top < EDGE) top = Math.min(at.bottom + GAP, Math.max(EDGE, window.innerHeight - height - EDGE));
    const left = Math.min(Math.max(EDGE, align === "end" ? at.right - width : at.left), window.innerWidth - width - EDGE);
    node.style.top = `${Math.round(top)}px`;
    node.style.left = `${Math.round(Math.max(EDGE, left))}px`;
    if (byKeyboard.current) items(node)[0]?.focus();
    byKeyboard.current = false;
  }, [open, align, side]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    }
    // The menu is pinned to where the button was. Once the window resizes, or something that holds the button
    // scrolls, it no longer is.
    const away = () => setOpen(false);
    function scrolled(event: Event) {
      const moved = event.target;
      if (moved instanceof Node && moved.contains(button.current)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (!open) {
      if (event.key === "ArrowDown" && event.target === button.current) {
        event.preventDefault();
        byKeyboard.current = true;
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      // Handled here: the window's own Escape shortcut must not also fire.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const node = menu.current;
    if (!node) return;
    const list = items(node);
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = list[(index + 1) % list.length];
    else if (event.key === "ArrowUp") next = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <span className="menu-anchor" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className={triggerClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={(event) => {
          // A click from the keyboard reports no pointer position.
          byKeyboard.current = event.detail === 0;
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div ref={menu} id={menuId} className="menu" role="menu" aria-label={label}>
          <MenuContext.Provider
            value={() => {
              close();
              button.current?.focus();
            }}
          >
            {children}
          </MenuContext.Provider>
        </div>
      ) : null}
    </span>
  );
}

function items(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
}

interface MenuItemProps {
  label: string;
  /** A second, quieter line. */
  sub?: string;
  icon?: IconName;
  /** Makes the item one of a set of choices and marks the current one. */
  checked?: boolean;
  tone?: "danger";
  disabled?: boolean;
  onSelect: () => void;
}

export function MenuItem({ label, sub, icon, checked, tone, disabled, onSelect }: MenuItemProps) {
  const close = useContext(MenuContext);
  return (
    <button
      type="button"
      className="menu-item"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      data-tone={tone}
      disabled={disabled}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      {icon ? <Icon name={icon} size={17} /> : null}
      <span className="menu-item-text">
        <span className="truncate">{label}</span>
        {sub ? <span className="menu-item-sub truncate">{sub}</span> : null}
      </span>
      {checked ? <Icon name="check" size={16} /> : null}
    </button>
  );
}
