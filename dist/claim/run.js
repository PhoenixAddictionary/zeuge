"use strict";
/**
 * claim/run — the shared pass used by both `zeuge claim detect` and `zeuge claim hook`:
 * positive control probe first, then detection, then a coverage block.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runClaimPass = runClaimPass;
const detect_1 = require("./detect");
const probe_1 = require("./probe");
const record_1 = require("./record");
const replay_1 = require("./replay");
function runClaimPass(params) {
    const rules = params.rules ?? detect_1.DEFAULT_RULES;
    const probeResult = (0, probe_1.runProbe)(rules);
    if (probeResult.probe === "DEAD") {
        return {
            coverage: {
                turns_scanned: params.text ? 1 : 0,
                statements_total: 0,
                statements_classified: 0,
                statements_matched: {},
                probe: "DEAD",
                probe_missing: probeResult.missing,
            },
            claims: [],
            seen: params.seen ?? new Set(),
        };
    }
    const { candidates, skipped, total, classified_sentences } = (0, detect_1.detectClaimsWithSkips)(params.text, rules);
    const rSha = (0, detect_1.rulesSha256)(rules);
    const built = candidates.map((c) => (0, record_1.buildClaim)({
        sessionId: params.sessionId,
        agent: params.agent,
        candidate: c,
        source: params.source,
        rulesSha256: rSha,
        redaction: params.redaction,
        occurredAt: params.occurredAt,
    }));
    const { claims, seen } = (0, replay_1.markReplays)(built, params.seen ?? new Set());
    const statements_matched = {};
    for (const c of claims) {
        statements_matched[c.claim_type] = (statements_matched[c.claim_type] ?? 0) + 1;
    }
    return {
        coverage: {
            turns_scanned: params.text ? 1 : 0,
            statements_total: total,
            statements_classified: classified_sentences,
            statements_matched,
            ...(Object.keys(skipped).length > 0 ? { statements_skipped: skipped } : {}),
            probe: "ALIVE",
        },
        claims,
        seen,
    };
}
