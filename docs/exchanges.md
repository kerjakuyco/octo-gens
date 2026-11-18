# Exchanges

Market data and orders use native adapters in `crates/octogens-core/src/venues`. The Model Context Protocol is used for everything else an exchange offers through its own tool server.

## What an adapter does

| Operation | Notes |
| --- | --- |
| Listing check | The exact token/USDT pair must be an active spot market. A tokenized stock must be flagged as one. A missing listing is reported, never replaced by another market. |
| Ticker | Last price, 24h change, high, low, volume, best bid and ask |
| Candles | 15m, 1h, 4h and 1d, up to 300 |
| Order book | Up to 200 levels per side |
| Balances | Needs API keys |
| Market order | Needs API keys. Sized in token units, with a client id for idempotency |

Public reads are retried once when no answer arrives. Signed requests and orders are sent exactly once: if an order fails after it may have reached the exchange, the error tells you to check there for the client id before trying again.

## Blocked networks

Some networks intercept or refuse connections to exchange domains.

- **Binance.** Public market data falls back to `data-api.binance.vision`, Binance's own market-data host. It never receives a signed request or an API key. Balances and orders still need `api.binance.com`.
- **Bybit, OKX.** There is no equivalent public host. The app reports that the connection was refused or intercepted; use another network or a VPN.

## Adding an exchange

1. Add a variant to `VenueId` in `model.rs`.
2. Add `venues/<name>.rs` with a type that implements `Dialect`: the host, the symbol format, request shapes, response parsing and signing. Dialects do no I/O, so they are easy to test.
3. Register it in `VenueClient::new`.
4. Add fixtures to `venues/tests.rs` for quotes, order books, orders and balances. The existing tests iterate over `VenueId::ALL`, so most of them will exercise the new exchange once fixtures exist.
5. Check it against the real exchange: `cargo run -p octogens-core --example probe -- <name> BTC`.
6. Add the exchange to `Feed` in `src/api/types.ts`, and its name to the interface where exchanges are listed.

## MCP servers

In **Connections** each exchange can have one MCP server attached.

| Kind | What starts | Needs |
| --- | --- | --- |
| Official | The exchange's pinned npm package (`bybit-official-trading-server`, `@okx_ai/okx-trade-mcp`), run with `node` and npm's `npx-cli.js` | Node.js 20 or newer |
| Custom command | Any program that speaks MCP over stdin/stdout | The program |
| Remote | A Streamable HTTP endpoint | An HTTPS URL (plain HTTP only on this computer) |

Details that matter:

- **Pinned versions.** Official packages are pinned in `mcp.rs`. Updating one is a code change that can be reviewed.
- **Secrets.** Keys for an official server go in its process environment, never on its command line, and are not saved. OKX live and demo profiles use the OKX config file already on your computer; the app does not write it.
- **Windows.** `npx.cmd` is a shell wrapper and cannot carry a JSON-RPC stream, so the app runs `node` with `npx-cli.js` directly and refuses `.cmd` and `.bat` launchers.
- **Read-only rule.** The assistant, and `@venue tool {...}` typed in chat, may call only tools the server marks `readOnlyHint: true`. Anything else must be run by you from the tool inspector.
- **Privacy.** Output of exchange tools is shown for the session and never written to the journal.
