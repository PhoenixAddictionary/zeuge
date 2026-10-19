# Security Policy

## Scope

zeuge is a local CLI and hook layer: instruction-order and hook-matcher
lints, a claim-shape probe, and a hash-chained ledger. It runs on your
machine, has no telemetry, and talks to no server. The realistic risks are:

- a hook or lint that executes or exfiltrates something it should not,
- a crafted input (config, ledger, claim file) that breaks the parser,
- supply-chain risk through dependencies — kept minimal on purpose
  (zero runtime dependencies; dev-only tooling).

## Reporting

- Prefer GitHub's private vulnerability reporting (Security tab → Report a
  vulnerability) for anything sensitive.
- Otherwise open an issue without sensitive detail and say where the
  problem lives.
- If you find a committed secret, say which file — never quote the secret.

No SLA. Community project; reports are read and answered in the open unless
they must stay private.

## Standing rules

- Claims are witnessed or marked. zeuge exists to tell OBSERVED from
  SIMULATED_NOT_OBSERVED — the tool itself never claims what it did not
  run.
- No tokens, credentials, or personal data in any file, fixture, or ledger
  sample.
