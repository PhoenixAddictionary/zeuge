/**
 * claim-hook-witness — the Stop hook must actually bind claims to real ledger
 * witnesses before nudging, and its nudge text must name what was actually checked (no ledger,
 * verification failed, or verified-but-nothing-matched) rather than asserting a check that
 * never ran. Complements the pure-predicate tests in witness-binding.test.ts and the
 * through-the-real-CLI acceptance tests in e2e-witness.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runClaimHook } from "../src/claim/hook";
import { appendEvent } from "../src/ledger/append";

const tmpDirs: string[] = [];
function tmpZeugeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-hook-p11-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge");
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function stopPayload(sessionId: string, text: string): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: "/irrelevant",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: { type: "text", text },
  });
}

// Note: appendEvent bodies below now set `command_kind: "test"`. These
// tests assert a `tests_pass` claim ("All tests pass.") becomes WITNESSED via a real ledger
// event — since the command_kind binding fix, a COMMAND_RUN event only backs `tests_pass` when its body
// carries `command_kind: "test"`, so the field is required for these tests to still exercise
// what they are named for (session binding / witness-check reporting), not the unrelated
// command-classification gate.
describe("claim/hook — P11 real witness binding", () => {
  it("a PASS ledger event in the SAME session yields WITNESSED, one witness, no nudge", () => {
    const zeugeDir = tmpZeugeDir();
    const ledgerPath = path.join(zeugeDir, "ledger.jsonl");
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:00000000000000000000000000000001" },
      body: { exit_code: 0, session_id: "session:s9", command_kind: "test" },
    });

    const result = runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0].status).toBe("WITNESSED");
    expect(parsed.claims[0].witnesses).toHaveLength(1);
    expect(parsed.coverage.witness_check.status).toBe("CHECKED");
    expect(parsed.coverage.witness_check.events_considered).toBe(1);
    expect(parsed.hookSpecificOutput).toBeNull();
  });

  it("no ledger file at all yields UNWITNESSED plus a nudge naming the missing-ledger case", () => {
    const zeugeDir = tmpZeugeDir(); // never created, no ledger.jsonl written
    const result = runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000, jsonMode: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.claims[0].status).toBe("UNWITNESSED");
    expect(parsed.coverage.witness_check.status).toBe("NO_LEDGER");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/no ledger found/);
  });

  it("a ledger that fails hash verification yields UNWITNESSED plus a nudge naming verification failure, not 'nothing matched'", () => {
    const zeugeDir = tmpZeugeDir();
    fs.mkdirSync(zeugeDir, { recursive: true });
    const ledgerPath = path.join(zeugeDir, "ledger.jsonl");
    fs.writeFileSync(ledgerPath, JSON.stringify({ schema: "zeuge.ledger.event.v1", seq: 1, event_hash: "tampered" }) + "\n");

    const result = runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000, jsonMode: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.claims[0].status).toBe("UNWITNESSED");
    expect(parsed.coverage.witness_check.status).toBe("VERIFICATION_FAILED");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/failed hash verification/);
  });

  it("a ledger event from a DIFFERENT (known) session does not witness — exclusion still works", () => {
    const zeugeDir = tmpZeugeDir();
    const ledgerPath = path.join(zeugeDir, "ledger.jsonl");
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:00000000000000000000000000000002" },
      body: { exit_code: 0, session_id: "session:other-session", command_kind: "test" },
    });

    const result = runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000, jsonMode: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.claims[0].status).toBe("UNWITNESSED");
    expect(parsed.coverage.witness_check.status).toBe("CHECKED");
    expect(parsed.coverage.witness_check.events_considered).toBe(1);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/1 event\(s\) considered, no matching witness/);
  });
});

// checkWitnesses -> verifyLedgerFile -> readFileSync was
// unguarded anywhere in runClaimHook. Reproduced with a DIRECTORY in place of the ledger file
// (readFileSync throws EISDIR) — the realistic triggers on a live install are EACCES/EPERM/EBUSY,
// but a directory is the deterministic, cross-run-reliable way to force the same throw in a test.
describe("claim/hook — a throw anywhere in the claim-check pass never escapes as a crash", () => {
  it("a DIRECTORY in place of .zeuge/ledger.jsonl: exit 0, no throw, additionalContext names the failure instead of a stack trace", () => {
    const zeugeDir = tmpZeugeDir();
    const ledgerPath = path.join(zeugeDir, "ledger.jsonl");
    fs.mkdirSync(ledgerPath, { recursive: true }); // a directory where the ledger file is expected

    expect(() => runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000, jsonMode: true })).not.toThrow();

    const result = runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/^\[zeuge\] claim check failed: /);
    expect(parsed.hookSpecificOutput.additionalContext).not.toMatch(/at Object\.|at Module\.|\.js:\d+:\d+/); // no stack-trace shape
  });

  it("the same directory-in-place-of-ledger case in the real (non-json) Claude Code wiring: exit 0, no throw", () => {
    const zeugeDir = tmpZeugeDir();
    const ledgerPath = path.join(zeugeDir, "ledger.jsonl");
    fs.mkdirSync(ledgerPath, { recursive: true });

    let result: ReturnType<typeof runClaimHook> | undefined;
    expect(() => {
      result = runClaimHook({ stdinText: stopPayload("session:s9", "All tests pass."), zeugeDir, now: 1000 });
    }).not.toThrow();
    expect(result!.exitCode).toBe(0);
    expect(result!.stdout).not.toBe("");
    const parsed = JSON.parse(result!.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/^\[zeuge\] claim check failed: /);
  });
});

// describeWitnessCheck used to interpolate the absolute
// ledger_path (built from the Stop payload's cwd, which carries the OS username on this
// platform) directly into additionalContext — a string that Claude Code appends to the agent's
// own context and ships to the model provider on the next request.
describe("claim/hook — the emitted witness-check string never carries an absolute path", () => {
  it("no ledger present: the nudge names the fixed relative .zeuge/ledger.jsonl location, never a joined absolute path", () => {
    const zeugeDir = tmpZeugeDir(); // never created, no ledger.jsonl written
    // A cwd chosen to be unmistakably absolute and to carry what a real OS username segment
    // looks like, so the assertion actually exercises "no absolute path leaked" rather than
    // happening to pass because the fixture cwd was already short.
    const payload = JSON.stringify({
      session_id: "session:s9",
      cwd: path.join(os.homedir(), "some-project"),
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: { type: "text", text: "All tests pass." },
    });

    const result = runClaimHook({ stdinText: payload, zeugeDir, now: 1000, jsonMode: true });
    const parsed = JSON.parse(result.stdout);
    const message: string = parsed.hookSpecificOutput.additionalContext;
    expect(message).toContain(".zeuge/ledger.jsonl");
    expect(message).not.toContain(os.homedir());
    expect(message).not.toContain(zeugeDir);
    // No absolute-path shape at all: no drive letter, no leading slash, no backslash.
    expect(message).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(message).not.toMatch(/\\/);
  });
});
