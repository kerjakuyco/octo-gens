/**
 * Icons for well-known coins, bundled with the app (the interface cannot load anything from the internet).
 *
 * The list is deliberately short of everything an icon set offers. A ticker is not a name: the same
 * letters can be a coin in an icon set and a stock or a different token on the exchange, and a wrong
 * logo is worse than none. Only coins whose ticker means one thing are here; every other market keeps
 * its letter mark. To add one, put `<TICKER>.svg` in `src/assets/coins/`.
 */
// Each icon stays a file of its own, loaded when a row that shows it is drawn, instead of text inside the script.
const FILES = import.meta.glob<string>("../assets/coins/*.svg", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
});

const ICONS = new Map<string, string>(
  Object.entries(FILES).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), url]),
);

/** Tickers that changed while the coin stayed the same. */
const RENAMED: Record<string, string> = { RENDER: "RNDR" };

/**
 * A market's base asset as the coin's own ticker. `1000PEPE` and `1MBABYDOGE` are quoted per
 * thousand or per million coins; `1INCH` is simply the coin's name.
 */
export function coinTicker(base: string): string {
  const ticker = base.toUpperCase().replace(/^(?:1M|10{3,})(?=[A-Z])/, "");
  return RENAMED[ticker] ?? ticker;
}

/** The address of a coin's icon, when the app has one. */
export function coinIcon(base: string): string | undefined {
  return ICONS.get(coinTicker(base));
}
