"use strict";
/**
 * license/providers/polar — validates a licence key against Polar.sh, the merchant of record
 * and key issuer (spec §5).
 *
 * Endpoint contract: POST {host}/v1/customer-portal/license-keys/validate with JSON body
 * {key, organization_id}. Host is https://api.polar.sh in production, or
 * https://sandbox-api.polar.sh when POLAR_ENVIRONMENT=sandbox (process env, or the off-repo
 * .polar.local wire next to licence.json). The frozen spec this package implements
 * explicitly flagged Polar's exact endpoint, auth scheme, and request/response bodies as
 * "TBD — verify against current Polar documentation before implementing"; this adapter has
 * NOT been smoke-tested against a live Polar organization at implementation time. Treat it
 * as a best-effort shape to be confirmed against Polar's live API reference before it
 * gates a real purchase, not as a verified integration. The response body's exact fields
 * are interpreted conservatively: an explicit `status`/`valid` field maps to
 * VALID/REVOKED/INVALID; anything else observed on a non-2xx response is UNREACHABLE
 * (never silently treated as VALID).
 *
 * organization_id is NEVER hardcoded — it is resolved by the caller (license/state.ts) from
 * ZEUGE_POLAR_ORG or a previously-stored value in .zeuge/licence.json, and validate() itself
 * refuses (UNREACHABLE, no network call made) when none is supplied, rather than guessing one.
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
exports.POLAR_SANDBOX_VALIDATE_URL = exports.POLAR_PRODUCTION_VALIDATE_URL = void 0;
exports.resolvePolarValidateUrl = resolvePolarValidateUrl;
exports.createPolarProvider = createPolarProvider;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const canon_1 = require("../../canon");
const provider_1 = require("../provider");
const paths_1 = require("../paths");
const POLAR_VALIDATE_PATH = "/v1/customer-portal/license-keys/validate";
exports.POLAR_PRODUCTION_VALIDATE_URL = `https://api.polar.sh${POLAR_VALIDATE_PATH}`;
exports.POLAR_SANDBOX_VALIDATE_URL = `https://sandbox-api.polar.sh${POLAR_VALIDATE_PATH}`;
function verdict(partial) {
    return { schema: "zeuge.license.verdict.v1", provider: "polar", ...partial };
}
/** Production stays api.polar.sh. Only an explicit sandbox environment retargets the host. */
function resolvePolarValidateUrl(environment) {
    return String(environment ?? "").trim().toLowerCase() === "sandbox"
        ? exports.POLAR_SANDBOX_VALIDATE_URL
        : exports.POLAR_PRODUCTION_VALIDATE_URL;
}
/**
 * File-based wire: .polar.local next to licence.json (resolved licence dir).
 * Reads POLAR_ENVIRONMENT only — never loads tokens or other secrets into process.env.
 */
function readPolarEnvironmentFromLocalFile() {
    try {
        const filePath = path.join((0, paths_1.resolveLicenseDir)().dir, ".polar.local");
        if (!fs.existsSync(filePath))
            return undefined;
        const text = fs.readFileSync(filePath, "utf8");
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const eq = trimmed.indexOf("=");
            if (eq <= 0)
                continue;
            const key = trimmed.slice(0, eq).trim();
            if (key !== "POLAR_ENVIRONMENT")
                continue;
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            return value;
        }
    }
    catch {
        /* unreadable wire file is not a hard failure — fall back to production */
    }
    return undefined;
}
function resolveEnvironment(opts) {
    if (opts.environment != null && String(opts.environment).trim() !== "")
        return opts.environment;
    const fromEnv = process.env.POLAR_ENVIRONMENT;
    if (fromEnv != null && fromEnv.trim() !== "")
        return fromEnv;
    return readPolarEnvironmentFromLocalFile();
}
function createPolarProvider(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    return {
        id: "polar",
        async validate(params) {
            const key_sha256 = (0, canon_1.sha256hex)(params.key);
            const key_id = (0, provider_1.keyIdFromSha256)(key_sha256);
            const checked_at = new Date().toISOString();
            const base = { key_id, key_sha256, checked_at, valid_until: null, grace_until: null, offline: false };
            if (!params.organizationId) {
                return verdict({ ...base, status: "UNREACHABLE", detail: "no organization_id configured (ZEUGE_POLAR_ORG or .zeuge/licence.json)" });
            }
            if (!fetchImpl) {
                return verdict({ ...base, status: "UNREACHABLE", detail: "no fetch implementation available in this runtime" });
            }
            const validateUrl = resolvePolarValidateUrl(resolveEnvironment(opts));
            let res;
            try {
                res = await fetchImpl(validateUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ key: params.key, organization_id: params.organizationId }),
                });
            }
            catch (err) {
                return verdict({ ...base, status: "UNREACHABLE", detail: `network error: ${err.message}` });
            }
            if (res.status === 403 || res.status === 404) {
                return verdict({ ...base, status: "REVOKED", detail: `polar responded ${res.status}` });
            }
            if (!res.ok) {
                return verdict({ ...base, status: "UNREACHABLE", detail: `polar responded ${res.status}` });
            }
            let body;
            try {
                body = await res.json();
            }
            catch (err) {
                return verdict({ ...base, status: "UNREACHABLE", detail: `unparseable polar response: ${err.message}` });
            }
            const b = (body ?? {});
            if (b.status === "granted" || b.valid === true) {
                const validUntil = typeof b.expires_at === "string" ? b.expires_at : null;
                return verdict({ ...base, status: "VALID", valid_until: validUntil, detail: "polar: granted" });
            }
            if (b.status === "revoked" || b.status === "disabled" || b.valid === false) {
                return verdict({ ...base, status: "REVOKED", detail: "polar: revoked" });
            }
            if (b.status === "expired") {
                return verdict({ ...base, status: "EXPIRED", detail: "polar: expired" });
            }
            const statusLabel = typeof b.status === "string" ? b.status : "unknown";
            return verdict({ ...base, status: "INVALID", detail: `polar: unrecognized status ${statusLabel}` });
        },
    };
}
