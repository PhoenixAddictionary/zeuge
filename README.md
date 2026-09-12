# zeuge

Audit what your coding agent claimed, not just what it ran.

Node >= 20. TypeScript. Zero runtime dependencies.

## Sixty seconds

No install, no licence, no network — just the repository as checked out. This asks the same
question zeuge asks on every agent turn: does this sentence have a witness?

Ask whether "All tests pass." has anything behind it yet:

```bash
echo '{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":{"type":"text","text":"All tests pass."}}' > stop.json

node bin/zeuge.js claim hook --event Stop --json < stop.json \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).claims[0].status)"
```

```
UNWITNESSED
```

Now record one passing test run in the ledger, and ask the exact same question again:

```bash
echo '{"eventFamily":"ACTION","actionType":"COMMAND_RUN","outcome":"PASS","actor":{"kind":"TOOL","id":"tool:npm-test"},"body":{"command_kind":"test"}}' > test-run.json
node bin/zeuge.js ledger append --event test-run.json

node bin/zeuge.js claim hook --event Stop --json < stop.json \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).claims[0].status)"
```

```
{"schema":"zeuge.ledger.event.v1","ledger_id":"ledger:...","seq":1,"recorded_at":"...","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","event_id":"event:...","event_family":"ACTION","action_type":"COMMAND_RUN","outcome":"PASS","trust_level":"L2","actor":{"kind":"TOOL","id":"tool:npm-test"},"body":{"command_kind":"test"},"body_sha256":"...","event_hash":"..."}
WITNESSED
```

(the ids, hashes, and timestamp on that middle line will differ on your own run — every ledger
event is stamped uniquely by design; only the two status lines, `UNWITNESSED` then `WITNESSED`,
are the point.)

Same sentence, same command, one ledger event appended in between. That contrast — a claim
with nothing behind it, then the same claim with a real command run behind it — is the whole
product. Everything below is how this happens automatically, inside a real agent session,
instead of by hand like this.

## The gap

Existing tools log actions: protect-mcp (MIT) signs and hash-chains tool calls; TraceAgent and
MintMCP host action logs. None of them reads the agent's own sentences ("all tests pass",
"deployed", "done") and asks: where is the witness?

Regulators now ask for event records (EU AI Act Art. 12 / Annex III, in force 2026-08-02) and an
IETF draft (Agent Audit Trail) standardizes hash-chained agent logs. zeuge writes its ledger in
that vocabulary.

## What it does

The headline is the claim audit, not the lints — the lints are supporting checks that catch
instruction-file faults which make an agent misbehave in the first place.

1. `zeuge claim` — a Stop hook that classifies the agent's final message into claim types
   (`tests_pass`, `deployed`, `fixed`, `done`, `file_exists`, `command_ran`) and marks each
   `WITNESSED` or `UNWITNESSED` against the ledger (`REFUTED` is a reserved third status for a
   planned refutation ledger and is not emitted by this free hook yet). Runs a positive-control
   probe first; a dead probe is reported, never hidden. Never blocks the agent.
2. `zeuge lint` — a supporting check for two instruction-file faults: a `PreToolUse` hook
   matcher that gates the agent's own diagnostic tools (self-lockout, on by default, severity
   `risk`), and an ordering clause placed after the action it qualifies (opt-in via
   `--experimental-order`, severity `review` — see below). Declares its blind spots in every
   run. Exit 3, never a silent 0, on unparsable input or nothing scanned.
3. `zeuge ledger` — hash-chained JSONL of tool outcomes; `verify` re-derives every hash and
   reports tamper, reorder, insert, and backdate; says plainly when the head is unbound
   (truncation not detectable without an out-of-band head).
4. `zeuge bundle` / `zeuge verify` / `zeuge report` — assembles a signed claim bundle from a
   session's claims, coverage, and ledger; verifies it fully offline by recomputing every hash
   and signature over the bundle's own bytes; renders it as a single-file HTML report with no
   network calls or external assets.

### Field test (2026-09-11)

Every finding carries a `severity` of `fault`, `risk`, or `review`; `zeuge lint` exits 1 by
default only on a `fault` (`--strict` makes any finding exit 1). This exists because of a
measurement, not a guess: run over 696 public third-party instruction files, the
instruction-order lint's original rule produced 457 findings across 210 files (30%), and the
inspected examples were false positives — the marker word appeared as ordinary prose, not an
ordering clause. A tightened rule (the clause must lead its own bullet, with no blank line
before it) leaves 12 findings across the same corpus, a 97.4% reduction. Consequently,
instruction-order is off by default, opt-in via `--experimental-order`, and every finding it
reports is severity `review`, never `fault`.

## Usage

