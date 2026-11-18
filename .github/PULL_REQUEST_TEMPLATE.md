## What this changes

<!-- What does it do, and why? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, and anything you checked by hand. -->

## Checklist

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass
- [ ] New behaviour has a test that fails without the change
- [ ] `src/api/types.ts` and `crates/octogens-core/src/studio/view.rs` still match, if either changed
- [ ] The assistant still cannot place, change or cancel an order, and no secret reaches a prompt, log, snapshot or the journal
- [ ] `CHANGELOG.md` has a line under *Unreleased*, if a user would notice the change
