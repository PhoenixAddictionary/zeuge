/**
 * canon — RFC 8785 (JCS)-style canonicalisation and sha256 helpers.
 *
 * A simplified but correct-for-this-schema-family JCS: object keys sorted by UTF-16 code
 * unit (JS default string comparison, which is what JCS specifies), string values through
 * JSON.stringify (matches JCS escaping for the ASCII-safe, non-surrogate content every zeuge
 * schema uses), and integers via Number.prototype.toString(). No float formatting edge cases
 * are handled beyond that, because no zeuge schema field is a non-integer float — durations
 * and counts are integers, everything else is a string, boolean, null, array, or object.
 */

import { createHash } from "node:crypto";

export const ZERO_HASH = "0".repeat(64);

/** True for a value JSON.stringify treats as "not representable" — undefined, a function, or
 *  a symbol. JSON.stringify OMITS such an object property entirely and renders such an ARRAY
 *  element as null. An earlier version rendered these as the string "null" in BOTH positions, so
 *  an object with an undefined-valued property canonicalized to a byte string JSON.stringify
 *  would never reproduce — a write-then-read-back round trip (write via JSON.stringify, which
 *  drops the key; read back and recompute the hash from the parsed, now key-less object) silently
 *  changed the hash. This function closes that write/read hash-mismatch class by treating both
 *  positions the same way. */
function isJsonUnrepresentable(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

function canonicalizeValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canon: non-finite number cannot be canonicalised");
    return Object.is(v, -0) ? "0" : v.toString();
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((el) => (isJsonUnrepresentable(el) ? "null" : canonicalizeValue(el))).join(",") + "]";
  }
  if (isJsonUnrepresentable(v)) return "null"; // only reachable for a top-level call
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => !isJsonUnrepresentable(obj[k]))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeValue(obj[k])).join(",") + "}";
  }
  throw new Error(`canon: unsupported value type ${typeof v}`);
}

export function canonicalize(value: unknown): string {
  return canonicalizeValue(value);
}

export function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256hex(canonicalize(value));
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, (m) => {
    // Date#toISOString already gives millisecond precision with a trailing Z; keep as-is.
    return m;
  });
}
