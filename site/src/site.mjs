// Shared constants and small HTML helpers for the pages.

export const REPO = "https://github.com/kerjakuyco/octo-neo";
export const RELEASES = `${REPO}/releases`;
export const ISSUES = `${REPO}/issues`;
export const ADVISORY = `${REPO}/security/advisories/new`;
export const TRADINGVIEW = "https://www.tradingview.com";
export const VERSION = "0.6.0";

/** A file in the repository, on GitHub. */
export const doc = (path, anchor = "") => `${REPO}/blob/main/${path}${anchor ? `#${anchor}` : ""}`;

/** The pages in the header, in order. */
export const NAV = [
  { href: "/assistant/", label: "Assistant" },
  { href: "/models/", label: "Models" },
  { href: "/markets/", label: "Markets" },
  { href: "/news/", label: "News" },
  { href: "/wallet/", label: "Wallet" },
  { href: "/safety/", label: "Safety" },
  { href: "/open-source/", label: "Open source" },
];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Line icons on a 24 px grid, the app's own shapes unless marked. They take the text color. Other
 * companies' marks are never drawn: an operating system or a provider is named in text.
 */
const ICONS = {
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  star: '<path d="m12 4 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.7-5 2.7.9-5.6-4-3.9 5.6-.8z"/>',
  assistant: '<path d="M4 5.5h16v10.5H9.8L5.5 19.5V16H4z"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 21 19.5H3zM12 10v4.5M12 17v.2"/>',
  news: '<path d="M4.5 5.5h11.5v13H6.5a2 2 0 0 1-2-2zM16 9.5h3.5v7a2 2 0 0 1-2 2H6.5M7.5 9h5.5M7.5 12.5h5.5M7.5 16h3"/>',
  wallet: '<path d="M4 7.5 16.5 4v3.5M4 7.5h16v12H5a1 1 0 0 1-1-1zM20 12h-5.5v3.5H20"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  external: '<path d="M10 5H5.5v13.5H19V14M14 4.5h5.5V10M19.5 4.5 11 13"/>',
  model: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 4v3M14 4v3M17 10h3M17 14h3M14 17v3M10 17v3M4 10h3M4 14h3"/>',
  trade: '<path d="M4 8.5h15m-4-4 4 4-4 4M20 15.5H5m4 4-4-4 4-4"/>',
  plug: '<path d="M9 4v4M15 4v4M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V20"/>',
  appearance: '<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11.2v5M12 7.8v.2"/>',
  // Not the app's: an arrow to the next page, and a folder and a file for the drawn code window.
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  folder: '<path d="M4 6.5h5.5l2 2H20v10H4z"/>',
  file: '<path d="M6.5 4h7.5l4 4v12h-11.5zM14 4v4h4"/>',
};

