import type { KeyboardEvent } from "react";
import { Icon, type IconName } from "./Icon";

export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** Drawn before the label, as the sidebar's navigation does. */
  icon?: IconName;
}

interface TabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  value: T;
  options: TabOption<T>[];
  onChange: (value: T) => void;
  /** Id of the element the tabs switch, which should carry `role="tabpanel"`. */
  panelId: string;
  /** Stack the tabs in a column, for a dialog's side list. */
  vertical?: boolean;
}

/** A tab list with arrow-key navigation. The caller renders the panel. */
export function Tabs<T extends string>({ label, value, options, onChange, panelId, vertical = false }: TabsProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const index = options.findIndex((option) => option.value === value);
    let next = -1;
    if (event.key === forward) next = (index + 1) % options.length;
    else if (event.key === back) next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    const option = options[next];
    if (!option) return;
    event.preventDefault();
    onChange(option.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div
      className={vertical ? "tabs tabs-vertical" : "tabs"}
      role="tablist"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {option.icon ? <Icon name={option.icon} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
