import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import type { Suggestion } from "../../lib/commands";
import { ask, prefillComposer, useBusy } from "../../state/app";

interface SuggestionsProps {
  items: readonly Suggestion[];
  /** Names the row for assistive technology. */
  label: string;
  /** `start` under an empty conversation, `follow` under the newest answer, a little smaller. */
  variant?: "start" | "follow";
}

/** The colour of a trade's direction, on the chip's icon only. */
function tone(item: Suggestion): "up" | "down" | undefined {
  if (item.kind !== "command") return undefined;
  if (item.command === "long") return "up";
  if (item.command === "short") return "down";
  return undefined;
}

/**
 * Things to ask with one click. A question is asked at once. A trade goes into the message box as its
 * command, to look over and send, so the chip shows the command it fills in.
 */
export function Suggestions({ items, label, variant = "start" }: SuggestionsProps) {
  const busy = useBusy();
  if (items.length === 0) return null;
  return (
    <div className="suggestions" data-variant={variant} role="group" aria-label={label}>
      {items.map((item, index) => {
        const command = item.kind === "command";
        return (
          <button
            key={item.label}
            type="button"
            className="suggestion"
            data-kind={item.kind}
            data-tone={tone(item)}
            style={{ "--i": index } as CSSProperties}
            disabled={!command && busy}
            aria-label={command ? `${item.label}, fills in /${item.command}` : undefined}
            title={command ? `Puts /${item.command} in the message box to look over before sending` : undefined}
            onClick={() => {
              if (item.kind === "ask") void ask(item.prompt);
              else prefillComposer(item.command, item.values);
            }}
          >
            <Icon name={item.icon} size={variant === "follow" ? 15 : 16} />
            <span className="suggestion-label">{item.label}</span>
            {command ? <span className="suggestion-command">/{item.command}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The quiet line under the starting points that says what the message box understands. */
export function ComposerHint() {
  return (
    <p className="chat-hint">
      Type <kbd>/</kbd> for commands <span aria-hidden="true">·</span> <kbd>$</kbd> to name a market
    </p>
  );
}
