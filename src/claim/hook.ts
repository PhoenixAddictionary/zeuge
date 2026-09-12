/**
 * claim/hook — stdin JSON in, stdout hookSpecificOutput out. Wired as Stop and PostToolUse in
 * hooks.json.
 *
 * Invariants (spec §2): exit 0 always; no decision/reason keys; stdout is one JSON object or
 * empty; per-claim_type cooldown (1800s, file state, fail-open); unreadable state, missing
 * ledger, or invalid stdin means exit 0 and silence; nothing read outside .zeuge/ for zeuge's
 * OWN state (the transcript itself is Claude Code's input, not zeuge state).
 *
 * Measured end to end (2026-09-11): an earlier version of this file never loaded a witness at
 * all — `runClaimPass` only detects and marks replays, so every claim it built started and
 * stayed status:"UNWITNESSED", and the code below just filtered on that never-changing field.
 * The hook therefore ASSERTED a check ("Missing witness: no matching ledger event in this
 * session") it never actually performed — the exact silent-pass class this package exists to
 * catch, in the package's own most important surface. It now loads witnesses from
 * `<cwd>/.zeuge/ledger.jsonl` (hash-verified via collectLedgerWitnesses), binds them with the
 * SAME predicate receipt/bundle.ts uses (`witnessBacksClaim`, in witness/binding.ts — one
 * shared function, not a second copy), and nudges only claims that remain UNWITNESSED after
 * that real bind. The message distinguishes three cases so it never claims a check that did
 * not run: no ledger file at that path, ledger present but hash-verification failed, or ledger
 * verified with N events considered but nothing matched.
 *
 * Verified against the official Claude Code hooks doc and a real transcript
 * file (2026-09-11): the REAL Stop payload is
 *   {session_id, prompt_id, transcript_path, cwd, permission_mode,
 *    hook_event_name:"Stop", stop_hook_active:boolean,
 *    last_assistant_message:{type:"text", text:string}}
 * Primary source of the turn text is `last_assistant_message.text`; transcript_path is a
 * fallback used only when it is absent. A real transcript JSONL line is
 *   {type:"assistant", uuid, parentUuid, timestamp, sessionId, cwd,
 *    message:{role:"assistant", content:[{type:"text",text} | {type:"tool_use",...}], ...}}
 * — message.content is an ARRAY of blocks, not a string. The prior parser only handled
 * string content and would have silently seen nothing on every real transcript: exactly the
 * silent-pass class this package exists to catch. The inline `transcript` array of
 * {role,content:string} turns is KEPT as a second, test-only source (hermetic unit tests use
 * it), tried between the two real fields.
 *
 * A JSON.parse failure on one transcript line used to be swallowed
 * with a bare `continue` — a corrupted transcript was indistinguishable from an empty one.
 * `extractFromRealTranscriptFile` now counts malformed lines and reports the count via
 * `TurnTextResult.malformedLines` -> `coverage.transcript_malformed_lines`, and the hook's
 * `additionalContext` says so whenever the count is greater than zero.
 *
 * The transcript file used to be read whole with `readFileSync`.
 * Real transcript files on this platform exceed 80 MB. `extractFromRealTranscriptFile` now
 * reads at most `TRANSCRIPT_READ_BUDGET_BYTES` (a named, documented constant) from the TAIL of
 * the file when it exceeds that budget, then scans upward from the end for the last assistant
 * entry exactly as before. `coverage.transcript_read_bounded` and
 * `coverage.transcript_read_budget_bytes` make a truncated read visible instead of silent.
 *
 * `checkWitnesses` -> `verifyLedgerFile` ->
 * `readFileSync` was not wrapped by anything in `runClaimHook`. Reproduced: put a DIRECTORY at
 * `.zeuge/ledger.jsonl` and send a normal Stop payload — the hook died with a raw Node stack
 * trace on stderr and exit 1, this command's own invariant (exit 0, always) broken by its own
 * core feature. EACCES/EPERM/EBUSY are the realistic triggers (EBUSY is ordinary when two
 * sessions touch their own state concurrently), not just the artificial directory case. The
 * whole claim-check pass (everything after stdin JSON parsing, which already fails closed on
 * its own) now runs inside one try/catch; any throw is reported the same way the pre-existing
 * transcript-unreadable branch already does — `[zeuge] claim check failed: <errorClass>` as
 * `additionalContext`, exit 0 — never a raw stack trace.
 *
 * `stop_hook_active === true` used to return
 * silently before anything was built, on the theory that this hook must not re-prompt on top of
 * a previous re-prompt. Reproduced: that payload with the text "I deployed the service." (a
 * genuinely new, never-before-seen claim) produced empty output and exit 0 — the exact
 * silent-drop this package exists to prevent, on its own most important surface. This hook
 * never blocks, so the loop this guard worried about cannot happen through it; the guard bought
 * nothing and cost every first-occurrence claim on such a turn. The early return is removed —
 * the normal pass now runs on every turn regardless of `stop_hook_active`. Repeat suppression
 * (the only thing worth keeping from the old guard) is already handled correctly downstream, by
 * the SAME statement's replay/cooldown state (seen-store.ts, state.ts, both keyed on the exact
 * `statement_sha256`) — a real repeat of an already-nudged statement stays suppressed; a first
 * occurrence, on any turn, is not.
 *
 * `describeWitnessCheck` used to interpolate
 * `check.ledger_path`, an ABSOLUTE path built from the Stop payload's `cwd`. Reproduced: with no
 * ledger present, the hook emitted `Missing witness: no ledger found at
 * C:\Users\<name>\...\.zeuge\ledger.jsonl.` — that sentence becomes `additionalContext`, which
 * Claude Code appends to the agent's own context and therefore ships to the model provider on
 * the very next request, in a package whose README says it never phones home. `check.ledger_path`
 * is kept on the `WitnessCheckResult` (the `--json` diagnostic surface is explicitly requested by
 * a human/CI caller, not auto-injected) — only the rendered sentence changes, to the fixed
 * relative location every real invocation actually uses (`RunHookParams.zeugeDir` is documented
 * test-only; the real Claude Code wiring never overrides it).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runClaimPass } from "./run";
import { AgentInfo, ClaimRecord } from "./record";
import { loadState, saveState, isInCooldown } from "./state";
import { loadSeen, saveSeen } from "./seen-store";
import { verifyLedgerFile } from "../ledger/verify";
import { collectLedgerWitnesses } from "../witness/sources/ledger";
import { rebindClaims } from "../receipt/bundle";
import { PLACEHOLDER_SESSION } from "../witness/binding";

const DEFAULT_AGENT: AgentInfo = {
  id: "agent:00000000000000000000000000000000",
  vendor: "anthropic",
  model: "unknown",
  harness: "claude-code",
  harness_version: "unknown",
};

export interface WitnessCheckResult {
  status: "NO_LEDGER" | "VERIFICATION_FAILED" | "CHECKED";
  ledger_path: string;
  events_considered: number;
}

/** Loads and hash-verifies the ledger at `ledgerPath`, then binds `claims` against whatever
 *  witnesses it yields, using the SAME predicate the bundle/verify path uses
 *  (`rebindClaims` -> `witnessBacksClaim`). Returns the re-bound claims (unchanged when there
 *  is nothing to check against) plus a report of what was actually checked — a missing ledger
 *  and a ledger that fails hash verification are DISTINCT from "checked, found nothing," and
 *  from each other, so the caller can say exactly what happened instead of asserting a check
 *  that never ran. */
