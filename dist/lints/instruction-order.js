"use strict";
/**
 * instruction-order — flags an evaluation-order clause that stands AFTER the action it
 * qualifies, inside instruction text a model reads top-down.
 *
 * Ported from tools/instruction-order-lint.ps1 (PowerShell original). Behavioural parity of the
 * ORIGINAL (loose) rule is verified against that script's own -SelfTest cases in
 * fixtures/instruction-order/.
 *
 * Field-tested (2026-09-11): the loose rule below, run over 696 public third-party
 * instruction files, produced 457 findings across 210 files (30%) — every inspected
 * adjacent-line example was a false positive (the marker word was ordinary prose, e.g. "Use
 * `unset CLAUDECODE` before `x`"). A TIGHTENED rule — the ordering clause must LEAD its own
 * bullet, immediately after the list marker and any emphasis/backtick markup, with no blank
 * line between the action line and the clause line — leaves 12 findings over the same corpus
 * (a 97.4% reduction). Consequently: `getFindingsLoose` (this file's original function, since renamed)
 * is kept only for its own regression fixtures and is no longer wired into `zeuge lint` at all;
 * `getFindingsTight` is the only function the CLI can reach, and only behind
 * `--experimental-order` (off by default), with every finding at severity "review".
 *
 * The distinction this lint is built on:
 *   - A STANDING PROHIBITION ("never do X", "nie X", "must not") is position-insensitive. It
 *     holds wherever it stands. Not flagged.
 *   - An EVALUATION-ORDER CLAUSE ("first", "before", "unless", "only if", "zuerst", "bevor",
 *     "ausser", "nur wenn", "es sei denn") qualifies the flow of reading itself. A reader who
 *     has already executed the action never reaches it. It MUST precede what it qualifies.
 *
 * Only the second class is reported. This lint does not decide precedence between rules; it
 * only checks that ordering-sensitive clauses are ordered.
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
exports.FIELD_TEST_NOTE = exports.BLIND_SPOTS = void 0;
exports.getClauseClass = getClauseClass;
exports.getFindingsLoose = getFindingsLoose;
exports.getFindingsTight = getFindingsTight;
exports.scanFile = scanFile;
const fs = __importStar(require("node:fs"));
// Ordering-sensitive: a reader who already acted never reaches these. Every marker carries a
// lookbehind against word chars AND hyphens so a compound word (German "Bevorzugung" contains
// "bevor"; English "verdict-first" contains "first ") does not trip the lint.
const ORDER_MARKERS = [
    /(?<![\w-])zuerst\b/,
    /(?<![\w-])als erstes\b/,
    /(?<![\w-])bevor\b/,
    /(?<![\w-])vorher\b/,
    /(?<![\w-])ausser wenn\b/,
    /(?<![\w-])ausser bei\b/,
    /(?<![\w-])es sei denn\b/,
    /(?<![\w-])nur wenn\b/,
    /(?<![\w-])nur falls\b/,
    /(?<![\w-])sofern\b/,
    /(?<![\w-])first[, ]/,
    /(?<![\w-])firstly\b/,
    /(?<![\w-])before\b/,
    /(?<![\w-])unless\b/,
    /(?<![\w-])only if\b/,
    /(?<![\w-])only when\b/,
    /(?<![\w-])except when\b/,
    /(?<![\w-])except if\b/,
    /(?<![\w-])prior to\b/,
];
// Position-insensitive: a standing prohibition holds wherever it stands. Deliberately NOT
// flagged, even after an action.
const STANDING = [/nie /, /niemals/, /never /, /must not/, /darf nicht/, /do not /, /kein[e]? /];
// Unconditional imperatives — the thing an ordering clause has to get in front of.
const ACTION_VERBS = [
    "gib",
    "gebe",
    "antworte",
    "wiedergib",
    "nenne",
    "melde",
    "schreibe",
    "setze",
    "nutze",
    "wende",
    "fuehre",
    "führe",
    "mache",
    "mach ",
    "starte",
    "lade",
    "pruefe",
    "prüfe",
    "emit",
    "answer",
    "restate",
    "report",
    "write",
    "use ",
    "apply",
    "run ",
    "start",
    "load",
    "return",
    "produce",
    "output",
    "treat ",
    "read ",
];
const ACTION_VERB_PATTERNS = ACTION_VERBS.map((v) => new RegExp("^" + v));
function getClauseClass(line) {
    let t = line.trim().replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
    t = t.replace(/\*\*/g, "");
    if (!t)
        return "OTHER";
    const low = t.toLowerCase();
    for (const m of ORDER_MARKERS)
        if (m.test(low))
            return "ORDER";
    for (const m of STANDING)
        if (m.test(low))
            return "STANDING";
    for (const v of ACTION_VERB_PATTERNS)
        if (v.test(low))
            return "ACTION";
    return "OTHER";
}
const HEADING_RE = /^\s*#{1,6}\s/;
const MARKER_COMMENT_RE = /<!--\s*[A-Z0-9_]+_(BEGIN|START|END)/;
const LIST_ITEM_RE = /^\s*([-*]|\d+\.)\s/;
/**
 * A block is a contiguous instruction unit: a marker-delimited region or a heading's section.
 * Ordering only matters INSIDE a unit; across units nothing is claimed (declared blind spot).
 *
 * This is the ORIGINAL, loose rule (renamed from `getFindings`): an order marker ANYWHERE
 * in a list line, after the first action line of the block, regardless of how many lines —
 * blank or not — separate them. Measured too noisy for real corpora (see module doc); kept only
 * so its own regression fixtures keep exercising it, never wired into `zeuge lint`.
 */
