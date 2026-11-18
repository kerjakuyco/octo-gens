/**
 * A small, safe markdown renderer for assistant answers.
 *
 * It parses a practical subset (paragraphs, headings, emphasis, code, lists,
 * tables, block quotes, rules, links) into a plain syntax tree and renders
 * that tree as React elements. No HTML from the source is ever interpreted,
 * so model output cannot inject markup. Links never navigate the app window:
 * `https:` links get a button that asks the host to open the system browser.
 *
 * Input may be incomplete while an answer streams in. With `streaming` set,
 * an unclosed code fence, emphasis, code span or link at the very end is
 * rendered as if it were already closed, so text does not jump around.
 */

import type { ReactNode } from "react";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  children: Inline[];
  /** Nested blocks, usually one sub-list. */
  blocks: Block[];
}

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const EMPTY_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPABLE = "\\`*_{}[]()#+-.!|~>";
const WORD = /[\p{L}\p{N}]/u;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

function runLength(src: string, at: number, ch: string): number {
  let end = at;
  while (src[end] === ch) end += 1;
  return end - at;
}

/* ------------------------------------------------------------------ inline */

/** Index of the backtick run of exactly `size` that closes a code span, or -1. */
function findCodeClose(src: string, from: number, size: number): number {
  let at = from;
  while (at < src.length) {
    if (src[at] === "`") {
      const run = runLength(src, at, "`");
      if (run === size) return at;
      at += run;
    } else {
      at += 1;
    }
  }
  return -1;
}

function codeText(raw: string): string {
  const text = raw.replace(/\n/g, " ");
  // One space of padding is conventional around a span that contains backticks.
  return text.length > 2 && text.startsWith(" ") && text.endsWith(" ") ? text.slice(1, -1) : text;
}

function findEmphasisClose(src: string, from: number, marker: string): number {
  const ch = marker[0]!;
  let at = from;
  while (at < src.length) {
    const cur = src[at]!;
    if (cur === "\\") {
      at += 2;
      continue;
    }
    if (cur === "`") {
      const run = runLength(src, at, "`");
      const close = findCodeClose(src, at + run, run);
      at = close === -1 ? at + run : close + run;
      continue;
    }
    if (cur !== ch) {
      at += 1;
      continue;
    }
    const run = runLength(src, at, ch);
    const before = src[at - 1];
    const closes = at > from && before !== undefined && !/\s/.test(before);
    if (marker.length === 2) {
      if (run >= 2 && closes) {
        // In a longer run, close with the last pair so an inner single marker closes first.
        return at + run - 2;
      }
      at += run;
      continue;
    }
    if (run === 2) {
      // A strong span nested inside single emphasis: step over it whole.
      const inner = src.indexOf(ch + ch, at + 2);
      at = inner === -1 ? at + 2 : inner + 2;
      continue;
    }
    if (closes && !(ch === "_" && isWordChar(src[at + run]))) return at;
    at += run;
  }
  return -1;
}

interface InlineHit {
  nodes: Inline[];
  end: number;
}

function parseEmphasis(src: string, at: number, streaming: boolean): InlineHit | null {
  const ch = src[at]!;
  const run = runLength(src, at, ch);
  if (ch === "~" && run < 2) return null;
  const marker = run >= 2 ? ch + ch : ch;
  const open = at + marker.length;
  const after = src[open];
  if (after === undefined || /\s/.test(after)) return null;
  if (ch === "_" && isWordChar(src[at - 1])) return null;

  const wrap = (children: Inline[]): Inline => {
    if (ch === "~") return { kind: "del", children };
    return marker.length === 2 ? { kind: "strong", children } : { kind: "em", children };
  };

  const close = findEmphasisClose(src, open, marker);
  if (close === -1) {
    if (!streaming) return null;
    return { nodes: [wrap(parseInline(src.slice(open), true))], end: src.length };
  }
  return { nodes: [wrap(parseInline(src.slice(open, close), false))], end: close + marker.length };
}

