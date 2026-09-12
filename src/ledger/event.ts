/**
 * ledger/event — builds and hashes a zeuge.ledger.event.v1 row.
 *
 * event_hash = sha256(JCS(event minus event_hash)); prev_hash is the predecessor's
 * event_hash, ZERO_HASH at seq 1.
 */

import { canonicalHash, ZERO_HASH } from "../canon";
import { makeId } from "../ids";
import type { ActionType, ActorKind, EventFamily, Outcome, TrustLevel } from "../vocab";

export interface LedgerEventBody {
  command_sha256?: string;
  exit_code?: number;
  stdout_sha256?: string;
  stderr_sha256?: string;
  cwd_sha256?: string;
  duration_ms?: number;
  previous_segment_head_hash?: string;
  /** Lexical classification of a COMMAND_RUN's command string (see ledger/command-kind.ts),
   *  written by the PostToolUse ledger hook. Never the command text itself — only this label.
   *  Absent on any event recorded before this field existed; absence must never be treated as
   *  "test" (see witness/sources/ledger.ts's binding rule). */
  command_kind?: "test" | "build" | "deploy" | "other";
  [key: string]: unknown;
}

export interface LedgerEvent {
  schema: "zeuge.ledger.event.v1";
  ledger_id: string;
  seq: number;
  recorded_at: string;
  prev_hash: string;
  event_id: string;
  event_family: EventFamily;
  action_type: ActionType | string;
  outcome: Outcome | string;
  trust_level: TrustLevel;
  actor: { kind: ActorKind; id: string };
  body: LedgerEventBody;
  body_sha256: string;
  event_hash: string;
}

export interface BuildEventParams {
  ledgerId: string;
  seq: number;
  prevHash: string;
  eventFamily: EventFamily;
  actionType: ActionType | string;
  outcome: Outcome | string;
  trustLevel?: TrustLevel;
  actor: { kind: ActorKind; id: string };
  body: LedgerEventBody;
  recordedAt?: string;
}

export function buildEvent(params: BuildEventParams): LedgerEvent {
  const body_sha256 = canonicalHash(params.body);
  const base = {
    schema: "zeuge.ledger.event.v1" as const,
    ledger_id: params.ledgerId,
    seq: params.seq,
    recorded_at: params.recordedAt ?? new Date().toISOString(),
    prev_hash: params.prevHash,
    event_id: makeId("event"),
    event_family: params.eventFamily,
    action_type: params.actionType,
    outcome: params.outcome,
    trust_level: params.trustLevel ?? "L2",
    actor: params.actor,
    body: params.body,
    body_sha256,
  };
  const event_hash = canonicalHash(base);
  return { ...base, event_hash };
}

/** Recomputes the hash of a stored event over every field except event_hash itself. */
export function recomputeEventHash(event: LedgerEvent): string {
  const { event_hash: _drop, ...rest } = event;
  return canonicalHash(rest);
}

export function firstEvent(ledgerId: string, params: Omit<BuildEventParams, "ledgerId" | "seq" | "prevHash">): LedgerEvent {
  return buildEvent({ ...params, ledgerId, seq: 1, prevHash: ZERO_HASH });
}
