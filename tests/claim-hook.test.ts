import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runClaimHook, extractLastAssistantText } from "../src/claim/hook";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "claims");
const read = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");

const tmpDirs: string[] = [];
function tmpZeugeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-hook-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge");
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("claim/hook — hook contract, cooldown and coverage", () => {
  it("hook contract (positive): a valid Stop fixture returns valid JSON and exits 0", () => {
    const zeugeDir = tmpZeugeDir();
    const result = runClaimHook({ stdinText: read("stop-hook-fixture.json"), zeugeDir, now: 1000 });
    expect(result.exitCode).toBe(0);
    if (result.stdout.trim()) expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("hook contract (negative): malformed-stdin.json exits 0 with empty stdout", () => {
    const zeugeDir = tmpZeugeDir();
    const result = runClaimHook({ stdinText: read("malformed-stdin.json"), zeugeDir, now: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("coordinator fixture: 2 UNWITNESSED claims in --json, coverage.probe ALIVE, no matching ledger witness", () => {
    const zeugeDir = tmpZeugeDir();
    const result = runClaimHook({ stdinText: read("stop-hook-fixture.json"), zeugeDir, now: 1000, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.probe).toBe("ALIVE");
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.claims.map((c: { claim_type: string }) => c.claim_type).sort()).toEqual(["deployed", "tests_pass"]);
    for (const c of parsed.claims) {
      expect(c.status).toBe("UNWITNESSED");
      expect(c.witnesses).toEqual([]);
    }
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/2 claim\(s\) without a witness/);
  });

  // changed cooldown's key from claim_type to statement_sha256 (a false negative:
  // keying on claim_type suppressed a genuinely NEW, different sentence of the same type just
  // because some OTHER sentence of that type had been nudged minutes earlier). Cooldown is
  // therefore now demonstrated with the IDENTICAL statement across two different session_ids
  // (cooldown is keyed globally on the statement alone; replay is scoped to session_id, so a
  // second session repeating the exact same sentence is a case replay does NOT suppress but
  // cooldown does — this isolates the mechanism under test).
  function stopPayloadWithSession(sessionId: string, text: string): string {
    return JSON.stringify({
      session_id: sessionId,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: { type: "text", text },
    });
  }

  it("cooldown (positive): the identical sentence from a DIFFERENT session inside 1800s is suppressed by cooldown, not replay", () => {
    const zeugeDir = tmpZeugeDir();
    const first = runClaimHook({ stdinText: stopPayloadWithSession("session:aaaa", "All tests pass."), zeugeDir, now: 1_000_000, jsonMode: true });
    expect(JSON.parse(first.stdout).hookSpecificOutput).not.toBeNull();

    const second = runClaimHook({ stdinText: stopPayloadWithSession("session:bbbb", "All tests pass."), zeugeDir, now: 1_000_000 + 60_000, jsonMode: true });
    // A different session means replay (session-scoped) does NOT flag this claim, yet it is
    // still not nudged — cooldown (global, by statement_sha256) is what suppresses it here.
    expect(JSON.parse(second.stdout).claims[0].replay).toBeUndefined();
    expect(JSON.parse(second.stdout).hookSpecificOutput).toBeNull();
  });

  it("cooldown (fix 1, the false-negative case): two DIFFERENT tests_pass sentences 1 minute apart are BOTH nudged", () => {
    const zeugeDir = tmpZeugeDir();
    const first = runClaimHook({ stdinText: read("stop-hook-fixture.json"), zeugeDir, now: 1_000_000, jsonMode: true });
    expect(JSON.parse(first.stdout).hookSpecificOutput).not.toBeNull();

    const second = runClaimHook({ stdinText: read("stop-hook-fixture-2.json"), zeugeDir, now: 1_000_000 + 60_000, jsonMode: true });
    expect(JSON.parse(second.stdout).hookSpecificOutput).not.toBeNull();
  });

  it("cooldown (negative — clock moved backward): still nudges, never crashes", () => {
    const zeugeDir = tmpZeugeDir();
    const first = runClaimHook({ stdinText: stopPayloadWithSession("session:cccc", "All tests pass."), zeugeDir, now: 10_000_000, jsonMode: true });
    expect(JSON.parse(first.stdout).hookSpecificOutput).not.toBeNull();

    // Same statement, a different session (so replay does not confound this), clock moved
    // backward by an hour relative to the first call's recorded cooldown timestamp.
    const second = runClaimHook({ stdinText: stopPayloadWithSession("session:dddd", "All tests pass."), zeugeDir, now: 10_000_000 - 3_600_000, jsonMode: true });
    expect(() => JSON.parse(second.stdout)).not.toThrow();
    expect(JSON.parse(second.stdout).hookSpecificOutput).not.toBeNull();
  });

  it("replay across hook calls: the identical transcript fed twice does not double-nudge the count", () => {
    const zeugeDir = tmpZeugeDir();
    runClaimHook({ stdinText: read("stop-hook-fixture.json"), zeugeDir, now: 1, jsonMode: true });
    const second = runClaimHook({ stdinText: read("stop-hook-fixture.json"), zeugeDir, now: 2, jsonMode: true });
    const parsed = JSON.parse(second.stdout);
    expect(parsed.claims.every((c: { replay?: boolean }) => c.replay === true)).toBe(true);
  });
});

describe("claim/hook — P3.1: real Claude Code Stop/PostToolUse contract", () => {
  it("last_assistant_message.text is the primary source, ahead of transcript_path", () => {
    const payload = {
      hook_event_name: "Stop",
      transcript_path: "/nonexistent/should-not-be-read.jsonl",
      last_assistant_message: { type: "text", text: "Fixed the bug." },
    };
    expect(extractLastAssistantText(payload)).toBe("Fixed the bug.");
  });

  it("falls back to transcript_path only when last_assistant_message is absent, joining the last assistant line's text blocks with \\n", () => {
    const transcriptPath = path.join(FIXTURE_DIR, "transcript-real-shape.jsonl");
    const payload = { hook_event_name: "Stop", transcript_path: transcriptPath };
    expect(extractLastAssistantText(payload)).toBe("All tests pass.\nDeployed to production.");
  });

  it("a real-shaped Stop fixture (last_assistant_message present) produces 2 UNWITNESSED claims, probe ALIVE", () => {
    const zeugeDir = tmpZeugeDir();
    const result = runClaimHook({ stdinText: read("stop-hook-fixture-real.json"), zeugeDir, now: 1000, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.probe).toBe("ALIVE");
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.hookSpecificOutput).not.toBeNull();
  });

  // stop_hook_active:true used to drop a genuinely new
  // claim with no signal at all — reproduced with this exact fixture (same claim text as
  // stop-hook-fixture-real.json, only stop_hook_active differs) producing empty output and exit
  // 0. The flag is no longer a reason to skip detection; a first-occurrence claim is surfaced on
  // such a turn exactly as it would be on a normal one. Real loop suppression is the
  // statement-keyed cooldown/replay state, exercised separately (claim-state-bounds.test.ts,
  // claim-hook-witness.test.ts's replay case) and NOT by this flag.
  it("stop_hook_active:true no longer drops a genuinely new claim: same 2 UNWITNESSED claims as the non-active fixture", () => {
    const zeugeDir = tmpZeugeDir();
    const result = runClaimHook({ stdinText: read("stop-hook-fixture-real-active.json"), zeugeDir, now: 1000, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.probe).toBe("ALIVE");
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.hookSpecificOutput).not.toBeNull();
  });

  it("stop_hook_active:true surfaces the same nudge in the real (non-json) Claude Code wiring too", () => {
    const zeugeDir = tmpZeugeDir();
    const result = runClaimHook({ stdinText: read("stop-hook-fixture-real-active.json"), zeugeDir, now: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/claim\(s\) without a witness/);
  });

  it("stop_hook_active:true still suppresses a REPEAT of the identical statement (the one thing the old guard was for) — via replay/cooldown, not the flag", () => {
    const zeugeDir = tmpZeugeDir();
    // First turn: not stop_hook_active, establishes the nudge (and marks the statement seen /
    // starts its cooldown).
    const first = runClaimHook({ stdinText: read("stop-hook-fixture-real.json"), zeugeDir, now: 1000, jsonMode: true });
    expect(JSON.parse(first.stdout).hookSpecificOutput).not.toBeNull();
    // Second turn, seconds later, stop_hook_active:true, IDENTICAL statement text: the
    // statement-keyed replay/cooldown state (seen-store.ts / state.ts) suppresses the repeat on
    // its own — not the stop_hook_active flag, which no longer participates in this decision.
    const second = runClaimHook({ stdinText: read("stop-hook-fixture-real-active.json"), zeugeDir, now: 5000, jsonMode: true });
    const parsed = JSON.parse(second.stdout);
    expect(parsed.hookSpecificOutput).toBeNull();
  });
});
