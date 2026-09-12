/**
 * Regression test: the pre-append boundary check and the full verify walk both used to
 * trust the ledger's OWN claimed segment boundary (a SEGMENT_OPEN row's carried
 * previous_segment_head_hash, re-derived only from the row physically before it, INSIDE the same
 * file). A rewrite of an already-sealed segment that ALSO recomputes every hash forward through
 * that boundary is internally consistent, so it passed both checks silently. `ledger/heads.ts`
 * now anchors the boundary in a separate, colocated, append-only record that append cross-checks
 * before trusting the boundary, and that verify recomputes and compares against on every sealed
 * segment.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent } from "../src/ledger/append";
import { verifyLedgerFile } from "../src/ledger/verify";
import { headsPathFor, readSegmentHeads, appendSegmentHeadRecord } from "../src/ledger/heads";
import { recomputeEventHash, LedgerEvent } from "../src/ledger/event";
import { canonicalHash } from "../src/canon";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpLedger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-heads-"));
  tmpDirs.push(dir);
  return path.join(dir, "ledger.jsonl");
}

const ACTOR = { kind: "SYSTEM" as const, id: "agent:33333333333333333333333333333333" };
function eventParams() {
  return { eventFamily: "ACTION" as const, actionType: "COMMAND_RUN" as const, outcome: "PASS" as const, actor: ACTOR, body: { exit_code: 0 } };
}

function readRows(ledgerPath: string): LedgerEvent[] {
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEvent);
}

function writeRows(ledgerPath: string, rows: LedgerEvent[]): void {
  fs.writeFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** Rewrites row[tamperIndex]'s body and CASCADES every hash forward through however many
 *  SEGMENT_OPEN boundaries follow — the exact sealed-segment cascade attack this file exercises: an internally-consistent,
 *  fully-recomputed rewrite of an old, already-sealed segment. */
function tamperAndCascade(rows: LedgerEvent[], tamperIndex: number): LedgerEvent[] {
  const copy = rows.map((r) => JSON.parse(JSON.stringify(r)) as LedgerEvent);
  copy[tamperIndex].body = { ...copy[tamperIndex].body, exit_code: 999 };
  copy[tamperIndex].body_sha256 = canonicalHash(copy[tamperIndex].body);
  copy[tamperIndex].event_hash = recomputeEventHash(copy[tamperIndex]);

  for (let i = tamperIndex + 1; i < copy.length; i++) {
    copy[i].prev_hash = copy[i - 1].event_hash;
    if (copy[i].action_type === "SEGMENT_OPEN") {
      copy[i].body = { ...copy[i].body, previous_segment_head_hash: copy[i - 1].event_hash };
      copy[i].body_sha256 = canonicalHash(copy[i].body);
    }
    copy[i].event_hash = recomputeEventHash(copy[i]);
  }
  return copy;
}

describe("ledger/heads — sealed-segment heads record", () => {
  it("an honest ledger with a rollover writes a heads record automatically, and append + verify both pass", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 3; i++) {
      const res = appendEvent(ledgerPath, eventParams(), { segmentCap: 2 }); // 3rd append rolls over
      expect(res.ok).toBe(true);
    }
    const headsPath = headsPathFor(ledgerPath);
    expect(fs.existsSync(headsPath)).toBe(true);
    const heads = readSegmentHeads(headsPath);
    expect(heads.records).toHaveLength(1);
    expect(heads.records[0].segment_index).toBe(0);

    const verification = verifyLedgerFile(ledgerPath);
    expect(verification.ok).toBe(true);

    // A further append (which will cross-check the boundary) still succeeds.
    const further = appendEvent(ledgerPath, eventParams(), { segmentCap: 2 });
    expect(further.ok).toBe(true);
  });

  it("a ledger with NO rollover yet passes even though no heads file was ever created", () => {
    const ledgerPath = tmpLedger();
    const res = appendEvent(ledgerPath, eventParams());
    expect(res.ok).toBe(true);
    expect(fs.existsSync(headsPathFor(ledgerPath))).toBe(false);

    const verification = verifyLedgerFile(ledgerPath);
    expect(verification.ok).toBe(true);
  });

  it("a rewritten sealed segment with hashes cascaded through the boundary is refused by append", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 3; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 2 }); // rows: e1, e2, SEGMENT_OPEN, e3
    }
    const rows = readRows(ledgerPath);
    expect(rows).toHaveLength(4);
    expect(rows[2].action_type).toBe("SEGMENT_OPEN");

    // Rewrite e2 (row 1, inside the now-sealed segment 0) and cascade the hash chain forward
    // through the SEGMENT_OPEN boundary and e3 — internally consistent, exactly the cascade attack described above.
    const cascaded = tamperAndCascade(rows, 1);
    writeRows(ledgerPath, cascaded);

    const before = fs.readFileSync(ledgerPath, "utf8");
    const result = appendEvent(ledgerPath, eventParams(), { segmentCap: 2 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.reason).toContain("sealed segment head does not match the recorded heads file");
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(before); // refused, file untouched
  });

  it("the same rewritten-and-cascaded ledger fails a full verify with the named issue", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 3; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 2 });
    }
    const rows = readRows(ledgerPath);
    const cascaded = tamperAndCascade(rows, 1);
    writeRows(ledgerPath, cascaded);

    const result = verifyLedgerFile(ledgerPath);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("sealed segment 0 head does not match the recorded heads file"))).toBe(true);
  });

  it("a missing heads record is reported by verify, never silently treated as agreement", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 3; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 2 });
    }
    fs.unlinkSync(headsPathFor(ledgerPath));

    const result = verifyLedgerFile(ledgerPath);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("segment heads record missing"))).toBe(true);
  });

  it("a missing heads record also refuses the next append, rather than trusting the boundary blind", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 3; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 2 });
    }
    fs.unlinkSync(headsPathFor(ledgerPath));

    const result = appendEvent(ledgerPath, eventParams(), { segmentCap: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("segment heads record is missing");
  });

  it("a heads record with MORE entries than the ledger's sealed segments is reported, not silently accepted", () => {
    const ledgerPath = tmpLedger();
    for (let i = 0; i < 3; i++) {
      appendEvent(ledgerPath, eventParams(), { segmentCap: 2 }); // 1 sealed segment
    }
    const headsPath = headsPathFor(ledgerPath);
    // Inject a bogus second entry the ledger itself has no corresponding sealed segment for.
    appendSegmentHeadRecord(headsPath, { segment_index: 1, head_hash: "f".repeat(64), sealed_at: new Date().toISOString() });

    const result = verifyLedgerFile(ledgerPath);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("entries but the ledger shows only"))).toBe(true);
  });
});
