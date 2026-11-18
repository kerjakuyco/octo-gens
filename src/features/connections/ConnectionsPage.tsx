import { useState } from "react";
import type { VenueId, VenueView } from "../../api/types";
import { plural } from "../../lib/format";
import { clearCredentials, mcpDisconnect, setFeed, useApp, useSnapshot } from "../../state/app";
import { devParams } from "../../state/dev";
import { CredentialsDialog } from "./CredentialsDialog";
import { McpDialog } from "./McpDialog";
import { ToolInspector } from "./ToolInspector";

type DialogKind = "keys" | "mcp" | "tools";

const TRANSPORT_WORDS = {
  official: "the official package",
  stdio: "a custom command",
  http: "a remote URL",
} as const;

interface VenueSectionProps {
  venue: VenueView;
  active: boolean;
  busy: boolean;
  onOpen: (kind: DialogKind) => void;
}

function VenueSection({ venue, active, busy, onOpen }: VenueSectionProps) {
  const { mcp } = venue;
  return (
    <section className="venue" aria-labelledby={`venue-${venue.id}`}>
      <div className="venue-head">
        <h2 id={`venue-${venue.id}`} className="venue-name">
          {venue.name}
        </h2>
        {active ? <span className="tag tag-ring">Active price feed</span> : null}
      </div>

      <div className="venue-row">
        <div className="venue-row-title">Market data</div>
        <div className="venue-row-text">
          <strong>Ready.</strong> Spot prices, candles and order books are public, so there is nothing to set up.
        </div>
        <div className="actions">
          {active ? null : (
            <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => void setFeed(venue.id)}>
              Use as price feed
            </button>
          )}
        </div>
      </div>

      <div className="venue-row">
        <div className="venue-row-title">API keys</div>
        <div className="venue-row-text">
          {venue.credentials ? (
            <>
              <strong>Loaded.</strong>{" "}
              {venue.remembered
                ? "Saved in the system keychain."
                : "Kept for this session only and forgotten when you quit."}{" "}
              Balances and live tickets are available.
            </>
          ) : (
            <>
              <strong>None.</strong> Add keys to read your balances and send live tickets. Paper trading does not need
              them.
            </>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => onOpen("keys")}>
            {venue.credentials ? "Replace keys" : "Add keys"}
          </button>
          {venue.credentials ? (
            <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => void clearCredentials(venue.id)}>
              Remove keys
            </button>
          ) : null}
        </div>
      </div>

      <div className="venue-row">
        <div className="venue-row-title">MCP server</div>
        <div className="venue-row-text">
          {mcp ? (
            <>
              <strong>{mcp.name}</strong>, version {mcp.version}. It runs from {TRANSPORT_WORDS[mcp.transport]} and
              offers {plural(mcp.tools, "tool")}.
            </>
          ) : venue.officialPackage ? (
            <>
              <strong>Not attached.</strong> Optional. {venue.name} publishes an official server with extra tools, or
              attach your own.
            </>
          ) : (
            <>
              <strong>Not attached.</strong> Optional. {venue.name} does not publish a server, but you can attach your
              own.
            </>
          )}
        </div>
        <div className="actions">
          {mcp ? (
            <>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => onOpen("tools")}>
                Inspect tools
              </button>
              <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => void mcpDisconnect(venue.id)}>
                Detach
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => onOpen("mcp")}>
              Attach a server
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function ConnectionsPage() {
  const snapshot = useSnapshot();
  const busy = useApp((state) => Boolean(state.working) || Boolean(state.live));
  const [dialog, setDialog] = useState<{ kind: DialogKind; venue: VenueId } | null>(() => {
    const dev = devParams();
    return dev.dialog && dev.dialog !== "trade" ? { kind: dev.dialog, venue: dev.venue ?? "bybit" } : null;
  });

  const venueFor = (kind: DialogKind): VenueView | null =>
    dialog?.kind === kind ? (snapshot.venues.find((venue) => venue.id === dialog.venue) ?? null) : null;
  const close = () => setDialog(null);

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Connections</h1>
        <p className="page-lead">
          Prices from Binance, Bybit and OKX work straight away. Add API keys only when you want balances or live
          orders, and attach an MCP server only if you want the assistant to have more tools.
        </p>

        {snapshot.venues.map((venue) => (
          <VenueSection
            key={venue.id}
            venue={venue}
            active={snapshot.feed === venue.id}
            busy={busy}
            onOpen={(kind) => setDialog({ kind, venue: venue.id })}
          />
        ))}

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">A token is its own market</h2>
          </div>
          <div className="section-body">
            <p className="section-text">
              TSLAx, AAPLx, NVDAx and SPYx are tokenized stocks, not broker shares. Every quote and ticket is checked
              against the exact token, its USDT pair and its spot listing on the chosen venue. If the pair is not
              listed there, you are told so; nothing else is substituted.
            </p>
          </div>
        </section>
      </div>

      <CredentialsDialog venue={venueFor("keys")} onClose={close} />
      <McpDialog venue={venueFor("mcp")} onClose={close} />
      <ToolInspector venue={venueFor("tools")} onClose={close} />
    </div>
  );
}
