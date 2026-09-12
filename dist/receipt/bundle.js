"use strict";
/**
 * receipt/bundle — assembles and signs a zeuge.bundle.v1 (spec §4).
 *
 * Binding implements the spec's full three-part test — `binds` contains the
 * claim_type, AND session matches (permissively, when either side's session is unknown — see
 * witness/binding.ts's isUnknownSession — or exactly, when both are known), AND the witness's
 * observed_at falls inside a time window around the claim's occurred_at (30 minutes, symmetric
 * — a witness can precede or follow the claim statement within a turn). The actual predicate
 * (`witnessBacksClaim`) now lives in witness/binding.ts, shared with the live Stop hook
 * (claim/hook.ts) — this caught a second, subtly different copy of this logic in the hook
 * that had never been wired in at all, so this module keeping its own copy risked exactly the drift
 * that caused that bug in the first place.
 * The bundle also carries the same `coverage` block the claim run itself
 * produced, because a report/verify pass downstream needs to know whether the detector that
 * produced these claims could even fire.
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
exports.ZERO_HASH = void 0;
exports.rebindClaims = rebindClaims;
exports.buildBundle = buildBundle;
exports.bundleSignatureMessage = bundleSignatureMessage;
exports.finalizeBundle = finalizeBundle;
exports.writeBundle = writeBundle;
const fs = __importStar(require("node:fs"));
const canon_1 = require("../canon");
Object.defineProperty(exports, "ZERO_HASH", { enumerable: true, get: function () { return canon_1.ZERO_HASH; } });
const ids_1 = require("../ids");
const keys_1 = require("./keys");
const vocab_1 = require("../vocab");
const binding_1 = require("../witness/binding");
const TRUST_ORDER = ["L0", "L1", "L2", "L3", "L4"];
/** Re-binds every claim to the witness set using `witnessBacksClaim`. Pure function so `verify`
 *  can call the IDENTICAL logic to re-derive status from a bundle's own witnesses and catch a
 *  claim whose status was hand-edited. */
function rebindClaims(claims, witnesses) {
    return claims.map((c) => {
        if (c.status === "REFUTED")
            return c; // refutation (its own refutation ledger) is out of scope here; never silently overwritten
        const matches = witnesses.filter((w) => (0, binding_1.witnessBacksClaim)(w, c));
        if (matches.length === 0)
            return { ...c, status: "UNWITNESSED", witnesses: [] };
        return { ...c, status: "WITNESSED", witnesses: matches.map((w) => w.witness_id) };
    });
}
function computeSummary(claims) {
    const witnessed = claims.filter((c) => c.status === "WITNESSED").length;
    const unwitnessed = claims.filter((c) => c.status === "UNWITNESSED").length;
    const refuted = claims.filter((c) => c.status === "REFUTED").length;
    const minTrust = claims.length === 0 ? "L0" : claims.reduce((min, c) => (TRUST_ORDER.indexOf(c.trust_level) < TRUST_ORDER.indexOf(min) ? c.trust_level : min), "L4");
    return { claims_total: claims.length, witnessed, unwitnessed, refuted, min_trust_level: minTrust };
}
function schemaFingerprints() {
    return {
        claim: (0, canon_1.canonicalHash)({ schema: "zeuge.claim.v1", fields: ["claim_id", "session_id", "agent", "occurred_at", "claim_type", "statement_sha256", "span", "detector", "witnesses", "status", "outcome", "trust_level", "redaction"] }),
        ledger_event: (0, canon_1.canonicalHash)({ schema: "zeuge.ledger.event.v1", fields: ["ledger_id", "seq", "recorded_at", "prev_hash", "event_id", "event_family", "action_type", "outcome", "trust_level", "actor", "body", "body_sha256", "event_hash"] }),
        bundle: (0, canon_1.canonicalHash)({ schema: "zeuge.bundle.v1", claim_types: vocab_1.CLAIM_TYPES }),
    };
}
function buildBundle(params) {
    const boundClaims = rebindClaims(params.claims, params.witnesses);
    return {
        schema: "zeuge.bundle.v1",
        bundle_id: (0, ids_1.makeId)("bundle"),
        produced_at: new Date().toISOString(),
        subject: params.subject,
        session: { session_id: params.sessionId, agent: params.agent },
        ledger: { ...params.ledger, referenced_events: params.referencedLedgerEvents },
        coverage: params.coverage,
        claims: boundClaims,
        witnesses: params.witnesses,
        summary: computeSummary(boundClaims),
        schema_fingerprints: schemaFingerprints(),
    };
}
/** Domain-separated signature input per spec: "zeuge:bundle:v1\n" + bundle_sha256. */
function bundleSignatureMessage(bundleSha256) {
    return Buffer.from("zeuge:bundle:v1\n" + bundleSha256, "utf8");
}
function finalizeBundle(unsigned, opts = {}) {
    const bundle_sha256 = (0, canon_1.canonicalHash)(unsigned);
    const signatures = [];
    if (opts.sign) {
        const zeugeDir = opts.zeugeDir ?? ".zeuge";
        const { publicKey, privateKey } = (0, keys_1.loadOrCreateKeypair)(zeugeDir);
        const message = bundleSignatureMessage(bundle_sha256);
        signatures.push({
            alg: "ed25519",
            key_id: (0, ids_1.makeId)("key"),
            public_key_spki_b64: (0, keys_1.publicKeySpkiB64)(publicKey),
            signed_sha256: bundle_sha256,
            signature_b64: (0, keys_1.signMessage)(message, privateKey),
            signed_at: new Date().toISOString(),
        });
    }
    return { ...unsigned, bundle_sha256, signatures };
}
function writeBundle(bundle, outPath) {
    fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
}
