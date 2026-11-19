import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, inlineText, parseInline, parseMarkdown, safeExternalUrl } from "./markdown";

function html(text: string, streaming = false): string {
  return renderToStaticMarkup(<Markdown text={text} streaming={streaming} onOpenLink={() => {}} />);
}

describe("blocks", () => {
  it("splits paragraphs and keeps single newlines as line breaks", () => {
    expect(html("BTC 62,786.40 USDT\nTestnet\n\nNext paragraph")).toBe(
      '<div class="md"><p>BTC 62,786.40 USDT<br/>Testnet</p><p>Next paragraph</p></div>',
    );
  });

  it("renders headings two levels down so they nest under the page", () => {
    expect(html("# Verdict\n### Risks")).toBe(
      '<div class="md"><h3 class="md-h md-h1">Verdict</h3><h5 class="md-h md-h3">Risks</h5></div>',
    );
  });

  it("parses bullet lists that follow a paragraph without a blank line", () => {
    const blocks = parseMarkdown("Key points:\n- trend is up\n- RSI 61");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(html("- a\n- b")).toBe('<div class="md"><ul><li>a</li><li>b</li></ul></div>');
  });

  it("keeps numbering and one level of nesting", () => {
    expect(html("3. third\n4. fourth\n   - detail\n   - more")).toBe(
      '<div class="md"><ol start="3"><li>third</li><li>fourth<ul><li>detail</li><li>more</li></ul></li></ol></div>',
    );
  });

  it("does not turn a sentence that starts with a year into a list", () => {
    const blocks = parseMarkdown("It peaked in\n2024. Then it fell.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("paragraph");
  });

  it("separates a bullet list from the numbered list after it", () => {
    const kinds = parseMarkdown("- a\n1. b").map((block) => block.kind === "list" && block.ordered);
    expect(kinds).toEqual([false, true]);
  });

  it("renders fenced code verbatim", () => {
    expect(html('```json\n{"pair": "<b>BTC</b>"}\n```')).toBe(
      '<div class="md"><pre class="md-code" data-lang="json"><code>{&quot;pair&quot;: &quot;&lt;b&gt;BTC&lt;/b&gt;&quot;}</code></pre></div>',
    );
  });

  it("renders tables with declared alignment and right-aligned figures", () => {
    const table = "| Pair | Price | Note |\n|:--|--:|--|\n| BTC | 84,215.50 | up |\n| ETH | 2,145.72 | flat |";
    const out = html(table);
    expect(out).toContain('<th scope="col" class="md-left">Pair</th>');
    expect(out).toContain('<td class="md-right">84,215.50</td>');
    expect(out).toContain("<td>up</td>");
  });

  it("right-aligns numeric columns even without alignment markers", () => {
    const out = html("| Pair | Change |\n|---|---|\n| BTC | +1.24% |\n| ETH | −0.80% |");
    expect(out).toContain('<td class="md-right">+1.24%</td>');
    expect(out).toContain("<td>BTC</td>");
  });

  it("pads short table rows instead of dropping cells", () => {
    const [table] = parseMarkdown("| a | b |\n|---|---|\n| 1 |");
    expect(table?.kind === "table" && table.rows[0]?.length).toBe(2);
  });

  it("renders block quotes and rules", () => {
    expect(html("> risk first\n\n---")).toBe(
      '<div class="md"><blockquote><p>risk first</p></blockquote><hr/></div>',
    );
  });
});

describe("inline", () => {
  it("handles strong, emphasis and both together", () => {
    expect(html("**bold** and *soft* and ***both***")).toBe(
      '<div class="md"><p><strong>bold</strong> and <em>soft</em> and <strong><em>both</em></strong></p></div>',
    );
  });

  it("nests strong inside emphasis", () => {
    expect(html("*a **b** c*")).toBe('<div class="md"><p><em>a <strong>b</strong> c</em></p></div>');
  });

  it("leaves snake_case, arithmetic and stray markers alone", () => {
    expect(inlineText(parseInline("call get_order_book then 5 * 3 * 2"))).toBe(
      "call get_order_book then 5 * 3 * 2",
    );
    expect(parseInline("get_order_book")).toEqual([{ kind: "text", text: "get_order_book" }]);
    expect(parseInline("a * b")).toEqual([{ kind: "text", text: "a * b" }]);
    expect(parseInline("**unclosed")).toEqual([{ kind: "text", text: "**unclosed" }]);
  });

  it("renders code spans without interpreting their content", () => {
    expect(html("use `**kwargs` here")).toBe('<div class="md"><p>use <code>**kwargs</code> here</p></div>');
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not emphasis\\*")).toEqual([{ kind: "text", text: "*not emphasis*" }]);
  });

  it("never emits markup from the source", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror="alert(1)">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("links", () => {
  it("gives https links a button and never an anchor", () => {
    const out = html("See [the docs](https://example.com/docs).");
    expect(out).toContain('aria-label="Open example.com in your browser"');
    expect(out).toContain('title="https://example.com/docs"');
    expect(out).not.toContain("<a ");
  });

  it("shows other schemes as plain text with the address visible", () => {
    const out = html("[click](javascript:alert(1)) and [plain](http://example.com)");
    expect(out).not.toContain("<button");
    expect(out).toContain("click (javascript:alert(1))");
    expect(out).toContain("plain (http://example.com)");
  });

  it("links bare URLs and leaves sentence punctuation outside", () => {
    const nodes = parseInline("Read https://example.com/a_(b), then go.");
    expect(nodes[1]).toEqual({
      kind: "link",
      href: "https://example.com/a_(b)",
      children: [{ kind: "text", text: "https://example.com/a_(b)" }],
    });
    expect(nodes[2]).toEqual({ kind: "text", text: ", then go." });
  });

  it("renders links as text when no opener is provided", () => {
    const out = renderToStaticMarkup(<Markdown text="[docs](https://example.com)" />);
    expect(out).toBe('<div class="md"><p><span class="md-link">docs</span></p></div>');
  });

  it("only accepts https for the system browser", () => {
    expect(safeExternalUrl("https://openrouter.ai/keys")).toBe("https://openrouter.ai/keys");
    expect(safeExternalUrl("http://example.com")).toBeNull();
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
  });
});

describe("streaming", () => {
  it("closes unfinished emphasis at the end and shows a caret", () => {
    expect(html("Trend is **clearly", true)).toBe(
      '<div class="md"><p>Trend is <strong>clearly</strong><span class="md-caret" aria-hidden="true"></span></p></div>',
    );
  });

  it("only closes markup in the last block", () => {
    const blocks = parseMarkdown("a stray * here\n\nstill **typing", true);
    expect(blocks[0]).toEqual({ kind: "paragraph", children: [{ kind: "text", text: "a stray * here" }] });
    expect(blocks[1]?.kind === "paragraph" && blocks[1].children[1]?.kind).toBe("strong");
  });

  it("renders an open code fence as code", () => {
    const out = html("```\nlet price", true);
    expect(out).toContain('<pre class="md-code"><code>let price<span class="md-caret"');
  });

  it("shows the label of a link whose address is still arriving", () => {
    expect(inlineText(parseInline("see [the order book](https://exa", true))).toBe("see the order book");
  });

  it("starts a table as soon as its header row begins", () => {
    const out = html("Readings:\n| Reading | Valu", true);
    expect(out).toContain("<p>Readings:</p>");
    expect(out).toContain('<th scope="col">Reading</th>');
    expect(out).not.toContain("| Reading");
    expect(html("| Reading | Value |\n|:--", true)).toContain('<th scope="col">Value</th>');
    expect(html("| Reading | Valu")).toContain("| Reading | Valu");
  });

  it("puts the caret in the last list item", () => {
    expect(html("- one\n- two", true)).toBe(
      '<div class="md"><ul><li>one</li><li>two<span class="md-caret" aria-hidden="true"></span></li></ul></div>',
    );
  });

  it("shows a caret before any text has arrived", () => {
    expect(html("", true)).toBe('<div class="md"><span class="md-caret" aria-hidden="true"></span></div>');
  });
});
