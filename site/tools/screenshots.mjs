// Takes the app pictures the site shows, from the interface running in a browser against its built-in mock.
//
//   cd ..                                   # the repository root
//   pnpm build && pnpm exec vite preview --port 4322 --strictPort
//   cd site
//   CHROME=/path/to/chrome node tools/screenshots.mjs [name ...]
//
// APP_URL overrides http://localhost:4322/. Each picture is saved in light and dark as
// src/assets/shots/<name>-<theme>-<pixel width>.webp: full windows at 1x and 2x, crops at 2x.
// A picture named <name>-phone is the one the site shows in place of <name> on a phone: the same
// page in a narrow window, which the app lays out for its width, at 2x.
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

/** A whole window, sidebar included. Rows that its bottom edge would cut are hidden. */
const WINDOW = { width: 1280, height: 788 };

/** The narrow window of a phone picture: the sidebar folds away and each page takes the width. */
const PHONE = { width: 660, height: 788 };

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

/** The window as it is now, after a prepare step that changed its height. */
const viewport = "({ x: 0, y: 0, width: innerWidth, height: innerHeight })";

/**
 * Parts of the conversation are taken in a window 776 pixels wide with the sidebar closed: the
 * conversation is then 728 pixels wide, and a crop 760 wide, the width of the site's text column,
 * keeps 16 pixels of the app's own margin on each side.
 */
const COLUMN = { width: 776, query: "&sidebar=0" };
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

/**
 * A market's page: ETH, opened from its position under Account the way a trader would, so Back
 * reads Account. The mock holds a long there with a stop-loss and a take-profit, which the page
 * lists and the chart draws.
 */
const ETH = "page=account&seed=conversation&positions=1";
async function openEth(page) {
  await page.evaluate(`[...document.querySelectorAll(".position button.symbol")].find((b) => b.textContent.trim().startsWith("ETH")).click()`);
  // The chart is drawn, the book has rows and the readings under the chart are in.
  await page.waitFor(`document.querySelector(".market-page .chart-canvas canvas") && !document.querySelector(".market-page .chart-overlay") && document.querySelector(".market-page .book-row") && document.querySelector(".struct-row .num")`, 20000);
  await sleep(1200);
}

/**
 * Makes the window end where the chart's card does, before the readings under it, then hides cut
 * rows. The chart's height follows the window's, so the window is fitted in a few rounds.
 */
async function fitToChart(page, view) {
  let height = view.height;
  for (let round = 0; round < 12; round += 1) {
    const fit = await page.evaluate(`Math.ceil(document.querySelector(".market-chart-card").getBoundingClientRect().bottom + 14)`);
    if (Math.abs(fit - height) <= 1) break;
    height = fit;
    await page.send("Emulation.setDeviceMetricsOverride", { width: view.width, height, deviceScaleFactor: view.scale, mobile: false });
    await sleep(400);
  }
  await sleep(800);
  await page.evaluate(hideCut(height));
}

/**
 * The tabs beside the chart are cropped inside their card, which draws its own edge, to one height:
 * the height of the Technicals tab. A shorter tab's card is drawn down to it.
 */
let tabHeight = 0;
const tabCard = `document.querySelector(".market-detail-card")`;
const tabContentHeight = `(() => Math.floor(${tabCard}.getBoundingClientRect().height - 2))()`;

const SHOTS = [
  // Whole windows, each with the narrow window a phone shows instead: the screener, and the account.
  ...[
    { name: "markets", query: "page=markets" },
    { name: "account", query: "page=account&seed=conversation&positions=1" },
  ].flatMap(({ name, query }) => [
    { name, query, scales: [1, 2], window: WINDOW, prepare: async (page) => page.evaluate(hideCut(WINDOW.height)) },
    { name: `${name}-phone`, query, window: PHONE, prepare: async (page) => page.evaluate(hideCut(PHONE.height)) },
  ]),
  // A market's page, down to the end of its chart.
  {
    name: "market",
    query: ETH,
    scales: [1, 2],
    window: WINDOW,
    prepare: async (page, view) => {
      await openEth(page);
      await fitToChart(page, view);
    },
    clip: viewport,
  },
  {
    name: "market-phone",
    query: ETH,
    window: PHONE,
    prepare: async (page, view) => {
      await openEth(page);
      await fitToChart(page, view);
    },
    clip: viewport,
  },
  // The readings under the chart: trend and moving averages, then volatility and flow.
  { name: "structure", query: ETH, height: 1400, prepare: openEth, clip: around([".structure-grid"], 12) },
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
  // The tabs of a market's page. Technicals first: its full height is the height of all four.
  ...["technicals", "book", "funding", "watchlist"].map((tab) => ({
    name: `tab-${tab}`,
    query: `page=market&seed=conversation&tab=${tab}`,
    height: 1300,
    prepare: async (page) => {
      // The Book tab goes on to the latest trades; they are hidden, like any row the crop would cut.
      await page.evaluate(`(() => {
        const card = ${tabCard};
        card.style.minHeight = "${tabHeight + 2}px";
        const body = card.querySelector('[role="tabpanel"]');
        const trades = body.querySelector(".tape-head");
        let hide = false;
        for (const node of trades ? [...body.children] : []) {
          if (node === trades) hide = true;
          if (hide) node.style.visibility = "hidden";
        }
      })()`);
      await sleep(200);
      await page.evaluate(hideCut(`(${tabCard}.getBoundingClientRect().top + 1 + ${tabHeight})`));
    },
    clip: `(() => {
      const card = ${tabCard}.getBoundingClientRect();
      return { x: Math.round(card.left + 1), y: Math.round(card.top + 1), width: Math.round(card.width - 2), height: TAB_HEIGHT };
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
    await page.goto(`${APP}?page=market&seed=conversation&tab=technicals&theme=light&speed=0`, { width: 1280, height: 1300, scale: 1, wait: 1800 });
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
        if (shot.prepare) await shot.prepare(page, view);
        const clip = shot.clip ? await page.evaluate(shot.clip.replace("TAB_HEIGHT", String(tabHeight))) : null;
        if (shot.clip && !clip) throw new Error(`${shot.name}: nothing to picture`);
        const width = Math.round((clip?.width ?? view.width) * scale);
        const file = join(OUT, `${shot.name}-${theme}-${width}.webp`);
        await page.capture(file, { clip, quality: scale === 1 ? 86 : 78 });
        console.log(file);
      }
    }
  }
} finally {
  await page.close();
}
