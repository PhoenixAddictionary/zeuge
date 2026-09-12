/**
 * claim/record — builds and validates a zeuge.claim.v1 record from a detected candidate.
 * Witness matching (binding a claim to a WitnessSource) is out of scope here; every record built here
 * starts life exactly as the schema's own default: witnesses:[], status:"UNWITNESSED".
 */

import { sha256hex } from "../canon";
import { makeId } from "../ids";
import type { ClaimCandidate } from "./detect";
import type { ClaimType } from "../vocab";

export type Redaction = "NONE" | "HASH_ONLY";

export interface AgentInfo {
  id: string;
  vendor: string;
  model: string;
  harness: string;
  harness_version: string;
}

export interface ClaimRecord {
  schema: "zeuge.claim.v1";
  claim_id: string;
  session_id: string;
  agent: AgentInfo;
  occurred_at: string;
  claim_type: ClaimType;
  statement?: string; // absent when redaction is HASH_ONLY
  statement_sha256: string;
  span: { source: string; start: number; end: number };
  detector: { rule_id: string; rules_sha256: string };
  witnesses: unknown[];
  // "REFUTED" is reserved for a planned refutation ledger (see vocab.ts / receipt/bundle.ts) and
  // is never assigned by anything in src/ today — nothing here builds a REFUTED record. Kept in
  // the union deliberately (do not delete); README.md / skills/zeuge-claim/SKILL.md describe it
  // to readers as reserved and not yet emitted, not as a live outcome.
  status: "UNWITNESSED" | "WITNESSED" | "REFUTED";
  outcome: "UNKNOWN";
  trust_level: "L0";
  redaction: Redaction;
  replay?: boolean;
}

export interface BuildClaimParams {
  sessionId: string;
  agent: AgentInfo;
  candidate: ClaimCandidate;
  source: string; // e.g. "stop_hook.last_assistant_message"
  rulesSha256: string;
  redaction?: Redaction;
  occurredAt?: string;
}

export function buildClaim(params: BuildClaimParams): ClaimRecord {
  const redaction = params.redaction ?? "NONE";
  const statement_sha256 = sha256hex(params.candidate.statement);
  return {
    schema: "zeuge.claim.v1",
    claim_id: makeId("claim"),
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