function findBracketClose(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let at = from; at < src.length; at += 1) {
    const cur = src[at];
    if (cur === "\\") {
      at += 1;
    } else if (cur === "\n" && open === "(") {
      return -1;
    } else if (cur === open) {
      depth += 1;
    } else if (cur === close) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

function parseLink(src: string, at: number, streaming: boolean): InlineHit | null {
  const start = src[at] === "!" ? at + 1 : at;
  const labelEnd = findBracketClose(src, start, "[", "]");
  if (labelEnd === -1) return null;
  const label = src.slice(start + 1, labelEnd);
  if (src[labelEnd + 1] !== "(") return null;
  const targetEnd = findBracketClose(src, labelEnd + 1, "(", ")");
  if (targetEnd === -1) {
    // The address is still arriving: show the label on its own for now.
    return streaming ? { nodes: parseInline(label, false), end: src.length } : null;
  }
  const target = src.slice(labelEnd + 2, targetEnd).trim();
  const href = (target.split(/\s+/)[0] ?? "").replace(/^<|>$/g, "");
  const children = parseInline(label || href, false);
  return { nodes: [{ kind: "link", href, children }], end: targetEnd + 1 };
}

const BARE_URL = /https?:\/\/[^\s<>"'`]+/y;

function parseBareUrl(src: string, at: number): InlineHit | null {
  BARE_URL.lastIndex = at;
  const match = BARE_URL.exec(src);
  if (!match) return null;
  let url = match[0];
  // Sentence punctuation that follows a URL is not part of it.
  for (;;) {
    const last = url[url.length - 1]!;
    if (".,;:!?*_~".includes(last)) {
      url = url.slice(0, -1);
    } else if (last === ")" && url.split("(").length <= url.split(")").length - 1) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  if (url.length <= "https://".length) return null;
  return { nodes: [{ kind: "link", href: url, children: [{ kind: "text", text: url }] }], end: at + url.length };
}

export function parseInline(src: string, streaming = false): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ kind: "text", text });
      text = "";
    }
  };
  const take = (hit: InlineHit): number => {
    flush();
    out.push(...hit.nodes);
    return hit.end;
  };

  let at = 0;
  while (at < src.length) {
    const ch = src[at]!;
    const next = src[at + 1];

    if (ch === "\\" && next !== undefined && ESCAPABLE.includes(next)) {
      text += next;
      at += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ kind: "break" });
      at += 1;
      continue;
    }
    if (ch === "`") {
      const run = runLength(src, at, "`");
      const close = findCodeClose(src, at + run, run);
      if (close !== -1) {
        flush();
        out.push({ kind: "code", text: codeText(src.slice(at + run, close)) });
        at = close + run;
      } else if (streaming && at + run < src.length) {
        flush();
        out.push({ kind: "code", text: codeText(src.slice(at + run)) });
        at = src.length;
      } else {
        text += "`".repeat(run);
        at += run;
      }
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const hit = parseEmphasis(src, at, streaming);
      if (hit) {
        at = take(hit);
      } else {
        const run = runLength(src, at, ch);
        text += ch.repeat(run);
        at += run;
      }
      continue;
    }
    if (ch === "[" || (ch === "!" && next === "[")) {
      const hit = parseLink(src, at, streaming);
      if (hit) {
        at = take(hit);
        continue;
      }
    }
    if (ch === "<") {
      const match = /^<(https?:\/\/[^\s<>]+)>/.exec(src.slice(at));
      if (match) {
        const url = match[1]!;
        at = take({
          nodes: [{ kind: "link", href: url, children: [{ kind: "text", text: url }] }],
          end: at + match[0].length,
        });
        continue;
      }
    }
    if (ch === "h" && src.startsWith("http", at) && !isWordChar(src[at - 1])) {
      const hit = parseBareUrl(src, at);
      if (hit) {
        at = take(hit);
        continue;
      }
    }
    text += ch;
    at += 1;
  }
  flush();
  return out;
}

/** The visible text of inline nodes, without markup. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return " ";
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}

/* ------------------------------------------------------------------ blocks */

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < body.length; at += 1) {
    const ch = body[at]!;
    if (ch === "\\" && body[at + 1] === "|") {
      cell += "|";
      at += 1;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], at: number): boolean {
  const head = lines[at];
  const rule = lines[at + 1];
  if (head === undefined || rule === undefined) return false;
  if (!head.includes("|") || !rule.includes("-") || !TABLE_RULE.test(rule)) return false;
  return rule.includes("|") || splitRow(head).length === 1;
}

/**
 * While an answer streams in, a table's header row arrives before the rule
 * under it. A final line that opens with a pipe is treated as the start of a
 * table, so raw pipes never flash by.
 */
function isOpeningTable(lines: string[], at: number): boolean {
  if (!lines[at]!.trimStart().startsWith("|")) return false;
  const rest = lines.slice(at + 1);
  if (rest.length === 0) return true;
  return rest.length === 1 && /^[\s|:-]*$/.test(rest[0]!);
}

/**
 * Whether a new block begins at this line. When `interrupting` a paragraph, a
 * numbered item only counts if it starts at 1, so "…in\n2024. Then…" stays prose.
 */
