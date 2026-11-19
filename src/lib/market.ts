import type { InstrumentView, Snapshot, WalletView } from "../api/types";

/** Quote assets the exchange margins perpetuals in, longest first so `USD1` wins over a bare `USD`. */
const QUOTES = ["USDT", "USD1", "USDC"];

/** The watchlist entry for a symbol, or a best-effort stand-in when it is not listed there. */
export function instrumentFor(snapshot: Snapshot, symbol: string): InstrumentView {
  const listed = snapshot.instruments.find((item) => item.symbol === symbol);
  if (listed) return listed;
  const quote = QUOTES.find((candidate) => symbol.length > candidate.length && symbol.endsWith(candidate));
  return {
    symbol,
    base: quote ? symbol.slice(0, -quote.length) : symbol,
    quote: quote ?? "",
    custom: false,
  };
}

/** The wallet of the active network. */
export function activeWallet(snapshot: Snapshot): WalletView {
  return (
    snapshot.wallets.find((wallet) => wallet.network === snapshot.network) ?? {
      network: snapshot.network,
      connected: false,
      user: null,
      agent: null,
      expires: null,
      needsDeposit: false,
    }
  );
}

/** Markets that match what was typed, best first: a base that starts with it, then one that contains it. */
export function matchMarkets<T extends { symbol: string; base: string }>(markets: T[], query: string): T[] {
  const text = query.trim().toUpperCase();
  if (!text) return [];
  const scored: { market: T; score: number }[] = [];
  for (const market of markets) {
    const base = market.base.toUpperCase();
    let score = -1;
    if (base === text) score = 0;
    else if (base.startsWith(text)) score = 1;
    else if (base.includes(text)) score = 2;
    else if (market.symbol.toUpperCase().includes(text)) score = 3;
    if (score >= 0) scored.push({ market, score });
  }
  return scored.sort((left, right) => left.score - right.score).map((entry) => entry.market);
}
