# Contributing to Octo Gens

Thanks for helping. This guide gets you from a clone to a pull request.

## Ways to help

- **Report a bug** or **suggest an idea** with the issue templates.
- **Fix something.** Issues labelled `good first issue` are a good start.
- **Add an exchange.** [docs/exchanges.md](docs/exchanges.md) walks through it.
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

You do not need exchange accounts or a model key. The sample tape and the paper account work offline.

| To work on | Run | Needs |
| --- | --- | --- |
| The core | `cargo test -p octogens-core` | Rust only |
| The interface | `pnpm dev` (browser, mock core) | Node only |
| The whole app | `pnpm tauri dev` | Both |

Two examples run the core without a window:

```sh
cargo run -p octogens-core --example desk -- sample "Compare BTC and ETH"
cargo run -p octogens-core --example probe -- okx BTC    # live public data
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

## What we look for

- **Tests that would fail without your change.** Tests live beside the code. They never reach the internet: exchanges and model providers are mocked with local HTTP servers.
- **Money is exact.** Use `rust_decimal::Decimal` for prices, quantities and balances. Floats are for indicators only.
- **Errors are for the trader.** A `DeskError` is shown as-is. Say what went wrong and what to do next. Never put a secret in one.
- **The assistant cannot trade.** Do not add a tool that places, changes or cancels an order, and do not weaken the checks listed under *Safeguards* in [docs/assistant.md](docs/assistant.md). Pull requests that do will not be merged.
- **Secrets stay in the keychain.** Nothing secret goes in preferences, the journal, logs, snapshots or errors.
- **The contract stays in step.** If you change a type in `src/api/types.ts` or `crates/octogens-core/src/studio/view.rs`, change the other. `tests/contract.rs` will tell you if you missed one.
- **Small dependencies.** This app holds exchange keys, so every new dependency is a risk. Explain why you need one.
- **Interface copy** is plain and in sentence case. The font stack is the system UI stack; do not add font files.

## Commits and pull requests

- Keep a pull request to one change. Describe what it does and why, and how you tested it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), in the imperative: `feat(venues): add Kraken adapter`, not "Added" or "Adds".
- Add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased* for anything a user would notice.
- By contributing you agree that your work is licensed under [GPL-3.0-only](LICENSE).

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