```
zeuge --help
zeuge lint <path> [--json] [--experimental-order] [--strict]
zeuge claim hook --event <Stop|PostToolUse> [--json]
zeuge claim detect [<file>] [--stdin] [--json]
zeuge claim rules --list|--sha256
zeuge ledger append --event <file> [--ledger <path>]
zeuge ledger verify [<path>] [--expected-head <hex>] [--json]
zeuge ledger head [<path>]
zeuge bundle --claims <file> --coverage <file> [--ledger <path>] [--session <id>] --out <file> [--sign]
zeuge verify <bundle.json> [--json] [--require-witnessed]
zeuge report <bundle.json> --html <out.html>
zeuge licence set <key> [--org <id>]
zeuge licence status [--json]
```

`zeuge lint <path>` looks for:

- `<path>/.claude/settings*.json` — scanned for `PreToolUse` matchers whose alternatives
  include `Read`, `Grep`, or `Glob`. On by default.
- `<path>/CLAUDE.md` and `<path>/AGENTS.md` — scanned for an evaluation-order clause that leads
  its own bullet immediately after the action it qualifies. Only scanned with
  `--experimental-order` (see Field test, above).

## What it does not do

- It does not prove the code is correct. It binds what was said to what was witnessed.
- It does not sign tool calls (use protect-mcp for that; zeuge can read its receipts as
  witnesses — adapter planned, not yet built).
- It does not phone home. The only network call is an optional licence check.

## Install

### As a Claude Code plugin

```
claude plugin marketplace add <owner>/<repo>
claude plugin install zeuge@zeuge
```

See `INSTALL.md` for the exact hook wiring this installs (`Stop` and `PostToolUse`, both
read-only at the plugin layer — they never block a tool call or a turn).

### Without a plugin, in any project

```
npx zeuge lint .
```

## Exit codes

