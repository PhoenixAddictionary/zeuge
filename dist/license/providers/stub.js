"use strict";
/**
 * license/providers/stub — a deterministic, network-free LicenseProvider for tests. Never
 * touches the network; the caller supplies exactly the verdict (or a function of the key) it
 * wants returned, so a test can exercise VALID/REVOKED/EXPIRED/INVALID/UNREACHABLE paths
 * without stubbing fetch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStubProvider = createStubProvider;
const canon_1 = require("../../canon");
const provider_1 = require("../provider");
function createStubProvider(opts) {
    return {
        id: "stub",
        async validate(params) {
            const status = typeof opts.status === "function" ? opts.status(params) : opts.status;
            const key_sha256 = (0, canon_1.sha256hex)(params.key);
            return {
                schema: "zeuge.license.verdict.v1",
                status,
                provider: "stub",
                key_id: (0, provider_1.keyIdFromSha256)(key_sha256),
                key_sha256,
                checked_at: new Date().toISOString(),
                valid_until: opts.valid_until ?? null,
                grace_until: null,
                offline: false,
                detail: opts.detail ?? `stub: ${status}`,
            };
        },
    };
}