function startsBlock(lines: string[], at: number, interrupting = false): boolean {
  const line = lines[at]!;
  if (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    isTableStart(lines, at)
  ) {
    return true;
  }
  const item = ITEM.exec(line);
  if (!item) return false;
  if (!interrupting) return true;
  const marker = item[2]!;
  return !/\d/.test(marker) || Number.parseInt(marker, 10) === 1;
}

function parseList(lines: string[], start: number, streaming: boolean): [Block, number] {
  const first = ITEM.exec(lines[start]!) ?? EMPTY_ITEM.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: { text: string[]; nested: string[]; nestedIndent: number }[] = [];
  let at = start;

  while (at < lines.length) {
    const line = lines[at]!;
    if (isBlank(line)) {
      let ahead = at + 1;
      while (ahead < lines.length && isBlank(lines[ahead]!)) ahead += 1;
      const upcoming = lines[ahead];
      if (upcoming === undefined) break;
      const item = ITEM.exec(upcoming);
      const continues = item ? item[1]!.length >= base : indentOf(upcoming) >= base + 2;
      if (!continues) break;
      at = ahead;
      continue;
    }

    const item = ITEM.exec(line) ?? EMPTY_ITEM.exec(line);
    const current = items[items.length - 1];
    if (item && !RULE.test(line)) {
      const indent = item[1]!.length;
      if (indent < base) break;
      if (indent >= base + 2 && current) {
        if (current.nested.length === 0) current.nestedIndent = indent;
        current.nested.push(line.slice(Math.min(indent, current.nestedIndent)));
      } else {
        if (/\d/.test(item[2]!) !== ordered) break;
        items.push({ text: [item[3] ?? ""], nested: [], nestedIndent: 0 });
      }
    } else {
      const indent = indentOf(line);
      if (!current || (indent < base + 2 && startsBlock(lines, at))) break;
      if (current.nested.length > 0) {
        current.nested.push(line.slice(Math.min(indent, current.nestedIndent)));
      } else {
        current.text.push(line.trim());
      }
    }
    at += 1;
  }

  const atEnd = at >= lines.length;
  const block: Block = {
    kind: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2]!, 10) : 1,
    items: items.map((item, index) => {
      const last = streaming && atEnd && index === items.length - 1;
      return {
        children: parseInline(item.text.join("\n"), last && item.nested.length === 0),
        blocks: item.nested.length > 0 ? parseBlocks(item.nested, last) : [],
      };
    }),
  };
  return [block, at];
}

function parseTable(lines: string[], start: number): [Block, number] {
  const head = splitRow(lines[start]!);
  const align = splitRow(lines[start + 1]!).map((cell): Align => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return left ? "left" : null;
  });
  const rows: string[][] = [];
  let at = start + 2;
  while (at < lines.length && !isBlank(lines[at]!) && lines[at]!.includes("|")) {
    rows.push(splitRow(lines[at]!));
    at += 1;
  }
  const width = head.length;
  const fit = (cells: string[]): Inline[][] =>
    Array.from({ length: width }, (_, column) => parseInline(cells[column] ?? "", false));
  const block: Block = {
    kind: "table",
    align: Array.from({ length: width }, (_, column) => align[column] ?? null),
    head: fit(head),
    rows: rows.map(fit),
  };
  return [block, at];
}

function parseBlocks(lines: string[], streaming: boolean): Block[] {
  const blocks: Block[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at]!;
    if (isBlank(line)) {
      at += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      at += 1;
      while (at < lines.length) {
        const candidate = lines[at]!.trim();
        if (candidate.startsWith(marker) && candidate.replaceAll(marker[0]!, "") === "") break;
        body.push(lines[at]!);
        at += 1;
      }
      at += 1; // closing fence, or past the end while the block is still streaming
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const last = streaming && at === lines.length - 1;
      blocks.push({ kind: "heading", level, children: parseInline(heading[2]!, last) });
      at += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (at < lines.length) {
        const quoted = QUOTE.exec(lines[at]!);
        if (!quoted) break;
        body.push(quoted[1] ?? "");
        at += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(body, streaming && at >= lines.length) });
      continue;
    }

    if (isTableStart(lines, at)) {
      const [table, next] = parseTable(lines, at);
      blocks.push(table);
      at = next;
      continue;
    }

    if (streaming && isOpeningTable(lines, at)) {
      const head = splitRow(line).map((cell) => parseInline(cell, false));
      blocks.push({ kind: "table", align: head.map(() => null), head, rows: [] });
      at = lines.length;
      continue;
    }

    if (ITEM.test(line)) {
      const [list, next] = parseList(lines, at, streaming);
      blocks.push(list);
      at = next;
      continue;
    }

    const body: string[] = [line.trim()];
    at += 1;
    while (
      at < lines.length &&
      !isBlank(lines[at]!) &&
      !startsBlock(lines, at, true) &&
      !(streaming && isOpeningTable(lines, at))
    ) {
      body.push(lines[at]!.trim());
      at += 1;
    }
    blocks.push({
      kind: "paragraph",
      children: parseInline(body.join("\n"), streaming && at >= lines.length),
    });
  }
  return blocks;
}