export function checkWitnesses(ledgerPath: string, claims: ClaimRecord[]): { claims: ClaimRecord[]; check: WitnessCheckResult } {
  if (!fs.existsSync(ledgerPath)) {
    return { claims, check: { status: "NO_LEDGER", ledger_path: ledgerPath, events_considered: 0 } };
  }
  const verification = verifyLedgerFile(ledgerPath);
  if (!verification.ok) {
    return { claims, check: { status: "VERIFICATION_FAILED", ledger_path: ledgerPath, events_considered: 0 } };
  }
  const collected = collectLedgerWitnesses(ledgerPath);
  return {
    claims: rebindClaims(claims, collected.witnesses),
    check: { status: "CHECKED", ledger_path: ledgerPath, events_considered: collected.events.length },
  };
}

/** The fixed, always-true relative location of the ledger file within a project.
 *  `RunHookParams.zeugeDir` is documented test-only ("override for tests; default <cwd>/.zeuge")
 *  — the real Claude Code wiring never overrides it, so this literal is accurate for every
 *  turn that actually reaches a model. Printed instead of `check.ledger_path` (an absolute path
 *  built from the Stop payload's `cwd`, which also carries the OS username on this platform) in
 *  the rendered description below, so the sentence that becomes `additionalContext` — and
 *  therefore ships to the model provider on the next request — never leaks either. */