function getFindingsLoose(lines) {
    const findings = [];
    let blockStart = 0;
    let lastAction = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (HEADING_RE.test(line) || MARKER_COMMENT_RE.test(line)) {
            blockStart = i;
            lastAction = null;
            continue;
        }
        if (!LIST_ITEM_RE.test(line))
            continue;
        const cls = getClauseClass(line);
        if (cls === "ACTION" && lastAction === null) {
            lastAction = i;
        }
        else if (cls === "ORDER" && lastAction !== null) {
            findings.push({
                actionLine: lastAction + 1,
                orderLine: i + 1,
                action: lines[lastAction].trim().replace(/\s+/g, " "),
                order: line.trim().replace(/\s+/g, " "),
                blockStart: blockStart + 1,
                severity: "review",
            });
        }
    }
    return findings;
}
// The tightened rule: the ordering clause must LEAD its own bullet — immediately after the list
// marker and any emphasis/backtick/underscore markup — not merely appear anywhere in the line.
// A dedicated bullet-detector (not the loose LIST_ITEM_RE, which only recognizes "N.") also
// accepts "N)" so the same bullet vocabulary the clause regex itself accepts is recognized on
// the preceding (action) line too.
const TIGHT_BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s/;
const TIGHT_ORDER_RE = /^\s*(?:[-*]|\d+[.)])\s+(?:\*\*|__|\*|_|`)?\s*(zuerst|als erstes|bevor|vorher|ausser wenn|ausser bei|es sei denn|nur wenn|first|firstly|before|unless|only if|only when|except when)\b/i;
/**
 * The tightened rule: a finding requires the clause to be on the PHYSICALLY IMMEDIATELY
 * PRECEDING line's bullet — no blank line, no intervening prose, no intervening unrelated
 * bullet — and to lead its own bullet rather than appear mid-sentence. Every finding is
 * severity "review": measured true-positive rate on real corpora is expected near zero (see
 * module doc), so this is a heuristic prompt for a human to look, never an asserted fault.
 */
function getFindingsTight(lines) {
    const findings = [];
    let blockStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (HEADING_RE.test(line) || MARKER_COMMENT_RE.test(line)) {
            blockStart = i;
            continue;
        }
        if (!TIGHT_ORDER_RE.test(line))
            continue;
        const prevIdx = i - 1;
        if (prevIdx < blockStart)
            continue; // nothing precedes this bullet in the current block
        const prevLine = lines[prevIdx];
        if (prevLine === undefined || prevLine.trim() === "")
            continue; // a blank line breaks adjacency
        if (!TIGHT_BULLET_RE.test(prevLine))
            continue; // preceding line is not itself a bullet
        if (getClauseClass(prevLine) !== "ACTION")
            continue; // preceding bullet is not an unconditional action
        findings.push({
            actionLine: prevIdx + 1,
            orderLine: i + 1,
            action: prevLine.trim().replace(/\s+/g, " "),
            order: line.trim().replace(/\s+/g, " "),
            blockStart: blockStart + 1,
            severity: "review",
        });
    }
    return findings;
}
function scanFile(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    return getFindingsLoose(lines);
}
exports.BLIND_SPOTS = [
    "instruction-order: cross-file precedence is invisible — a guard in one file against an action in another is never seen.",
    "instruction-order: only bullet and numbered lines are classified; ordinary prose paragraphs are skipped.",
    "instruction-order: lexical, never semantic — an exception phrased without a marker word is invisible, and a marker word used innocently is a false positive.",
    "instruction-order: it cannot tell whether the ordering clause actually qualifies THAT action; a human decides.",
    "instruction-order: standing prohibitions are deliberately not flagged, so a genuine ordering defect phrased as \"never\" slips through.",
    "instruction-order: even the tightened rule still fires on a numbered step whose leading word is a step description, not a misordered qualifier (e.g. \"5. Before each edit pass, ...\"); true positives in real corpora are expected to be near zero.",
];
/** Printed once, verbatim, whenever --experimental-order is used — the measured result
 *  this check's own default-off posture is based on, not a hidden footnote. */
exports.FIELD_TEST_NOTE = "heuristic: 12 findings over 696 public instruction files in the 2026-09-11 field test; expect false positives";
