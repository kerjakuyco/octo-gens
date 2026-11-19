// Takes the app pictures the site shows, from the interface running in a browser against its built-in mock.
//
//   cd ..                                   # the repository root
//   pnpm build && pnpm exec vite preview --port 4322 --strictPort
//   cd site
//   CHROME=/path/to/chrome node tools/screenshots.mjs [name ...]
//
// APP_URL overrides http://localhost:4322/. Each picture is saved in light and dark as
// src/assets/shots/<name>-<theme>-<pixel width>.webp: full windows at 1x and 2x, crops at 2x.
// A picture named <name>-phone is the crop the site shows in place of <name> on a phone.
// The mock shows a fictional account and a fictional model; nothing here reaches a real service.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "shots");
const APP = process.env.APP_URL || "http://localhost:4322/";
const only = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true });

const ask = (text) => `history=0&network=testnet&wallet=connected&ask=${encodeURIComponent(text)}`;

/**
 * A whole window is 788 pixels high: the order book's rows are 23 pixels apart from 627, so its
 * bottom edge falls between two rows. Rows in other lists that the edge would cut are hidden, so
 * a picture never ends on half a line.
 */
const WINDOW = { width: 1280, height: 788 };

/** Hides every table row or list item that the line y crosses, so a crop ends between rows. */
const hideCut = (y) => `(() => {
  for (const node of document.querySelectorAll("tr, li")) {
    const b = node.getBoundingClientRect();
    if (b.height > 0 && b.height < 120 && b.top < ${y} && b.bottom > ${y}) node.style.visibility = "hidden";
  }
})()`;

/** The smallest box around every element matching the selectors, padded. */
const around = (selectors, pad = 16) => `(() => {
  // A closed dialog or a collapsed element reports an empty box at the origin; it is not on screen.
  const boxes = ${JSON.stringify(selectors)}
    .flatMap((s) => [...document.querySelectorAll(s)])
    .map((n) => n.getBoundingClientRect())
    .filter((b) => b.width > 0 && b.height > 0);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b.left)) - ${pad};
  const top = Math.min(...boxes.map((b) => b.top)) - ${pad};
  const right = Math.max(...boxes.map((b) => b.right)) + ${pad};
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + ${pad};
  return { x: Math.round(left + scrollX), y: Math.round(top + scrollY), width: Math.round(right - left), height: Math.round(bottom - top) };
})()`;

/**
 * Parts of the conversation are taken in a window 776 pixels wide with the sidebar and the panel
 * closed: the conversation is then 728 pixels wide, and a crop 760 wide, the width of the site's
 * text column, keeps 16 pixels of the app's own margin on each side.
 */
const COLUMN = { width: 776, query: "&sidebar=0&panel=0" };
const column = (selectors, pad = 16) => `(() => {
  const box = ${around(selectors, pad)};
  return box && { ...box, x: 8, width: 760 };
})()`;

/** A settings dialog down to its last line of content, not its full fixed height. */
const settings = `(() => {
  const dialog = document.querySelector(".dialog").getBoundingClientRect();
  let bottom = 0;
  for (const node of document.querySelectorAll(".dialog *")) {
    if (node.children.length && !/^(INPUT|BUTTON|SELECT|SVG)$/i.test(node.tagName)) continue;
    const b = node.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && getComputedStyle(node).visibility !== "hidden") bottom = Math.max(bottom, b.bottom);
  }
  return { x: Math.round(dialog.left), y: Math.round(dialog.top), width: Math.round(dialog.width), height: Math.round(Math.min(dialog.bottom, bottom + 32) - dialog.top) };
})()`;

/** The tabs of the market panel are cropped to one height, the height of the Technicals tab. */
let tabHeight = 0;
const tabTop = `(() => Math.round(document.querySelector('.panel [role="tablist"]').getBoundingClientRect().top - 14))()`;
const tabContentHeight = `(() => {
  const tabs = document.querySelector('.panel [role="tablist"]').getBoundingClientRect();
  const body = document.querySelector('.panel [role="tabpanel"]');
  const bottom = Math.max(...[...body.querySelectorAll("*")].map((n) => n.getBoundingClientRect().bottom));
  return Math.round(bottom + 14 - (tabs.top - 14));
})()`;

