/**
 * claim/state — per-STATEMENT cooldown state, fail-open. Nothing here ever throws: an
 * unreadable or missing state file just means "no cooldown recorded yet," and a failed write
 * is swallowed (the hook must never crash Claude Code over a state-file problem).
 *
 * The field used to be named `last_nudged` and documented as
 * "claim_type -> epoch ms", and `isInCooldown`'s second parameter was named `claimType` — but
 * the ONLY real caller (claim/hook.ts) has always passed `statement_sha256`, which is correct
 * and deliberate: keying on claim_type would suppress a genuinely NEW, different statement of
 * the same claim_type merely because some OTHER statement of that type was nudged inside the
 * cooldown window. That false negative shipped once and was fixed. A reader relying
 * only on the names and this comment could conclude the product still had the old
 * bug; it does not, but the contract was lying about itself. The field and parameter are now
 * named for what they actually are, so the type signature documents the real contract instead
 * of a different one. NEVER re-key this on claim_type.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const COOLDOWN_MS = 1800 * 1000;

/**
 * Retention window for a cooldown entry, kept well above COOLDOWN_MS (30 min) so
 * a time-based prune can never remove an entry that is still suppressing an active cooldown —
 * an entry is only ever eligible for age-based pruning once it is provably long past the point
 * it could still matter to `isInCooldown`. 24h gives generous slack for clock skew and long
 * idle gaps between hook invocations while still keeping the file from growing forever.
 */
export const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on distinct statement entries kept, independent of age; bounds file
 * size and per-turn write cost even if a session nudges an unusually large number of distinct
 * statements inside one retention window. Chosen generously above plausible daily nudge
 * volume. Entries still inside COOLDOWN_MS of `now` are NEVER evicted by this cap — see
 * `pruneEntries` — because dropping a live cooldown entry would resurface a claim that was
 * already answered this window.
 */
export const STATE_MAX_ENTRIES = 5000;

export interface ClaimState {
  /** statement_sha256 -> epoch ms of the last nudge for that EXACT statement. Never keyed on
   *  claim_type — see the file-level comment above. */
  last_nudged_by_statement: Record<string, number>;
}

/** Pre-migration on-disk shape: older state files used the field name `last_nudged`. The DATA
 *  was always statement_sha256-keyed (only the name and comment were wrong), so an old file's
 *  entries carry over unchanged under the corrected field name — see `loadState`. */
interface LegacyClaimState {
  last_nudged?: Record<string, number>;
}

export function statePath(zeugeDir: string): string {
  return path.join(zeugeDir, "claim-state.json");
}

/** Bounds an entries map by age and count. `now`-relative age governs both the retention
 *  prune and which entries are "protected" from the count-based cap:
 *  - Retention: an entry is dropped only when `now - ts` is provably >= STATE_RETENTION_MS
 *    (non-negative elapsed). A future timestamp (clock moved backward since it was recorded)
 *    is never treated as stale — fail open toward keeping it rather than guessing.
 *  - Cap: if more than STATE_MAX_ENTRIES survive retention, the oldest are evicted first, but
 *    an entry still inside COOLDOWN_MS of `now` is exempt from cap eviction. In the extreme
 *    case where more than STATE_MAX_ENTRIES entries are simultaneously inside COOLDOWN_MS,
 *    the cap is allowed to soft-overrun rather than ever dropping a live cooldown record. */
function pruneEntries(entries: Record<string, number>, now: number): Record<string, number> {
  const withinCooldown = new Set<string>();
  const survivors: [string, number][] = [];
  for (const [key, ts] of Object.entries(entries)) {
    const elapsed = now - ts;
    if (elapsed >= 0 && elapsed < COOLDOWN_MS) withinCooldown.add(key);
    if (elapsed >= 0 && elapsed >= STATE_RETENTION_MS) continue; // provably stale: drop
    survivors.push([key, ts]);
  }
  if (survivors.length <= STATE_MAX_ENTRIES) return Object.fromEntries(survivors);
  survivors.sort((a, b) => b[1] - a[1]); // newest first
  const kept: [string, number][] = [];
  const overflow: [string, number][] = [];
  for (const entry of survivors) {
    if (kept.length < STATE_MAX_ENTRIES) kept.push(entry);
    else overflow.push(entry);
  }
  for (const entry of overflow) {
    if (withinCooldown.has(entry[0])) kept.push(entry); // never drop a live cooldown entry
  }
  return Object.fromEntries(kept);
}

export function loadState(zeugeDir: string): ClaimState {
  try {
    const raw = fs.readFileSync(statePath(zeugeDir), "utf8");
    const parsed = JSON.parse(raw) as (ClaimState & LegacyClaimState) | null;
    if (parsed && typeof parsed === "object") {
      if (parsed.last_nudged_by_statement && typeof parsed.last_nudged_by_statement === "object") {
        return { last_nudged_by_statement: parsed.last_nudged_by_statement };
      }
      // Migration: old field name, same statement_sha256-keyed data — carry it over rather
      // than silently discarding cooldown history on upgrade.
      if (parsed.last_nudged && typeof parsed.last_nudged === "object") {
        return { last_nudged_by_statement: parsed.last_nudged };
      }
    }
    return { last_nudged_by_statement: {} };
  } catch {
    return { last_nudged_by_statement: {} };
  }
}

export function saveState(zeugeDir: string, state: ClaimState, now: number = Date.now()): void {
  try {
    fs.mkdirSync(zeugeDir, { recursive: true });
    const bounded: ClaimState = { last_nudged_by_statement: pruneEntries(state.last_nudged_by_statement, now) };
    fs.writeFileSync(statePath(zeugeDir), JSON.stringify(bounded), "utf8");
  } catch {
    /* fail-open: a state write failure must never break the hook */
  }
}

/**
 * A statement is in cooldown iff its EXACT statement_sha256 was nudged within the last
 * COOLDOWN_MS, judged against `now`. If the recorded last-nudged time is AFTER `now` (the
 * clock moved backward since), that recorded time is untrustworthy and treated as
 * no-cooldown — fail open: never crash, never silently suppress a claim (never "assume it was
 * shown") because of a clock glitch or a missing/corrupt state file.
 */
export function isInCooldown(state: ClaimState, statementSha256: string, now: number): boolean {
  const last = state.last_nudged_by_statement[statementSha256];
  if (last === undefined) return false;
  const elapsed = now - last;
  if (elapsed < 0) return false; // clock moved backward: does not count as "still in cooldown"
  return elapsed < COOLDOWN_MS;
}