const LEDGER_RELATIVE_PATH = ".zeuge/ledger.jsonl";

/** The exact, distinct wording per witness-check status — used both by the live nudge text and
 *  available to any caller (e.g. --json diagnostics) that wants the same phrasing. Never
 *  describes a check that did not run, and never names an absolute path — the
 *  absolute `check.ledger_path` stays available on the result itself for a diagnostic caller
 *  that explicitly asked for it (e.g. `--json`), just not in this rendered sentence. */
export function describeWitnessCheck(check: WitnessCheckResult): string {
  if (check.status === "NO_LEDGER") return `no ledger found at ${LEDGER_RELATIVE_PATH}`;
  if (check.status === "VERIFICATION_FAILED") return `ledger at ${LEDGER_RELATIVE_PATH} failed hash verification — witnesses not trusted`;
  return `ledger verified, ${check.events_considered} event(s) considered, no matching witness`;
}

interface TranscriptTurn {
  role?: string;
  content?: string;
}

interface RealContentBlock {
  type?: string;
  text?: string;
}

export interface TurnTextResult {
  text: string;
  /** Set when transcript_path was the resolution path AND reading/parsing it threw. A read
   *  failure is NOT "no assistant text" — collapsing them into the same "" was a silent-pass:
   *  the caller must be able to tell "checked, found nothing" from "could not
   *  check at all." */
  transcriptUnreadable?: { errorClass: string };
  /** Count of lines that failed JSON.parse while scanning the real transcript file
   *  (real-file path only — the inline test-only `transcript` array is already-parsed JSON, so
   *  this concept does not apply there). Present only when > 0. */
  malformedLines?: number;
  /** Set when the real transcript file exceeded TRANSCRIPT_READ_BUDGET_BYTES and
   *  only a bounded tail of it was read. `readBudgetBytes` names the exact budget applied. */
  readBounded?: boolean;
  readBudgetBytes?: number;
}

/** Bounded-tail-read budget for a real transcript file: real transcript files on
 *  this platform can exceed 80 MB, and reading one whole with `readFileSync` on every Stop is
 *  unbounded work for a hook that must return quickly. 2 MB comfortably covers many turns of a
 *  real conversation while keeping a hard, named ceiling on the read. */
export const TRANSCRIPT_READ_BUDGET_BYTES = 2 * 1024 * 1024;

/** Reads a transcript file, bounded to at most `budgetBytes` from the END of the file when it
 *  is larger than that budget. Returns whether the read was truncated so the caller can report
 *  it. A bounded read's first captured line is very likely a partial fragment of whatever line
 *  the cut landed inside; that fragment fails JSON.parse and is counted as a malformed line by
 *  the caller exactly like a genuinely corrupted line would be — the truncation is disclosed via
 *  `readBounded`/`readBudgetBytes` regardless, so this is never silent. */
