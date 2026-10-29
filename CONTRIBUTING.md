# Contributing

Welcome aboard. zeuge is a verification and receipt layer for people who
run AI coding agents — keep contributions in that spirit: witnessed,
reproducible, small.

## How to contribute

1. Fork, branch, change, pull request. Small PRs beat large ones.
2. The PR body says *what* changed and *why*, with receipts: command output
   before/after when behavior changed.
3. Nothing merges without the maintainer. Draft PRs welcome for early
   feedback.

## Constraints

- **Zero runtime dependencies.** `dependencies` in package.json stays
  empty. Dev tooling (typescript, vitest, tsx) is fine; runtime deps are
  not — if you think one is needed, the PR must argue for it.
- **Node >= 20, CommonJS.** Source in `src/`, built to `dist/` with
  `npm run build`.
- **Tests gate the merge.** `npm test` (vitest, with the `verify:dist`
  pretest) must pass. Add tests for new behavior; fixtures go in
  `fixtures/`.
- **No secrets.** No tokens, credentials, or personal data in any file,
  fixture, commit message, or PR body.
- MIT licensed; by opening a PR you agree your contribution lands under
  MIT.
