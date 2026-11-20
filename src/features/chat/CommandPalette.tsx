import { Icon } from "../../components/Icon";
import {
  COMMAND_GROUPS,
  type Command,
  type CommandContext,
  blocker,
  searchCommands,
} from "../../lib/commands";
import { type ListSection, Listbox } from "./Listbox";

export interface PaletteList {
  items: Command[];
  sections: ListSection[];
}

/** The commands for what was typed after the slash: all of them under their groups, or the best matches first. */
export function paletteItems(query: string): PaletteList {
  const items = searchCommands(query);
  if (query.trim()) return { items, sections: [] };
  const sections: ListSection[] = [];
  items.forEach((command, index) => {
    if (items[index - 1]?.group === command.group) return;
    const group = COMMAND_GROUPS.find((item) => item.id === command.group);
    sections.push({ label: group?.label ?? command.group, start: index });
  });
  return { items, sections };
}

/** The colour of a command's icon: a long reads as up, a short as down. */
function iconTone(command: Command): string | undefined {
  if (command.id === "long") return "up";
  if (command.id === "short") return "down";
  return undefined;
}

interface CommandPaletteProps {
  id: string;
  list: PaletteList;
  active: number;
  context: CommandContext;
  onActive: (index: number) => void;
  onPick: (command: Command) => void;
}

/**
 * The commands of the message box. A command that cannot run yet stays in the list, dimmed, and says
 * why instead of what it does: it can still be picked, and the box then offers the fix.
 */
export function CommandPalette({ id, list, active, context, onActive, onPick }: CommandPaletteProps) {
  return (
    <Listbox
      id={id}
      label="Commands"
      items={list.items}
      sections={list.sections}
      active={active}
      onActive={onActive}
      onPick={(command) => onPick(command)}
      itemKey={(command) => command.id}
      itemClass="cmd-option"
      itemData={(command) => ({
        "data-blocked": blocker(command, context) ? "true" : undefined,
        "data-tone": iconTone(command),
      })}
      renderItem={(command) => {
        const blocked = blocker(command, context);
        return (
          <>
            <span className="cmd-icon">
              <Icon name={command.icon} size={16} />
            </span>
            <span className="cmd-name">{command.title}</span>
            <span className="cmd-id">/{command.id}</span>
            <span className="cmd-hint truncate">{blocked ? blocked.text : command.hint}</span>
          </>
        );
      }}
      empty="No command matches"
    />
  );
}
