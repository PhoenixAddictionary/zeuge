"use strict";
/**
 * claim/record — builds and validates a zeuge.claim.v1 record from a detected candidate.
 * Witness matching (binding a claim to a WitnessSource) is out of scope here; every record built here
 * starts life exactly as the schema's own default: witnesses:[], status:"UNWITNESSED".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildClaim = buildClaim;
const canon_1 = require("../canon");
const ids_1 = require("../ids");
function buildClaim(params) {
    const redaction = params.redaction ?? "NONE";
    const statement_sha256 = (0, canon_1.sha256hex)(params.candidate.statement);
    return {
        schema: "zeuge.claim.v1",
        claim_id: (0, ids_1.makeId)("claim"),
        session_id: params.sessionId,
        agent: params.agent,
        occurred_at: params.occurredAt ?? new Date().toISOString(),
        claim_type: params.candidate.claim_type,
        ...(redaction === "NONE" ? { statement: params.candidate.statement } : {}),
        statement_sha256,
        span: { source: params.source, start: params.candidate.span.start, end: params.candidate.span.end },
        detector: { rule_id: params.candidate.rule_id, rules_sha256: params.rulesSha256 },
        witnesses: [],
        status: "UNWITNESSED",
        outcome: "UNKNOWN",
        trust_level: "L0",
        redaction,
    };
}
