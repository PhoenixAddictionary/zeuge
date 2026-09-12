import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { appendEvent } from "../src/ledger/append";
import { runLedgerHook } from "../src/ledger/hook";
// These tests spawn real subprocesses and, in one case, run `git archive`. The default
// five-second per-test timeout is enough on an idle machine and not enough on a loaded one:
// running the suite four times concurrently made two of them time out with no assertion
// failure at all. A red build caused by a busy machine teaches a reader to ignore red builds,
// so the budget is stated here rather than inherited.
vi.setConfig({ testTimeout: 30000 });


const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-lock-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge", "ledger.jsonl");
}

/** A pid that is guaranteed dead: spawn a trivial child process synchronously and return its
 *  pid after it has already exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid ?? 999999;
}

const ACTOR = { kind: "SYSTEM" as const, id: "agent:11111111111111111111111111111111" };
function appendParams() {
  return { eventFamily: "ACTION" as const, actionType: "COMMAND_RUN" as const, outcome: "PASS" as const, actor: ACTOR, body: { exit_code: 0 } };
}

describe("ledger/lock — stale-lock recovery", () => {
  it("a stale lock (age > 30s, dead pid) is recovered and the append proceeds", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), acquired_at: Date.now() - 40_000 }));

    const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 500 });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // released cleanly after our own acquisition
    expect(fs.existsSync(ledgerPath)).toBe(true);
  });

  it("a live holder's lock is refused no matter how old it is — age is never a substitute for liveness", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    // Our OWN pid is alive (this test process), and the lock is far past the OLD 5-minute
    // force-stale threshold that the pre-fix implementation would have stolen from it anyway.
    // That was exactly the bug: a slow-but-healthy holder is ordinary, so stealing its lock lets
    // two processes append at once. The fix requires PROOF of death; age alone must never grant
    // removal of a live holder's lock.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: Date.now() - 6 * 60 * 1000 }));

    const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.issueCode).toBe("LOCK_HELD");
    expect(result.lockHolderPid).toBe(process.pid);
    expect(result.lockDetail).toBe("HOLDER_ALIVE");
    expect(fs.existsSync(ledgerPath)).toBe(false); // nothing was written
    expect(fs.existsSync(lockPath)).toBe(true); // the live holder's lock was NOT removed

    fs.unlinkSync(lockPath);
  });

  it("a dead holder's lock is still recovered once past the minimum age", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), acquired_at: Date.now() - 6 * 60 * 1000 }));

    const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 500 });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // released cleanly after our own acquisition
  });

  it("liveness that cannot be determined (e.g. EPERM) refuses rather than steals, and names the reason", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    // A pid whose liveness we cannot determine — e.g. owned by another user. Simulated by
    // making process.kill throw something other than ESRCH.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, acquired_at: Date.now() - 6 * 60 * 1000 }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid === 424242) {
        const err = Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
        throw err;
      }
      return true;
    });

    try {
      const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 100 });

      expect(result.ok).toBe(false);
      expect(result.issueCode).toBe("LOCK_HELD");
      expect(result.lockHolderPid).toBe(424242);
      expect(result.lockDetail).toBe("UNKNOWN_LIVENESS");
      expect(fs.existsSync(lockPath)).toBe(true); // never stolen when liveness is unknown
    } finally {
      killSpy.mockRestore();
      fs.unlinkSync(lockPath);
    }
  });

  it("an unreadable/unparseable lock file is refused, never treated as stale", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    fs.writeFileSync(lockPath, "not json");

    const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.issueCode).toBe("LOCK_HELD");
    expect(result.lockHolderPid).toBe(null);
    expect(result.lockDetail).toBe("UNREADABLE_LOCK_INFO");
    expect(fs.existsSync(lockPath)).toBe(true);

    fs.unlinkSync(lockPath);
  });

  it("a fresh, live-held lock (age <= 30s) is refused with LOCK_HELD, never silently taken", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: Date.now() }));

    const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.issueCode).toBe("LOCK_HELD");
    expect(fs.existsSync(ledgerPath)).toBe(false); // nothing was written

    fs.unlinkSync(lockPath); // our own test's lock was never acquired by appendEvent — clean up manually
  });

  it("an aged-but-not-yet-30s lock held by a live process is still refused (not stale)", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: Date.now() - 10_000 }));

    const result = appendEvent(ledgerPath, appendParams(), { lockTimeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.issueCode).toBe("LOCK_HELD");
    fs.unlinkSync(lockPath);
  });

  it("ledger/hook surfaces LOCK_HELD via hookSpecificOutput and still exits 0 (never blocks)", () => {
    const ledgerPath = tmpLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: Date.now() }));

    const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { exitCode: 0 } });
    const result = runLedgerHook({ stdinText: payload, ledgerPath, lockTimeoutMs: 100 });

    expect(result.exitCode).toBe(0);
    expect(result.appended).toBe(false);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[zeuge] ledger locked — event not recorded");

    fs.unlinkSync(lockPath);
  });
});
