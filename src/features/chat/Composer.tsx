import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../../components/Icon";
import {
  type Command,
  type CommandValues,
  type FixTarget,
  blocker,
  caution,
  commandById,
  commandContext,
  commandTone,
  defaultValues,
  findCommand,
  marketName,
  mentionAt,
  replaceMention,
  slashQuery,
  valuesFor,
  writeMessage,
} from "../../lib/commands";
import { usePresence } from "../../lib/hooks";
import { computeJournalMetrics, journalReviewPrompt, useJournal } from "../../lib/journal";
import { networkName } from "../../lib/network";
import {
  type ComposerPreset,
  ask,
  navigate,
  openSettings,
  stopTurn,
  takeComposerPreset,
  useApp,
  useSnapshot,
} from "../../state/app";
import { CommandChips, CommandNoteLine } from "./CommandChips";
import { CommandPalette, paletteItems } from "./CommandPalette";
import { stepIndex } from "./Listbox";
import { type MarketOption, MarketList, loadCatalog, marketOptions, useCatalog } from "./MarketPicker";

const MAX_HEIGHT = 200;
/** Room a list leaves for the top bar above it, and for the window's edge below. */
const TOP_ROOM = 64;
const EDGE = 12;
/** Below this much room above the box, a list opens beneath it when there is more room there. */
const ROOM = 340;

/** The command in the box and its settings. */
interface Active {
  command: Command;
  values: CommandValues;
}

