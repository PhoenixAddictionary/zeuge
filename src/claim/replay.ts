/**
 * claim/replay — the same statement (by session_id + statement_sha256) fed to detection twice
 * yields one claim, flagged replay:true on the repeat, never double-counted.
 */

import type { ClaimRecord } from "./record";

/** Pure, in-memory replay pass: given a running `seen` set of "sessionId:statementSha256"
 *  keys, flags each already-seen claim as replay:true and returns the updated set. The claim
 *  is still returned (never silently dropped) so a caller can choose to exclude replays from
 *  counts or nudges, but the record itself is honest about what it is. */
export function markReplays(claims: ClaimRecord[], seen: Set<string> = new Set()): { claims: ClaimRecord[]; seen: Set<string> } {
  const nextSeen = new Set(seen);
  const out = claims.map((c) => {
    const key = `${c.session_id}:${c.statement_sha256}`;
    const isReplay = nextSeen.has(key);
    nextSeen.add(key);
    return isReplay ? { ...c, replay: true } : c;
  });
  return { claims: out, seen: nextSeen };
}

/** Removes replayed claims from a count, so a replay is never counted as a second distinct
 *  unwitnessed claim. */
export function countNonReplays(claims: ClaimRecord[]): number {
  return claims.filter((c) => !c.replay).length;
}
