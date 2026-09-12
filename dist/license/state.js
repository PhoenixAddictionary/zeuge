"use strict";
/**
 * license/state — the local key store (.zeuge/licence.json), organization_id resolution, and
 * the resolved LicenseState machine (VALID | GRACE | EXPIRED | REVOKED | UNKNOWN) gated
 * commands actually branch on.
 *
 * Two entry points matter to callers:
 *   - `refreshLicenseStatus` — used ONLY by `zeuge licence status` (and `licence set`'s own
 *     verification, if it chooses to check immediately). This is the ONLY place in the whole
 *     package, besides `set`, that may make a network call.
 *   - `resolveLocalLicenseState` — used by every Pro-gated command's own gate (`report --html`,
 *     `verify --require-witnessed`). It NEVER calls a provider; it only reads the local key
 *     file and the HMAC-checked cache, does grace-window arithmetic, and may
 *     advance the cache's clock-rollback high-water mark — a local file write, still no network
 *     call. This is what makes "no network call anywhere except licence status/set" true by
 *     construction — a gate that physically cannot reach a provider cannot phone home even if a
 *     future edit forgot to check a flag.
 *
 * VALID vs GRACE is deliberately never conflated: VALID is reported only by
 * `refreshLicenseStatus` in the instant a live provider call itself returned VALID. Every other
 * read (including the very next command, and always for the local gate) is, honestly, relying
 * on a CACHED answer rather than a fresh one — so it resolves to GRACE (still within the
 * 14-day window) or EXPIRED (past it), never a re-asserted VALID it did not itself confirm.
 * Both VALID and GRACE unlock a Pro-gated command; only the label differs.
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
exports.setLicenseKey = setLicenseKey;
exports.readLicenseKey = readLicenseKey;
exports.resolveOrganizationId = resolveOrganizationId;
exports.resolveState = resolveState;
exports.resolveLocalLicenseState = resolveLocalLicenseState;
exports.refreshLicenseStatus = refreshLicenseStatus;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const cache_1 = require("./cache");
function keyFilePath(zeugeDir) {
    return path.join(zeugeDir, "licence.json");
}
function setLicenseKey(zeugeDir, key, organizationId) {
    fs.mkdirSync(zeugeDir, { recursive: true });
    const record = { schema: "zeuge.licence.key.v1", key, ...(organizationId ? { organization_id: organizationId } : {}) };
    fs.writeFileSync(keyFilePath(zeugeDir), JSON.stringify(record), { mode: 0o600 });
    try {
        fs.chmodSync(keyFilePath(zeugeDir), 0o600);
    }
    catch {
        /* best-effort on platforms where chmod is a no-op */
    }
}
function readLicenseKey(zeugeDir) {
    try {
        const raw = fs.readFileSync(keyFilePath(zeugeDir), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.key === "string")
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
/** organization_id resolution order, exactly as specified: env ZEUGE_POLAR_ORG first, then
 *  whatever was stored alongside the key on `licence set`. Never a hardcoded default. */
function resolveOrganizationId(zeugeDir) {
    const fromEnv = process.env.ZEUGE_POLAR_ORG;
    if (fromEnv)
        return fromEnv;
    return readLicenseKey(zeugeDir)?.organization_id;
}
/** Pure function of a cache record (or its absence) and the current time — no I/O, no network.
 *  `justConfirmed` is true only in the instant a live provider call itself said VALID; every
 *  other caller (including every Pro-gated command's gate) omits it and gets an honestly-
 *  labeled GRACE/EXPIRED instead of a re-asserted VALID it did not itself check. */
function resolveState(cache, opts = {}) {
    const now = opts.now ?? Date.now();
    if (!cache)
        return "UNKNOWN";
    if (cache.status === "VALID") {
        if (opts.justConfirmed)
            return "VALID";
        return (0, cache_1.isWithinGrace)(cache.grace_until, now) ? "GRACE" : "EXPIRED";
    }
    if (cache.status === "REVOKED")
        return "REVOKED";
    // EXPIRED, INVALID, or (should it ever be persisted) UNREACHABLE all fail closed as EXPIRED —
    // none of them is evidence of current entitlement.
    return "EXPIRED";
}
const CLOCK_ROLLBACK_NOTE = " (CLOCK_MOVED_BACKWARD: system clock reads earlier than a previously observed time — grace held steady, not extended)";
/** The local-only gate every Pro-gated command calls. No network call, ever — reads only the
 *  key file (to know whether a key exists / to HMAC-verify the cache against it) and the cache.
 *
 * It now ALSO does one small local write — advancing the cache's
 * `max_observed_at` high-water mark when this check's `now` is the most-forward time seen so
 * far. That write never touches the network, never lowers the mark, and is the only way the
 * clock-rollback defense stays effective for a user who only ever runs Pro-gated commands and
 * never calls `zeuge licence status` again after the first `licence set` — without it, the
 * high-water mark would stay pinned at the original validation time forever, and rolling the
 * clock back to just after that moment would show full grace indefinitely. */
function resolveLocalLicenseState(zeugeDir, now = Date.now()) {
    const keyFile = readLicenseKey(zeugeDir);
    if (!keyFile) {
        return { state: "UNKNOWN", blocked: true, message: "no licence key set — run `zeuge licence set <key>`" };
    }
    const read = (0, cache_1.readLicenseCache)(zeugeDir, keyFile.key);
    if (!read.ok) {
        const reason = read.reason === "TAMPERED" ? "licence cache failed its integrity check" : "licence never validated — run `zeuge licence status`";
        return { state: "EXPIRED", blocked: true, message: reason };
    }
    const clockMovedBackward = (0, cache_1.isClockMovedBackward)(read.cache.max_observed_at, now);
    const effNow = (0, cache_1.effectiveNow)(read.cache.max_observed_at, now);
    const advanced = (0, cache_1.advanceMaxObservedAt)(read.cache.max_observed_at, now);
    if (advanced !== read.cache.max_observed_at) {
        (0, cache_1.writeLicenseCache)(zeugeDir, keyFile.key, { ...read.cache, max_observed_at: advanced });
    }
    const state = resolveState(read.cache, { now: effNow });
    const clockNote = clockMovedBackward ? CLOCK_ROLLBACK_NOTE : "";
    if (state === "GRACE") {
        const daysLeft = read.cache.grace_until ? Math.max(0, Math.ceil((Date.parse(read.cache.grace_until) - effNow) / (24 * 60 * 60 * 1000))) : 0;
        return { state, blocked: false, message: `licence offline grace: ${daysLeft} day(s) remaining${clockNote}`, clockMovedBackward };
    }
    if (state === "VALID")
        return { state, blocked: false, clockMovedBackward };
    const messages = {
        VALID: "",
        GRACE: "",
        EXPIRED: "licence expired — run `zeuge licence status`",
        REVOKED: "licence revoked",
        UNKNOWN: "no licence key set",
    };
    return { state, blocked: true, message: `${messages[state]}${clockNote}`, clockMovedBackward };
}
/** The ONLY function (besides a provider's own validate()) that makes a network call. Called by
 *  `zeuge licence status`. ZEUGE_OFFLINE=1 skips the call entirely and resolves from the
 *  existing cache alone (same math the local gate uses). */
function refreshLicenseStatus(zeugeDir, provider) {
    const keyFile = readLicenseKey(zeugeDir);
    if (!keyFile) {
        return { state: "UNKNOWN", verdict: offlineSkippedVerdict("no licence key set"), clockMovedBackward: false };
    }
    if (process.env.ZEUGE_OFFLINE === "1") {
        const read = (0, cache_1.readLicenseCache)(zeugeDir, keyFile.key);
        if (!read.ok) {
            return { state: "UNKNOWN", verdict: offlineSkippedVerdict("ZEUGE_OFFLINE=1: skipped network check, resolved from cache"), clockMovedBackward: false };
        }
        const now = Date.now();
        const clockMovedBackward = (0, cache_1.isClockMovedBackward)(read.cache.max_observed_at, now);
        const effNow = (0, cache_1.effectiveNow)(read.cache.max_observed_at, now);
        const advanced = (0, cache_1.advanceMaxObservedAt)(read.cache.max_observed_at, now);
        if (advanced !== read.cache.max_observed_at) {
            (0, cache_1.writeLicenseCache)(zeugeDir, keyFile.key, { ...read.cache, max_observed_at: advanced });
        }
        const state = resolveState(read.cache, { now: effNow });
        return { state, verdict: offlineSkippedVerdict("ZEUGE_OFFLINE=1: skipped network check, resolved from cache"), clockMovedBackward };
    }
    const organizationId = resolveOrganizationId(zeugeDir);
    return provider.validate({ key: keyFile.key, organizationId }).then((verdict) => {
        return applyVerdict(zeugeDir, keyFile.key, provider.id, verdict);
    });
}
function offlineSkippedVerdict(detail) {
    return {
        schema: "zeuge.license.verdict.v1",
        status: "UNREACHABLE",
        provider: "none",
        key_id: "key:00000000000000000000000000000000",
        key_sha256: "0".repeat(64),
        checked_at: new Date().toISOString(),
        valid_until: null,
        grace_until: null,
        offline: true,
        detail,
    };
}
function applyVerdict(zeugeDir, key, providerId, verdict) {
    // Carry the high-water mark forward across every branch below (never reset it to nothing on
    // a fresh write) — a live check's own checked_at is itself evidence of "at least this much
    // real time has passed," so it can only ever raise the mark, never lower it.
    const priorRead = (0, cache_1.readLicenseCache)(zeugeDir, key);
    const priorMax = priorRead.ok ? priorRead.cache.max_observed_at : undefined;
    const checkedAtMs = Date.parse(verdict.checked_at);
    const carriedMax = Number.isFinite(checkedAtMs) ? (0, cache_1.advanceMaxObservedAt)(priorMax, checkedAtMs) : priorMax;
    if (verdict.status === "VALID") {
        const grace_until = (0, cache_1.computeGraceUntil)(verdict.checked_at);
        (0, cache_1.writeLicenseCache)(zeugeDir, key, {
            provider: providerId,
            key_sha256: verdict.key_sha256,
            status: "VALID",
            validated_at: verdict.checked_at,
            expires_at: verdict.valid_until,
            grace_until,
            max_observed_at: carriedMax,
        });
        return { state: "VALID", verdict, clockMovedBackward: false };
    }
    if (verdict.status === "REVOKED" || verdict.status === "INVALID") {
        // "REVOKED/INVALID take effect at once and clear the cache — a revoked key gets no grace."
        // Overwriting with grace_until:null (rather than deleting the file outright) means the
        // local gate can later report the SPECIFIC reason (REVOKED) instead of degrading to the
        // more ambiguous "never validated" EXPIRED message.
        (0, cache_1.writeLicenseCache)(zeugeDir, key, {
            provider: providerId,
            key_sha256: verdict.key_sha256,
            status: "REVOKED",
            validated_at: verdict.checked_at,
            expires_at: null,
            grace_until: null,
            max_observed_at: carriedMax,
        });
        return { state: "REVOKED", verdict, clockMovedBackward: false };
    }
    if (verdict.status === "EXPIRED") {
        (0, cache_1.writeLicenseCache)(zeugeDir, key, {
            provider: providerId,
            key_sha256: verdict.key_sha256,
            status: "EXPIRED",
            validated_at: verdict.checked_at,
            expires_at: null,
            grace_until: null,
            max_observed_at: carriedMax,
        });
        return { state: "EXPIRED", verdict, clockMovedBackward: false };
    }
    // UNREACHABLE: fall back to whatever the existing cache already says, applying grace math —
    // this is the ONLY path that can resolve to GRACE from inside `licence status` itself. The
    // clock-rollback defense applies here exactly as it does to the local gate: use effectiveNow for the grace check,
    // and persist the high-water mark forward so a subsequently rolled-back clock cannot re-widen
    // the window that this genuine check just observed.
    if (!priorRead.ok)
        return { state: "UNKNOWN", verdict, clockMovedBackward: false };
    const now = Date.now();
    const clockMovedBackward = (0, cache_1.isClockMovedBackward)(priorRead.cache.max_observed_at, now);
    const effNow = (0, cache_1.effectiveNow)(priorRead.cache.max_observed_at, now);
    const advanced = (0, cache_1.advanceMaxObservedAt)(priorRead.cache.max_observed_at, now);
    if (advanced !== priorRead.cache.max_observed_at) {
        (0, cache_1.writeLicenseCache)(zeugeDir, key, { ...priorRead.cache, max_observed_at: advanced });
    }
    const state = resolveState(priorRead.cache, { now: effNow });
    return { state, verdict, clockMovedBackward };
}
