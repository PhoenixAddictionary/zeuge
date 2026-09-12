"use strict";
/**
 * witness/binding — the shared claim<->witness binding predicate used by BOTH the offline
 * bundle/verify path (receipt/bundle.ts) and the live Stop hook (claim/hook.ts).
 *
 * Root cause this file fixes: before it existed, `receipt/bundle.ts` treated an ABSENT witness
 * session_id as "unknown, bind permissively" but treated a claim's PLACEHOLDER session (the
 * exact all-zero string every un-sessioned `claim detect`/`claim hook` call stamps) as a real,
 * KNOWN, different session — a hard exclusion. That asymmetry is exactly why
 * `zeuge claim detect` (no --session) piped into `zeuge bundle` produced a bundle whose own
 * single claim was UNWITNESSED against its own single witness, even though neither side had
 * ever been told a real session id.
 *
 * `isUnknownSession` treats undefined, "", and the placeholder session id identically: a claim
 * or witness carrying any of these is not asserting "no session", it is asserting "I don't know
 * my session" — and an unknown session on EITHER side must fall back to the same permissive
 * rule (claim_type membership + time window), never a hard exclusion. A hard exclusion is
 * reserved for two CONFIRMED, DIFFERENT, KNOWN session ids — see the module doc that used to
 * live on receipt/bundle.ts's own copy of this logic, and the witness-side doc on
 * witness/source.ts's `session_id` field, which already declared the weaker (permissive) proof
 * for an absent witness session; this file makes that declaration symmetric.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WITNESS_WINDOW_MS = exports.PLACEHOLDER_SESSION = void 0;
exports.isUnknownSession = isUnknownSession;
exports.withinWitnessWindow = withinWitnessWindow;
exports.witnessBacksClaim = witnessBacksClaim;
/** The exact placeholder every un-sessioned caller stamps: claim/hook.ts's DEFAULT when a Stop
 *  payload carries no session_id, and cli.ts's default for `claim detect` / `bundle --session`
 *  when the flag is omitted. Centralized here so every producer and this predicate agree on the
 *  one string that means "no real session was ever supplied," rather than each file re-typing
 *  the same 36 zeros and risking drift. */
exports.PLACEHOLDER_SESSION = "session:00000000000000000000000000000000";
/** True for undefined, empty, or the all-zero placeholder — the three ways a session id can be
 *  "not really a session" rather than a genuine identifier. */
function isUnknownSession(sessionId) {
    return sessionId === undefined || sessionId === "" || sessionId === exports.PLACEHOLDER_SESSION;
}
/** The turn-window half-width: "the last 30 min" fallback named in the spec's binding rules.
 *  Applied symmetrically around the claim's occurred_at (a witnessing command can run either
 *  just before or just after the claim sentence within the same turn). */
exports.WITNESS_WINDOW_MS = 30 * 60 * 1000;
/** True iff `witness` may back `claim` on time alone: both timestamps parse, and they are no
 *  further apart than WITNESS_WINDOW_MS. An unparseable timestamp on either side fails closed
 *  (never backs a claim it cannot actually place in time). */
function withinWitnessWindow(claim, witness) {
    const claimTime = Date.parse(claim.occurred_at);
    const witnessTime = Date.parse(witness.observed_at);
    if (!Number.isFinite(claimTime) || !Number.isFinite(witnessTime))
        return false;
    return Math.abs(claimTime - witnessTime) <= exports.WITNESS_WINDOW_MS;
}
/** The ONE shared binding test used by both the bundle/verify path and the live Stop hook:
 *  claim_type membership, then session (permissive when EITHER side is unknown per
 *  `isUnknownSession`, a hard exclusion only when BOTH sides are known and different), then the
 *  time window. Documented weaker proof: an unknown session on either side is not evidence of
 *  a DIFFERENT session, but it is also weaker proof than a confirmed same-session match. */
function witnessBacksClaim(witness, claim) {
    if (!witness.binds.includes(claim.claim_type))
        return false;
    const bothKnown = !isUnknownSession(witness.session_id) && !isUnknownSession(claim.session_id);
    if (bothKnown && witness.session_id !== claim.session_id)
        return false;
    return withinWitnessWindow(claim, witness);
}