/** A list the box opens: over the conversation, or beneath the box when that is where the room is. */
function Pop({ closing, children }: { closing: boolean; children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const pop = node.current;
    const anchor = pop?.parentElement;
    if (!pop || !anchor) return;
    function place() {
      if (!pop || !anchor) return;
      const at = anchor.getBoundingClientRect();
      const above = at.top - TOP_ROOM;
      const below = window.innerHeight - at.bottom - EDGE;
      const up = above >= ROOM || above >= below;
      pop.dataset.side = up ? "top" : "bottom";
      pop.style.maxHeight = `${Math.round(Math.max(140, Math.min(420, up ? above : below)))}px`;
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);

  return (
    <div ref={node} className="composer-pop" data-state={closing ? "closing" : "open"}>
      {children}
      <div className="composer-pop-keys" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to pick
        </span>
        <span>
          <kbd>esc</kbd> to close
        </span>
      </div>
    </div>
  );
}

function placeholderFor(active: Active | null): string {
  if (!active) return "Ask anything, or type / for commands";
  const { command } = active;
  if (command.needs.includes("position")) return "Add a note (optional)";
  if (command.id === "grid") return "Add details, like a wider range (optional)";
  if (command.group === "trade") return "Add details, like a stop level (optional)";
  return "Add details (optional)";
}

/**
 * The message box. A question goes as typed. A command, picked from the list that `/` opens, writes
 * the message from its settings, shown as chips beside it; `$` names a market. Either way what is
 * sent is a message, which the assistant answers like any other.
 */
export function Composer() {
  const snapshot = useSnapshot();
  const running = useApp((state) => state.live !== null);
  const focusTick = useApp((state) => state.composerFocus);
  const preset = useApp((state) => state.composerPreset);
  const timeframe = useApp((state) => state.chartTimeframe);
  const { entries } = useJournal();
  const catalog = useCatalog(snapshot.network);

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState<Active | null>(null);
  /** The command just taken out of the box, drawn while its row closes. */
  const [leaving, setLeaving] = useState<Active | null>(null);
  /** The list of commands was opened from the button, over text that stays as it is. */
  const [browse, setBrowse] = useState(false);
  /** The text and caret at which a list was closed, so it stays closed until something changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** Which earlier message the arrow keys brought back, newest first; -1 for none. */
  const [recall, setRecall] = useState(-1);
  const [caretRequest, setCaretRequest] = useState<{ at: number } | null>(null);
  const [appliedPreset, setAppliedPreset] = useState<ComposerPreset | null>(null);
  // What each list showed while it was open, so it does not change under its own exit.
  const [shownPalette, setShownPalette] = useState("");
  const [shownMention, setShownMention] = useState("");

  const field = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const paletteId = useId();
  const mentionId = useId();
  const noteId = useId();

  const journalReview = useMemo(() => {
    const metrics = computeJournalMetrics(entries, snapshot.network);
    return metrics.totalCount > 0 ? journalReviewPrompt(metrics) : "";
  }, [entries, snapshot.network]);
  const context = useMemo(() => commandContext(snapshot, journalReview), [snapshot, journalReview]);
  const defaults = useMemo(() => defaultValues(snapshot, timeframe), [snapshot, timeframe]);
  const history = useMemo(
    () =>
      snapshot.turns
        .map((turn) => turn.title)
        .filter(Boolean)
        .reverse(),
    [snapshot.turns],
  );

  function commandWith(command: Command, values?: Partial<CommandValues>): Active {
    return { command, values: valuesFor(command, active?.values ?? defaults, context, values) };
  }

  function placeCaret(at: number) {
    setCaret(at);
    setCaretRequest({ at });
  }

  function choose(command: Command, values?: Partial<CommandValues>, clear = slashQuery(text) !== null) {
    setActive(commandWith(command, values));
    setLeaving(null);
    if (clear) {
      setText("");
      placeCaret(0);
    }
    setBrowse(false);
    setDismissed(null);
    setHighlight(0);
    setRecall(-1);
  }

  // A request from elsewhere in the app: a command to put in the box, or the list of commands to open.
  if (preset !== null && preset !== appliedPreset) {
    setAppliedPreset(preset);
    const command = preset.command === null ? undefined : commandById(preset.command);
    if (command) {
      choose(command, preset.values);
    } else if (preset.command === null) {
      if (text === "") {
        setText("/");
        placeCaret(1);
      } else {
        setBrowse(true);
      }
      setDismissed(null);
      setHighlight(0);
    }
  }

  // Taken once: a request must not apply again when the box is drawn anew.
  useEffect(() => {
    if (preset) takeComposerPreset();
  }, [preset]);

  const slash = slashQuery(text);
  const paletteQuery = browse ? "" : slash;
  const mention = paletteQuery === null ? mentionAt(text, caret) : null;
  const listKey = `${browse ? 1 : 0}|${caret}|${text}`;
  const paletteOpen = paletteQuery !== null && dismissed !== listKey;
  const mentionOpen = !paletteOpen && mention !== null && dismissed !== listKey;
  if (paletteOpen && paletteQuery !== shownPalette) setShownPalette(paletteQuery);
  if (mentionOpen && mention.query !== shownMention) setShownMention(mention.query);
  const palettePresence = usePresence(paletteOpen, 140);
  const mentionPresence = usePresence(mentionOpen, 140);

  const palette = useMemo(() => paletteItems(shownPalette), [shownPalette]);
  const positionsOnly = Boolean(active?.command.needs.includes("position"));
  const markets = useMemo(
    () => marketOptions(snapshot, catalog.rows, shownMention, positionsOnly),
    [snapshot, catalog.rows, shownMention, positionsOnly],
  );
  const listCount = paletteOpen ? palette.items.length : mentionOpen ? markets.items.length : 0;
  const index = Math.min(highlight, Math.max(0, listCount - 1));

  const rowPresence = usePresence(active !== null, 240);
  const shown = active ?? (rowPresence.closing ? leaving : null);
  const shownBlock = shown ? blocker(shown.command, context, shown.values) : null;
  const shownCaution = shown && !shownBlock ? caution(shown.command, context) : null;
  const blocked = active !== null && blocker(active.command, context, active.values) !== null;
  const tone = active ? commandTone(active.command, active.values) : null;
  const trade = active?.command.group === "trade";
  const preview = shown ? (shown.command.write(shown.values, context).split("\n")[0] ?? "") : "";
  // A command name still being typed is not a message: Enter picks from the list instead.
  const canSend = active ? !blocked : text.trim() !== "" && slash === null;

  useEffect(() => {
    field.current?.focus();
  }, [focusTick]);

  // Grow with the message, up to a point.
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // Put the caret where a change made in code left it, once the new text is in the field.
  useLayoutEffect(() => {
    const node = field.current;
    if (!node || !caretRequest) return;
    node.focus();
    node.setSelectionRange(caretRequest.at, caretRequest.at);
  }, [caretRequest]);

  // A click anywhere else closes an open list.
  useEffect(() => {
    if (!paletteOpen && !mentionOpen) return;
    function outside(event: PointerEvent) {
      if (wrap.current?.contains(event.target as Node)) return;
      if (browse) setBrowse(false);
      else setDismissed(listKey);
    }
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [paletteOpen, mentionOpen, browse, listKey]);

  function focusField() {
    field.current?.focus();
  }

  function drop() {
    if (!active) return;
    setLeaving(active);
    setActive(null);
  }

  function dismiss() {
    if (browse) setBrowse(false);
    else setDismissed(listKey);
  }

  function pickMarket(option: MarketOption) {
    if (!mention) return;
    if (active && active.command.params.includes("market")) {
      // The command names its market in a chip, so the market goes there and the `$` it was typed with goes.
      setActive({ ...active, values: { ...active.values, market: option.symbol } });
      setText(text.slice(0, mention.start) + text.slice(mention.end));
      placeCaret(mention.start);
    } else {
      const next = replaceMention(text, mention, marketName(option.symbol));
      setText(next.text);
      placeCaret(next.caret);
    }
    setHighlight(0);
  }

  function pickHighlighted() {
    if (paletteOpen) {
      const command = palette.items[index];
      if (command) choose(command);
    } else if (mentionOpen) {
      const option = markets.items[index];
      if (option) pickMarket(option);
    }
  }

  function send() {
    if (running) return;
    if (active) {
      if (blocked) return;
      const sending = active;
      const note = text;
      const message = writeMessage(active.command, active.values, context, note);
      drop();
      setText("");
      setCaret(0);
      setRecall(-1);
      void ask(message).then((accepted) => {
        if (accepted) return;
        // A message the core would not take is handed back, so nothing has to be set up twice.
        setActive((current) => current ?? sending);
        setText((current) => current || note);
      });
      return;
    }
    const message = text.trim();
    if (!message || slash !== null) return;
    setText("");
    setCaret(0);
    setRecall(-1);
    void ask(message).then((accepted) => {
      if (!accepted) setText((current) => current || message);
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (running) stopTurn();
    else send();
  }

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    const at = event.target.selectionStart;
    // A space right after a command's name turns the name into the command.
    const named = /^\/(\S+) $/.exec(value)?.[1];
    const command = named === undefined ? undefined : findCommand(named);
    if (command) {
      choose(command, undefined, true);
      return;
    }
    setText(value);
    setCaret(at);
    setBrowse(false);
    setHighlight(0);
    setRecall(-1);
    if (mentionAt(value, at)) loadCatalog(snapshot.network);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (paletteOpen || mentionOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (listCount > 0) setHighlight(stepIndex(index, listCount, event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        // With nothing to pick, Enter does nothing: an unfinished command name is not a message.
        if (listCount === 0) {
          if (event.key === "Enter") event.preventDefault();
          return;
        }
        event.preventDefault();
        pickHighlighted();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!running) send();
      return;
    }
    if (event.key === "Escape" && active) {
      event.preventDefault();
      drop();
      return;
    }
    if (event.key === "Backspace" && active && text === "") {
      event.preventDefault();
      drop();
      return;
    }
    // The arrow keys bring back earlier messages of this conversation, as a terminal does.
    if (active || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    const node = event.currentTarget;
    if (event.key === "ArrowUp") {
      const recalling = text === "" || (recall >= 0 && text === history[recall]);
      const firstLine = !text.slice(0, node.selectionStart).includes("\n");
      const older = history[recall + 1];
      if (!recalling || !firstLine || older === undefined) return;
      event.preventDefault();
      setRecall(recall + 1);
      setText(older);
      placeCaret(older.length);
    } else if (event.key === "ArrowDown" && recall >= 0 && text === history[recall]) {
      if (text.slice(node.selectionEnd).includes("\n")) return;
      event.preventDefault();
      const newer = recall > 0 ? (history[recall - 1] ?? "") : "";
      setRecall(recall - 1);
      setText(newer);
      placeCaret(newer.length);
    }
  }

  function toggleCommands() {
    if (paletteOpen) {
      if (!browse && text === "/") {
        setText("");
        placeCaret(0);
      } else {
        dismiss();
      }
      return;
    }
    if (text === "") {
      setText("/");
      placeCaret(1);
    } else {
      setBrowse(true);
      focusField();
    }
    setDismissed(null);
    setHighlight(0);
  }

  function toggleMarket() {
    if (mentionOpen) {
      dismiss();
      focusField();
      return;
    }
    const at = field.current?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const insert = before === "" || /\s$/.test(before) ? "$" : " $";
    setText(before + insert + text.slice(at));
    placeCaret(at + insert.length);
    setBrowse(false);
    setDismissed(null);
    setHighlight(0);
    setRecall(-1);
    loadCatalog(snapshot.network);
  }

  function fix(target: FixTarget) {
    if (target === "activity") navigate("activity");
    else openSettings(target);
  }

  const listOpen = paletteOpen || mentionOpen;
  const listId = paletteOpen ? paletteId : mentionId;

  return (
    <div ref={wrap} className="composer-wrap">
      {palettePresence.mounted ? (
        <Pop closing={palettePresence.closing}>
          <CommandPalette
            id={paletteId}
            list={palette}
            active={Math.min(highlight, Math.max(0, palette.items.length - 1))}
            context={context}
            onActive={setHighlight}
            onPick={(command) => {
              choose(command);
              focusField();
            }}
          />
        </Pop>
      ) : null}
      {mentionPresence.mounted ? (
        <Pop closing={mentionPresence.closing}>
          <MarketList
            id={mentionId}
            items={markets.items}
            sections={markets.sections}
            active={Math.min(highlight, Math.max(0, markets.items.length - 1))}
            query={shownMention}
            positionsOnly={positionsOnly}
            onActive={setHighlight}
            onPick={pickMarket}
            current={active?.command.params.includes("market") ? active.values.market : undefined}
          />
        </Pop>
      ) : null}

      <form className="composer" data-tone={tone ?? undefined} data-command={active ? "true" : undefined} onSubmit={onSubmit}>
        <div className="composer-command" data-open={active !== null} inert={active === null}>
          <div className="composer-command-inner">
            {shown ? (
              <div className="composer-command-body">
                <CommandChips
                  key={shown.command.id}
                  command={shown.command}
                  values={shown.values}
                  maxLeverage={snapshot.risk.maxLeverage}
                  onValues={(values) => setActive((current) => (current ? { ...current, values } : current))}
                  onRemove={() => {
                    drop();
                    focusField();
                  }}
                  onDone={focusField}
                />
                {shownBlock ? (
                  <CommandNoteLine id={noteId} note={shownBlock} tone="block" onFix={fix} />
                ) : shownCaution ? (
                  <CommandNoteLine id={noteId} note={shownCaution} tone="caution" onFix={fix} />
                ) : null}
                <p className="cmd-preview" title={preview}>
                  <span className="cmd-preview-label">Sends</span>
                  <span className="truncate">{preview}</span>
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <textarea
          ref={field}
          rows={1}
          role="combobox"
          aria-label="Message"
          aria-expanded={listOpen}
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen && listCount > 0 ? `${listId}-${index}` : undefined}
          aria-autocomplete="list"
          aria-describedby={active && (shownBlock || shownCaution) ? noteId : undefined}
          placeholder={placeholderFor(active)}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        />

        <div className="composer-tools">
          <button
            type="button"
            className="composer-tool"
            aria-label="Commands"
            aria-haspopup="listbox"
            aria-expanded={paletteOpen}
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleCommands}
          >
            <Icon name="slash" size={16} />
            <span className="composer-tool-label">Commands</span>
          </button>
          <button
            type="button"
            className="composer-tool"
            aria-label="Market"
            aria-haspopup="listbox"
            aria-expanded={mentionOpen}
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleMarket}
          >
            <Icon name="dollar" size={16} />
            <span className="composer-tool-label">Market</span>
          </button>
          <span className="grow" />
          {trade ? (
            <span className="chip composer-network" data-tone={snapshot.network === "mainnet" ? "warn" : undefined}>
              {networkName(snapshot.network)}
            </span>
          ) : null}
          <button
            type="submit"
            className="send"
            data-state={running ? "stop" : "send"}
            aria-label={running ? "Stop" : "Send"}
            disabled={!running && !canSend}
          >
            <Icon key={running ? "stop" : "send"} name={running ? "stop" : "send"} size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
