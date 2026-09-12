/**
 * ledger/verify — re-derives every hash in a ledger file and asserts exact seq order,
 * ledger_id match, unique event_id, non-decreasing recorded_at, body_sha256 match, and (for
 * any SEGMENT_OPEN row) that its carried previous_segment_head_hash matches the recomputed
 * hash of the row physically before it. Nothing here trusts a stored hash over a recomputed
 * one — the whole point of a hash chain is that the verifier never takes the file's word for
 * its own integrity.
 *
 * The per-row walk is factored out as `verifyRows`, parameterized by a starting
 * seq and an initial "trusted" prev hash, so a caller other than the full-file walk below can
 * verify a BOUNDED slice of rows (e.g. only the current segment) without re-parsing or
 * re-hashing everything before it. `verifyLedgerContent`/`verifyLedgerFile` (this module's own
 * public, full-file entry points, and the standalone `zeuge ledger verify` CLI command) always
 * walk the WHOLE chain from ZERO_HASH — only `ledger/append.ts`'s own pre-append check uses the
 * bounded form, and it declares the resulting blind spot (a tamper confined to an old, already
 * rolled-over segment is not caught by append; only a full verify catches it).
 *
 * The full walk here additionally cross-checks every SEALED
 * segment's recomputed head against the separate append-only record in `ledger/heads.ts`. The
 * PRE-EXISTING "previous segment head mismatch" check below only recomputes a SEGMENT_OPEN row's
 * carried head from the row physically before it, INSIDE this same file — a rewrite that
 * recomputes every hash forward through the boundary passes that check by construction. The
 * heads-record cross-check compares against something that does not live inside the file being
 * checked, so it also has to be rewritten to keep the tamper invisible — see ledger/heads.ts's
 * own doc for the honest limit of what that actually buys (a raised cost, not a closed gap).
 * `verifyLedgerFile` resolves the heads record automatically (colocated beside the ledger file);
 * `verifyLedgerContent`/`verifyRows` take it as a parameter (or `null` for "looked for it and it
 * is missing"), so a caller exercising the pure per-row logic can inject records directly.
 */

import * as fs from "node:fs";
import { canonicalHash, ZERO_HASH } from "../canon";
import { recomputeEventHash, LedgerEvent } from "./event";
import { SEGMENT_CAP, SEGMENT_OPEN_ACTION_TYPE } from "./segment";
import { headsPathFor, readSegmentHeads, SegmentHeadRecord } from "./heads";

export interface VerifyIssue {
  seq: number | null;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  event_count: number;
  head_hash: string;
  segments: number;
  issues: VerifyIssue[];
}

export interface VerifyOptions {
  expectedHead?: string;
  /** Override for the sealed-segment heads record path (default: colocated beside
   *  the ledger file, see ledger/heads.ts's headsPathFor). Only consulted by verifyLedgerFile,
   *  which resolves it into concrete records before delegating to verifyLedgerContent. */
  headsPath?: string;
  /** Direct injection of already-resolved heads records, bypassing filesystem resolution —
   *  used internally once verifyLedgerFile has read the file, and directly by callers exercising
   *  verifyLedgerContent/verifyRows in isolation. `null` means "a heads record was looked for
   *  and is missing" (still checked, never silently treated as agreement); `undefined` (the
   *  default) means "do not perform this check at all" — used by ledger/append.ts's own bounded
   *  tail verification, which runs its own separate, narrower cross-check (see append.ts). */
  headsRecords?: SegmentHeadRecord[] | null;
}

function parseLines(raw: string): { rows: unknown[]; parseIssues: VerifyIssue[] } {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: unknown[] = [];
  const parseIssues: VerifyIssue[] = [];
  lines.forEach((line, idx) => {
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      parseIssues.push({ seq: null, message: `malformed json at physical line ${idx + 1}: ${(err as Error).message}` });
    }
  });
  return { rows, parseIssues };
}