function readTranscriptTail(transcriptPath: string, budgetBytes: number): { raw: string; bounded: boolean } {
  const size = fs.statSync(transcriptPath).size;
  if (size <= budgetBytes) {
    return { raw: fs.readFileSync(transcriptPath, "utf8"), bounded: false };
  }
  const fd = fs.openSync(transcriptPath, "r");
  try {
    const buffer = Buffer.alloc(budgetBytes);
    fs.readSync(fd, buffer, 0, budgetBytes, size - budgetBytes);
    return { raw: buffer.toString("utf8"), bounded: true };
  } finally {
    fs.closeSync(fd);
  }
}

/** Extracts text from a real transcript JSONL: the last line with type==="assistant" whose
 *  message.content array has at least one text block, joining those blocks with "\n". Lines
 *  that are assistant turns made only of tool_use blocks (no text) are skipped. Bounded to
 *  TRANSCRIPT_READ_BUDGET_BYTES from the tail and counts malformed lines it skips
 *  while scanning — both reported on the result rather than silently absorbed. */
function extractFromRealTranscriptFile(transcriptPath: string): TurnTextResult {
  let raw: string;
  let bounded = false;
  try {
    const tail = readTranscriptTail(transcriptPath, TRANSCRIPT_READ_BUDGET_BYTES);
    raw = tail.raw;
    bounded = tail.bounded;
  } catch (err) {
    const errorClass = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.constructor.name) : "UnknownError";
    return { text: "", transcriptUnreadable: { errorClass } };
  }
  const boundedFields = bounded ? { readBounded: true, readBudgetBytes: TRANSCRIPT_READ_BUDGET_BYTES } : {};
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let malformedLines = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      malformedLines++;
      continue;
    }
    if (obj?.type !== "assistant") continue;
    const message = obj.message as { content?: unknown } | undefined;
    if (!message || !Array.isArray(message.content)) continue;
    const textBlocks = (message.content as RealContentBlock[]).filter((b) => b?.type === "text" && typeof b.text === "string");
    if (textBlocks.length === 0) continue;
    return {
      text: textBlocks.map((b) => b.text).join("\n"),
      ...(malformedLines > 0 ? { malformedLines } : {}),
      ...boundedFields,
    };
  }
  return { text: "", ...(malformedLines > 0 ? { malformedLines } : {}), ...boundedFields };
}

/** Resolves the turn text AND reports whether a real transcript file was attempted and
 *  unreadable. `extractLastAssistantText` below is the plain-text convenience wrapper kept for
 *  existing callers that only need the string. */
export function resolveTurnText(payload: Record<string, unknown>): TurnTextResult {
  // 1. Real, primary field.
  const lastAssistantMessage = payload.last_assistant_message as { type?: string; text?: string } | undefined;
  if (lastAssistantMessage && typeof lastAssistantMessage.text === "string") {
    return { text: lastAssistantMessage.text };
  }

  // 2. Test-only convenience: an inline transcript array of {role, content:string} turns.
  if (Array.isArray(payload.transcript)) {
    const turns = payload.transcript as TranscriptTurn[];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]?.role === "assistant" && typeof turns[i]?.content === "string") return { text: turns[i].content as string };
    }
    return { text: "" };
  }

  // 3. Real fallback: parse the transcript file on disk in its real array-of-blocks shape.
  if (typeof payload.transcript_path === "string") {
    return extractFromRealTranscriptFile(payload.transcript_path);
  }

  return { text: "" };
}

export function extractLastAssistantText(payload: Record<string, unknown>): string {
  return resolveTurnText(payload).text;
}

export interface RunHookParams {
  stdinText: string;
  now?: number;
  zeugeDir?: string; // override for tests; default <cwd>/.zeuge
  eventName?: string;
  jsonMode?: boolean;
  /** Test-only: inject a rule set to exercise the probe-DEAD path deterministically. */
  rules?: import("./detect").ClaimRule[];
}

