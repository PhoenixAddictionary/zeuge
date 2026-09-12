"use strict";
/**
 * license/cache — the local licence cache (licence-cache.json, next to licence.json — see
 * license/paths.ts for where that directory actually is), HMAC-checked so an edited cache (e.g.
 * someone hand-extending grace_until to keep a Pro command unlocked forever) is DETECTED rather
 * than trusted. Per the spec: "the state file is re-validated, never trusted as proof of
 * entitlement" — the HMAC is exactly that re-validation, done locally without a network call.
 *
 * This is worth stating plainly here, because it shapes every design
 * choice below: this offline check is a convenience for honest users, not a security boundary.
 * The HMAC key is derived from the licence key itself (sha256 of the raw key), so anyone who
 * holds ANY key string — including a revoked or fabricated one — can compute a valid HMAC over
 * a cache record they invented. That is a real, accepted limitation, not an oversight: this
 * package is MIT-licensed source, so a user who wants to bypass the check entirely can delete
 * it in under a minute, making a heavier local cryptographic scheme theatre rather than
 * protection. What the HMAC DOES buy: it stops a cache file from being hand-edited (e.g. to
 * extend grace_until) while the rest of the tool is left intact — a materially different, much
 * more common failure mode than "attacker forges a whole key." See README.md's Licence section
 * and `zeuge licence status`'s own output for the user-facing version of this same statement.
 *
 * Checked 2026-09-11 against Polar's documented `ValidatedLicenseKey` response schema
 * (customer-portal license-keys validate endpoint): it carries no signature, no public-key-
 * verifiable field, and no other client-checkable authenticity field — only descriptive fields
 * (id, status, usage, expires_at, ...). There is nothing to verify the cache against besides the
 * key itself, so the HMAC stays keyed on the licence key, as it always was; this is a confirmed
 * absence, not an unresolved TBD. If a future Polar response shape adds such a field, binding
 * the cache to it instead of to the raw key would close this gap for real — until then, do not
 * invent one.
 *
 * Only key_sha256 is ever written here, never the raw key (the spec's "keys are stored hashed"
 * — the one place the raw key itself is held locally is license/state.ts's key file, which is
 * necessarily re-sent to the provider on every future `licence status` refresh).
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
exports.GRACE_MS = void 0;
exports.computeGraceUntil = computeGraceUntil;
exports.isWithinGrace = isWithinGrace;
exports.effectiveNow = effectiveNow;
exports.isClockMovedBackward = isClockMovedBackward;
exports.advanceMaxObservedAt = advanceMaxObservedAt;
exports.writeLicenseCache = writeLicenseCache;
exports.readLicenseCache = readLicenseCache;
exports.clearLicenseCache = clearLicenseCache;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const canon_1 = require("../canon");
exports.GRACE_MS = 14 * 24 * 60 * 60 * 1000;
function cachePath(zeugeDir) {
    return path.join(zeugeDir, "licence-cache.json");
}
function computeHmac(record, key) {
    return (0, node_crypto_1.createHmac)("sha256", key).update((0, canon_1.canonicalize)(record)).digest("hex");
}
/** Computes grace_until for a freshly-VALID verdict: validated_at + 14 days. Only meaningful
 *  for a VALID status; callers store null for anything else. */
function computeGraceUntil(validatedAtIso) {
    return new Date(Date.parse(validatedAtIso) + exports.GRACE_MS).toISOString();
}
function isWithinGrace(graceUntilIso, now = Date.now()) {
    if (!graceUntilIso)
        return false;
    const g = Date.parse(graceUntilIso);
    return Number.isFinite(g) && now <= g;
}
/** The effective "now" for grace-window arithmetic: never earlier than the highest
 *  `now` this cache has ever been evaluated against. A rolled-back system clock cannot move
 *  this value down; it can only fail to advance it. The practical effect: rolling the clock
 *  back FREEZES remaining grace at whatever was legitimately left (it neither resets to a fresh
 *  14 days nor keeps counting down), which is exactly "do not extend or renew grace" without
 *  ever turning a suspicious clock into a lockout — a caller using `effectiveNow` for its grace
 *  check keeps working for whatever grace legitimately remains. */
function effectiveNow(maxObservedAtIso, rawNow) {
    const maxObserved = maxObservedAtIso ? Date.parse(maxObservedAtIso) : NaN;
    return Number.isFinite(maxObserved) && maxObserved > rawNow ? maxObserved : rawNow;
}
/** True exactly when `rawNow` is strictly earlier than the stored high-water mark — i.e. the
 *  system clock has moved backward since this cache was last checked. Callers report this as
 *  the named state `CLOCK_MOVED_BACKWARD`. */
function isClockMovedBackward(maxObservedAtIso, rawNow) {
    const maxObserved = maxObservedAtIso ? Date.parse(maxObservedAtIso) : NaN;
    return Number.isFinite(maxObserved) && rawNow < maxObserved;
}
/** The ISO instant callers should persist back into the cache after each check: `max(existing,
 *  rawNow)`, monotonically non-decreasing by construction. Returns the ORIGINAL string
 *  unchanged (not merely an equal instant re-serialized) when nothing needs to advance, so a
 *  caller can cheaply skip a write via `advanceMaxObservedAt(x, now) !== x`. */
function advanceMaxObservedAt(maxObservedAtIso, rawNow) {
    if (!maxObservedAtIso)
        return new Date(rawNow).toISOString();
    const maxObserved = Date.parse(maxObservedAtIso);
    return Number.isFinite(maxObserved) && maxObserved > rawNow ? maxObservedAtIso : new Date(rawNow).toISOString();
}
function writeLicenseCache(zeugeDir, key, record) {
    fs.mkdirSync(zeugeDir, { recursive: true });
    const full = { schema: "zeuge.license.cache.v1", ...record };
    const stored = { ...full, hmac: computeHmac(full, key) };
    fs.writeFileSync(cachePath(zeugeDir), JSON.stringify(stored), "utf8");
}
/** Reads and HMAC-verifies the cache against `key`. A structurally-valid-but-hmac-mismatched
 *  file is reported TAMPERED, never silently accepted and never silently treated the same as
 *  MISSING (a caller must fail closed on TAMPERED, not fall back to "no cache" leniency). */
function readLicenseCache(zeugeDir, key) {
    let raw;
    try {
        raw = fs.readFileSync(cachePath(zeugeDir), "utf8");
    }
    catch {
        return { ok: false, reason: "MISSING" };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, reason: "INVALID" };
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.hmac !== "string") {
        return { ok: false, reason: "INVALID" };
    }
    const { hmac, ...record } = parsed;
    const recomputed = computeHmac(record, key);
    if (recomputed !== hmac) {
        return { ok: false, reason: "TAMPERED" };
    }
    return { ok: true, cache: record };
}
function clearLicenseCache(zeugeDir) {
    try {
        fs.unlinkSync(cachePath(zeugeDir));
    }
    catch {
        /* already absent */
    }
}
