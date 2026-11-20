import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import {
  type Command,
  type CommandNote,
  type CommandValues,
  type FixTarget,
  type Option,
  type ParamKey,
  GRID_COUNT_OPTIONS,
  MARGIN_OPTIONS,
  MODE_OPTIONS,
  PARAM_LABELS,
  RISK_OPTIONS,
  SHARE_OPTIONS,
  SIDE_OPTIONS,
  TARGET_OPTIONS,
  TIMEFRAME_OPTIONS,
  chipText,
  commandTone,
  leverageOptions,
} from "../../lib/commands";
import { MarketChip } from "./MarketPicker";

/** Where a chip falls in the row, so the chips arrive one after another. */
function order(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

interface OptionChipProps<T extends string | number> {
  param: ParamKey;
  values: CommandValues;
  options: readonly Option<T>[];
  value: T;
  index: number;
  tone?: "up" | "down";
  onPick: (value: T) => void;
}

/** A setting with a few choices: a chip that opens a short menu above itself. */
function OptionChip<T extends string | number>({ param, values, options, value, index, tone, onPick }: OptionChipProps<T>) {
  const current = options.find((option) => option.value === value);
  return (
    <span className="cmd-chip-slot" style={order(index)}>
      <Menu
        label={`${PARAM_LABELS[param]}: ${current?.label ?? chipText(param, values)}`}
        triggerClass={tone ? `cmd-chip cmd-chip-${tone}` : "cmd-chip"}
        side="top"
        trigger={
          <>
            <span className="truncate">{chipText(param, values)}</span>
            <Icon name="chevronDown" size={13} />
          </>
        }
      >
        {options.map((option) => (
          <MenuItem
            key={String(option.value)}
            label={option.label}
            sub={option.sub}
            checked={option.value === value}
            onSelect={() => onPick(option.value)}
          />
        ))}
      </Menu>
    </span>
  );
}

interface CommandChipsProps {
  command: Command;
  values: CommandValues;
  maxLeverage: number;
  onValues: (values: CommandValues) => void;
  onRemove: () => void;
  /** Hands the keyboard back to the message box once a setting is picked. */
  onDone: () => void;
}

/** The command in the box, and its settings as chips beside it. */
export function CommandChips({ command, values, maxLeverage, onValues, onRemove, onDone }: CommandChipsProps) {
  const tone = commandTone(command, values) ?? undefined;
  const positionsOnly = command.needs.includes("position");

  function set<K extends keyof CommandValues>(key: K, value: CommandValues[K]) {
    onValues({ ...values, [key]: value });
    onDone();
  }

  function chip(param: ParamKey, index: number) {
    switch (param) {
      case "market":
      case "other":
        return (
          <MarketChip
            key={param}
            label={PARAM_LABELS[param]}
            value={param === "market" ? values.market : values.other}
            prefix={param === "other" ? "vs" : undefined}
            positionsOnly={param === "market" && positionsOnly}
            onPick={(symbol) => onValues({ ...values, [param]: symbol })}
            onDone={onDone}
            style={order(index)}
          />
        );
      case "side":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={SIDE_OPTIONS}
            value={values.side}
            index={index}
            tone={values.side === "long" ? "up" : "down"}
            onPick={(value) => set("side", value)}
          />
        );
      case "risk":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={RISK_OPTIONS}
            value={values.risk}
            index={index}
            onPick={(value) => set("risk", value)}
          />
        );
      case "leverage":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={leverageOptions(maxLeverage)}
            value={values.leverage}
            index={index}
            onPick={(value) => set("leverage", value)}
          />
        );
      case "target":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={TARGET_OPTIONS}
            value={values.target}
            index={index}
            onPick={(value) => set("target", value)}
          />
        );
      case "timeframe":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={TIMEFRAME_OPTIONS}
            value={values.timeframe}
            index={index}
            onPick={(value) => set("timeframe", value)}
          />
        );
      case "share":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={SHARE_OPTIONS}
            value={values.share}
            index={index}
            onPick={(value) => set("share", value)}
          />
        );
      case "mode":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={MODE_OPTIONS}
            value={values.mode}
            index={index}
            tone={values.mode === "long" ? "up" : values.mode === "short" ? "down" : undefined}
            onPick={(value) => set("mode", value)}
          />
        );
      case "grids":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={GRID_COUNT_OPTIONS}
            value={values.grids}
            index={index}
            onPick={(value) => set("grids", value)}
          />
        );
      case "margin":
        return (
          <OptionChip
            key={param}
            param={param}
            values={values}
            options={MARGIN_OPTIONS}
            value={values.margin}
            index={index}
            onPick={(value) => set("margin", value)}
          />
        );
    }
  }

  return (
    <div className="cmd-chips" role="group" aria-label={`${command.title} settings`}>
      <span className="cmd-pill" data-tone={tone} style={order(0)}>
        <Icon name={command.icon} size={15} />
        <span className="cmd-pill-title">{command.title}</span>
        <button type="button" className="cmd-pill-remove" aria-label={`Remove ${command.title}`} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      </span>
      {command.params.map((param, index) => chip(param, index + 1))}
    </div>
  );
}

interface CommandNoteLineProps {
  note: CommandNote;
  /** A note that stops the command from being sent, or one to know before sending it. */
  tone: "block" | "caution";
  id?: string;
  onFix: (target: FixTarget) => void;
}

/** Why a command cannot be sent yet, or what to know before it is, with the way to fix it. */
export function CommandNoteLine({ note, tone, id, onFix }: CommandNoteLineProps) {
  const { fix } = note;
  return (
    <p id={id} className="cmd-note" data-tone={tone}>
      <Icon name={tone === "block" ? "alert" : "info"} size={14} />
      <span className="cmd-note-text">{note.text}</span>
      {fix ? (
        <button type="button" className="cmd-note-fix" onClick={() => onFix(fix.target)}>
          {fix.label}
        </button>
      ) : null}
    </p>
  );
}
