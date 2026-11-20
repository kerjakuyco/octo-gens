/**
 * The News page of the in-browser mock: invented stories from invented newsrooms, with
 * abstract pictures drawn here as SVG. Nothing is read from a network, and no real
 * publisher, person or company appears.
 */

import type { NewsDesk, NewsFeedView, StoryView } from "./types";

/** Every newsroom the mock reads, in a fixed order: the crypto desk first, then the economy. */
export const MOCK_PUBLISHERS = [
  "Tidewire",
  "Kelp Desk",
  "The Brine Report",
  "Inkline",
  "Tidal Reserve Bank",
  "The Pelagic Post",
  "Undertow Markets",
  "Seafloor Ledger",
] as const;

type Publisher = (typeof MOCK_PUBLISHERS)[number];

interface Seed {
  title: string;
  source: Publisher;
  /** Minutes before the mock started that it was published. */
  minutes: number;
  summary: string;
  topics: string[];
  /** Coins it is about, as base assets; only those listed on the active network become markets. */
  coins: string[];
  desk: NewsDesk;
  /** How its picture is drawn, chosen so that neighbouring stories differ; null for a story without one. */
  art: [Motif, number] | null;
}

const SEEDS: Seed[] = [
  {
    title: "Bitcoin holds above 62,000 as options traders pay up for upside",
    source: "Tidewire",
    minutes: 18,
    summary:
      "Open interest in contracts expiring next quarter rose for a fourth day, a sign traders want exposure to a rally without chasing the spot price.",
    topics: ["Bitcoin", "Derivatives"],
    coins: ["BTC"],
    desk: "crypto",
    art: ["bars", 1],
  },
  {
    title: "Tidal Reserve Bank holds its policy rate and keeps a cut on the table",
    source: "Tidal Reserve Bank",
    minutes: 27,
    summary:
      "The board said inflation is cooling but wants a few more months of evidence before it moves. Two members voted for a cut.",
    topics: ["Rates", "Policy"],
    coins: [],
    desk: "macro",
    art: ["arcs", 4],
  },
  {
    title: "Ether funding turns negative for the first time this month",
    source: "Kelp Desk",
    minutes: 41,
    summary:
      "Shorts are now paying longs to keep their positions open on most venues. In past months that has come before sharp squeezes.",
    topics: ["Ether", "Funding"],
    coins: ["ETH"],
    desk: "crypto",
    art: ["waves", 2],
  },
  {
    title: "SOL validators vote on a fee change that would halve priority tips",
    source: "The Brine Report",
    minutes: 64,
    summary:
      "Part of every tip would go to the network's community fund instead. Voting closes on Sunday, and early tallies favour the change.",
    topics: ["Solana", "Governance"],
    coins: ["SOL"],
    desk: "crypto",
    art: ["bands", 3],
  },
  {
    title: "Payrolls beat forecasts for a third month as wage growth cools",
    source: "The Pelagic Post",
    minutes: 82,
    summary:
      "Employers added more jobs than economists expected, while average hourly pay rose at its slowest pace in two years.",
    topics: ["Economy", "Jobs"],
    coins: [],
    desk: "macro",
    art: ["field", 7],
  },
  {
    title: "Why perpetual traders watch the weekend basis",
    source: "Inkline",
    minutes: 110,
    summary:
      "The gap between perpetual and spot prices tends to stretch when fewer desks are open. A short guide to reading it before Monday.",
    topics: ["Explainers"],
    coins: ["BTC", "ETH"],
    desk: "crypto",
    art: ["orbs", 6],
  },
  {
    title: "DOGE jumps 9% as a remittance pilot widens to three more regions",
    source: "Tidewire",
    minutes: 140,
    summary:
      "A cross-border payments trial that settles in DOGE added three corridors this week, its operator said, without naming volumes.",
    topics: ["Dogecoin", "Payments"],
    coins: ["DOGE"],
    desk: "crypto",
    art: null,
  },
  {
    title: "Tech shares slip as bond yields climb to a six-week high",
    source: "Undertow Markets",
    minutes: 160,
    summary:
      "Longer-dated yields rose for a fifth session, pulling the most richly valued stocks lower while banks edged up.",
    topics: ["Stocks", "Bonds"],
    coins: [],
    desk: "macro",
    art: ["bars", 5],
  },
  {
    title: "Stablecoin supply hits a record as exchange balances climb",
    source: "Kelp Desk",
    minutes: 175,
    summary: "New issuance has outpaced redemptions for six weeks in a row, adding to the cash waiting on exchanges.",
    topics: ["Stablecoins"],
    coins: [],
    desk: "crypto",
    art: ["waves", 0],
  },
  {
    title: "Gold steadies near its record as the dollar softens",
    source: "Seafloor Ledger",
    minutes: 195,
    summary:
      "The metal held its gains after a weaker dollar and lower real yields made it cheaper to hold for overseas buyers.",
    topics: ["Commodities", "Gold"],
    coins: ["XAU"],
    desk: "macro",
    art: ["arcs", 9],
  },
  {
    title: "XRP open interest doubles in a week while liquidations stay muted",
    source: "The Brine Report",
    minutes: 220,
    summary:
      "Leverage is building without the forced selling that usually comes with it, a pattern analysts say can unwind quickly.",
    topics: ["XRP", "Derivatives"],
    coins: ["XRP"],
    desk: "crypto",
    art: ["field", 2],
  },
  {
    title: "LINK node operators add price feeds on two more networks",
    source: "Inkline",
    minutes: 270,
    summary: "The new feeds cover lending markets that had relied on a single source for prices, one of the operators said.",
    topics: ["Infrastructure"],
    coins: ["LINK"],
    desk: "crypto",
    art: ["arcs", 6],
  },
  {
    title: "Factory activity shrinks again, but new orders tick up",
    source: "The Pelagic Post",
    minutes: 290,
    summary:
      "The purchasing managers' index stayed below the line that separates growth from contraction for a seventh month.",
    topics: ["Economy", "Manufacturing"],
    coins: [],
    desk: "macro",
    art: null,
  },
  {
    title: "AVAX rallies after a gaming network moves its tokens onto the chain",
    source: "Tidewire",
    minutes: 310,
    summary: "The studio behind several mobile games said it will migrate its in-game tokens over the next month.",
    topics: ["Gaming"],
    coins: ["AVAX"],
    desk: "crypto",
    art: ["bands", 5],
  },
  {
    title: "Miners sold the fewest coins in a year last month, chain data shows",
    source: "Kelp Desk",
    minutes: 360,
    summary:
      "Outflows from wallets linked to large mining pools fell to their lowest since last autumn, easing a steady source of supply.",
    topics: ["Bitcoin", "Mining"],
    coins: ["BTC"],
    desk: "crypto",
    art: null,
  },
  {
    title: "What a softer dollar means for bitcoin and commodities",
    source: "Undertow Markets",
    minutes: 400,
    summary: "A weaker dollar has tended to lift assets priced in it. How strong that link has been, and where it has broken.",
    topics: ["Explainers", "Currencies"],
    coins: ["BTC"],
    desk: "macro",
    art: ["waves", 8],
  },
  {
    title: "SUI unlock adds 2% to circulating supply on Monday",
    source: "The Brine Report",
    minutes: 440,
    summary:
      "Tokens set aside for early backers start to vest next week. Past unlocks of this size moved the price for a day or two.",
    topics: ["Token unlocks"],
    coins: ["SUI"],
    desk: "crypto",
    art: ["orbs", 0],
  },
  {
    title: "Minutes show the board split on how fast to shrink its balance sheet",
    source: "Tidal Reserve Bank",
    minutes: 510,
    summary:
      "Several members wanted to slow the runoff of bonds the bank holds; others argued markets can absorb the current pace.",
    topics: ["Rates", "Policy"],
    coins: [],
    desk: "macro",
    art: ["field", 1],
  },
  {
    title: "A quiet week for altcoins hides a busy one for options",
    source: "Inkline",
    minutes: 560,
    summary:
      "Spot volumes fell across mid-sized coins, but options desks reported their busiest week since the summer.",
    topics: ["Derivatives"],
    coins: ["ETH", "SOL"],
    desk: "crypto",
    art: ["bars", 4],
  },
  {
    title: "Oil falls 3% on signs that stockpiles are rising",
    source: "Seafloor Ledger",
    minutes: 620,
    summary: "Inventories grew more than forecast for a second week, offsetting talk of tighter supply from producers.",
    topics: ["Commodities", "Energy"],
    coins: [],
    desk: "macro",
    art: ["waves", 7],
  },
  {
    title: "Lawmakers publish a draft on how exchanges must hold customer coins",
    source: "Tidewire",
    minutes: 680,
    summary:
      "The proposal would require exchanges to keep client assets apart from their own and to prove it with regular audits.",
    topics: ["Regulation"],
    coins: [],
    desk: "crypto",
    art: ["bands", 6],
  },
  {
    title: "TON and LTC lead weekend volume as traders rotate out of majors",
    source: "Kelp Desk",
    minutes: 790,
    summary: "Turnover in the two coins rose by a third while bitcoin and ether volumes thinned out.",
    topics: ["Markets"],
    coins: ["TON", "LTC"],
    desk: "crypto",
    art: null,
  },
  {
    title: "Retail sales rise 0.4%, led by online spending",
    source: "Undertow Markets",
    minutes: 900,
    summary: "Shoppers spent more for a second month, helped by discounts that pulled holiday purchases forward.",
    topics: ["Economy", "Consumers"],
    coins: [],
    desk: "macro",
    art: null,
  },
  {
    title: "Consumer confidence rebounds to its best level since spring",
    source: "The Pelagic Post",
    minutes: 1210,
    summary:
      "Households grew more upbeat about jobs and prices, though fewer said it was a good time to buy a home.",
    topics: ["Economy", "Consumers"],
    coins: [],
    desk: "macro",
    art: ["orbs", 9],
  },
];

