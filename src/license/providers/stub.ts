/**
 * license/providers/stub — a deterministic, network-free LicenseProvider for tests. Never
 * touches the network; the caller supplies exactly the verdict (or a function of the key) it
 * wants returned, so a test can exercise VALID/REVOKED/EXPIRED/INVALID/UNREACHABLE paths
 * without stubbing fetch.
 */

import { sha256hex } from "../../canon";
import { keyIdFromSha256 } from "../provider";
import type { LicenseProvider, LicenseVerdict, LicenseVerdictStatus, ValidateParams } from "../provider";

export type StubVerdicts = LicenseVerdictStatus | ((params: ValidateParams) => LicenseVerdictStatus);

export interface StubProviderOptions {
  /** Fixed status, or a function of the validate() params, to return every call. */
  status: StubVerdicts;
  valid_until?: string | null;
  detail?: string;
}

export function createStubProvider(opts: StubProviderOptions): LicenseProvider {
  return {
    id: "stub",
    async validate(params: ValidateParams): Promise<LicenseVerdict> {
      const status = typeof opts.status === "function" ? opts.status(params) : opts.status;
      const key_sha256 = sha256hex(params.key);
      return {
        schema: "zeuge.license.verdict.v1",
        status,
        provider: "stub",
        key_id: keyIdFromSha256(key_sha256),
        key_sha256,
        checked_at: new Date().toISOString(),
        valid_until: opts.valid_until ?? null,
        grace_until: null,
        offline: false,
        detail: opts.detail ?? `stub: ${status}`,
      };
    },
  };
}
