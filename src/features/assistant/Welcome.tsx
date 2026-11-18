import { BrandMark } from "../../components/BrandMark";
import { baseOf } from "../../lib/format";
import { ask, navigate, useSnapshot } from "../../state/app";

interface Suggestion {
  prompt: string;
  note: string;
}

/** A starter order size that is small in value whatever the token costs. */
function starterQuantity(lastPrice: number): string {
  if (lastPrice >= 10_000) return "0.01";
  if (lastPrice >= 100) return "1";
  if (lastPrice >= 1) return "10";
  return "1000";
}

/** The empty conversation: what the assistant can do, and a few ways to start. */
export function Welcome() {
  const snapshot = useSnapshot();
  const instrument = snapshot.instruments.find((item) => item.pair === snapshot.focus);
  const ticker = instrument?.ticker ?? baseOf(snapshot.focus);
  const other = snapshot.instruments.find((item) => item.pair !== snapshot.focus)?.ticker ?? "ETH";
  const quantity = starterQuantity(Number(snapshot.quotes[snapshot.focus]?.price ?? 0));
  const builtin = snapshot.assistant.provider === "builtin";

  const order: Suggestion = { prompt: `Buy ${quantity} ${ticker}`, note: "Drafts a paper ticket" };
  const suggestions: Suggestion[] = builtin
    ? [
        { prompt: `Analyze ${ticker}`, note: "Price and pattern readings" },
        { prompt: `Compare ${ticker} and ${other}`, note: "Side by side" },
        { prompt: "Review my portfolio", note: "Paper positions and cash" },
        order,
      ]
    : [
        { prompt: "What is moving on my watchlist?", note: "Scans every symbol" },
        { prompt: `Analyze ${ticker} on the 4h chart`, note: "Trend, momentum, levels" },
        { prompt: `Compare ${ticker} and ${other}`, note: "Side by side" },
        { prompt: `Size a ${ticker} long risking 1% of my equity`, note: "Plan and ticket" },
        order,
      ];

  return (
    <div className="welcome">
      <BrandMark size={44} />
      <h2 className="welcome-title">Ask the desk.</h2>
      <p className="welcome-lead">
        Research a market, compare tokens, size a position or draft an order. Nothing trades until you confirm the
        ticket.
      </p>

      <ul className="suggestions" aria-label="Ways to start">
        {suggestions.map((suggestion) => (
          <li key={suggestion.prompt}>
            <button type="button" className="suggestion" onClick={() => void ask(suggestion.prompt)}>
              <span>{suggestion.prompt}</span>
              <span className="suggestion-note">{suggestion.note}</span>
            </button>
          </li>
        ))}
      </ul>

      {builtin ? (
        <div className="setup">
          <div className="setup-text">
            <strong>The built-in agents are answering.</strong>
            They handle quotes, comparisons, your portfolio and order commands. Add an OpenRouter model for open
            research with tools.
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => navigate("settings")}>
            Choose a model
          </button>
        </div>
      ) : null}

      {snapshot.feed === "sample" ? (
        <p className="welcome-note">
          You are on the sample tape, so every price is fictional. Pick Binance, Bybit or OKX above for live spot
          data. No keys are needed to read prices.
        </p>
      ) : null}
    </div>
  );
}
