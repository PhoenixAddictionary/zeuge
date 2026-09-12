/**
 * receipt/verify — offline verification of a zeuge.bundle.v1. Every check is recomputation
 * over the bundle's own bytes; nothing here touches the machine that produced it (spec §4).
 *
 * Exit-code contract (this module returns a verdict; the CLI layer maps it to an exit code):
 *   0 clean · 1 gate finding (--require-witnessed, or the coverage/probe-DEAD gate) ·
 *   3 integrity failure (hash/signature/chain tamper).
 */

import { canonicalHash } from "../canon";
import { verifySignature, publicKeyFromSpkiB64 } from "./keys";
import { bundleSignatureMessage, rebindClaims } from "./bundle";
import { recomputeEventHash, LedgerEvent } from "../ledger/event";
import type { Bundle } from "./bundle";
import type { FindingSeverity } from "../severity";

export interface VerifyIssue {
  code: string;
  message: string;
  /** Set only for UNWITNESSED_GATED_CLAIM — an explicit gate the caller asked for via
   *  --require-witnessed is a "fault", not merely a risk or a review prompt. Every other issue
   *  here is an integrity failure (tamper, bad signature, broken chain), which is a distinct
   *  class from a severity and is never gated by --strict. */
  severity?: FindingSeverity;
}

export interface VerifyVerdict {
  ok: boolean;
  integrityFailure: boolean;
  gateFinding: boolean;
  issues: VerifyIssue[];
}

function checkBundleHash(bundle: Bundle, issues: VerifyIssue[]): void {
  const { bundle_sha256, signatures, ...rest } = bundle as unknown as Record<string, unknown>;
  const recomputed = canonicalHash(rest);
  if (recomputed !== bundle_sha256) {
    issues.push({ code: "BUNDLE_HASH_MISMATCH", message: "bundle hash mismatch — the bundle body was edited after signing" });
  }
  void signatures;
}

function checkSignatures(bundle: Bundle, issues: VerifyIssue[]): void {
  for (const sig of bundle.signatures ?? []) {
    if (sig.signed_sha256 !== bundle.bundle_sha256) {
      issues.push({ code: "SIGNATURE_INVALID", message: `signature invalid: signed_sha256 does not match bundle_sha256 (key ${sig.key_id})` });
      continue;
    }
    let publicKey;
    try {
      publicKey = publicKeyFromSpkiB64(sig.public_key_spki_b64);
    } catch {
      issues.push({ code: "SIGNATURE_INVALID", message: `signature invalid: unparseable public key (key ${sig.key_id})` });
      continue;
    }
    const message = bundleSignatureMessage(bundle.bundle_sha256);
    const ok = verifySignature(message, sig.signature_b64, publicKey);
    if (!ok) {
      issues.push({ code: "SIGNATURE_INVALID", message: `signature invalid (key ${sig.key_id})` });
    }
  }
}

function checkReferencedEvents(bundle: Bundle, issues: VerifyIssue[]): void {
  const events = (bundle.ledger?.referenced_events ?? []) as LedgerEvent[];
  const byId = new Map<string, LedgerEvent>();
  for (const e of events) {
    let recomputed: string;
    try {
      recomputed = recomputeEventHash(e);
    } catch {
      issues.push({ code: "REFERENCED_EVENT_INVALID", message: `embedded ledger event ${e?.event_id ?? "?"} does not hash-verify` });
      continue;
    }
    if (recomputed !== e.event_hash) {
      issues.push({ code: "REFERENCED_EVENT_INVALID", message: `embedded ledger event ${e.event_id} hash mismatch` });
      continue;
    }
    byId.set(e.event_id, e);
  }

  for (const w of bundle.witnesses ?? []) {
    if (w.kind !== "LEDGER_EVENT") continue;
    const event = byId.get(w.locator);
    if (!event) {
      issues.push({ code: "MISSING_REFERENCED_EVENT", message: `witness ${w.witness_id} references ledger event ${w.locator}, which is not embedded in this bundle` });
      continue;
    }
    if (event.event_hash !== w.content_sha256) {
      issues.push({ code: "MISSING_REFERENCED_EVENT", message: `witness ${w.witness_id} content_sha256 does not match its referenced event's hash` });
    }
  }
}

function checkRebinding(bundle: Bundle, issues: VerifyIssue[]): void {
  const recomputed = rebindClaims(bundle.claims, bundle.witnesses);
  for (let i = 0; i < bundle.claims.length; i++) {
    const stored = bundle.claims[i];
    const fresh = recomputed[i];
    if (stored.status !== fresh.status) {
      issues.push({
        code: "CLAIM_STATUS_MISMATCH",
        message: `claim ${stored.claim_id} status "${stored.status}" does not match what its own witnesses[] re-derive ("${fresh.status}")`,
      });
    }
  }
}

function checkCoverage(bundle: Bundle, gateIssues: VerifyIssue[]): void {
  // No coverage block, or a DEAD probe, is never "clean." Default posture here
  // (no --require-witnessed) is stricter — integrity failure — handled by the caller; this
  // function only records the finding itself.
  if (!bundle.coverage) {
    gateIssues.push({ code: "COVERAGE_MISSING", message: "bundle carries no coverage block — the claims it contains cannot be trusted to be complete" });
    return;
  }
  if (bundle.coverage.probe === "DEAD") {
    gateIssues.push({ code: "PROBE_DEAD", message: "bundle's coverage.probe is DEAD — its own positive control could not fire" });
  }
}

export interface VerifyOptions {
  requireWitnessed?: boolean;
}

const GATED_CLAIM_TYPES = ["done", "tests_pass"];

export function verifyBundle(bundle: Bundle, opts: VerifyOptions = {}): VerifyVerdict {
  const integrityIssues: VerifyIssue[] = [];
  const gateIssues: VerifyIssue[] = [];
  const coverageIssues: VerifyIssue[] = [];

  checkBundleHash(bundle, integrityIssues);
  checkSignatures(bundle, integrityIssues);
  checkReferencedEvents(bundle, integrityIssues);
  checkRebinding(bundle, integrityIssues);
  checkCoverage(bundle, coverageIssues);

  if (opts.requireWitnessed) {
    for (const c of bundle.claims ?? []) {
      if (GATED_CLAIM_TYPES.includes(c.claim_type) && c.status !== "WITNESSED") {
        gateIssues.push({ code: "UNWITNESSED_GATED_CLAIM", message: `claim ${c.claim_id} (${c.claim_type}) is ${c.status}, not WITNESSED`, severity: "fault" });
      }
    }
    // Under --require-witnessed, a missing/DEAD coverage block is explicitly a GATE finding
    // (exit 1), not an integrity failure.
    gateIssues.push(...coverageIssues);
  } else {
    // Without --require-witnessed, the same condition is still never "clean" — treated here
    // as an integrity failure (exit 3), reconciling A1's own severity with the general rule
    // that an unusable coverage claim is a stronger defect than "found nothing."
    integrityIssues.push(...coverageIssues);
  }

  const integrityFailure = integrityIssues.length > 0;
  const gateFinding = !integrityFailure && gateIssues.length > 0;

  return {
    ok: !integrityFailure && !gateFinding,
    integrityFailure,
    gateFinding,
    issues: [...integrityIssues, ...gateIssues],
  };
}
