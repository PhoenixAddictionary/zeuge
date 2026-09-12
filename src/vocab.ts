/**
 * vocab — frozen enums shared by the claim and ledger schemas.
 */

export const CLAIM_TYPES = ["tests_pass", "deployed", "fixed", "done", "file_exists", "command_ran", "other"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const ACTION_TYPES = [
  "TOOL_INVOCATION",
  "COMMAND_RUN",
  "FILE_WRITE",
  "CLAIM_EMITTED",
  "CLAIM_VERIFIED",
  "CLAIM_REFUTED",
  "LICENSE_CHECK",
  "SEGMENT_OPEN",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const OUTCOMES = ["PASS", "FAILED", "BLOCKED", "REFUSED", "NO_RESULT", "PENDING", "UNKNOWN", "NOT_APPLICABLE"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const CLAIM_STATUS = ["UNWITNESSED", "WITNESSED", "REFUTED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

export const TRUST_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const EVENT_FAMILIES = ["CLAIM", "ACTION", "RESULT", "VERIFICATION", "CONTROL", "LIFECYCLE"] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

export const ACTOR_KINDS = ["MODEL", "HUMAN", "TOOL", "SYSTEM"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
