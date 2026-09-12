/**
 * ledger/append — appends one event under an exclusive lock, write-temp-then-rename.
 * Refuses to append onto an already-invalid ledger (exit 3 at the CLI layer) so corruption
 * cannot be buried under new, otherwise-valid-looking rows. Inserts a SEGMENT_OPEN marker
 * automatically when the current segment has reached SEGMENT_CAP events.
 *
 * Pre-append verification is bounded: an earlier version re-verified the WHOLE
 * ledger — parsing and hash-recomputing every row of every prior segment — on every single
 * append, an O(n^2) cost across a long-lived ledger that the acceptance-scale test in
 * ledger.test.ts already called out as too expensive to exercise directly via repeated
 * appendEvent calls. Only the CURRENT segment (the physical tail since the last SEGMENT_OPEN,
 * or the whole file when there is no SEGMENT_OPEN yet) is now parsed and hash-verified before
 * appending; rows in an already-rolled-over segment are neither JSON.parsed nor hash-recomputed
 * here. The trust boundary this draws, declared rather than hidden: a tamper confined to an old
 * segment is not caught by append — only the standalone, always-full `zeuge ledger verify`
 * command re-derives the chain all the way back to genesis.
 *
 * The bounded check above trusts the tail's own SEGMENT_OPEN row as
 * the boundary into the current segment — which means a rewrite of an old sealed segment that
 * ALSO recomputes every hash forward through that boundary passes here undetected (the tail is
 * internally consistent by construction). Before relying on that boundary, this module now
 * cross-checks it against the separate, append-only heads record in `ledger/heads.ts`: the LAST
 * recorded sealed-segment head must match what the tail's SEGMENT_OPEN row claims. A missing or
 * mismatched record refuses the append (code 3), same as any other already-invalid-ledger
 * refusal — never silently treated as agreement. Every time THIS module seals a new segment, it
 * writes that segment's head to the record in the same lock, so the check never has anything to
 * compare against that this module didn't itself just write on the way there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ZERO_HASH } from "../canon";
import { makeId } from "../ids";
import { buildEvent, LedgerEvent, LedgerEventBody } from "./event";
import { verifyRows } from "./verify";
import { SEGMENT_CAP, SEGMENT_OPEN_ACTION_TYPE } from "./segment";
import { withLedgerLock, writeAtomic, LedgerLockHeldError } from "./lock";
import { headsPathFor, readSegmentHeads, readLastSegmentHead, appendSegmentHeadRecord } from "./heads";
import type { ActionType, ActorKind, EventFamily, Outcome } from "../vocab";

export interface AppendParams {
  eventFamily: EventFamily;
  actionType: ActionType | string;
  outcome: Outcome | string;
  actor: { kind: ActorKind; id: string };
  body: LedgerEventBody;
  recordedAt?: string;
}

export interface AppendResult {
  ok: boolean;
  code: 0 | 3;
  event?: LedgerEvent;
  reason?: string;
  /** A machine-readable refusal code, distinct from the human `reason` string. Currently only
   *  set for a lock-contention refusal; other refusals are identified by `reason`
   *  text alone, as before. */
  issueCode?: "LOCK_HELD";
  /** Set alongside issueCode "LOCK_HELD" so a stuck ledger can be diagnosed without
   *  guessing — the holder pid (if known) and the exact liveness decision that led to refusal
   *  (see ledger/lock.ts's LockDecisionReason). */
  lockHolderPid?: number | null;
  lockDetail?: string;
}

const SEGMENT_OPEN_MARKER = `"action_type":"${SEGMENT_OPEN_ACTION_TYPE}"`;

function splitNonEmptyLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/** Cheap, non-parsing scan for the last physical line that carries a SEGMENT_OPEN row, so the
 *  boundary between "old, already-rolled-over segments" and "the current tail" can be found
 *  without JSON.parsing (let alone hash-recomputing) anything in an old segment. */
function findLastSegmentOpenIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(SEGMENT_OPEN_MARKER)) return i;
  }
  return -1;
}

export interface AppendOptions {
  /** Test-only override of the rollover threshold. Production always uses SEGMENT_CAP. */
  segmentCap?: number;
  /** Test-only override of the lock-acquisition timeout (see ledger/lock.ts). Production uses
   *  that module's own default. */
  lockTimeoutMs?: number;
}

