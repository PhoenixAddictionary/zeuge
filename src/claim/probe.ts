/**
 * claim/probe — a positive control run before every
 * real scan. An undetected claim is indistinguishable from an absent one, so before trusting
 * the detector on real text, run it on one built-in planted sentence per claim_type. If any
 * planted sentence is not detected, the whole run reports probe: DEAD and — for a non-hook
 * caller — refuses to emit claim records at all (exit 3): a probe that cannot fire proves
 * nothing (lineage: a check whose failure mode is silence is not a check).
 */

import { DEFAULT_RULES, ClaimRule, detectClaims } from "./detect";
import type { ClaimType } from "../vocab";

export const PLANTED_SENTENCES: Array<{ claim_type: ClaimType; text: string }> = [
  { claim_type: "tests_pass", text: "All tests pass." },
  { claim_type: "deployed", text: "Deployed to production." },
  { claim_type: "fixed", text: "Fixed the bug." },
  { claim_type: "done", text: "Done." },
];

export interface ProbeResult {
  probe: "ALIVE" | "DEAD";
  missing: ClaimType[];
}

export function runProbe(rules: ClaimRule[] = DEFAULT_RULES): ProbeResult {
  const missing: ClaimType[] = [];
  for (const planted of PLANTED_SENTENCES) {
    const found = detectClaims(planted.text, rules).some((c) => c.claim_type === planted.claim_type);
    if (!found) missing.push(planted.claim_type);
  }
  return { probe: missing.length === 0 ? "ALIVE" : "DEAD", missing };
}

export interface CoverageBlock {
  turns_scanned: number;
  /** The coverage denominator — every sentence seen this run (0 when the probe is
   *  DEAD, since no real scanning happens on that path). Shown first in the report and listed
   *  first here so a reader sees the whole denominator before the breakdown. */
  statements_total: number;
  statements_classified: number;
  statements_matched: Partial<Record<ClaimType, number>>;
  /** Sentences that carried a marker word but were guarded out (negation,
   *  imperative, conditional, question, quoted), keyed by reason, so the report can show the
   *  denominator instead of a detection count with no visible "what didn't count." */
  statements_skipped?: Record<string, number>;
  probe: "ALIVE" | "DEAD";
  probe_missing?: ClaimType[];
  /** Set when transcript_path was the resolution path and reading it failed —
   *  distinct from "read fine, found nothing." */
  transcript_unreadable?: boolean;
  transcript_unreadable_class?: string;
  /** Count of transcript lines that failed JSON.parse while
   *  scanning a real transcript file for the last assistant entry. Present only when > 0 — a
   *  corrupted transcript must be distinguishable from an empty one, not silently swallowed by
   *  a `continue`. */
  transcript_malformed_lines?: number;
  /** Set when the real transcript file exceeded
   *  TRANSCRIPT_READ_BUDGET_BYTES (claim/hook.ts) and only a bounded tail was read, so a
   *  truncated read is visible in the report rather than silent. `transcript_read_budget_bytes`
   *  names the exact byte budget applied. Both absent when the file fit within budget. */
  transcript_read_bounded?: boolean;
  transcript_read_budget_bytes?: number;
  /** How the live Stop hook's witness-binding pass actually went this turn — distinct
   *  from the detection coverage above. Absent when there were no candidate claims to check
   *  (nothing to bind, nothing to report). `NO_LEDGER` and `VERIFICATION_FAILED` both mean the
   *  hook could NOT check witnesses at all (never conflated with "checked, found nothing");
   *  `CHECKED` means the ledger hash-verified and `events_considered` events were weighed
   *  against every candidate claim. */
  witness_check?: {
    status: "NO_LEDGER" | "VERIFICATION_FAILED" | "CHECKED";
    ledger_path: string;
    events_considered: number;
  };
}