/** Parses markdown into blocks. Set `streaming` while the text is still arriving. */
export function parseMarkdown(source: string, streaming = false): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines, streaming);
}

/* ------------------------------------------------------------------ render */

/** Returns the URL when it is safe to hand to the system browser. */
export function safeExternalUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const NUMERIC_CELL = /^[+\-−]?[$€£]?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|x|[A-Za-z]{1,6})?$/;

function isNumericColumn(rows: Inline[][][], column: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const text = inlineText(row[column] ?? []).trim();
    if (text === "" || text === "—" || text === "-") continue;
    if (!NUMERIC_CELL.test(text)) return false;
    seen += 1;
  }
  return seen > 0;
}

interface RenderOptions {
  onOpenLink?: (url: string) => void;
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M6.5 3.5h-3v9h9v-3M9 3h4v4M13 3 7.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function renderInline(nodes: Inline[], options: RenderOptions): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "break":
        return <br key={index} />;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children, options)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children, options)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children, options)}</del>;
      case "link": {
        const label = renderInline(node.children, options);
        const url = safeExternalUrl(node.href);
        if (!url) {
          const shown = inlineText(node.children);
          return (
            <span key={index}>
              {label}
              {node.href && shown !== node.href ? ` (${node.href})` : null}
            </span>
          );
        }
        const { onOpenLink } = options;
        return (
          <span key={index} className="md-link">
            {label}
            {onOpenLink ? (
              <button
                type="button"
                className="md-link-open"
                title={url}
                aria-label={`Open ${new URL(url).hostname} in your browser`}
                onClick={() => onOpenLink(url)}
              >
                <ExternalGlyph />
              </button>
            ) : null}
          </span>
        );
      }
    }
  });
}

const CARET = <span key="caret" className="md-caret" aria-hidden="true" />;

function renderBlock(block: Block, key: number, options: RenderOptions, caret: boolean): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p key={key}>
          {renderInline(block.children, options)}
          {caret ? CARET : null}
        </p>
      );
    case "heading": {
      // Answers sit under the page and turn headings, so shift levels down by two.
      const Tag = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.children, options)}
          {caret ? CARET : null}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={key} className="md-code" data-lang={block.lang || undefined}>
          <code>
            {block.text}
            {caret ? CARET : null}
          </code>
        </pre>
      );
    case "rule":
      return <hr key={key} />;
    case "quote":
      return <blockquote key={key}>{renderBlocks(block.blocks, options, caret)}</blockquote>;
    case "list": {
      const lastItem = block.items.length - 1;
      const items = block.items.map((item, index) => {
        const here = caret && index === lastItem;
        return (
          <li key={index}>
            {renderInline(item.children, options)}
            {here && item.blocks.length === 0 ? CARET : null}
            {renderBlocks(item.blocks, options, here)}
          </li>
        );
      });
      if (!block.ordered) return <ul key={key}>{items}</ul>;
      return (
        <ol key={key} start={block.start !== 1 ? block.start : undefined}>
          {items}
        </ol>
      );
    }
    case "table": {
      const classes = block.align.map((align, column) => {
        if (align) return `md-${align}`;
        return isNumericColumn(block.rows, column) ? "md-right" : undefined;
      });
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  <th key={column} scope="col" className={classes[column]}>
                    {renderInline(cell, options)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className={classes[column]}>
                      {renderInline(cell, options)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {caret ? CARET : null}
        </div>
      );
    }
  }
}

function renderBlocks(blocks: Block[], options: RenderOptions, caret: boolean): ReactNode[] {
  const last = blocks.length - 1;
  return blocks.map((block, index) => renderBlock(block, index, options, caret && index === last));
}

export interface MarkdownProps {
  text: string;
  /** The text is still arriving: close unfinished markup and show a caret. */
  streaming?: boolean;
  /** Called for `https:` links. Without it links render as plain text. */
  onOpenLink?: (url: string) => void;
}

export function Markdown({ text, streaming = false, onOpenLink }: MarkdownProps) {
  const blocks = parseMarkdown(text, streaming);
  return (
    <div className="md">
      {renderBlocks(blocks, { onOpenLink }, streaming)}
      {streaming && blocks.length === 0 ? CARET : null}
    </div>
  );
}
