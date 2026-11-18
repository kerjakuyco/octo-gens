"""Bundled stdio MCP server; each process is scoped to exactly one exchange."""

import os
import sys

from mcp.server.fastmcp import FastMCP

from .exchanges import Venue


def main():
    venue = Venue(sys.argv[-1], os.environ.get("OCTO_KEY", ""), os.environ.get("OCTO_SECRET", ""),
                  os.environ.get("OCTO_PASSPHRASE", ""))
    server = FastMCP(f"Octo Gens / {venue.id} spot", log_level="ERROR")

    @server.tool()
    def spot_listing(pair: str) -> dict:
        """Check that the exact token/USDT pair is active on the venue's spot market."""
        return venue.listing(pair)

    @server.tool()
    def spot_quote(pair: str) -> dict:
        """Get a verified spot price, timestamp and completed daily closes for a token/USDT pair."""
        return venue.quote(pair)

    if venue.key:
        @server.tool()
        def spot_balances() -> dict:
            """Read exchange account balances (unified wallet on Bybit)."""
            return {"balances": venue.balances()}

        @server.tool()
        def spot_market_order(pair: str, side: str, quantity: str, client_id: str) -> dict:
            """Submit a live spot market order in base-token units."""
            return venue.order(pair, side, quantity, client_id)

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