const SHOTS = [
  // Whole windows, each with the crop a phone shows instead.
  {
    name: "desk",
    query: "seed=conversation",
    scales: [1, 2],
    window: WINDOW,
    // The conversation from its start: the answer to "BTC outlook" with the cards it read.
    prepare: async (page) => {
      await page.evaluate("document.querySelector('.thread').scrollTop = 0");
      await sleep(300);
      await page.evaluate(hideCut(WINDOW.height));
    },
    // On a phone, the market panel alone, down to the third row of the order book.
    phone: `(() => {
      const panel = document.querySelector(".panel").getBoundingClientRect();
      const rows = [...document.querySelectorAll(".panel .book-row")].slice(0, 3);
      return { x: Math.round(panel.left), y: 0, width: Math.round(panel.width), height: Math.round(rows.at(-1).getBoundingClientRect().bottom + 1) };
    })()`,
  },
  {
    name: "markets",
    query: "page=markets",
    scales: [1, 2],
    window: WINDOW,
    prepare: async (page) => page.evaluate(hideCut(WINDOW.height)),
    // On a phone, the screener alone.
    phone: `(() => {
      const panel = document.querySelector(".panel").getBoundingClientRect();
      const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
      return { x: Math.round(sidebar.right), y: 0, width: Math.round(panel.left - sidebar.right), height: ${WINDOW.height} };
    })()`,
  },
  {
    name: "account",
    query: "page=account&seed=conversation&positions=1",
    scales: [1, 2],
    window: WINDOW,
    prepare: async (page) => page.evaluate(hideCut(WINDOW.height)),
    // On a phone, the account alone.
    phone: `(() => {
      const panel = document.querySelector(".panel").getBoundingClientRect();
      const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
      return { x: Math.round(sidebar.right), y: 0, width: Math.round(panel.left - sidebar.right), height: ${WINDOW.height} };
    })()`,
  },
  // Parts of the conversation.
  // These two run at the mock's own pace, so the time on the activity line is a realistic one.
  {
    name: "turn-btc",
    query: ask("BTC outlook") + COLUMN.query,
    width: COLUMN.width,
    live: true,
    height: 1200,
    // The mock reads a fresh order book for the card and for the answer; take the picture when they agree.
    consistent: `(() => {
      const card = /Bids (\\d+)%/.exec(document.querySelector('.turn .share-legend')?.textContent ?? "")?.[1];
      const text = /Bids hold (\\d+)%/.exec(document.querySelector('.turn .md')?.textContent ?? "")?.[1];
      return Boolean(card) && card === text;
    })()`,
    clip: column([".turn .said", ".turn .activity", ".turn .cards", ".turn .md"]),
  },
  {
    name: "plan-ticket",
    query: ask("Long ETH, 1% risk") + COLUMN.query,
    width: COLUMN.width,
    height: 1700,
    // The cards above the plan are hidden, so the picture does not open on the edge of one.
    prepare: async (page) =>
      page.evaluate(`(() => {
        const cards = [...document.querySelectorAll(".turn .cards > *")];
        const plan = cards.findIndex((n) => n.getAttribute("aria-label") === "Plan");
        cards.slice(0, plan).forEach((n) => (n.style.visibility = "hidden"));
      })()`),
    clip: column(['.turn .card[aria-label="Plan"]', ".turn .md", ".turn .ticket"]),
  },
  { name: "ticket-mainnet", query: "seed=liveticket" + COLUMN.query, width: COLUMN.width, clip: column([".ticket"], 12) },
  {
    name: "news",
    query: ask("Any news on BTC and ETH?") + COLUMN.query,
    width: COLUMN.width,
    live: true,
    height: 1200,
    clip: column([".turn .said", ".turn .activity", ".turn .cards", ".turn .md"]),
  },
  // The market panel: its head and chart, then each tab.
  {
    name: "panel",
    query: "seed=conversation&tab=book",
    height: 1300,
    clip: `(() => {
      const panel = document.querySelector(".panel").getBoundingClientRect();
      const tabs = document.querySelector('.panel [role="tablist"]').getBoundingClientRect();
      return { x: Math.round(panel.left), y: Math.round(panel.top), width: Math.round(panel.width), height: Math.round(tabs.top - panel.top - 6) };
    })()`,
  },
  // Technicals first: its full height is the height of all four.
  ...["technicals", "book", "funding", "watchlist"].map((tab) => ({
    name: `tab-${tab}`,
    query: `seed=conversation&tab=${tab}`,
    height: 1500,
    prepare: async (page) => {
      // The Book tab goes on to the latest trades; they are hidden, like any row the crop would cut.
      await page.evaluate(`(() => {
        const body = document.querySelector('.panel [role="tabpanel"]');
        const trades = [...body.querySelectorAll(".panel-sub")].find((n) => n.textContent.trim() === "Trades");
        let hide = false;
        for (const node of trades ? [...trades.parentElement.children] : []) {
          if (node === trades) hide = true;
          if (hide) node.style.visibility = "hidden";
        }
      })()`);
      await page.evaluate(hideCut(`(${tabTop} + ${tabHeight} - 10)`));
    },
    clip: `(() => {
      const panel = document.querySelector(".panel").getBoundingClientRect();
      return { x: Math.round(panel.left), y: ${tabTop}, width: Math.round(panel.width), height: TAB_HEIGHT };
    })()`,
  })),
  // Settings.
  { name: "settings-models", query: "settings=models", clip: settings },
  { name: "settings-wallet", query: "settings=wallet", clip: settings },
  {
    name: "settings-trading",
    query: "settings=trading",
    clip: settings,
    // A new installation limits leverage to 3x; the mock starts higher.
    prepare: async (page) => {
      await page.click('.dialog input[inputmode="numeric"]');
      await page.evaluate(`document.querySelector('.dialog input[inputmode="numeric"]').select()`);
      await page.type("3");
      await page.evaluate(`document.querySelector('.dialog input[inputmode="numeric"]').blur()`);
      await sleep(300);
    },
  },
  { name: "settings-tools", query: "settings=tools&mcp=1", clip: settings },
];