export function appendEvent(ledgerPath: string, params: AppendParams, opts: AppendOptions = {}): AppendResult {
  const segmentCap = opts.segmentCap ?? SEGMENT_CAP;
  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    return withLedgerLock(
      ledgerPath,
      () => {
        const existingRaw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
        const lines = splitNonEmptyLines(existingRaw);

        let last: LedgerEvent | undefined;
        if (lines.length > 0) {
          try {
            last = JSON.parse(lines[lines.length - 1]) as LedgerEvent;
          } catch (err) {
            return { ok: false, code: 3 as const, reason: `ledger is already invalid: malformed json at the last physical line: ${(err as Error).message}` };
          }
        }

        let sinceOpen = 0;
        if (lines.length > 0) {
          const segOpenIdx = findLastSegmentOpenIndex(lines);
          const tailStartIdx = segOpenIdx >= 0 ? segOpenIdx : 0;
          sinceOpen = segOpenIdx >= 0 ? lines.length - 1 - segOpenIdx : lines.length;

          const tailLines = lines.slice(tailStartIdx);
          let tailRows: unknown[];
          try {
            tailRows = tailLines.map((l) => JSON.parse(l));
          } catch (err) {
            return { ok: false, code: 3 as const, reason: `ledger is already invalid: malformed json in the current segment: ${(err as Error).message}` };
          }
          const tailFirst = tailRows[0] as LedgerEvent | undefined;
          // The tail's own first row's prev_hash is taken on trust as the boundary into this
          // segment (see module doc): if the tail starts at a SEGMENT_OPEN row, that IS the
          // already-committed previous-segment head; otherwise (no rollover yet) the tail is
          // the whole ledger and genuinely starts at ZERO_HASH.
          const initialPrevHash = segOpenIdx >= 0 && tailFirst ? tailFirst.prev_hash : ZERO_HASH;

          // Before trusting that boundary at all, cross-check it against the
          // separate heads record — only relevant once at least one segment has already sealed
          // (segOpenIdx >= 0). This never runs on a still-first-segment ledger.
          if (segOpenIdx >= 0 && tailFirst) {
            const headsPath = headsPathFor(ledgerPath);
            const lastHead = readLastSegmentHead(headsPath);
            if (lastHead.malformed) {
              return {
                ok: false,
                code: 3 as const,
                reason: `ledger is already invalid: segment heads record malformed: ${lastHead.malformedMessage ?? "unknown shape"}`,
              };
            }
            if (!lastHead.record) {
              return {
                ok: false,
                code: 3 as const,
                reason:
                  "ledger is already invalid: segment heads record is missing — cannot confirm the sealed segment boundary was not rewritten (see ledger/heads.ts)",
              };
            }
            if (lastHead.record.head_hash !== initialPrevHash) {
              return {
                ok: false,
                code: 3 as const,
                reason: `ledger is already invalid: sealed segment head does not match the recorded heads file (recorded ${lastHead.record.head_hash}, ledger claims ${initialPrevHash}) — possible rewrite of an old segment`,
              };
            }
          }

          const verification = verifyRows(tailRows, { startSeq: tailStartIdx + 1, initialPrevHash, expectedLedgerId: last!.ledger_id });
          if (!verification.ok) {
            // Append refusal: the file is returned untouched — no write happens on this path.
            return { ok: false, code: 3 as const, reason: `ledger is already invalid: ${verification.issues[0]?.message ?? "unknown issue"}` };
          }
        }

        const ledgerId = last?.ledger_id ?? makeId("ledger");
        let nextSeq = (last?.seq ?? 0) + 1;
        let prevHash = last?.event_hash ?? ZERO_HASH;

        const newLines: string[] = [];

        if (sinceOpen >= segmentCap) {
          const sealedHeadHash = prevHash; // the head of the segment being sealed by this rollover
          const openEvent = buildEvent({
            ledgerId,
            seq: nextSeq,
            prevHash,
            eventFamily: "LIFECYCLE",
            actionType: SEGMENT_OPEN_ACTION_TYPE,
            outcome: "NOT_APPLICABLE",
            actor: { kind: "SYSTEM", id: makeId("agent") },
            body: { previous_segment_head_hash: prevHash },
          });
          newLines.push(JSON.stringify(openEvent));
          nextSeq += 1;
          prevHash = openEvent.event_hash;

          // Record the just-sealed segment's head in the same lock that seals it —
          // a full read here is fine (it only happens once per SEGMENT_CAP appends, not once per
          // append) and gives the correct next segment_index regardless of how many segments
          // have sealed before.
          const headsPath = headsPathFor(ledgerPath);
          const priorHeads = readSegmentHeads(headsPath);
          appendSegmentHeadRecord(headsPath, {
            segment_index: priorHeads.records.length,
            head_hash: sealedHeadHash,
            sealed_at: new Date().toISOString(),
          });
        }

        const event = buildEvent({
          ledgerId,
          seq: nextSeq,
          prevHash,
          eventFamily: params.eventFamily,
          actionType: params.actionType,
          outcome: params.outcome,
          actor: params.actor,
          body: params.body,
          recordedAt: params.recordedAt,
        });
        newLines.push(JSON.stringify(event));

        const separator = existingRaw.length > 0 && !existingRaw.endsWith("\n") ? "\n" : "";
        writeAtomic(ledgerPath, existingRaw + separator + newLines.join("\n") + "\n");

        return { ok: true, code: 0 as const, event };
      },
      opts.lockTimeoutMs
    );
  } catch (err) {
    if (err instanceof LedgerLockHeldError) {
      // A live holder refuses cleanly instead of the whole call throwing — surfaced
      // as a typed issueCode so both the CLI (--json) and the PostToolUse ledger hook can report
      // it instead of silently doing nothing or crashing.
      return {
        ok: false,
        code: 3 as const,
        reason: `ledger locked: ${err.message}`,
        issueCode: "LOCK_HELD",
        lockHolderPid: err.holderPid,
        lockDetail: err.detail,
      };
    }
    throw err;
  }
}
