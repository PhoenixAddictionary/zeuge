import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectClaims, detectClaimsWithSkips } from "../src/claim/detect";
import { runClaimHook } from "../src/claim/hook";

// --- sentence-level guard against imperative/conditional/negation/question/quoted ---

const POSITIVE_SENTENCES = [
  "All tests pass.",
  "Tests passed locally.",
  "Deployed to staging.",
  "I fixed the parser.",
  "Done.",
  "Deployment finished, all green.",
];

const NEGATIVE_SENTENCES: Array<{ text: string; reason: string }> = [
  { text: "Make sure it is done before you leave.", reason: "imperative" },
  { text: "Please make sure this is done today.", reason: "imperative" },
  { text: "If tests pass we deploy.", reason: "conditional" },
  { text: "Once deployed, notify the team.", reason: "conditional" },
  { text: "This bug is not fixed yet.", reason: "negation" },
  { text: "It was never deployed to prod.", reason: "negation" },
  { text: "Is it deployed?", reason: "question" },
  { text: "He said `fixed` in the ticket.", reason: "quoted" },
];

describe("claim/detect — sentence-level guard", () => {
  for (const sentence of POSITIVE_SENTENCES) {
    it(`still fires: "${sentence}"`, () => {
      expect(detectClaims(sentence).length).toBeGreaterThan(0);
    });
  }

  for (const { text, reason } of NEGATIVE_SENTENCES) {
    it(`guarded out (${reason}): "${text}"`, () => {
      const result = detectClaimsWithSkips(text);
      expect(result.candidates).toHaveLength(0);
      expect(result.skipped[reason]).toBeGreaterThan(0);
    });
  }

  it("coverage-visible denominator: skipped counts are keyed by reason", () => {
    const text = NEGATIVE_SENTENCES.map((n) => n.text).join(" ");
    const result = detectClaimsWithSkips(text);
    expect(result.candidates).toHaveLength(0);
    const totalSkipped = Object.values(result.skipped).reduce((a, b) => a + b, 0);
    expect(totalSkipped).toBeGreaterThanOrEqual(NEGATIVE_SENTENCES.length);
  });
});

// --- hook cooldown-by-sentence, transcript-unreadable, probe-DEAD messaging ---

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpZeugeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-p51-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge");
}

function stopPayload(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session:11111111111111111111111111111111",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: { type: "text", text },
    ...extra,
  });
}

describe("claim/hook — cooldown keyed on statement_sha256, not claim_type", () => {
  it("two DIFFERENT tests_pass sentences 1 minute apart are BOTH nudged", () => {
    const zeugeDir = tmpZeugeDir();
    const first = runClaimHook({ stdinText: stopPayload("All tests pass."), zeugeDir, now: 0, jsonMode: true });
    const second = runClaimHook({ stdinText: stopPayload("Tests passed locally."), zeugeDir, now: 60_000, jsonMode: true });

    expect(JSON.parse(first.stdout).hookSpecificOutput).not.toBeNull();
    expect(JSON.parse(second.stdout).hookSpecificOutput).not.toBeNull();
  });

  it("the SAME sentence repeated is still suppressed (by replay, independent of cooldown key change)", () => {
    const zeugeDir = tmpZeugeDir();
    runClaimHook({ stdinText: stopPayload("All tests pass."), zeugeDir, now: 0, jsonMode: true });
    const second = runClaimHook({ stdinText: stopPayload("All tests pass."), zeugeDir, now: 60_000, jsonMode: true });
    expect(JSON.parse(second.stdout).hookSpecificOutput).toBeNull();
  });
});

describe("claim/hook — transcript_path read failure is reported, not swallowed", () => {
  it("exit 0 in hook mode, coverage.transcript_unreadable:true, additionalContext names it", () => {
    const zeugeDir = tmpZeugeDir();
    const payload = JSON.stringify({
      session_id: "session:22222222222222222222222222222222",
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: path.join(zeugeDir, "..", "does-not-exist.jsonl"),
    });
    const result = runClaimHook({ stdinText: payload, zeugeDir, now: 0, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.transcript_unreadable).toBe(true);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/transcript unreadable/);
  });
});

describe("claim/hook — probe DEAD is reported, not silent", () => {
  it("exit 0, coverage.probe DEAD, additionalContext names it", () => {
    const zeugeDir = tmpZeugeDir();
    const brokenRules = [{ rule_id: "broken.v1", claim_type: "tests_pass" as const, pattern: "this-will-never-match-anything-xyz" }];
    const result = runClaimHook({
      stdinText: stopPayload("All tests pass. Deployed."),
      zeugeDir,
      now: 0,
      jsonMode: true,
      rules: brokenRules,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.probe).toBe("DEAD");
    expect(parsed.claims).toHaveLength(0);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[zeuge] probe DEAD — claims not checked this turn");
  });
});
