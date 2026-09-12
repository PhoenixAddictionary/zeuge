/**
 * ids — opaque identifiers: /^[a-z][a-z0-9_-]{1,31}:[0-9a-f]{32,64}$/
 */

import { randomBytes } from "node:crypto";

export const ID_RE = /^[a-z][a-z0-9_-]{1,31}:[0-9a-f]{32,64}$/;

export function makeId(prefix: string): string {
  return `${prefix}:${randomBytes(16).toString("hex")}`;
}

export function isValidId(value: string, prefix?: string): boolean {
  if (!ID_RE.test(value)) return false;
  if (prefix && !value.startsWith(prefix + ":")) return false;
  return true;
}
