# Contributing to OctoNeo

Thanks for helping. This guide gets you from a clone to a pull request.

## Ways to help

- **Report a bug** or **suggest an idea** with the issue templates.
- **Fix something.** Issues labelled `good first issue` are a good start.
- **Check the app against the exchange.** [docs/exchange.md](docs/exchange.md) says what has and has not been verified on the live service.
- **Improve the assistant.** [docs/assistant.md](docs/assistant.md) covers the prompt and tools.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Set up

You need [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 20 or newer, [pnpm](https://pnpm.io) 10, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
git clone https://github.com/kerjakuyco/octo-gens.git
cd octo-gens
pnpm install
pnpm tauri dev
```

You do not need a wallet or a model key. Market data is public, and the tests run against stand-ins for the exchange and for every model provider. To chat with the assistant in the running app you do need a model: a free one in [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) is enough.

| To work on | Run | Needs |
| --- | --- | --- |
| The core | `cargo test -p octoneo-core` | Rust only |
| The interface | `pnpm dev` (browser, mock core) | Node only |
| The whole app | `pnpm tauri dev` | Both |

Two examples run the core without a window. Both only read, and sign nothing:

```sh
cargo run -p octoneo-core --example probe   # live market data from both networks
cargo run -p octoneo-core --example news    # the real news feeds, and which publishers let an app read a page
```

## Before you open a pull request

Run what CI runs:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm typecheck && pnpm lint && pnpm test
```

If you touched the shell, the interface or the contract between them, also run the end-to-end smoke test. It opens the app window briefly:

```sh
pnpm tauri build --debug --no-bundle
pnpm smoke
```

### Local builds on macOS and the keychain

A build made on your Mac is sealed with an ad-hoc signature, and that signature is different for every build. macOS ties keychain access to it, so each new build asks again whether it may read the keys an earlier build stored. To keep one identity across builds, sign with a certificate you already have, for example an Apple Development certificate:

```sh
security find-identity -v -p codesigning     # the identities you can sign with
APPLE_SIGNING_IDENTITY="Apple Development: you@example.com (TEAMID)" pnpm tauri build --bundles app
```

The first launch of a build signed this way still asks once for each key an earlier build stored; choose *Always Allow* and later builds are not asked again. Never commit an identity: `tauri.conf.json` stays on the ad-hoc signature (`"-"`).

The smoke test does not touch the keychain. It sets `OCTONEO_NO_KEYCHAIN`, which keeps keys in memory for the session.

## What we look for

- **Tests that would fail without your change.** Tests live beside the code. They never reach the internet: the exchange and model providers are mocked with local HTTP servers.
- **Money is exact.** Use `rust_decimal::Decimal` for prices, quantities and balances. Floats are for indicators only.
- **Errors are for the trader.** A `DeskError` is shown as-is. Say what went wrong and what to do next. Never put a secret in one.
- **The assistant cannot trade.** Do not add a tool that places, changes or cancels an order, and do not weaken the checks listed under *Safeguards* in [docs/assistant.md](docs/assistant.md). Pull requests that do will not be merged.
- **A model answers, or nothing does.** There are no rule-based replies and no typed commands. Do not add a path that answers a message without the connected model.
- **The app never asks for withdrawal.** The API wallet is approved for perpetual trading only. Do not add a request that moves funds, and never ask for a wallet's own key or seed phrase.
- **Secrets stay in the keychain.** Nothing secret goes in preferences, the journal, logs, snapshots or errors.
- **The contract stays in step.** If you change a type in `src/api/types.ts` or `crates/octoneo-core/src/studio/view.rs`, change the other. `tests/contract.rs` will tell you if you missed one.
- **Small dependencies.** This app holds a key that can trade, so every new dependency is a risk. Explain why you need one.
- **Interface copy** is short, plain and in sentence case: a label, not an explanation. If a screen needs a paragraph to be understood, change the screen. The font stack is the system UI stack; do not add font files.

## Commits and pull requests

- Keep a pull request to one change. Describe what it does and why, and how you tested it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), in the imperative: `feat(exchange): add limit orders`, not "Added" or "Adds".
- Add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased* for anything a user would notice.
- By contributing you agree that your work is licensed under [GPL-3.0-only](LICENSE).

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
