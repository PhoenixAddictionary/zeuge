/**
 * witness/sources/protect-mcp — adapter for an external "protect-mcp" receipt.
 *
 * Scope, exactly as instructed (coordinator override of the original spec's fuller mapping):
 * map ONLY tool_name, input_hash, output_hash, parent_receipt_id, public_key, signature.
 * Everything else in the upstream schema is TBD and carried verbatim under `extra`, never
 * interpreted or guessed at. This adapter does NOT verify the embedded signature — that is
 * out of scope here — so every witness it produces is kind:"external_receipt",
 * verified:false, verification:"UNVERIFIED". A future signature-checking pass can upgrade
 * verified/verification without changing this adapter's contract.
 */

import { makeId } from "../../ids";
import type { Witness } from "../source";

export interface ProtectMcpReceipt {
  tool_name?: unknown;
  input_hash?: unknown;
  output_hash?: unknown;
  parent_receipt_id?: unknown;
  public_key?: unknown;
  signature?: unknown;
  [key: string]: unknown;
}

export interface ProtectMcpWitness extends Witness {
  kind: "external_receipt";
  verified: false; // signature verification is explicitly out of scope for this adapter
  /** The six mapped fields, verbatim, whether or not each is used elsewhere on the witness —
   *  "map only those" means these are the interpreted ones, not that unused ones are dropped. */
  receipt: {
    tool_name?: unknown;
    input_hash?: unknown;
    output_hash?: unknown;
    parent_receipt_id?: unknown;
    public_key?: unknown;
    signature?: unknown;
  };
}

const MAPPED_FIELDS = ["tool_name", "input_hash", "output_hash", "parent_receipt_id", "public_key", "signature"];

export interface AdaptResult {
  witness: ProtectMcpWitness;
  missingRequired: string[];
}

/** A receipt this adapter can usefully witness anything with needs at least tool_name and one
 *  of input_hash/output_hash to bind to a claim_type and content hash — everything else
 *  (parent_receipt_id, public_key, signature) is carried through but not required. Required
 *  fields are named explicitly rather than silently defaulted, per the same "no claim without
 *  a named witness" discipline as the rest of zeuge. */
const REQUIRED_FIELDS = ["tool_name", "output_hash"];

export function adaptProtectMcpReceipt(receipt: ProtectMcpReceipt): AdaptResult {
  const missingRequired = REQUIRED_FIELDS.filter((f) => receipt[f] === undefined || receipt[f] === null || receipt[f] === "");

  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(receipt)) {
    if (!MAPPED_FIELDS.includes(key)) extra[key] = receipt[key];
  }

  const toolName = typeof receipt.tool_name === "string" ? receipt.tool_name : "unknown";
  const outputHash = typeof receipt.output_hash === "string" ? receipt.output_hash : "";

  const witness: ProtectMcpWitness = {
    witness_id: makeId("witness"),
    kind: "external_receipt",
    source: "protect-mcp",
    locator: typeof receipt.parent_receipt_id === "string" ? receipt.parent_receipt_id : makeId("receipt"),
    content_sha256: /^[0-9a-f]{64}$/i.test(outputHash) ? outputHash.toLowerCase() : "",
    observed_at: new Date().toISOString(),
    binds: [toolName],
    trust_level: "L1", // an unverified external claim of custody, not zeuge's own chain
    verification: "UNVERIFIED",
    verified: false,
    receipt: {
      tool_name: receipt.tool_name,
      input_hash: receipt.input_hash,
      output_hash: receipt.output_hash,
      parent_receipt_id: receipt.parent_receipt_id,
      public_key: receipt.public_key,
      signature: receipt.signature,
    },
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  return { witness, missingRequired };
}