export function icon(name, size = 18, className = "") {
  return `<svg class="icon${className ? ` ${className}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

/**
 * Something to read before acting. Its words say what it is; the dot beside them only marks its
 * kind: amber for what has not been tried on the live exchange, red for the risk of trading.
 */
export function callout(html, tone = "warn") {
  return `<div class="callout" data-tone="${tone}" role="note"><span class="callout-dot" aria-hidden="true"></span><div class="callout-body">${html}</div></div>`;
}

/** Inline code. */
export const code = (text) => `<code>${esc(text)}</code>`;

/** A link that leaves the site. It opens in the same tab, like any other link. */
export const out = (href, text) => `<a href="${esc(href)}">${text}</a>`;

/**
 * A table of facts. Cells are HTML. With `stack`, rows become blocks on narrow screens,
 * each cell labeled with its column, so a three-column table still reads on a phone.
 */
export function table({ head, rows, caption = "", stack = false, numeric = [], nowrap = [], rowHeaders = true, className = "" }) {
  const plain = (html) => html.replace(/<[^>]+>/g, "");
  // A stacked table changes its display on narrow screens, which drops the table's meaning in some
  // browsers; explicit roles keep it.
  const role = (name) => (stack ? ` role="${name}"` : "");
  const num = (index) => {
    const names = [numeric.includes(index) ? "num" : "", nowrap.includes(index) ? "nowrap" : ""].filter(Boolean);
    return names.length ? ` class="${names.join(" ")}"` : "";
  };
  const cls = ["table", stack ? "stack" : "", className].filter(Boolean).join(" ");
  const headRow = head.map((html, index) => `<th scope="col"${num(index)}${role("columnheader")}>${html}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = row
        .map((html, index) => {
          if (index === 0 && rowHeaders) return `<th scope="row"${num(index)}${role("rowheader")}>${html}</th>`;
          const label = stack ? ` data-label="${esc(plain(head[index]))}"` : "";
          return `<td${num(index)}${label}${role("cell")}>${html}</td>`;
        })
        .join("");
      return `<tr${role("row")}>${cells}</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table class="${cls}"${role("table")}>${caption ? `<caption>${caption}</caption>` : ""}
<thead${role("rowgroup")}><tr${role("row")}>${headRow}</tr></thead>
<tbody${role("rowgroup")}>
${body}
</tbody></table></div>`;
}

/**
 * Label and value pairs, the way the app lists the facts of a ticket. In a section they are laid
 * out as a grid of short items; in a reference, as rows.
 */
export function facts(pairs, className = "") {
  return `<dl class="facts${className ? ` ${className}` : ""}">${pairs
    .map(([term, value]) => `<div class="fact"><dt>${term}</dt><dd>${value}</dd></div>`)
    .join("")}</dl>`;
}

/** A section of a document page, with the id the page index links to. */
export function section(id, title, body, { lead = "" } = {}) {
  return `<section class="doc-section" id="${id}" aria-labelledby="${id}-title">
<h2 id="${id}-title">${title}</h2>
${lead ? `<p class="section-lead">${lead}</p>` : ""}
${body}
</section>`;
}

/**
 * Reference a reader opens when they need it, such as request budgets or error codes: a summary
 * that says what is inside, then the material. Nothing in it is left out of the page.
 */
export function reference(summary, body) {
  // A reference that holds one table and nothing else lets the table fill it, under the summary.
  const flush = /^\s*<div class="table-wrap">[\s\S]*<\/table><\/div>\s*$/.test(body);
  return `<details class="reference${flush ? " reference-flush" : ""}">
<summary>${icon("chevron", 16)}<span class="reference-title">${summary}</span></summary>
<div class="reference-body">
${body}
</div>
</details>`;
}

/** The two actions the site offers everywhere: the download, and the source. */
export function actions() {
  return `<div class="actions">
  <a class="button button-brand" href="/download/">Download OctoNeo${icon("chevron", 16, "button-chevron")}</a>
  <a class="button button-quiet" href="${REPO}">View source on GitHub</a>
</div>`;
}

/** The feature pages in reading order. Each ends by pointing at the next. */
const TOUR = [
  ["/assistant/", "The assistant"],
  ["/models/", "Models"],
  ["/markets/", "Markets and orders"],
  ["/news/", "News"],
  ["/wallet/", "Wallet and funds"],
  ["/safety/", "Safety and privacy"],
  ["/open-source/", "Open source"],
  ["/download/", "Download OctoNeo"],
];

/**
 * The last line of a page's text: the next page of the tour. Where that would be the download, the
 * closing band's button is the way there, so there is no line.
 */
function docNext(path) {
  const at = TOUR.findIndex(([href]) => href === path);
  if (at < 0) return "";
  const [href, label] = TOUR[(at + 1) % TOUR.length];
  if (href === "/download/") return "";
  return `<p class="doc-next"><span class="doc-next-label">Next</span><a href="${href}">${label}${icon("arrow", 18, "doc-next-arrow")}</a></p>`;
}

/** The band that closes a feature page: one line, and the two actions. Words from the home page. */
function docClose(path) {
  if (path === "/download/") return "";
  return `<section class="page-close" aria-labelledby="page-close-title">
  <div class="wrap">
    <h2 id="page-close-title">Start with a question</h2>
    <p>Download OctoNeo, connect a model and ask “BTC outlook”. When you are ready to trade, start on testnet.</p>
    ${actions()}
  </div>
</section>`;
}

/**
 * A feature page: a centered head with its title, a lead and the two actions; one large picture of
 * the app drawn in HTML (`visual`); then sections beside an index of them, the next page, and the
 * closing band. `sections` is a list of { id, title, lead, body }; the index names each section by
 * its heading. Where there is no room beside the text, the index is folded above it. `meta` is a
 * short line under the actions; `buttons` replaces the two actions; `notice`, such as a callout,
 * stands under the picture, before the text.
 */
export function docPage({ path, title, lead, meta = "", buttons = actions(), visual = "", notice = "", sections }) {
  const index = sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join("\n");
  return `<div class="page-head">
  <div class="wrap page-intro">
    <h1>${title}</h1>
    <p class="page-lead">${lead}</p>
    ${buttons}
    ${meta ? `<p class="page-meta">${meta}</p>` : ""}
  </div>
  ${visual ? `<div class="wrap page-visual">${visual}</div>` : ""}
  ${notice ? `<div class="wrap page-notice">${notice}</div>` : ""}
</div>
<div class="wrap doc">
  <nav class="toc" aria-labelledby="toc-title">
    <h2 class="toc-title" id="toc-title">On this page</h2>
    <ol>
${index}
    </ol>
  </nav>
  <div class="doc-body">
<details class="reference toc-inline">
<summary>${icon("chevron", 16)}<span class="reference-title">On this page</span></summary>
<nav aria-label="On this page">
<ol>
${index}
</ol>
</nav>
</details>
${sections.map((s) => section(s.id, s.title, s.body, { lead: s.lead })).join("\n")}
${docNext(path)}
  </div>
</div>
${docClose(path)}`;
}

/**
 * Shell commands in a block. Lines that start with # are comments. Each line is its own element,
 * so the stylesheet can mark commands with a prompt and indent a command that wraps; the line
 * breaks stay in the text, for copying and for reading without styles. With `title`, the block is
 * a window with that name in its bar.
 */
export function shell(lines, { title = "" } = {}) {
  const html = lines
    .map((line) => {
      if (line.startsWith("#")) return `<span class="line comment">${esc(line)}</span>`;
      const [command, comment] = line.split(/(\s+#\s.*)$/);
      return `<span class="line command">${esc(command)}${comment ? `<span class="comment">${esc(comment)}</span>` : ""}</span>`;
    })
    .join("\n");
  const block = `<pre class="code shell"><code>${html}</code></pre>`;
  if (!title) return block;
  return `<div class="code-window">
<div class="code-window-bar"><span class="code-window-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="code-window-title">${title}</span></div>
${block}
</div>`;
}

/** A literal block, such as a message the app signs. */
export function literal(text, label) {
  return `<pre class="code" aria-label="${esc(label)}"><code>${esc(text)}</code></pre>`;
}

/* ----------------------------------------------- the app, drawn in HTML */

/**
 * A slice of the app drawn in HTML: the picture at the head of a feature page. It holds sample
 * data, and its caption says whose. Like a picture, it is read by its label: assistive technology
 * gets `label` instead of every number and drawn button inside it, and nothing in it takes focus.
 */
export function ui({ label, caption, body, className = "" }) {
  return `<figure class="ui-figure${className ? ` ${className}` : ""}">
<div class="ui" role="img" aria-label="${esc(label)}">
${body}
</div>
<figcaption>${caption}</figcaption>
</figure>`;
}

/** A small rounded label, as the app draws a side, a network or a status. */
export const chip = (text, tone = "") => `<span class="ui-chip"${tone ? ` data-tone="${tone}"` : ""}>${text}</span>`;

/** A network: amber for testnet, as the app marks it, and the same for real funds. */
export const network = (text, tone = "warn") => `<span class="ui-chip ui-network" data-tone="${tone}"><span class="ui-dot"></span>${text}</span>`;

/** Label and value pairs inside a drawn card, values in figures. */
export function uiFacts(pairs, className = "") {
  return `<dl class="ui-facts${className ? ` ${className}` : ""}">${pairs
    .map(([term, value, tone = ""]) => `<div><dt>${term}</dt><dd class="num${tone ? ` ${tone}` : ""}">${value}</dd></div>`)
    .join("")}</dl>`;
}

/** A drawn button: a picture of one, so it is a span, not a control. */
export const uiButton = (text, kind = "") => `<span class="ui-button${kind ? ` ui-button-${kind}` : ""}">${text}</span>`;
