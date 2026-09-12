"use strict";
/**
 * ledger/event — builds and hashes a zeuge.ledger.event.v1 row.
 *
 * event_hash = sha256(JCS(event minus event_hash)); prev_hash is the predecessor's
 * event_hash, ZERO_HASH at seq 1.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEvent = buildEvent;
exports.recomputeEventHash = recomputeEventHash;
exports.firstEvent = firstEvent;
const canon_1 = require("../canon");
const ids_1 = require("../ids");
function buildEvent(params) {
    const body_sha256 = (0, canon_1.canonicalHash)(params.body);
    const base = {
        schema: "zeuge.ledger.event.v1",
        ledger_id: params.ledgerId,
        seq: params.seq,
        recorded_at: params.recordedAt ?? new Date().toISOString(),
        prev_hash: params.prevHash,
        event_id: (0, ids_1.makeId)("event"),
        event_family: params.eventFamily,
        action_type: params.actionType,
        outcome: params.outcome,
        trust_level: params.trustLevel ?? "L2",
        actor: params.actor,
        body: params.body,
        body_sha256,
    };
    const event_hash = (0, canon_1.canonicalHash)(base);
    return { ...base, event_hash };
}
/** Recomputes the hash of a stored event over every field except event_hash itself. */
function recomputeEventHash(event) {
    const { event_hash: _drop, ...rest } = event;
    return (0, canon_1.canonicalHash)(rest);
}
function firstEvent(ledgerId, params) {
    return buildEvent({ ...params, ledgerId, seq: 1, prevHash: canon_1.ZERO_HASH });
}
