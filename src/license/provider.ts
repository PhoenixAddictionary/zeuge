/**
 * license/provider — the LicenseProvider interface and the zeuge.license.verdict.v1 shape
 * (spec §5). A provider's job is narrow: given a key (and optionally a product/instance/org
 * id), return exactly one of five raw statuses. Everything else — caching, the 14-day offline
 * grace window, and the higher-level VALID/GRACE/EXPIRED/REVOKED/UNKNOWN state a command
 * actually gates on — lives in license/cache.ts and license/state.ts, never inside a provider.
 */

export type LicenseVerdictStatus = "VALID" | "INVALID" | "REVOKED" | "EXPIRED" | "UNREACHABLE";

export interface LicenseVerdict {
  schema: "zeuge.license.verdict.v1";
  status: LicenseVerdictStatus;
  provider: string;
  key_id: string;
  key_sha256: string;
  checked_at: string;
  valid_until: string | null;
  grace_until: string | null;
  offline: boolean;
  detail: string;
}

export interface ValidateParams {
  key: string;
  product_id?: string;
  instance_id?: string;
  organizationId?: string;
}

export interface LicenseProvider {
  id: string;
  validate(params: ValidateParams): Promise<LicenseVerdict>;
}

/** A stable key_id derived from key_sha256 (same key -> same id every call), never a fresh
 *  random id per validate() — matches the ids.ts opaque-id format (`key:<32-64 hex>`). */
export function keyIdFromSha256(keySha256: string): string {
  return `key:${keySha256.slice(0, 32)}`;
}

