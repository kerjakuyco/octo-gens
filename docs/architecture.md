# Architecture

Octo Gens has three layers. Each one knows only about the layer below it.

```
┌──────────────────────────────────────────────────────────────┐
│ src/            Interface (React, TypeScript)                 │
│                 Renders a Snapshot, sends commands.           │
│                 No network access, no secrets.                │
├──────────────────────── Tauri IPC ───────────────────────────┤
│ src-tauri/      Desktop shell (Rust)                          │
│                 Window, system keychain, one command per      │
│                 studio action. No trading logic.              │
├──────────────────────────────────────────────────────────────┤
│ crates/octogens-core/   Trading core (Rust)                   │
│                 Exchanges, paper ledger, indicators, the      │
│                 assistant loop, MCP client. No UI code.       │
└──────────────────────────────────────────────────────────────┘
          │                    │                     │
   Binance, Bybit, OKX     OpenRouter, Ollama    MCP servers
```

## The core

`crates/octogens-core` is an ordinary Rust library. It can be built, tested and run without Tauri, a web view or Node (`cargo test -p octogens-core`, or `cargo run -p octogens-core --example desk`).

| Module | Responsibility |
| --- | --- |
| `model`, `instruments` | Domain types and the tradable universe. Money is `rust_decimal::Decimal`, never a float. |
| `sample` | The sample tape: reproducible fictional prices, always flagged as sample. |
| `venues` | Native spot adapters. One `VenueClient` does the HTTP work; each exchange is a `Dialect` (paths, field names, signing). |
| `ledger` | Paper accounts in SQLite, one book per price feed. Fills are atomic and idempotent by client id. |
| `indicators` | Deterministic technical readings, so the model never does arithmetic. |
| `llm` | OpenRouter (catalog, streamed chat, tool calls, reasoning hand-back) and Ollama. |
| `assistant` | The system prompt, the tool definitions, and the agent loop. |
| `mcp` | Model Context Protocol client for exchange tool servers. |
| `store` | Preferences, the run journal, and the `SecretStore` trait. |
| `studio` | The one object that owns the desk's state and offers every action. |

### The studio

`Studio` is the only thing the shell talks to. Every action returns a `Snapshot`: everything the interface renders. That keeps the interface a pure function of the snapshot and makes the core easy to test, because a test calls the same methods the interface does.

State sits behind short locks that are never held across a network call, so the interface stays responsive while the assistant works. Actions that would change the desk under a running turn (switching feed, changing keys) are refused until the turn ends.

### A chat turn

1. The message is routed before any model sees it. An exact command (`buy 0.5 BTC`, `@bybit tool {...}`) is carried out directly: it is instant, free and cannot be misread.
2. Otherwise the configured model gets the standing instructions, recent turns, and the message with a `<desk>` block describing the feed and account right now.
3. `assistant::run` loops: ask the model, run the tools it calls, hand the results back. It ends when the model answers in words, the tool budget is used up, or you press Stop.
4. Steps and text stream to the interface as `TurnEvent`s. The finished run goes to the journal.

The loop has no access to orders. The only tool that touches trading is `propose_order`, which drafts a ticket. A ticket is carried out by `Studio::submit_ticket`, which only the interface calls, when you confirm.

## The shell

`src-tauri` is deliberately thin: `lib.rs` maps each command to a `Studio` method, and `keychain.rs` implements `SecretStore` with the system keychain. Turn events travel over a Tauri channel; snapshots from background work (the pattern watch) are emitted as the `snapshot` event.

The web view runs under a content security policy that allows no network connections except IPC. Its only capability beyond the app's own commands is opening `https` links in your browser.

## The interface

`src` is a React app with no UI kit and no state library. `src/api/types.ts` is the contract with the core; `src/api/tauri.ts` implements it over IPC and `src/api/mock.ts` implements it in the browser, so the interface can be developed with `pnpm dev` alone.

The contract is enforced: `crates/octogens-core/tests/contract.rs` serialises real values from the core and fails if their fields differ from the TypeScript declarations.

## Where data lives

| Data | Location | Notes |
| --- | --- | --- |
| Paper books | `spot-usdt-<feed>.sqlite3` in the data folder | One file per feed |
| Run journal | `journal.sqlite3` | Last 300 runs. Output of exchange tools is never written here |
| Preferences | `preferences.json` | No secrets |
| OpenRouter key, remembered exchange keys | System keychain | In memory only if no keychain exists |

## Testing

| Layer | How it is tested |
| --- | --- |
| Core | Unit tests beside the code. Exchanges, OpenRouter and MCP are exercised against local mock HTTP servers; the stdio MCP transport against a real child process when Node is installed. |
| Contract | `tests/contract.rs`, as above. |
| Interface | Unit tests for the Markdown renderer, formatters, ticket states and the mock backend. |
| Whole app | `pnpm smoke` starts a debug build, types an order into the real window, confirms the ticket and checks the fill in the journal. |

Tests never reach the internet. `cargo run -p octogens-core --example probe -- okx BTC` reads live public data through an adapter when you want to check one against the real exchange.
