/**
 * e2e-witness — the check whose absence let the core bug ship. Every other test
 * in the P11 set calls into the TypeScript modules or `main()` in-process; none of them ran the
 * product the way a real user (or the real Stop/PostToolUse hooks) runs it — two SEPARATE
 * process invocations of the compiled CLI, communicating only through stdin/stdout and a real
 * `.zeuge/ledger.jsonl` on disk in a real (non-POSIX-emulated) Windows temp directory. This file
 * drives `bin/zeuge.js` (which requires the committed `dist/cli.js`) exactly as
 * hooks/hooks.json does, and exactly as this project's own documented manual VERIFY sequence does.
 *
 * Requires `npm run build` to have produced an up-to-date dist/ — that is also what
 * `npm run verify:dist` (wired as npm's own pretest hook) checks before `npm test` ever reaches
 * vitest, so under the real `npm test` entry point this precondition is already enforced.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { setLicenseKey, refreshLicenseStatus } from "../src/license/state";
import { createStubProvider } from "../src/license/providers/stub";
// These tests spawn real subprocesses and, in one case, run `git archive`. The default
// five-second per-test timeout is enough on an idle machine and not enough on a loaded one:
// running the suite four times concurrently made two of them time out with no assertion
// failure at all. A red build caused by a busy machine teaches a reader to ignore red builds,
// so the budget is stated here rather than inherited.
vi.setConfig({ testTimeout: 30000 });


const REPO_DIR = path.join(__dirname, "..");
const BIN = path.join(REPO_DIR, "bin", "zeuge.js");

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
/** A real, native Windows temp directory (os.tmpdir(), not a Git-Bash POSIX path) — the exact
 *  distinction that matters here: Node resolves paths natively regardless of the shell that
 *  launched this test runner, so this is safe from that gotcha by construction. */
function nativeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { cwd: string; input?: string }): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd: opts.cwd, input: opts.input ?? "", encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function stopPayload(sessionId: string, cwd: string, text: string): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: { type: "text", text },
  });
}

function postToolUsePayload(sessionId: string, cwd: string): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "204 passed",
  });
}

describe("e2e (real CLI, real subprocess, native temp dir) — P11 acceptance", () => {
  it("(a) ledger hook records a PASS Bash event, then Stop hook on 'All tests pass.' yields WITNESSED, one witness, no nudge", () => {
    const dir = nativeTmpDir("zeuge-e2e-a-");
    const ledgerResult = run(["ledger", "hook"], { cwd: dir, input: postToolUsePayload("s9", dir) });
    expect(ledgerResult.status).toBe(0);
    expect(fs.existsSync(path.join(dir, ".zeuge", "ledger.jsonl"))).toBe(true);

    const stopResult = run(["claim", "hook", "--event", "Stop", "--json"], { cwd: dir, input: stopPayload("s9", dir, "All tests pass.") });
    expect(stopResult.status).toBe(0);
    const parsed = JSON.parse(stopResult.stdout);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0].status).toBe("WITNESSED");
    expect(parsed.claims[0].witnesses).toHaveLength(1);
    expect(parsed.hookSpecificOutput).toBeNull();
  });

  it("(b) same Stop payload with an empty/missing ledger yields UNWITNESSED plus a nudge naming the missing-ledger case", () => {
    const dir = nativeTmpDir("zeuge-e2e-b-");
    const stopResult = run(["claim", "hook", "--event", "Stop", "--json"], { cwd: dir, input: stopPayload("s9", dir, "All tests pass.") });
    expect(stopResult.status).toBe(0);
    const parsed = JSON.parse(stopResult.stdout);
    expect(parsed.claims[0].status).toBe("UNWITNESSED");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/no ledger found/);
  });

  it("(c) a ledger event from a DIFFERENT session must not witness (exclusion still works when both sessions are known)", () => {
    const dir = nativeTmpDir("zeuge-e2e-c-");
    const ledgerResult = run(["ledger", "hook"], { cwd: dir, input: postToolUsePayload("session-A", dir) });
    expect(ledgerResult.status).toBe(0);

    const stopResult = run(["claim", "hook", "--event", "Stop", "--json"], { cwd: dir, input: stopPayload("session-B", dir, "All tests pass.") });
    const parsed = JSON.parse(stopResult.stdout);
    expect(parsed.claims[0].status).toBe("UNWITNESSED");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/no matching witness/);
  });

  it("(d) the detect -> bundle -> verify path yields WITNESSED with a real --session", () => {
    const dir = nativeTmpDir("zeuge-e2e-d-");
    const ledgerResult = run(["ledger", "hook"], { cwd: dir, input: postToolUsePayload("s9", dir) });
    expect(ledgerResult.status).toBe(0);

    const detectResult = run(["claim", "detect", "--stdin", "--json", "--session", "s9"], { cwd: dir, input: "All tests pass." });
    expect(detectResult.status).toBe(0);
    const detected = JSON.parse(detectResult.stdout);
    expect(detected.claims.length).toBeGreaterThan(0);
    fs.writeFileSync(path.join(dir, "claims.json"), JSON.stringify(detected.claims));
    fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(detected.coverage));

    const bundleResult = run(
      ["bundle", "--claims", "claims.json", "--coverage", "coverage.json", "--ledger", path.join(".zeuge", "ledger.jsonl"), "--session", "s9", "--out", "bundle.json"],
      { cwd: dir }
);
    expect(bundleResult.status).toBe(0);

    const bundle = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));
    expect(bundle.claims[0].status).toBe("WITNESSED");
    expect(bundle.summary.witnessed).toBe(1);
    expect(bundle.summary.unwitnessed).toBe(0);

    const verifyResult = run(["verify", "bundle.json", "--json"], { cwd: dir });
    expect(verifyResult.status).toBe(0);
    const verdict = JSON.parse(verifyResult.stdout);
    expect(verdict.ok).toBe(true);
  });

  it("(e) verify --require-witnessed exits 1 on an unwitnessed gated claim, using the stub licence provider to unlock the gate", async () => {
    const dir = nativeTmpDir("zeuge-e2e-e-");
    const zeugeDir = path.join(dir, ".zeuge");

    // Wire the stub licence provider the same way `zeuge licence status` would, so the local
    // gate resolves VALID without ever touching the network — without it (the test previously
    // would have hit exit 4 before it could even gate).
    setLicenseKey(zeugeDir, "test-key-e2e");
    await refreshLicenseStatus(zeugeDir, createStubProvider({ status: "VALID" }));
    expect(fs.existsSync(path.join(zeugeDir, "licence-cache.json"))).toBe(true);

    // No ledger at all -> the one claim ("tests_pass", a GATED_CLAIM_TYPE) stays UNWITNESSED.
    const detectResult = run(["claim", "detect", "--stdin", "--json", "--session", "s9"], { cwd: dir, input: "All tests pass." });
    const detected = JSON.parse(detectResult.stdout);
    fs.writeFileSync(path.join(dir, "claims.json"), JSON.stringify(detected.claims));
    fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(detected.coverage));

    const bundleResult = run(["bundle", "--claims", "claims.json", "--coverage", "coverage.json", "--session", "s9", "--out", "bundle.json"], { cwd: dir });
    expect(bundleResult.status).toBe(0);
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));
    expect(bundle.claims[0].status).toBe("UNWITNESSED");

    const verifyResult = run(["verify", "bundle.json", "--require-witnessed", "--json"], { cwd: dir });
    expect(verifyResult.status).toBe(1);
    const verdict = JSON.parse(verifyResult.stdout);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i: { code: string }) => i.code === "UNWITNESSED_GATED_CLAIM")).toBe(true);
  });
});
