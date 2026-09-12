"use strict";
/**
 * claim/seen-store — persists the replay "seen" set (session_id:statement_sha256 keys) across
 * hook invocations. Fail-open, same discipline as claim/state.ts: an unreadable or missing
 * file just means nothing has been seen yet — a repeated statement then looks new again and
 * CAN be nudged (subject to cooldown), which is the fail-open direction: never silently
 * "assume it was shown" — and a failed write never crashes the hook.
 *
 * The on-disk store used to be a bare array that only ever grew,
 * one entry per distinct session+statement pair, rewritten whole on every save with no cap or
 * pruning — unbounded growth and unbounded per-turn write cost in a long-running install.
 * Entries are now timestamped internally and bounded by age (SEEN_RETENTION_MS) and count
 * (SEEN_MAX_ENTRIES), mirroring claim/state.ts's STATE_RETENTION_MS/STATE_MAX_ENTRIES. An
 * entry still inside COOLDOWN_MS of `now` is never evicted (see `pruneEntries`): dropping a
 * just-recorded entry mid-cooldown would make this hook's own current-turn statement look
 * "new" again while claim/state.ts is still actively suppressing a nudge for it.
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
exports.SEEN_MAX_ENTRIES = exports.SEEN_RETENTION_MS = void 0;
exports.loadSeen = loadSeen;
exports.saveSeen = saveSeen;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const state_1 = require("./state");
/** Retention window for a seen entry — see claim/state.ts STATE_RETENTION_MS for the identical
 *  rationale (kept well above COOLDOWN_MS so pruning can never race an active cooldown). */
exports.SEEN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Hard cap on distinct seen entries — see claim/state.ts STATE_MAX_ENTRIES for the identical
 *  rationale. Entries still inside COOLDOWN_MS of `now` are exempt from this cap. */
exports.SEEN_MAX_ENTRIES = 5000;
function seenPath(zeugeDir) {
    return path.join(zeugeDir, "claim-seen.json");
}
/** Same bounding shape as claim/state.ts's pruneEntries: age-based retention first (never
 *  dropping a future-timestamped — i.e. clock-skewed — entry), then a count cap that exempts
 *  anything still inside COOLDOWN_MS of `now`, allowing a soft cap overrun only in the extreme
 *  case where more than SEEN_MAX_ENTRIES entries are simultaneously inside that window. */
function pruneEntries(entries, now) {
    const withinCooldown = new Set();
    const survivors = [];
    for (const [key, ts] of Object.entries(entries)) {
        const elapsed = now - ts;
        if (elapsed >= 0 && elapsed < state_1.COOLDOWN_MS)
            withinCooldown.add(key);
        if (elapsed >= 0 && elapsed >= exports.SEEN_RETENTION_MS)
            continue; // provably stale: drop
        survivors.push([key, ts]);
    }
    if (survivors.length <= exports.SEEN_MAX_ENTRIES)
        return Object.fromEntries(survivors);
    survivors.sort((a, b) => b[1] - a[1]); // newest first
    const kept = [];
    const overflow = [];
    for (const entry of survivors) {
        if (kept.length < exports.SEEN_MAX_ENTRIES)
            kept.push(entry);
        else
            overflow.push(entry);
    }
    for (const entry of overflow) {
        if (withinCooldown.has(entry[0]))
            kept.push(entry); // never drop a live cooldown entry
    }
    return Object.fromEntries(kept);
}
function loadSeen(zeugeDir, now = Date.now()) {
    try {
        const raw = fs.readFileSync(seenPath(zeugeDir), "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            // Legacy format: a bare array of keys, no timestamps. Migration choice: stamp every
            // legacy entry with `now` (this load's time) rather than epoch-0, so upgrading a live
            // store does not make every pre-existing entry look ancient and vanish on the very next
            // save's retention prune.
            const timestamps = {};
            for (const key of parsed)
                if (typeof key === "string")
                    timestamps[key] = now;
            return { keys: new Set(Object.keys(timestamps)), timestamps };
        }
        if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
            const timestamps = {};
            for (const [key, ts] of Object.entries(parsed.entries)) {
                if (typeof ts === "number")
                    timestamps[key] = ts;
            }
            return { keys: new Set(Object.keys(timestamps)), timestamps };
        }
        return { keys: new Set(), timestamps: {} };
    }
    catch {
        return { keys: new Set(), timestamps: {} };
    }
}
/** `current` is the full seen set after this turn's pass (claim/run.ts's `pass.seen` — a
 *  superset of `previous.keys` plus any keys newly seen this turn; see claim/replay.ts).
 *  Already-known keys keep their original timestamp from `previous.timestamps`; brand-new keys
 *  are stamped `now`. The merged, timestamped map is bounded (`pruneEntries`) before it is
 *  written, under the new `{ entries }` shape — see `loadSeen` for the legacy-array read path
 *  this replaces. */
function saveSeen(zeugeDir, current, previous, now = Date.now()) {
    try {
        const merged = {};
        for (const key of current)
            merged[key] = previous.timestamps[key] ?? now;
        const bounded = pruneEntries(merged, now);
        fs.mkdirSync(zeugeDir, { recursive: true });
        fs.writeFileSync(seenPath(zeugeDir), JSON.stringify({ entries: bounded }), "utf8");
    }
    catch {
        /* fail-open */
    }
}