export function verifyLedgerFile(filePath: string, opts: VerifyOptions = {}): VerifyResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, event_count: 0, head_hash: ZERO_HASH, segments: 0, issues: [{ seq: null, message: "ledger file does not exist" }] };
  }
  const raw = fs.readFileSync(filePath, "utf8");

  // Resolve the heads record automatically unless the caller already injected one
  // (or explicitly asked to skip the check by passing headsRecords itself — not exposed on this
  // path, but kept symmetric with verifyLedgerContent for direct callers).
  let headsRecords = opts.headsRecords;
  let headsFileIssues: VerifyIssue[] = [];
  if (headsRecords === undefined) {
    const headsPath = opts.headsPath ?? headsPathFor(filePath);
    const headsRead = readSegmentHeads(headsPath);
    headsRecords = headsRead.exists ? headsRead.records : null;
    headsFileIssues = headsRead.issues;
  }

  return verifyLedgerContent(raw, { ...opts, headsRecords }, headsFileIssues);
}

export function verifyLedgerContent(raw: string, opts: VerifyOptions = {}, extraIssues: VerifyIssue[] = []): VerifyResult {
  const { rows, parseIssues } = parseLines(raw);
  return verifyRows(rows, { expectedHead: opts.expectedHead, headsRecords: opts.headsRecords }, [...parseIssues, ...extraIssues]);
}

export interface VerifyRowsOptions {
  expectedHead?: string;
  /** The seq the FIRST row in `rows` is expected to carry. Full-file verification always
   *  starts at 1; a bounded tail verification starts at the tail's real physical seq. */
  startSeq?: number;
  /** The trusted prev_hash the first row in `rows` is checked against. Full-file verification
   *  always starts at ZERO_HASH (genesis); a bounded tail verification starts at the already-
   *  committed previous-segment head, taken on trust rather than re-derived. */
  initialPrevHash?: string;
  /** When set, every row's ledger_id is cross-checked against this value from the start,
   *  instead of being learned from the first row in `rows` (needed for a bounded tail slice,
   *  whose first row is not the ledger's actual first row). */
  expectedLedgerId?: string | null;
  /** See VerifyOptions.headsRecords — same semantics, threaded through to the per-row walk. */
  headsRecords?: SegmentHeadRecord[] | null;
}

/** The shared per-row hash-chain walk used by both the full-file verify below and the bounded
 *  tail verify `ledger/append.ts` runs before every append. */
