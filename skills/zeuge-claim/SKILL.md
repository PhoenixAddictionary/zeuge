---
name: zeuge-claim
description: Before asserting tests pass / deployed / fixed / done, check the claim
  against the witnesses of this session. Use at the end of any turn carrying such a claim.
---

Before writing a sentence like "tests pass", "deployed", "fixed", or "done" into a reply or a
handoff document, run `npx zeuge claim detect --stdin --json` over the drafted text (raw prose
on stdin, or a hook-payload-shaped JSON object — both are accepted; see below). Read the
`claims` array in its output: each claim carries a `status` of `UNWITNESSED` or `WITNESSED`. A
third status, `REFUTED`, is reserved for a planned refutation ledger and is not emitted by this
command yet — never expect or wait for it.

- **UNWITNESSED** — do not assert the claim as fact. Either produce the witness (run the
  command and show its exit code, hash the file and show the hash, point at the specific ledger
  event) or rewrite the sentence as `NOT CHECKED: <claim>`. Never restate an UNWITNESSED claim
  as though the detector's silence were confirmation.
- **WITNESSED** — the claim has at least one matching ledger event or receipt inside the same
  session and a ~30-minute time window. State the claim and name the witness (its `locator`),
  not just the status word.

Detection: `zeuge claim detect [<file>] [--stdin] [--json]`. It runs a positive-control
    probe first: if the probe reports `DEAD`, the command exits 3 and emits no
    claim records at all — treat that as "the detector itself is broken right now," never as
    "no claims were made." A `transcript_path` in the input that cannot be read is the same
    kind of failure: exit 3, reported, not silently swallowed as empty text.
Ledger: Record tool outcomes with `zeuge ledger append`; never hand-edit the ledger to manufacture a
    witness. `zeuge ledger verify` re-derives every hash and reports tamper, reorder, insert,
    and backdate; it says plainly when the head is `UNBOUND` (truncation is not detectable
    without `--expected-head`).
Handoff: Before a handoff: `zeuge bundle --claims <file> --coverage <file> --ledger <path> --session
    <id> --out bundle.json --sign`, then `zeuge verify bundle.json --require-witnessed` (exit 1
    if any `done`/`tests_pass` claim is not `WITNESSED`) and attach `zeuge report bundle.json
    --html report.html`. Quote the exit code, not a paraphrase of it — `verify`'s authenticity
    is `LOCAL_ONLY` (a bundle proves what its own signing machine attests, nothing more; see the
    report's own THREATS section).
Licence: A licence block (exit 4, from `report` or `verify --require-witnessed`) is reported, never
    worked around. Run `zeuge licence status` to see why (VALID, GRACE with days remaining,
    EXPIRED, REVOKED, or UNKNOWN with no key set) — never retry the same command hoping it
    passes on its own.
