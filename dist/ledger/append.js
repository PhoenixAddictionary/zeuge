"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendEvent = appendEvent;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const canon_1 = require("../canon");
const ids_1 = require("../ids");
const event_1 = require("./event");
const verify_1 = require("./verify");
const segment_1 = require("./segment");
const lock_1 = require("./lock");
const heads_1 = require("./heads");
const SEGMENT_OPEN_MARKER = `"action_type":"${segment_1.SEGMENT_OPEN_ACTION_TYPE}"`;
function splitNonEmptyLines(raw) {
    return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
}
/** Cheap, non-parsing scan for the last physical line that carries a SEGMENT_OPEN row, so the
 *  boundary between "old, already-rolled-over segments" and "the current tail" can be found
 *  without JSON.parsing (let alone hash-recomputing) anything in an old segment. */
function findLastSegmentOpenIndex(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(SEGMENT_OPEN_MARKER))
            return i;
    }
    return -1;
}
function appendEvent(ledgerPath, params, opts = {}) {
    const segmentCap = opts.segmentCap ?? segment_1.SEGMENT_CAP;
    const dir = path.dirname(ledgerPath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    try {
        return (0, lock_1.withLedgerLock)(ledgerPath, () => {
            const existingRaw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
            const lines = splitNonEmptyLines(existingRaw);
            let last;
            if (lines.length > 0) {
                try {
                    last = JSON.parse(lines[lines.length - 1]);
                }
                catch (err) {
                    return { ok: false, code: 3, reason: `ledger is already invalid: malformed json at the last physical line: ${err.message}` };
                }
            }
            let sinceOpen = 0;
            if (lines.length > 0) {
                const segOpenIdx = findLastSegmentOpenIndex(lines);
                const tailStartIdx = segOpenIdx >= 0 ? segOpenIdx : 0;
                sinceOpen = segOpenIdx >= 0 ? lines.length - 1 - segOpenIdx : lines.length;
                const tailLines = lines.slice(tailStartIdx);
                let tailRows;
                try {
                    tailRows = tailLines.map((l) => JSON.parse(l));
                }
                catch (err) {
                    return { ok: false, code: 3, reason: `ledger is already invalid: malformed json in the current segment: ${err.message}` };
                }
                const tailFirst = tailRows[0];
                // The tail's own first row's prev_hash is taken on trust as the boundary into this
                // segment (see module doc): if the tail starts at a SEGMENT_OPEN row, that IS the
                // already-committed previous-segment head; otherwise (no rollover yet) the tail is
                // the whole ledger and genuinely starts at ZERO_HASH.
                const initialPrevHash = segOpenIdx >= 0 && tailFirst ? tailFirst.prev_hash : canon_1.ZERO_HASH;
                // Before trusting that boundary at all, cross-check it against the
                // separate heads record — only relevant once at least one segment has already sealed
                // (segOpenIdx >= 0). This never runs on a still-first-segment ledger.
                if (segOpenIdx >= 0 && tailFirst) {
                    const headsPath = (0, heads_1.headsPathFor)(ledgerPath);
                    const lastHead = (0, heads_1.readLastSegmentHead)(headsPath);
                    if (lastHead.malformed) {
                        return {
                            ok: false,
                            code: 3,
                            reason: `ledger is already invalid: segment heads record malformed: ${lastHead.malformedMessage ?? "unknown shape"}`,
                        };
                    }
                    if (!lastHead.record) {
                        return {
                            ok: false,
                            code: 3,
                            reason: "ledger is already invalid: segment heads record is missing — cannot confirm the sealed segment boundary was not rewritten (see ledger/heads.ts)",
                        };
                    }
                    if (lastHead.record.head_hash !== initialPrevHash) {
                        return {
                            ok: false,
                            code: 3,
                            reason: `ledger is already invalid: sealed segment head does not match the recorded heads file (recorded ${lastHead.record.head_hash}, ledger claims ${initialPrevHash}) — possible rewrite of an old segment`,
                        };
                    }
                }
                const verification = (0, verify_1.verifyRows)(tailRows, { startSeq: tailStartIdx + 1, initialPrevHash, expectedLedgerId: last.ledger_id });
                if (!verification.ok) {
                    // Append refusal: the file is returned untouched — no write happens on this path.
                    return { ok: false, code: 3, reason: `ledger is already invalid: ${verification.issues[0]?.message ?? "unknown issue"}` };
                }
            }
            const ledgerId = last?.ledger_id ?? (0, ids_1.makeId)("ledger");
            let nextSeq = (last?.seq ?? 0) + 1;
            let prevHash = last?.event_hash ?? canon_1.ZERO_HASH;
            const newLines = [];
            if (sinceOpen >= segmentCap) {
                const sealedHeadHash = prevHash; // the head of the segment being sealed by this rollover
                const openEvent = (0, event_1.buildEvent)({
                    ledgerId,
                    seq: nextSeq,
                    prevHash,
                    eventFamily: "LIFECYCLE",
                    actionType: segment_1.SEGMENT_OPEN_ACTION_TYPE,
                    outcome: "NOT_APPLICABLE",
                    actor: { kind: "SYSTEM", id: (0, ids_1.makeId)("agent") },
                    body: { previous_segment_head_hash: prevHash },
                });
                newLines.push(JSON.stringify(openEvent));
                nextSeq += 1;
                prevHash = openEvent.event_hash;
                // Record the just-sealed segment's head in the same lock that seals it —
                // a full read here is fine (it only happens once per SEGMENT_CAP appends, not once per
                // append) and gives the correct next segment_index regardless of how many segments
                // have sealed before.
                const headsPath = (0, heads_1.headsPathFor)(ledgerPath);
                const priorHeads = (0, heads_1.readSegmentHeads)(headsPath);
                (0, heads_1.appendSegmentHeadRecord)(headsPath, {
                    segment_index: priorHeads.records.length,
                    head_hash: sealedHeadHash,
                    sealed_at: new Date().toISOString(),
                });
            }
            const event = (0, event_1.buildEvent)({
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
            (0, lock_1.writeAtomic)(ledgerPath, existingRaw + separator + newLines.join("\n") + "\n");
            return { ok: true, code: 0, event };
        }, opts.lockTimeoutMs);
    }
    catch (err) {
        if (err instanceof lock_1.LedgerLockHeldError) {
            // A live holder refuses cleanly instead of the whole call throwing — surfaced
            // as a typed issueCode so both the CLI (--json) and the PostToolUse ledger hook can report
            // it instead of silently doing nothing or crashing.
            return {
                ok: false,
                code: 3,
                reason: `ledger locked: ${err.message}`,
                issueCode: "LOCK_HELD",
                lockHolderPid: err.holderPid,
                lockDetail: err.detail,
            };
        }
        throw err;
    }
}
