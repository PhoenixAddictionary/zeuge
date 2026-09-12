import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent } from "../src/ledger/append";
import { verifyLedgerFile } from "../src/ledger/verify";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpLedger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-bounded-"));
  tmpDirs.push(dir);
  return path.join(dir, "ledger.jsonl");
}

const ACTOR = { kind: "SYSTEM" as const, id: "agent:22222222222222222222222222222222" };
function eventParams() {
  return { eventFamily: "ACTION" as const, actionType: "COMMAND_RUN" as const, outcome: "PASS" as const, actor: ACTOR, body: { exit_code: 0 } };
}

describe("ledger/append — bounded pre-append verification", () => {
  it("an append over a 3-segment ledger does not JSON.parse the rows belonging to segment 1", () => {
    const ledgerPath = tmpLedger();
    // segmentCap=3: 3 business events per segment. 8 appends -> 2 rollovers -> 3 segments.
    for (let i = 0; i < 8; i++) {
      const res = appendEvent(ledgerPath, eventParams(), { segmentCap: 3 });
      expect(res.ok).toBe(true);
    }
    const before = verifyLedgerFile(ledgerPath);
    expect(before.ok).toBe(true);
    expect(before.segments).toBe(3);

    const totalLines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    expect(totalLines).toBeGreaterThan(8); // includes the 2 SEGMENT_OPEN marker rows

    const parseSpy = vi.spyOn(JSON, "parse");
    parseSpy.mockClear();
    const result = appendEvent(ledgerPath, eventParams(), { segmentCap: 3 });
    const parseCallCount = parseSpy.mock.calls.length;
    parseSpy.mockRestore();

    expect(result.ok).toBe(true);
    // Bounded verification only ever parses the last physical line once (to build the new
    // event) plus the rows of the CURRENT segment (at most segmentCap+1 of them here). It must
    // never approach parsing every one of the totalLines rows, which is what the previous
    // (unbounded) implementation did on every single append.
    expect(parseCallCount).toBeLessThan(totalLines);
    expect(parseCallCount).toBeLessThanOrEqual(6); // current segment (<=3 rows + 1 SEGMENT_OPEN) + the one-off "last line" parse, generously bounded

    const after = verifyLedgerFile(ledgerPath);
    expect(after.ok).toBe(true);
    expect(after.event_count).toBe(before.event_count + 1);
  });

  it("bounded verification still refuses an append when the CURRENT segment is tampered", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 5; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 3 });
    }
    const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    // Tamper the LAST row (guaranteed to be in the current/tail segment): flip its outcome text
    // so body_sha256 (and therefore event_hash) no longer matches.
    const lastIdx = lines.length - 1;
    const tamperedLast = lines[lastIdx].replace('"outcome":"PASS"', '"outcome":"FAILED"');
    expect(tamperedLast).not.toBe(lines[lastIdx]);
    lines[lastIdx] = tamperedLast;
    fs.writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");

    const before = fs.readFileSync(ledgerPath, "utf8");
    const result = appendEvent(ledgerPath, eventParams(), { segmentCap: 3 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    const after = fs.readFileSync(ledgerPath, "utf8");
    expect(after).toBe(before); // refused, file untouched
  });

  it("declared blind spot: a tamper confined to an already-rolled-over OLD segment is NOT caught by append (only the standalone full verify catches it)", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 5; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 3 });
    }
    const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    // Row 0 is in segment 1, which has already rolled over by the time we appended 5 events
    // with a cap of 3. Tamper it in a way that keeps it syntactically valid JSON.
    lines[0] = lines[0].replace('"outcome":"PASS"', '"outcome":"FAILED"');
    fs.writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");

    // The standalone, always-full verify DOES catch it.
    const fullVerify = verifyLedgerFile(ledgerPath);
    expect(fullVerify.ok).toBe(false);

    // A bounded append, which never re-parses segment 1, does not — declared, not silent
    // (see ledger/append.ts's module doc).
    const appendResult = appendEvent(ledgerPath, eventParams(), { segmentCap: 3 });
    expect(appendResult.ok).toBe(true);
  });
});