export interface RunHookResult {
  exitCode: 0; // this command's own invariant: exit 0 always, never blocks Claude Code
  stdout: string;
}

export function runClaimHook(params: RunHookParams): RunHookResult {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(params.stdinText);
    if (!parsed || typeof parsed !== "object") return { exitCode: 0, stdout: "" };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { exitCode: 0, stdout: "" };
  }

  // stop_hook_active is NOT a reason to skip detection.
  // It used to short-circuit here unconditionally, silently dropping every genuinely new claim
  // on such a turn. This hook never blocks, so the "loop" the old guard worried about cannot
  // happen through it; the real, and correct, repeat-suppression is the statement-keyed
  // cooldown/replay state below, which runs regardless of this flag. See the file-level doc
  // comment for the full reproduction and rationale.
  const eventNameForErrors = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "Stop";
  try {
    return runClaimPassInner(params, payload);
  } catch (err) {
    // Any throw from here on (most realistically
    // verifyLedgerFile's readFileSync hitting a directory, EACCES, EPERM, or EBUSY) must never
    // produce a raw stack trace and exit 1 — this command's own invariant is exit 0, always. Same
    // shape as the pre-existing transcript-unreadable branch: a named [zeuge]-prefixed
    // additionalContext, reported rather than swallowed or crashed on.
    const errorClass = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.constructor.name) : "UnknownError";
    const additionalContext = `[zeuge] claim check failed: ${errorClass}`;
    const hookSpecificOutput = { hookEventName: params.eventName ?? eventNameForErrors, additionalContext };
    if (params.jsonMode) {
      return { exitCode: 0, stdout: JSON.stringify({ coverage: { error: errorClass }, claims: [], hookSpecificOutput }) + "\n" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput }) + "\n" };
  }
}

/** The real body of the claim-check pass, factored out so `runClaimHook` can wrap all of it
 *  in one try/catch without the indentation churn of wrapping in place. */
