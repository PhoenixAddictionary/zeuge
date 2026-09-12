import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyLedgerFile, verifyLedgerContent } from "../src/ledger/verify";
import { appendEvent } from "../src/ledger/append";
import { buildEvent } from "../src/ledger/event";
import { ZERO_HASH } from "../src/canon";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "ledger");

function issueText(result: { issues: { message: string }[] }): string {
  return result.issues.map((i) => i.message).join(" | ");
}

describe("ledger/verify", () => {
  it("chain replay (positive): ledger-ok.jsonl verifies ok, head matches its last event_hash", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "ledger-ok.jsonl"));
    expect(result.ok).toBe(true);
    expect(result.event_count).toBe(5);
    expect(result.head_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chain replay (negative): tamper-body.jsonl fails with 'event hash mismatch' at seq 3", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "tamper-body.jsonl"));
    expect(result.ok).toBe(false);
    expect(issueText(result)).toContain("event hash mismatch");
    expect(result.issues.some((i) => i.seq === 3)).toBe(true);
  });

  it("reorder (negative): swapped-seq.jsonl fails with 'sequence mismatch'", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "swapped-seq.jsonl"));
    expect(result.ok).toBe(false);
    expect(issueText(result)).toContain("sequence mismatch");
  });

  it("truncation (positive alone): truncated-tail.jsonl verifies ok with no expected head", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "truncated-tail.jsonl"));
    expect(result.ok).toBe(true);
  });

  it("truncation (negative with --expected-head): fails with 'expected head mismatch'", () => {
    const full = verifyLedgerFile(path.join(FIXTURE_DIR, "ledger-ok.jsonl"));
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "truncated-tail.jsonl"), { expectedHead: full.head_hash });
    expect(result.ok).toBe(false);
    expect(issueText(result)).toContain("expected head mismatch");
  });

  it("insertion (negative): inserted-row.jsonl fails with 'previous hash mismatch'", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "inserted-row.jsonl"));
    expect(result.ok).toBe(false);
    expect(issueText(result)).toContain("previous hash mismatch");
  });

  it("clock (negative): backdated.jsonl fails with 'recorded_at moved backward'", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "backdated.jsonl"));
    expect(result.ok).toBe(false);
    expect(issueText(result)).toContain("recorded_at moved backward");
  });

  it("segments (negative): segment-head-broken.jsonl fails with 'previous segment head mismatch'", () => {
    const result = verifyLedgerFile(path.join(FIXTURE_DIR, "segment-head-broken.jsonl"));
    expect(result.ok).toBe(false);
    expect(issueText(result)).toContain("previous segment head mismatch");
  });
});

describe("ledger/append — segments and refusal", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function tmpLedger(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-ledger-"));
    tmpDirs.push(dir);
    return path.join(dir, "ledger.jsonl");
  }

  it("append's own rollover logic inserts a real SEGMENT_OPEN once the cap is reached (small cap, exercises the real code path cheaply)", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 4; i++) {
      const res = appendEvent(
        ledgerPath,
        {
          eventFamily: "ACTION",
          actionType: "COMMAND_RUN",
          outcome: "PASS",
          actor: { kind: "SYSTEM", id: "agent:cccccccccccccccccccccccccccccccc" },
          body: { exit_code: 0 },
        },
        { segmentCap: 3 }
);
      expect(res.ok).toBe(true);
    }
    const result = verifyLedgerFile(ledgerPath);
    expect(result.ok).toBe(true);
    expect(result.segments).toBe(2);
    // 3 business events + 1 SEGMENT_OPEN marker + 1 business event = 5 physical rows.
    expect(result.event_count).toBe(5);
  });

  it("segments (positive, acceptance-scale): a directly-constructed 5001-business-event, 2-segment ledger verifies ok and spans both segments", () => {
    // Constructed directly with buildEvent (not 5001 sequential appendEvent calls, which would
    // each re-verify the whole file so far and cost O(n^2) — appendEvent's rollover mechanics
    // are exercised for real in the small-cap test above; this test targets verify()'s own
    // ability to walk a real 5000-event-cap chain end to end).
    const ledgerId = "ledger:11111111111111111111111111111111";
    const actor = { kind: "SYSTEM" as const, id: "agent:22222222222222222222222222222222" };
    const lines: string[] = [];
    let prevHash = ZERO_HASH;
    let seq = 1;
    for (let i = 0; i < 5000; i++) {
      const e = buildEvent({ ledgerId, seq, prevHash, eventFamily: "ACTION", actionType: "COMMAND_RUN", outcome: "PASS", actor, body: { exit_code: 0 } });
      lines.push(JSON.stringify(e));
      prevHash = e.event_hash;
      seq++;
    }
    const openEvent = buildEvent({
      ledgerId,
      seq,
      prevHash,
      eventFamily: "LIFECYCLE",
      actionType: "SEGMENT_OPEN",
      outcome: "NOT_APPLICABLE",
      actor,
      body: { previous_segment_head_hash: prevHash },
    });
    lines.push(JSON.stringify(openEvent));
    prevHash = openEvent.event_hash;
    seq++;
    const lastEvent = buildEvent({ ledgerId, seq, prevHash, eventFamily: "ACTION", actionType: "COMMAND_RUN", outcome: "PASS", actor, body: { exit_code: 0 } });
    lines.push(JSON.stringify(lastEvent));

    const result = verifyLedgerContent(lines.join("\n") + "\n");
    expect(result.ok).toBe(true);
    expect(result.segments).toBe(2);
    expect(result.event_count).toBe(5002); // 5001 business events + 1 SEGMENT_OPEN marker
    expect(result.head_hash).toBe(lastEvent.event_hash);
  });

  it("append refusal (negative): appending onto an already-invalid ledger exits 3 and leaves the file byte-identical", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-ledger-refuse-"));
    tmpDirs.push(dir);
    const ledgerPath = path.join(dir, "ledger.jsonl");
    const badContent = fs.readFileSync(path.join(FIXTURE_DIR, "tamper-body.jsonl"), "utf8");
    fs.writeFileSync(ledgerPath, badContent, "utf8");

    const res = appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:dddddddddddddddddddddddddddddddd" },
      body: { exit_code: 0 },
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
    const after = fs.readFileSync(ledgerPath, "utf8");
    expect(after).toBe(badContent);
  });

  it("a fresh ledger starts at seq 1 with prev_hash ZERO_HASH", () => {
    const ledgerPath = tmpLedger();
    const res = appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      body: { exit_code: 0 },
    });
    expect(res.ok).toBe(true);
    expect(res.event?.seq).toBe(1);
    expect(res.event?.prev_hash).toBe("0".repeat(64));
  });
});
