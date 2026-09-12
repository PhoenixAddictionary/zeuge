"use strict";
/**
 * license/provider — the LicenseProvider interface and the zeuge.license.verdict.v1 shape
 * (spec §5). A provider's job is narrow: given a key (and optionally a product/instance/org
 * id), return exactly one of five raw statuses. Everything else — caching, the 14-day offline
 * grace window, and the higher-level VALID/GRACE/EXPIRED/REVOKED/UNKNOWN state a command
 * actually gates on — lives in license/cache.ts and license/state.ts, never inside a provider.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.keyIdFromSha256 = keyIdFromSha256;
/** A stable key_id derived from key_sha256 (same key -> same id every call), never a fresh
 *  random id per validate() — matches the ids.ts opaque-id format (`key:<32-64 hex>`). */
function keyIdFromSha256(keySha256) {
    return `key:${keySha256.slice(0, 32)}`;
}