function runClaimPassInner(params: RunHookParams, payload: Record<string, unknown>): RunHookResult {
  const cwd = typeof payload.cwd === "string" ? (payload.cwd as string) : process.cwd();
  const zeugeDir = params.zeugeDir ?? path.join(cwd, ".zeuge");
  const sessionId = typeof payload.session_id === "string" ? (payload.session_id as string) : PLACEHOLDER_SESSION;
  const agent: AgentInfo =
    payload.agent && typeof payload.agent === "object" ? { ...DEFAULT_AGENT, ...(payload.agent as object) } : DEFAULT_AGENT;
  const eventName = params.eventName ?? (typeof payload.hook_event_name === "string" ? payload.hook_event_name : "Stop");
  const now = params.now ?? Date.now();

  const turn = resolveTurnText(payload);

  const seenBefore = loadSeen(zeugeDir, now);
  const pass = runClaimPass({
    text: turn.text,
    sessionId,
    agent,
    source: `${eventName.toLowerCase()}_hook.last_assistant_message`,
    seen: seenBefore.keys,
    rules: params.rules,
  });
  saveSeen(zeugeDir, pass.seen, seenBefore, now);
  if (turn.transcriptUnreadable) {
    pass.coverage.transcript_unreadable = true;
    pass.coverage.transcript_unreadable_class = turn.transcriptUnreadable.errorClass;
  }
  // The malformed-line count and the bounded-read flag are surfaced in the coverage block unconditionally (never only inside
  // the nudge text), so a --json/report consumer sees them even on a turn that also nudges for
  // an unrelated reason, or nudges not at all.
  if (turn.malformedLines !== undefined && turn.malformedLines > 0) {
    pass.coverage.transcript_malformed_lines = turn.malformedLines;
  }
  if (turn.readBounded) {
    pass.coverage.transcript_read_bounded = true;
    pass.coverage.transcript_read_budget_bytes = turn.readBudgetBytes;
  }

  // Actually bind the candidate claims to real witnesses before deciding what is
  // UNWITNESSED — this is the check the hook previously asserted but never ran. Only bother
  // touching the ledger at all when there is at least one candidate claim to check; an empty
  // turn (or a DEAD probe, handled below) has nothing to bind.
  let boundClaims = pass.claims;
  let witnessCheck: import("./probe").CoverageBlock["witness_check"];
  if (pass.claims.length > 0) {
    const ledgerPath = path.join(zeugeDir, "ledger.jsonl");
    const bound = checkWitnesses(ledgerPath, pass.claims);
    boundClaims = bound.claims;
    witnessCheck = bound.check;
    pass.coverage.witness_check = bound.check;
  }

  // Cooldown is keyed on the EXACT statement (statement_sha256), never on
  // claim_type. Keying on claim_type meant a second, genuinely different tests_pass sentence
  // was suppressed just because some OTHER tests_pass sentence had been nudged minutes
  // earlier — a false negative. Replay (seen-store, above) already handles "the identical
  // sentence again"; cooldown now only ever suppresses that same exact sentence repeating.
  const unwitnessed = boundClaims.filter((c) => c.status === "UNWITNESSED" && !c.replay);
  const cooldownState = loadState(zeugeDir);
  const claimsToNudge = unwitnessed.filter((c) => !isInCooldown(cooldownState, c.statement_sha256, now));

  let additionalContext: string | undefined;

  if (turn.transcriptUnreadable) {
    // A read failure is reported, not swallowed to a silent "0 claims."
    additionalContext = `[zeuge] transcript unreadable: ${turn.transcriptUnreadable.errorClass}`;
  } else if (pass.coverage.probe === "DEAD") {
    // DEAD is reported, not silence — the hook still never blocks (exit 0), but
    // an agent (and the report) must be able to see that claims were not checked this turn.
    additionalContext = "[zeuge] probe DEAD — claims not checked this turn";
  } else if (claimsToNudge.length > 0) {
    const typesToNudge = Array.from(new Set(claimsToNudge.map((c) => c.claim_type)));
    // The message names exactly what was checked (or why nothing could be checked) —
    // never the previous unconditional, unrun "no matching ledger event" assertion.
    const witnessNote = witnessCheck ? describeWitnessCheck(witnessCheck) : "no ledger checked";
    additionalContext = `[zeuge] ${claimsToNudge.length} claim(s) without a witness: ${typesToNudge.join(", ")}. Missing witness: ${witnessNote}. Name the witness or say NOT CHECKED.`;
    for (const c of claimsToNudge) cooldownState.last_nudged_by_statement[c.statement_sha256] = now;
    saveState(zeugeDir, cooldownState, now);
  }

  // A malformed transcript must never look like "nothing to report" — append (or, if
  // nothing else fired this turn, stand alone as) a note naming the count, independent of
  // whichever branch above did or did not already produce a message.
  if (pass.coverage.transcript_malformed_lines) {
    const note = `[zeuge] transcript had ${pass.coverage.transcript_malformed_lines} malformed line(s) — possible content loss.`;
    additionalContext = additionalContext ? `${additionalContext} ${note}` : note;
  }

  const hookSpecificOutput: { hookEventName: string; additionalContext: string } | null = additionalContext
    ? { hookEventName: eventName, additionalContext }
    : null;

  if (params.jsonMode) {
    // Diagnostic surface for humans/tests/CI — NOT what hooks.json wires into Claude Code.
    // Still exits 0: this is the same command, just verbose, and the hook invariant is
    // unconditional. Carries the BOUND claims (real status), not the pre-binding placeholders.
    return { exitCode: 0, stdout: JSON.stringify({ coverage: pass.coverage, claims: boundClaims, hookSpecificOutput }) + "\n" };
  }

  // Real Claude Code wiring: exactly one JSON object, or nothing.
  if (hookSpecificOutput) {
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput }) + "\n" };
  }
  return { exitCode: 0, stdout: "" };
}