export function verifyRows(rows: unknown[], opts: VerifyRowsOptions = {}, parseIssues: VerifyIssue[] = []): VerifyResult {
  const startSeq = opts.startSeq ?? 1;
  const initialPrevHash = opts.initialPrevHash ?? ZERO_HASH;
  const issues: VerifyIssue[] = [...parseIssues];

  const events = rows as LedgerEvent[];
  let ledgerId: string | null = opts.expectedLedgerId ?? null;
  const seenEventIds = new Set<string>();
  let prevRecordedAt: string | null = null;
  let prevRealEventHash = initialPrevHash; // recomputed hash of the immediately preceding physical row
  let segments = 1;
  let sinceLastSegmentOpen = 0;
  let headHash = initialPrevHash;
  // Counts sealed segments encountered so far (0-based), matched against
  // opts.headsRecords[sealedIndex] in the SEGMENT_OPEN branch below. Only advances when a
  // heads-record check was actually requested (opts.headsRecords !== undefined) — the bounded
  // tail verify ledger/append.ts runs never asks for this, so it costs nothing there.
  let sealedIndex = 0;

  for (let i = 0; i < events.length; i++) {
    const row = events[i];
    const seq = startSeq + i;
    headHash = ZERO_HASH;

    if (!row || typeof row !== "object") {
      issues.push({ seq, message: "row is not an object" });
      continue;
    }

    if (row.schema !== "zeuge.ledger.event.v1") {
      issues.push({ seq, message: "unexpected schema" });
    }

    if (ledgerId === null) {
      ledgerId = row.ledger_id;
    } else if (row.ledger_id !== ledgerId) {
      issues.push({ seq, message: "ledger id mismatch" });
    }

    if (row.seq !== seq) {
      issues.push({ seq, message: `sequence mismatch: expected seq ${seq}, row carries seq ${row.seq}` });
    }

    if (row.event_id) {
      if (seenEventIds.has(row.event_id)) issues.push({ seq, message: "duplicate event id" });
      seenEventIds.add(row.event_id);
    }

    if (prevRecordedAt !== null && typeof row.recorded_at === "string" && row.recorded_at < prevRecordedAt) {
      issues.push({ seq, message: "recorded_at moved backward" });
    }
    if (typeof row.recorded_at === "string") prevRecordedAt = row.recorded_at;

    const recomputedBodyHash = row.body !== undefined ? canonicalHash(row.body) : undefined;
    if (recomputedBodyHash !== undefined && row.body_sha256 !== recomputedBodyHash) {
      issues.push({ seq, message: "body hash mismatch" });
    }

    let recomputedEventHash: string;
    try {
      recomputedEventHash = recomputeEventHash(row);
    } catch {
      issues.push({ seq, message: "unable to recompute event hash" });
      continue;
    }
    if (recomputedEventHash !== row.event_hash) {
      issues.push({ seq, message: "event hash mismatch" });
    }

    if (row.prev_hash !== prevRealEventHash) {
      issues.push({ seq, message: "previous hash mismatch" });
    }

    if (row.action_type === SEGMENT_OPEN_ACTION_TYPE) {
      const carried = row.body && (row.body as Record<string, unknown>).previous_segment_head_hash;
      if (carried !== prevRealEventHash) {
        issues.push({ seq, message: "previous segment head mismatch" });
      }

      // The check above only recomputes the carried head from the row physically
      // before it, INSIDE this same file — a rewrite that cascades every hash forward through
      // the boundary passes it by construction. Cross-checking against the separate, externally
      // written heads record (ledger/heads.ts) catches exactly that case, because the rewrite
      // would also have to touch that file to stay hidden.
      if (opts.headsRecords !== undefined) {
        if (opts.headsRecords === null) {
          issues.push({ seq, message: `segment heads record missing: cannot confirm sealed segment ${sealedIndex} head was not rewritten out-of-band` });
        } else {
          const recorded = opts.headsRecords[sealedIndex];
          if (!recorded) {
            issues.push({ seq, message: `segment heads record has no entry for sealed segment ${sealedIndex}` });
          } else if (recorded.head_hash !== prevRealEventHash) {
            issues.push({
              seq,
              message: `sealed segment ${sealedIndex} head does not match the recorded heads file (recorded ${recorded.head_hash}, ledger claims ${prevRealEventHash})`,
            });
          }
        }
        sealedIndex += 1;
      }

      segments += 1;
      sinceLastSegmentOpen = 0;
    } else {
      sinceLastSegmentOpen += 1;
      if (sinceLastSegmentOpen > SEGMENT_CAP) {
        issues.push({ seq, message: `segment exceeds cap of ${SEGMENT_CAP} without a SEGMENT_OPEN` });
      }
    }

    prevRealEventHash = recomputedEventHash;
    headHash = recomputedEventHash;
  }

  if (opts.expectedHead !== undefined && opts.expectedHead !== headHash) {
    issues.push({ seq: null, message: "expected head mismatch" });
  }

  // A heads record carrying MORE sealed-segment entries than the ledger itself shows
  // means the ledger was shortened (segments removed) without the heads record following it —
  // also never silently treated as agreement.
  if (Array.isArray(opts.headsRecords) && opts.headsRecords.length > sealedIndex) {
    issues.push({
      seq: null,
      message: `segment heads record has ${opts.headsRecords.length} entries but the ledger shows only ${sealedIndex} sealed segment(s)`,
    });
  }

  return {
    ok: issues.length === 0,
    event_count: events.length,
    head_hash: headHash,
    segments,
    issues,
  };
}