const page = await launch();
try {
  if (SHOTS.some((shot) => shot.name.startsWith("tab-") && (!only.size || only.has(shot.name)))) {
    await page.goto(`${APP}?seed=conversation&tab=technicals&theme=light&speed=0`, { width: 1280, height: 1500, scale: 1, wait: 1800 });
    tabHeight = await page.evaluate(tabContentHeight);
  }
  for (const shot of SHOTS) {
    if (only.size && !only.has(shot.name)) continue;
    for (const theme of ["light", "dark"]) {
      for (const scale of shot.scales ?? [2]) {
        const url = `${APP}?${shot.query}&theme=${theme}&speed=${shot.live ? 1 : 0}`;
        const view = { width: shot.window?.width ?? shot.width ?? 1280, height: shot.window?.height ?? shot.height ?? 800, scheme: theme, scale, wait: 1800 };
        await page.goto(url, view);
        // A live answer is finished when its copy and retry buttons appear.
        if (shot.live) await page.waitFor("document.querySelector('.turn .turn-actions')", 20000);
        for (let attempt = 1; shot.consistent && !(await page.evaluate(shot.consistent)); attempt += 1) {
          if (attempt === 12) throw new Error(`${shot.name}: the card and the answer never agreed`);
          await page.goto(url, view);
          await page.waitFor("document.querySelector('.turn .turn-actions')", 20000);
        }
        if (shot.prepare) await shot.prepare(page);
        const clip = shot.clip ? await page.evaluate(shot.clip.replace("TAB_HEIGHT", String(tabHeight))) : null;
        if (shot.clip && !clip) throw new Error(`${shot.name}: nothing to picture`);
        const width = Math.round((clip?.width ?? view.width) * scale);
        const file = join(OUT, `${shot.name}-${theme}-${width}.webp`);
        await page.capture(file, { clip, quality: scale === 1 ? 86 : 78 });
        console.log(file);
        // The phone crop comes from the same window, at 2x.
        if (shot.phone && scale === 2) {
          const box = await page.evaluate(shot.phone);
          const phoneFile = join(OUT, `${shot.name}-phone-${theme}-${Math.round(box.width * 2)}.webp`);
          await page.capture(phoneFile, { clip: box, quality: 78 });
          console.log(phoneFile);
        }
      }
    }
  }
} finally {
  await page.close();
}
