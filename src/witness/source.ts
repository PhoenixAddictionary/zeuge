/**
 * witness/source — the WitnessSource interface and the Witness shape (spec §4).
 * Matching a claim to a witness is conservative by design: no fuzzy matching, unmatched
 * means UNWITNESSED, not "probably fine."
 */

export type WitnessKind = "LEDGER_EVENT" | "TOOL_RECEIPT" | "FILE_HASH" | "COMMAND_RESULT" | "external_receipt";

export interface Witness {
  witness_id: string;
  kind: WitnessKind;
  source: string; // "zeuge.ledger" | "protect-mcp" | "fs"
  locator: string; // path | event_id | receipt_id
  content_sha256: string;
  observed_at: string;
  binds: string[]; // claim_types this witness can back
  trust_level: "L0" | "L1" | "L2" | "L3" | "L4";
  verification: "VERIFIED" | "UNVERIFIED" | "FAILED";
  /** Explicit signature-verified flag for external-receipt adapters that deliberately do NOT
   *  verify a signature (e.g. protect-mcp, out of scope for this package version). Absent for
   *  witness kinds where the concept does not apply (e.g. LEDGER_EVENT). */
  verified?: boolean;
  /** External-adapter fields that are TBD upstream and not (yet) interpreted — carried
   *  verbatim so nothing is silently discarded, never guessed at. */
  extra?: Record<string, unknown>;
  /** The session the underlying event/receipt was recorded under, when the source
   *  can determine one. Absent (not empty-string) for a source that cannot determine a
   *  session — receipt/bundle.ts's binding pass treats an absent session_id permissively
   *  (claim_type + time window only, the earlier behavior before session binding existed) and a
   *  PRESENT-but-different session_id as a hard exclusion, so a witness from a different session
   *  never backs a claim it merely resembles by claim_type. */
  session_id?: string;
}

export interface WitnessSource {
  id: string;
  collect(params: { session_id: string; since?: string; until?: string }): Promise<Witness[]>;
}
