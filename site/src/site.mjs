// Shared constants and small HTML helpers for the pages.

export const REPO = "https://github.com/kerjakuyco/octo-neo";
export const RELEASES = `${REPO}/releases`;
export const ISSUES = `${REPO}/issues`;
export const ADVISORY = `${REPO}/security/advisories/new`;
export const TRADINGVIEW = "https://www.tradingview.com";
export const VERSION = "0.5.0";

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

/** Line icons on a 24 px grid, the app's own shapes. They take the text color. */
const ICONS = {
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 21 19.5H3zM12 10v4.5M12 17v.2"/>',
  news: '<path d="M4.5 5.5h11.5v13H6.5a2 2 0 0 1-2-2zM16 9.5h3.5v7a2 2 0 0 1-2 2H6.5M7.5 9h5.5M7.5 12.5h5.5M7.5 16h3"/>',
  wallet: '<path d="M4 7.5 16.5 4v3.5M4 7.5h16v12H5a1 1 0 0 1-1-1zM20 12h-5.5v3.5H20"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  external: '<path d="M10 5H5.5v13.5H19V14M14 4.5h5.5V10M19.5 4.5 11 13"/>',
};

export function icon(name, size = 18, className = "") {
  return `<svg class="icon${className ? ` ${className}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

/** The app icon in its tile, drawn small: the simplified mark the favicon uses. */
export function tile(size = 28) {
  return `<svg class="tile" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">
  <rect width="32" height="32" rx="7.5" fill="#2a63dd"/>
  <g fill="none" stroke="#ffffff" stroke-width="2.7" stroke-linecap="round">
    <path d="M 20.6 16.6 C 23.6 18.6, 27.2 17.6, 27.2 14.2"/>
    <path d="M 20 19 C 22 22.6, 25.6 23.4, 27.4 21.4"/>
    <path d="M 18 20.2 C 18.2 23.8, 20.4 26.4, 23.6 26.2"/>
    <path d="M 11.4 16.6 C 8.4 18.6, 4.8 17.6, 4.8 14.2"/>
    <path d="M 12 19 C 10 22.6, 6.4 23.4, 4.6 21.4"/>
    <path d="M 14 20.2 C 13.8 23.8, 11.6 26.4, 8.4 26.2"/>
  </g>
  <ellipse cx="16" cy="12.6" rx="7.4" ry="7.6" fill="#ffffff"/>
  <rect x="11.4" y="12.6" width="3.4" height="1.5" rx="0.75" fill="#2a63dd"/>
  <rect x="17.2" y="12.6" width="3.4" height="1.5" rx="0.75" fill="#2a63dd"/>
</svg>`;
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

/** Label and value pairs, the way the app lists the facts of a ticket. */
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
  return `<details class="reference">
<summary>${icon("chevron", 16)}<span class="reference-title">${summary}</span></summary>
<div class="reference-body">
${body}
</div>
</details>`;
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
  ["/download/", "Get OctoNeo"],
];

/** The end of a feature page: the next page, and the one action. */
function docEnd(path) {
  const at = TOUR.findIndex(([href]) => href === path);
  if (at < 0) return "";
  const [href, label] = TOUR[(at + 1) % TOUR.length];
  // Where the next page is the download page, the action is the way there.
  const next = href === "/download/" ? "" : `<p class="doc-next"><span class="doc-next-label">Next</span> <a href="${href}">${label}</a></p>`;
  const action = path === "/download/" ? "" : `<a class="button button-brand" href="/download/">Get OctoNeo</a>`;
  return `<div class="doc-end">
${next}
${action}
</div>`;
}

/**
 * A feature page: its title, a lead, an optional picture, then sections beside an index of them,
 * and at the end the next page. `sections` is a list of { id, title, lead, body }; the index
 * names each section by its heading. Where there is no room beside the text, the index is folded
 * above it.
 */
export function docPage({ path, title, lead, picture = "", sections }) {
  const index = sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join("\n");
  return `<div class="page-head">
  <div class="wrap">
    <h1>${title}</h1>
    <p class="page-lead">${lead}</p>
  </div>
  ${picture ? `<div class="wrap page-picture">${picture}</div>` : ""}
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
${docEnd(path)}
  </div>
</div>`;
}

/** Shell commands in a block. Lines that start with # are comments. */
export function shell(lines) {
  const html = lines
    .map((line) => {
      const [command, comment] = line.split(/(\s+#\s.*)$/);
      if (line.startsWith("#")) return `<span class="comment">${esc(line)}</span>`;
      return `${esc(command)}${comment ? `<span class="comment">${esc(comment)}</span>` : ""}`;
    })
    .join("\n");
  return `<pre class="code"><code>${html}</code></pre>`;
}

/** A literal block, such as a message the app signs. */
export function literal(text, label) {
  return `<pre class="code" aria-label="${esc(label)}"><code>${esc(text)}</code></pre>`;
}
