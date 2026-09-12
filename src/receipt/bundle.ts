/**
 * receipt/bundle — assembles and signs a zeuge.bundle.v1 (spec §4).
 *
 * Binding implements the spec's full three-part test — `binds` contains the
 * claim_type, AND session matches (permissively, when either side's session is unknown — see
 * witness/binding.ts's isUnknownSession — or exactly, when both are known), AND the witness's
 * observed_at falls inside a time window around the claim's occurred_at (30 minutes, symmetric
 * — a witness can precede or follow the claim statement within a turn). The actual predicate
 * (`witnessBacksClaim`) now lives in witness/binding.ts, shared with the live Stop hook
 * (claim/hook.ts) — this caught a second, subtly different copy of this logic in the hook
 * that had never been wired in at all, so this module keeping its own copy risked exactly the drift
 * that caused that bug in the first place.
 * The bundle also carries the same `coverage` block the claim run itself
 * produced, because a report/verify pass downstream needs to know whether the detector that
 * produced these claims could even fire.
 */

import * as fs from "node:fs";
import { canonicalHash, ZERO_HASH } from "../canon";
import { makeId } from "../ids";
import { loadOrCreateKeypair, publicKeySpkiB64, signMessage } from "./keys";
import type { ClaimRecord } from "../claim/record";
import type { Witness } from "../witness/source";
import type { CoverageBlock } from "../claim/probe";
import { CLAIM_TYPES } from "../vocab";
import { witnessBacksClaim } from "../witness/binding";

export interface LedgerSummary {
  ledger_id: string;
  head_hash: string;
  event_count: number;
  segments: Array<{ name: string; head_hash: string }>;
}

export interface BuildBundleParams {
  sessionId: string;
  agent: Record<string, unknown>;
  subject: { repo_head: string; branch_ref: string; dirty: boolean; dirty_paths_sha256: string | null };
  claims: ClaimRecord[];
  witnesses: Witness[];
  ledger: LedgerSummary;
  coverage: CoverageBlock;
  /** The exact ledger events backing any LEDGER_EVENT witness, embedded so verify() can run
   *  fully offline against the bundle bytes alone (spec: "no access to producer machine"). */
  referencedLedgerEvents: unknown[];
}

export interface Bundle {
  schema: "zeuge.bundle.v1";
  bundle_id: string;
  produced_at: string;
  subject: BuildBundleParams["subject"];
  session: { session_id: string; agent: Record<string, unknown> };
  ledger: LedgerSummary & { referenced_events: unknown[] };
  coverage: CoverageBlock;
  claims: ClaimRecord[];
  witnesses: Witness[];
  summary: { claims_total: number; witnessed: number; unwitnessed: number; refuted: number; min_trust_level: string };
  schema_fingerprints: { claim: string; ledger_event: string; bundle: string };
  bundle_sha256: string;
  signatures: Array<{
    alg: "ed25519";
    key_id: string;
    public_key_spki_b64: string;
    signed_sha256: string;
    signature_b64: string;
    signed_at: string;
  }>;
}

const TRUST_ORDER = ["L0", "L1", "L2", "L3", "L4"];

/** Re-binds every claim to the witness set using `witnessBacksClaim`. Pure function so `verify`
 *  can call the IDENTICAL logic to re-derive status from a bundle's own witnesses and catch a
 *  claim whose status was hand-edited. */
export function rebindClaims(claims: ClaimRecord[], witnesses: Witness[]): ClaimRecord[] {
  return claims.map((c) => {
    if (c.status === "REFUTED") return c; // refutation (its own refutation ledger) is out of scope here; never silently overwritten
    const matches = witnesses.filter((w) => witnessBacksClaim(w, c));
    if (matches.length === 0) return { ...c, status: "UNWITNESSED", witnesses: [] };
    return { ...c, status: "WITNESSED", witnesses: matches.map((w) => w.witness_id) };
  });
}

function computeSummary(claims: ClaimRecord[]) {
  const witnessed = claims.filter((c) => c.status === "WITNESSED").length;
  const unwitnessed = claims.filter((c) => c.status === "UNWITNESSED").length;
  const refuted = claims.filter((c) => c.status === "REFUTED").length;
  const minTrust = claims.length === 0 ? "L0" : claims.reduce((min, c) => (TRUST_ORDER.indexOf(c.trust_level) < TRUST_ORDER.indexOf(min) ? c.trust_level : min), "L4");
  return { claims_total: claims.length, witnessed, unwitnessed, refuted, min_trust_level: minTrust };
}

function schemaFingerprints() {
  return {
    claim: canonicalHash({ schema: "zeuge.claim.v1", fields: ["claim_id", "session_id", "agent", "occurred_at", "claim_type", "statement_sha256", "span", "detector", "witnesses", "status", "outcome", "trust_level", "redaction"] }),
    ledger_event: canonicalHash({ schema: "zeuge.ledger.event.v1", fields: ["ledger_id", "seq", "recorded_at", "prev_hash", "event_id", "event_family", "action_type", "outcome", "trust_level", "actor", "body", "body_sha256", "event_hash"] }),
    bundle: canonicalHash({ schema: "zeuge.bundle.v1", claim_types: CLAIM_TYPES }),
  };
}

export function buildBundle(params: BuildBundleParams): Omit<Bundle, "bundle_sha256" | "signatures"> {
  const boundClaims = rebindClaims(params.claims, params.witnesses);
  return {
    schema: "zeuge.bundle.v1",
    bundle_id: makeId("bundle"),
    produced_at: new Date().toISOString(),
    subject: params.subject,
    session: { session_id: params.sessionId, agent: params.agent },
    ledger: { ...params.ledger, referenced_events: params.referencedLedgerEvents },
    coverage: params.coverage,
    claims: boundClaims,
    witnesses: params.witnesses,
    summary: computeSummary(boundClaims),
    schema_fingerprints: schemaFingerprints(),
  };
}

/** Domain-separated signature input per spec: "zeuge:bundle:v1\n" + bundle_sha256. */
export function bundleSignatureMessage(bundleSha256: string): Buffer {
  return Buffer.from("zeuge:bundle:v1\n" + bundleSha256, "utf8");
}

export function finalizeBundle(unsigned: Omit<Bundle, "bundle_sha256" | "signatures">, opts: { sign?: boolean; zeugeDir?: string } = {}): Bundle {
  const bundle_sha256 = canonicalHash(unsigned);
  const signatures: Bundle["signatures"] = [];

  if (opts.sign) {
    const zeugeDir = opts.zeugeDir ?? ".zeuge";
    const { publicKey, privateKey } = loadOrCreateKeypair(zeugeDir);
    const message = bundleSignatureMessage(bundle_sha256);
    signatures.push({
      alg: "ed25519",
      key_id: makeId("key"),
      public_key_spki_b64: publicKeySpkiB64(publicKey),
      signed_sha256: bundle_sha256,
      signature_b64: signMessage(message, privateKey),
      signed_at: new Date().toISOString(),
    });
  }

  return { ...unsigned, bundle_sha256, signatures };
}

export function writeBundle(bundle: Bundle, outPath: string): void {
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
}

export { ZERO_HASH };