Every command shares one contract:

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | finding (a gate fired — a lint finding, or `verify --require-witnessed` on an unwitnessed gated claim) |
| `2` | usage or invalid input |
| `3` | integrity failure (tamper, bad signature, broken hash chain, an unreadable transcript in `claim detect`, or `claim detect`'s own positive-control probe reporting `DEAD`) |
| `4` | licence required — `zeuge report` or `zeuge verify --require-witnessed` with no VALID/GRACE licence state (`zeuge licence status` explains why) |

`--json` prints exactly one JSON object to stdout; human-readable text goes to stderr for
errors and stdout for normal output.

## Licence key (Pro features)

`report` and `verify --require-witnessed` are the only Pro-gated commands; everything else
(`lint`, `claim`, `ledger`, plain `verify`) is free and unlicensed, always. `zeuge licence set
<key>` stores a key locally; `zeuge licence status` checks it against Polar (the only network
call in this package) and caches the result with a 14-day offline grace window so the tool keeps
working without a connection.

**This offline check is a convenience for honest users, not a security boundary.** The cache is
HMAC-checked so a hand-edited cache file (e.g. someone stretching `grace_until`) is detected, but
the HMAC key is derived from the licence key itself — anyone holding any key string, including a
revoked or fabricated one, can produce a cache this tool accepts. That is a known, accepted
limitation, not an oversight: this package is MIT-licensed source, and deleting the licence check
entirely takes under a minute, so a heavier local cryptographic scheme would be theatre, not
protection. Revocation only takes effect the next time `zeuge licence status` can reach the
provider — an offline machine keeps whatever grace it had already earned. (Checked against
Polar's documented validate-response schema: it carries no signature or other client-verifiable
field to bind the cache to instead, so this is the honest floor, not a placeholder.)

By default the key is stored under your OS's own per-user config directory —
`%LOCALAPPDATA%\zeuge` on Windows, `$XDG_CONFIG_HOME/zeuge` (or `~/.config/zeuge`) elsewhere —
never inside the current project, so it can't end up committed to a repository by accident. Set
`ZEUGE_LICENSE_DIR` to override that location. An existing project-local `.zeuge/licence.json`
from an earlier version is still read (nobody loses their key on upgrade), but `licence
set`/`licence status` print a one-line warning when that file sits inside a git work tree; move
it by deleting the file and re-running `zeuge licence set <key>`. **Add `.zeuge/` to your
project's `.gitignore` regardless** — the cache file that lives alongside the key is lower risk
(it holds only a hash of the key, never the key itself) but still has no reason to be committed.

## Threats — what a zeuge receipt does not prove

1. **It binds what was witnessed, not that the code is correct.** A `WITNESSED` `tests_pass`
   claim proves a command that LOOKS like a test invocation ran and exited 0 in a recorded
   environment (`command_kind: "test"`, classified lexically from a small documented table —
   see `src/ledger/command-kind.ts`). A command that looks like a test run is still not proof
   that the suite covered anything, ran meaningfully, or exited 0 for the right reason; the
   classification itself is lexical, not semantic, so an aliased or wrapped command is
   classified by its surface text. `WITNESSED` is not `true`.
2. **Local key custody.** Keys are generated and held on the audited machine, so whoever
   controls it can sign a bundle describing events that did not happen. `zeuge verify` reports
   its own authenticity as `LOCAL_ONLY` for exactly this reason — a signature proves custody
   continuity since signing, not honesty at signing time.
3. **Clock trust.** `recorded_at` and related timestamps come from the local clock.
   Monotonicity is checked within a chain; absolute time is unverified.
4. **Detection is regex-shaped.** Unusual phrasing produces no claim, and an undetected claim
   looks exactly like a claim that never existed.
5. **Hash chains detect tampering, not prevent it.** `zeuge ledger verify` without
   `--expected-head` reports `head_binding: UNBOUND` — truncation of the tail is not detectable
   without an externally held head hash to compare against.
6. **Omission is invisible.** Nothing forces an agent to emit events. Silence is not evidence
   an action did not occur.
7. **No authority.** A receipt grants no merge, deploy, publish, or payment right. It is
   evidence handed to whoever holds that authority.
8. **The cooldown store's entry cap is a soft bound.** Every entry created in a turn carries
   the current timestamp and is therefore exempt from eviction while it is inside the cooldown
   window (1800s), so the worst case is the number of distinct claim statements one installation
   produces within that window, not the nominal cap.
9. **A payload carrying no session id at all yields a permissive witness match** (claim_type
   membership and the time window only, no session exclusion). The harness this package targets
   always sends one, so this is a documented edge, not a live hole.

## Network behaviour

Offline by default. Every tool in this category claims that; this one had it checked rather than
just asserted.

- The only network call anywhere in this package is `zeuge licence status`, which checks a
  stored key against Polar.
- `zeuge licence set` stores a key locally and itself makes no network call.
- `lint`, `claim`, `ledger`, and plain `verify` (without `--require-witnessed`) never touch the
  network — the check is not on their path at all.
- The Pro-gated commands' own licence check — `verify --require-witnessed` and `report` — also
  never calls the network itself: both read only a local, HMAC-checked cache. See "Licence key"
  above for exactly what that check does and does not guarantee.

**How that was verified.** Two independent passes, not one assertion:

- **Static.** A pass over the shipped source, the compiled `dist/` output, and the packaged
  binary found exactly one absolute URL anywhere in any of the three: the licence provider's
  own validation endpoint. Neither the `http`/`https` modules, `net`, `dgram`, DNS, nor TLS
  appear anywhere; there is no `child_process` use, no WebSocket, no `XMLHttpRequest`, and the
  package ships with zero runtime dependencies — nothing else is loaded that could originate a
  connection.
- **Dynamic.** A pass ran every free (non-licence-gated) command — the ledger hook, the claim
  hook, `lint`, `ledger verify`, and plain `verify` — with the outbound-connection primitives
  replaced by recording tripwires instead of mocks that simply return success. Zero outbound
  attempts were recorded across the run, and each command was separately confirmed to have
  actually executed its real logic rather than exiting early on a missing fixture or an
  unrelated error — a command that exits before reaching the network proves nothing about
  whether it would have called out.
- **Limitation.** The dynamic pass only instruments the one Node process it runs in; a child
  process or a native addon spawned from inside it would not be seen by those tripwires. That
  is exactly what the static result above rules out: there is no `child_process` call anywhere
  in the source, compiled output, or binary, so nothing in this package can spawn one to route
  around the instrumentation.

Verifying this yourself does not require trusting either pass: grep the compiled `dist/` and the
packaged binary for `http://` and `https://` and confirm the licence endpoint is the only hit,
then check `package.json` for `dependencies`.

## License

MIT, see `LICENSE`. Copyright (c) 2026 Raeder Unfinished.

## Development

```sh
npm install
npm test          # vitest
npm run build      # tsc -> dist/
node bin/zeuge.js lint fixtures/sample-project        # exit 1, three planted findings
node bin/zeuge.js lint fixtures/sample-project-clean  # exit 0
```

Running `npm test` from a downloaded archive (e.g. GitHub's "Download ZIP") rather than a clone skips two checks that need a real git checkout — the `pretest` dist/ build-output check and four git-archive-export tests — and reports them accordingly; a clone runs all of them.

Line endings are normalized to LF via `.gitattributes`, so a clone on any platform checks out the same bytes and reproduces the committed `dist/` build byte for byte.
