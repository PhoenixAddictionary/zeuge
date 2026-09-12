/**
 * claim/run — the shared pass used by both `zeuge claim detect` and `zeuge claim hook`:
 * positive control probe first, then detection, then a coverage block.
 */

import { DEFAULT_RULES, ClaimRule, detectClaimsWithSkips, rulesSha256 } from "./detect";
import { runProbe, CoverageBlock } from "./probe";
import { buildClaim, ClaimRecord, AgentInfo, Redaction } from "./record";
import { markReplays } from "./replay";
import type { ClaimType } from "../vocab";

export interface RunClaimPassParams {
  text: string;
  sessionId: string;
  agent: AgentInfo;
  source: string;
  rules?: ClaimRule[];
  redaction?: Redaction;
  seen?: Set<string>; // replay state carried in by the caller (hook.ts persists it to disk)
  occurredAt?: string;
}

export interface RunClaimPassResult {
  coverage: CoverageBlock;
  claims: ClaimRecord[];
  seen: Set<string>;
}

export function runClaimPass(params: RunClaimPassParams): RunClaimPassResult {
  const rules = params.rules ?? DEFAULT_RULES;
  const probeResult = runProbe(rules);

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

  const { candidates, skipped, total, classified_sentences } = detectClaimsWithSkips(params.text, rules);
  const rSha = rulesSha256(rules);
  const built = candidates.map((c) =>
    buildClaim({
      sessionId: params.sessionId,
      agent: params.agent,
      candidate: c,
      source: params.source,
      rulesSha256: rSha,
      redaction: params.redaction,
      occurredAt: params.occurredAt,
    })
  );
  const { claims, seen } = markReplays(built, params.seen ?? new Set());

  const statements_matched: Partial<Record<ClaimType, number>> = {};
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
