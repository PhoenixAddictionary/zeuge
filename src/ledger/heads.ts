/**
 * ledger/heads — a small, separate append-only record, held BESIDE the ledger, of
 * every SEALED segment's head hash: one line per completed segment, `{segment_index, head_hash,
 * sealed_at}`.
 *
 * The gap this closes: `ledger/append.ts`'s pre-append check trusts the tail's own first row
 * (the SEGMENT_OPEN marker)'s `prev_hash` as the boundary into the current segment — and
 * `ledger/verify.ts`'s full walk, when re-deriving a SEGMENT_OPEN row's `previous_segment_head_hash`,
 * only recomputes it from the row physically before it, INSIDE the same file. Both checks are
 * internally consistent, so a whole OLD sealed segment can be rewritten and every hash from
 * there forward — including the SEGMENT_OPEN row's own carried head and event_hash — recomputed
 * to cascade cleanly through the boundary. Append then accepts the next write, and a full verify
 * accepts the whole file, because the rewritten chain is, by construction, internally
 * consistent. This module gives both checks something to compare against that does NOT live
 * inside the rows being checked: `append` cross-checks the boundary it is about to build on
 * against the LAST recorded head before writing; `verify` recomputes every sealed segment's head
 * during its walk and compares each one against this record, reporting a named issue on any
 * mismatch or on a record that is missing entirely (never silently treating "no record" as
 * "agrees").
 *
 * HONEST LIMIT (do not remove this paragraph — it belongs in THREATS/README too): this raises
 * the COST of a rewrite, it does not CLOSE it. This file lives on the same filesystem, writable
 * by the same process, as the ledger it is meant to anchor — anyone able to rewrite the ledger
 * can rewrite this file to match. The only thing that actually closes this gap is a head hash
 * held somewhere the writer does not control (a remote anchor, a third party, a human-read
 * printout) — which this package does not provide.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomic } from "./lock";

export interface SegmentHeadRecord {
  segment_index: number;
  head_hash: string;
  sealed_at: string;
}

export interface HeadsIssue {
  seq: number | null;
  message: string;
}

export interface ReadSegmentHeadsResult {
  exists: boolean;
  records: SegmentHeadRecord[];
  issues: HeadsIssue[];
}

export interface ReadLastSegmentHeadResult {
  exists: boolean;
  record: SegmentHeadRecord | null;
  malformed: boolean;
  malformedMessage?: string;
}

/** The heads record lives beside the ledger file, named independently of the ledger's own
 *  filename so any ledger path (default or overridden) gets a discoverable, colocated record. */
export function headsPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), "segment-heads.jsonl");
}

function splitNonEmptyLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

function parseRecordLine(line: string): SegmentHeadRecord | { malformed: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return { malformed: (err as Error).message };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as Record<string, unknown>).segment_index === "number" &&
    typeof (parsed as Record<string, unknown>).head_hash === "string" &&
    typeof (parsed as Record<string, unknown>).sealed_at === "string"
  ) {
    return parsed as SegmentHeadRecord;
  }
  return { malformed: "unexpected shape (expected {segment_index:number, head_hash:string, sealed_at:string})" };
}

/** Full read: every sealed-segment record, in order, plus any malformed-line issues. Used by
 *  `ledger/verify.ts`'s full walk (proportional to segment count, not event count — negligible
 *  next to the whole-ledger re-hash it already does) and by `ledger/append.ts` only at the
 *  moment it seals a NEW segment (to compute the next segment_index), never on every append. */
export function readSegmentHeads(headsPath: string): ReadSegmentHeadsResult {
  if (!fs.existsSync(headsPath)) {
    return { exists: false, records: [], issues: [] };
  }
  const raw = fs.readFileSync(headsPath, "utf8");
  const lines = splitNonEmptyLines(raw);
  const records: SegmentHeadRecord[] = [];
  const issues: HeadsIssue[] = [];
  lines.forEach((line, idx) => {
    const result = parseRecordLine(line);
    if ("malformed" in result) {
      issues.push({ seq: null, message: `segment heads record malformed at physical line ${idx + 1}: ${result.malformed}` });
    } else {
      records.push(result);
    }
  });
  return { exists: true, records, issues };
}

/** Bounded read: only the LAST physical line is parsed (O(1) regardless of how many segments
 *  have sealed over the ledger's lifetime). This is the only read `ledger/append.ts` performs on
 *  every single append after the first rollover — its pre-append cross-check only ever needs
 *  the MOST RECENTLY sealed segment's head, never the full history (that is verify's job). */
export function readLastSegmentHead(headsPath: string): ReadLastSegmentHeadResult {
  if (!fs.existsSync(headsPath)) {
    return { exists: false, record: null, malformed: false };
  }
  const raw = fs.readFileSync(headsPath, "utf8");
  const lines = splitNonEmptyLines(raw);
  if (lines.length === 0) {
    return { exists: true, record: null, malformed: false };
  }
  const result = parseRecordLine(lines[lines.length - 1]);
  if ("malformed" in result) {
    return { exists: true, record: null, malformed: true, malformedMessage: result.malformed };
  }
  return { exists: true, record: result, malformed: false };
}

/** Appends one sealed-segment head record, write-temp-then-rename (same crash-safety discipline
 *  as the ledger itself — see ledger/lock.ts's writeAtomic). Always called from inside the SAME
 *  exclusive ledger lock that guards the SEGMENT_OPEN row it corresponds to (ledger/append.ts),
 *  so the two writes are never observed independently by a concurrent reader. */
export function appendSegmentHeadRecord(headsPath: string, record: SegmentHeadRecord): void {
  const dir = path.dirname(headsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(headsPath) ? fs.readFileSync(headsPath, "utf8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeAtomic(headsPath, existing + separator + JSON.stringify(record) + "\n");
}