/* --------------------------------------------------------------- pictures */

function hash(text: string): number {
  let value = 2166136261;
  for (let at = 0; at < text.length; at += 1) {
    value ^= text.charCodeAt(at);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** mulberry32: the same story always gets the same picture. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Palette {
  top: string;
  bottom: string;
  /** Three colours that sit on the background. */
  ink: [string, string, string];
}

/** Muted, mid-toned and print-like, so a picture sits as well on a white page as on a dark one. */
const PALETTES: Palette[] = [
  { top: "#163a40", bottom: "#24605b", ink: ["#e8a87c", "#f3d9b1", "#c38d9e"] },
  { top: "#1c2b4a", bottom: "#2f4c7e", ink: ["#f2b134", "#ed6a4b", "#f4eedb"] },
  { top: "#3b2c4d", bottom: "#6a4b78", ink: ["#f4a582", "#ffd8a8", "#9cc6dc"] },
  { top: "#3d4a2f", bottom: "#6b7a45", ink: ["#e9c46a", "#f4a261", "#f6f0d8"] },
  { top: "#2a3942", bottom: "#41596a", ink: ["#bcd3e6", "#f0b67f", "#f2735f"] },
  { top: "#4a1d2c", bottom: "#7a2f42", ink: ["#f6bd60", "#f3e6d8", "#8fb3a7"] },
  { top: "#10263a", bottom: "#1f4f6f", ink: ["#7cc3f5", "#ffd166", "#ef6f8a"] },
  { top: "#e7dac6", bottom: "#d4bd9c", ink: ["#8e5c42", "#3d405b", "#df7a5e"] },
  { top: "#d3dbdf", bottom: "#b2c0c8", ink: ["#37474f", "#ff8a65", "#5c7383"] },
  { top: "#1f3a2c", bottom: "#356b52", ink: ["#e3ee9e", "#f6c453", "#f2f0e4"] },
];

type Draw = (next: () => number, palette: Palette) => string;

const W = 1200;
const H = 800;

const n = (value: number) => Math.round(value);

/** Rolling hills of colour under a low sun. */
const waves: Draw = (next, { ink }) => {
  const sunX = 220 + next() * 760;
  const sunY = 170 + next() * 140;
  let out = `<circle cx="${n(sunX)}" cy="${n(sunY)}" r="${n(90 + next() * 70)}" fill="${ink[1]}" opacity=".92"/>`;
  for (let band = 0; band < 4; band += 1) {
    const base = 420 + band * 95 + next() * 30;
    const amp = 26 + next() * 34;
    const phase = next() * Math.PI * 2;
    const freq = 0.8 + next() * 1.1;
    let d = `M0 ${n(base)}`;
    for (let x = 0; x <= W; x += 40) {
      d += `L${x} ${n(base + Math.sin((x / W) * Math.PI * 2 * freq + phase) * amp)}`;
    }
    out += `<path d="${d}L${W} ${H}L0 ${H}Z" fill="${ink[band % 3]}" opacity="${(0.5 + band * 0.14).toFixed(2)}"/>`;
  }
  return out;
};

/** Overlapping discs, like coins or planets seen from far away. */
const orbs: Draw = (next, { ink }) => {
  let out = "";
  const count = 4 + Math.floor(next() * 3);
  for (let at = 0; at < count; at += 1) {
    out += `<circle cx="${n(next() * W)}" cy="${n(120 + next() * (H - 240))}" r="${n(110 + next() * 230)}" fill="${ink[at % 3]}" opacity="${(0.55 + next() * 0.35).toFixed(2)}"/>`;
  }
  return out;
};

/** A skyline of rounded bars under a low disc, with a thin line over them: a market, without any numbers. */
const bars: Draw = (next, { ink, top }) => {
  const rising = next() > 0.35;
  let out = `<circle cx="${n(rising ? 760 + next() * 200 : 240 + next() * 200)}" cy="${n(230 + next() * 70)}" r="${n(150 + next() * 60)}" fill="${ink[1]}" opacity=".9"/>`;
  const count = 13;
  const step = W / count;
  const width = step * 0.62;
  let level = rising ? 0.26 : 0.7;
  const tops: string[] = [];
  for (let at = 0; at < count; at += 1) {
    level = Math.min(0.82, Math.max(0.16, level + (rising ? 0.04 : -0.04) + (next() - 0.5) * 0.12));
    const height = level * (H - 120);
    const x = at * step + (step - width) / 2;
    const y = H - height;
    tops.push(`${n(x + width / 2)},${n(y - 30)}`);
    out += `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height + width)}" rx="${n(width / 2)}" fill="${ink[at % 2 === 0 ? 0 : 2]}" opacity="${at % 2 === 0 ? ".94" : ".6"}"/>`;
  }
  out += `<polyline points="${tops.join(" ")}" fill="none" stroke="${top}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
  return out;
};

/** Concentric arcs from a corner, like ripples on still water. */
const arcs: Draw = (next, { ink }) => {
  const corner = Math.floor(next() * 4);
  const cx = corner % 2 === 0 ? 0 : W;
  const cy = corner < 2 ? H : 0;
  let out = "";
  for (let ring = 0; ring < 9; ring += 1) {
    const r = 140 + ring * 115 + next() * 20;
    out += `<circle cx="${cx}" cy="${cy}" r="${n(r)}" fill="none" stroke="${ink[ring % 3]}" stroke-width="${n(34 + next() * 26)}" opacity="${(0.45 + next() * 0.45).toFixed(2)}"/>`;
  }
  return out;
};

/** Broad diagonal bands with a disc set into them. */
const bands: Draw = (next, { ink }) => {
  const angle = -20 - next() * 25;
  let out = `<g transform="rotate(${n(angle)} ${W / 2} ${H / 2})">`;
  let y = -400;
  let at = 0;
  while (y < H + 400) {
    const height = 70 + next() * 150;
    if (at % 2 === 0) {
      out += `<rect x="-400" y="${n(y)}" width="${W + 800}" height="${n(height)}" fill="${ink[at % 3]}" opacity="${(0.5 + next() * 0.4).toFixed(2)}"/>`;
    }
    y += height;
    at += 1;
  }
  out += "</g>";
  out += `<circle cx="${n(260 + next() * 680)}" cy="${n(220 + next() * 360)}" r="${n(120 + next() * 80)}" fill="${ink[1]}" opacity=".95"/>`;
  return out;
};

/** A field of dots with a disc on one side and a tilted card on the other. */
const field: Draw = (next, { ink }) => {
  let out = "";
  for (let y = 60; y < H; y += 68) {
    for (let x = 60; x < W; x += 68) out += `<circle cx="${x}" cy="${y}" r="5" fill="${ink[2]}" opacity=".24"/>`;
  }
  const left = next() > 0.5;
  out += `<circle cx="${n(left ? 300 + next() * 120 : 780 + next() * 120)}" cy="${n(260 + next() * 100)}" r="${n(150 + next() * 60)}" fill="${ink[0]}" opacity=".92"/>`;
  const width = 300 + next() * 110;
  const height = width * 0.62;
  const x = left ? 620 + next() * 110 : 170 + next() * 110;
  const y = 360 + next() * 110;
  out += `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="22" fill="${ink[1]}" opacity=".88" transform="rotate(${n(-9 + next() * 18)} ${n(x + width / 2)} ${n(y + height / 2)})"/>`;
  return out;
};

const MOTIFS = { waves, orbs, bars, arcs, bands, field } satisfies Record<string, Draw>;

type Motif = keyof typeof MOTIFS;

/**
 * A picture for a story: abstract and editorial, the same every time for the same story. The
 * motif and palette can be chosen; the rest of the composition follows from `seed`.
 */
export function storyPicture(seed: string, motif?: Motif, palette?: number): string {
  const next = random(hash(seed));
  const colours = PALETTES[palette ?? Math.floor(next() * PALETTES.length)] ?? PALETTES[0]!;
  const names = Object.keys(MOTIFS) as Motif[];
  const draw = MOTIFS[motif ?? names[Math.floor(next() * names.length)]!];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="${colours.top}"/>` +
    `<stop offset="1" stop-color="${colours.bottom}"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#g)"/>${draw(next, colours)}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* ------------------------------------------------------------------- feed */

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface MockFeedOptions {
  /** When the mock started: stories are dated before it, so they age as time passes. */
  anchor: number;
  /** When the feeds were last read. */
  readAt: number;
  /** Markets on the active network, to find the ones a story is about. */
  listed: { symbol: string; base: string }[];
  /** Newsrooms that did not answer; their stories are left out. */
  missing: string[];
  /** No newsroom had anything to say. */
  empty?: boolean;
}

/** The News page as the core would build it: newest first, every publisher, and who could not be reached. */
export function mockNewsFeed({ anchor, readAt, listed, missing, empty = false }: MockFeedOptions): NewsFeedView {
  const bases = new Map(listed.map((market) => [market.base, market.symbol]));
  const stories: StoryView[] = empty
    ? []
    : SEEDS.filter((seed) => !missing.includes(seed.source))
        .sort((left, right) => left.minutes - right.minutes)
        .map((seed) => ({
          title: seed.title,
          source: seed.source,
          url: `https://${slug(seed.source).replace(/-/g, "")}.example/${seed.desk}/${slug(seed.title)}`,
          published: new Date(anchor - seed.minutes * 60_000).toISOString(),
          summary: seed.summary,
          image: seed.art ? storyPicture(seed.title, ...seed.art) : null,
          topics: [...seed.topics],
          markets: seed.coins.flatMap((coin) => {
            const symbol = bases.get(coin);
            return symbol ? [symbol] : [];
          }),
          desk: seed.desk,
        }));
  return {
    stories,
    publishers: [...MOCK_PUBLISHERS],
    missing: MOCK_PUBLISHERS.filter((publisher) => missing.includes(publisher)),
    readAt: new Date(readAt).toISOString(),
  };
}
