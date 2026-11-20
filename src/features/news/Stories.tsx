import type { StoryView } from "../../api/types";
import { useMinute } from "../../lib/clock";
import { ago, dayTime } from "../../lib/format";
import { instrumentFor } from "../../lib/market";
import { useSnapshot } from "../../state/app";
import { InstrumentMark } from "../market/InstrumentMark";
import { storyAge } from "./news";
import { Picture } from "./Picture";

/** How long ago something was published, kept current. Nothing when the publisher gave no time. */
export function Age({ iso, short = false, className }: { iso: string | null; short?: boolean; className?: string }) {
  const now = useMinute();
  const text = short ? ago(iso, now) : storyAge(iso, now);
  if (!iso || !text) return null;
  return (
    <time className={className} dateTime={iso} title={dayTime(iso)}>
      {text}
    </time>
  );
}

/** Markets a story is about. Each opens that market's page. */
export function MarketChips({ markets, onMarket }: { markets: string[]; onMarket: (symbol: string) => void }) {
  const snapshot = useSnapshot();
  if (markets.length === 0) return null;
  const shown = markets.slice(0, 3);
  const rest = markets.slice(3).map((symbol) => instrumentFor(snapshot, symbol).base);
  return (
    <ul className="story-chips" aria-label="Markets in this story">
      {shown.map((symbol) => {
        const { base } = instrumentFor(snapshot, symbol);
        return (
          <li key={symbol}>
            <button type="button" className="story-chip" aria-label={`Open the ${base} market`} onClick={() => onMarket(symbol)}>
              <InstrumentMark base={base} size="sm" />
              <span>{base}</span>
            </button>
          </li>
        );
      })}
      {rest.length > 0 ? (
        <li className="story-chip-more" title={rest.join(", ")}>
          +{rest.length}
        </li>
      ) : null}
    </ul>
  );
}

export interface StoryActions {
  onOpen: (story: StoryView) => void;
  onMarket: (symbol: string) => void;
}

/**
 * The headline is the story's one control: it opens the article, and its hit area stretches over
 * the whole story, picture included. The market chips sit above it as controls of their own.
 */
function Headline({ story, onOpen, as: Tag }: { story: StoryView; onOpen: (story: StoryView) => void; as: "h3" | "p" }) {
  return (
    <Tag className="story-title">
      <button type="button" className="story-open" data-story={story.url} onClick={() => onOpen(story)}>
        {story.title}
      </button>
    </Tag>
  );
}

/** A story with its picture: the lead, one beside it, or a card in the grid. */
export function Story({ story, variant, onOpen, onMarket }: StoryActions & { story: StoryView; variant: "lead" | "rail" | "card" }) {
  return (
    <article className={`story story-${variant}`}>
      <Picture image={story.image} source={story.source} className="story-pic" eager={variant === "lead"} />
      <p className="story-source">{story.source}</p>
      <Headline story={story} onOpen={onOpen} as="h3" />
      {story.summary ? <p className="story-summary">{story.summary}</p> : null}
      <div className="story-foot">
        <Age iso={story.published} className="story-time" />
        <MarketChips markets={story.markets} onMarket={onMarket} />
      </div>
    </article>
  );
}

/** One line of the compact list: when, what, and who. */
export function Brief({ story, onOpen, onMarket }: StoryActions & { story: StoryView }) {
  return (
    <li className="story brief">
      <span className="brief-time">
        <Age iso={story.published} short />
      </span>
      <div className="brief-body">
        <Headline story={story} onOpen={onOpen} as="p" />
        <div className="brief-meta">
          <span className="story-source">{story.source}</span>
          <MarketChips markets={story.markets} onMarket={onMarket} />
        </div>
      </div>
    </li>
  );
}
