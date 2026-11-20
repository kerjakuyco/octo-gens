import { useState } from "react";
import { pictureSrc } from "../../state/app";

interface PictureProps {
  /** `StoryView.image`: never loaded from the publisher, only through the core. */
  image: string | null;
  /** The publisher, set on the tile shown when there is no picture. */
  source: string;
  className?: string;
  /** For the picture at the top of the page, which should not wait to be scrolled to. */
  eager?: boolean;
}

/**
 * A story's picture in a frame of fixed proportions (set by `className`). It fades in once
 * it has arrived; a story without one, or whose picture fails, gets a quiet tile bearing the
 * publisher's name instead of a broken image. Decorative: the headline beside it says it all.
 */
export function Picture({ image, source, className, eager = false }: PictureProps) {
  const src = pictureSrc(image);
  // A new address starts over: the frame is keyed by it.
  return <Frame key={src} src={src} source={source} className={className} eager={eager} />;
}

function Frame({ src, source, className, eager }: { src: string; source: string; className?: string; eager: boolean }) {
  const [state, setState] = useState<"waiting" | "shown" | "failed">(src ? "waiting" : "failed");
  const initial = Array.from(source.replace(/^the\s+/i, "").trim())[0]?.toUpperCase() ?? "";

  return (
    <span className={className ? `pic ${className}` : "pic"} data-state={state}>
      {state === "failed" ? (
        <span className="pic-fallback" aria-hidden="true">
          <span className="pic-name">{source}</span>
          <span className="pic-initial">{initial}</span>
        </span>
      ) : (
        <img
          src={src}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          {...(eager ? { fetchPriority: "high" as const } : {})}
          onLoad={() => setState("shown")}
          onError={() => setState("failed")}
        />
      )}
    </span>
  );
}
