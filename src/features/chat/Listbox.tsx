import { type ReactNode, useLayoutEffect, useRef } from "react";

/** A heading drawn above the item at `start`. */
export interface ListSection {
  label: string;
  start: number;
}

/** The next index after moving `delta` places through `count` items, wrapping at both ends. */
export function stepIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  const from = Math.min(Math.max(index, 0), count - 1);
  return (from + delta + count) % count;
}

interface ListboxProps<T> {
  /** The listbox's id. Each option's id is this id, a dash, and its index, for `aria-activedescendant`. */
  id: string;
  label: string;
  items: readonly T[];
  /** The highlighted item, which Enter picks. */
  active: number;
  onActive: (index: number) => void;
  onPick: (item: T, index: number) => void;
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  sections?: readonly ListSection[];
  /** Shown in place of the items when there are none. */
  empty?: ReactNode;
  /** Shown after the items, for example while more are on their way. */
  footer?: ReactNode;
  className?: string;
  itemClass?: string;
  itemData?: (item: T) => Record<`data-${string}`, string | undefined>;
}

/**
 * A list of options that the keyboard drives from elsewhere: the field the trader types in keeps the
 * focus, and says which option is highlighted. One highlight slides between the options rather than
 * each option lighting up on its own, and the highlighted option is kept in view.
 */
export function Listbox<T>({
  id,
  label,
  items,
  active,
  onActive,
  onPick,
  itemKey,
  renderItem,
  sections = [],
  empty,
  footer,
  className = "",
  itemClass = "",
  itemData,
}: ListboxProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const glider = useRef<HTMLDivElement>(null);
  /** What was last scrolled into view, so a re-render alone never pulls the list back from where it was scrolled. */
  const revealed = useRef("");

  useLayoutEffect(() => {
    const node = list.current;
    const mark = glider.current;
    if (!node || !mark) return;
    const option = node.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!option) {
      mark.style.opacity = "0";
      return;
    }
    const top = option.offsetTop;
    const height = option.offsetHeight;
    // The first placement jumps; only later moves slide.
    const first = mark.dataset.placed !== "true";
    if (first) mark.style.transition = "none";
    mark.style.opacity = "1";
    mark.style.height = `${height}px`;
    mark.style.transform = `translateY(${top}px)`;
    if (first) {
      void mark.offsetHeight;
      mark.style.transition = "";
      mark.dataset.placed = "true";
    }

    const key = `${active}:${items.length}:${items[0] === undefined ? "" : itemKey(items[0])}`;
    if (revealed.current === key) return;
    revealed.current = key;
    // An option that opens its section brings the section's heading into view with it.
    const heading = option.previousElementSibling;
    const from = heading instanceof HTMLElement && heading.dataset.heading === "true" ? heading.offsetTop : top;
    if (from < node.scrollTop) node.scrollTop = Math.max(0, from - 4);
    else if (top + height > node.scrollTop + node.clientHeight) node.scrollTop = top + height - node.clientHeight + 4;
  });

  function option(item: T, index: number) {
    return (
      <div
        key={itemKey(item)}
        id={`${id}-${index}`}
        role="option"
        aria-selected={index === active}
        className={`lb-option ${itemClass}`}
        data-index={index}
        {...itemData?.(item)}
        // Moving, not entering: a list scrolled by the keyboard must not hand the highlight to whatever lands under a still pointer.
        onPointerMove={() => {
          if (index !== active) onActive(index);
        }}
        // The field keeps the focus, so typing goes on where it was.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onPick(item, index)}
      >
        {renderItem(item, index)}
      </div>
    );
  }

  const groups = sections.map((section, index) => ({
    label: section.label,
    start: section.start,
    end: sections[index + 1]?.start ?? items.length,
  }));

  return (
    <div ref={list} id={id} role="listbox" aria-label={label} className={`lb ${className}`}>
      <div ref={glider} className="lb-glider" aria-hidden="true" />
      {groups.length > 0
        ? groups.map((group) => (
            <div key={group.label} role="group" aria-labelledby={`${id}-g${group.start}`} className="lb-group">
              <div id={`${id}-g${group.start}`} className="lb-heading" data-heading="true">
                {group.label}
              </div>
              {items.slice(group.start, group.end).map((item, offset) => option(item, group.start + offset))}
            </div>
          ))
        : items.map((item, index) => option(item, index))}
      {items.length === 0 && empty ? <div className="lb-empty">{empty}</div> : null}
      {footer}
    </div>
  );
}
