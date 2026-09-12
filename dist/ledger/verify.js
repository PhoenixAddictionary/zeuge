"use strict";
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
exports.verifyLedgerFile = verifyLedgerFile;
exports.verifyLedgerContent = verifyLedgerContent;
exports.verifyRows = verifyRows;
const fs = __importStar(require("node:fs"));
const canon_1 = require("../canon");
const event_1 = require("./event");
const segment_1 = require("./segment");
const heads_1 = require("./heads");
function parseLines(raw) {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const rows = [];
    const parseIssues = [];
    lines.forEach((line, idx) => {
        try {
            rows.push(JSON.parse(line));
        }
        catch (err) {
            parseIssues.push({ seq: null, message: `malformed json at physical line ${idx + 1}: ${err.message}` });
        }
    });
    return { rows, parseIssues };
}
function verifyLedgerFile(filePath, opts = {}) {
    if (!fs.existsSync(filePath)) {
        return { ok: false, event_count: 0, head_hash: canon_1.ZERO_HASH, segments: 0, issues: [{ seq: null, message: "ledger file does not exist" }] };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    // Resolve the heads record automatically unless the caller already injected one
    // (or explicitly asked to skip the check by passing headsRecords itself — not exposed on this
    // path, but kept symmetric with verifyLedgerContent for direct callers).
    let headsRecords = opts.headsRecords;
    let headsFileIssues = [];
    if (headsRecords === undefined) {
        const headsPath = opts.headsPath ?? (0, heads_1.headsPathFor)(filePath);
        const headsRead = (0, heads_1.readSegmentHeads)(headsPath);
        headsRecords = headsRead.exists ? headsRead.records : null;
        headsFileIssues = headsRead.issues;
    }
    return verifyLedgerContent(raw, { ...opts, headsRecords }, headsFileIssues);
}
function verifyLedgerContent(raw, opts = {}, extraIssues = []) {
    const { rows, parseIssues } = parseLines(raw);
    return verifyRows(rows, { expectedHead: opts.expectedHead, headsRecords: opts.headsRecords }, [...parseIssues, ...extraIssues]);
}
/** The shared per-row hash-chain walk used by both the full-file verify below and the bounded
 *  tail verify `ledger/append.ts` runs before every append. */
function verifyRows(rows, opts = {}, parseIssues = []) {
    const startSeq = opts.startSeq ?? 1;
    const initialPrevHash = opts.initialPrevHash ?? canon_1.ZERO_HASH;
    const issues = [...parseIssues];
    const events = rows;
    let ledgerId = opts.expectedLedgerId ?? null;
    const seenEventIds = new Set();
    let prevRecordedAt = null;
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
        headHash = canon_1.ZERO_HASH;
        if (!row || typeof row !== "object") {
            issues.push({ seq, message: "row is not an object" });
            continue;
        }
        if (row.schema !== "zeuge.ledger.event.v1") {
            issues.push({ seq, message: "unexpected schema" });
        }
        if (ledgerId === null) {
            ledgerId = row.ledger_id;
        }
        else if (row.ledger_id !== ledgerId) {
            issues.push({ seq, message: "ledger id mismatch" });
        }
        if (row.seq !== seq) {
            issues.push({ seq, message: `sequence mismatch: expected seq ${seq}, row carries seq ${row.seq}` });
        }
        if (row.event_id) {
            if (seenEventIds.has(row.event_id))
                issues.push({ seq, message: "duplicate event id" });
            seenEventIds.add(row.event_id);
        }
        if (prevRecordedAt !== null && typeof row.recorded_at === "string" && row.recorded_at < prevRecordedAt) {
            issues.push({ seq, message: "recorded_at moved backward" });
        }
        if (typeof row.recorded_at === "string")
            prevRecordedAt = row.recorded_at;
        const recomputedBodyHash = row.body !== undefined ? (0, canon_1.canonicalHash)(row.body) : undefined;
        if (recomputedBodyHash !== undefined && row.body_sha256 !== recomputedBodyHash) {
            issues.push({ seq, message: "body hash mismatch" });
        }
        let recomputedEventHash;
        try {
            recomputedEventHash = (0, event_1.recomputeEventHash)(row);
        }
        catch {
            issues.push({ seq, message: "unable to recompute event hash" });
            continue;
        }
        if (recomputedEventHash !== row.event_hash) {
            issues.push({ seq, message: "event hash mismatch" });
        }
        if (row.prev_hash !== prevRealEventHash) {
            issues.push({ seq, message: "previous hash mismatch" });
        }
        if (row.action_type === segment_1.SEGMENT_OPEN_ACTION_TYPE) {
            const carried = row.body && row.body.previous_segment_head_hash;
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
                }
                else {
                    const recorded = opts.headsRecords[sealedIndex];
                    if (!recorded) {
                        issues.push({ seq, message: `segment heads record has no entry for sealed segment ${sealedIndex}` });
                    }
                    else if (recorded.head_hash !== prevRealEventHash) {
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
        }
        else {
            sinceLastSegmentOpen += 1;
            if (sinceLastSegmentOpen > segment_1.SEGMENT_CAP) {
                issues.push({ seq, message: `segment exceeds cap of ${segment_1.SEGMENT_CAP} without a SEGMENT_OPEN` });
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
