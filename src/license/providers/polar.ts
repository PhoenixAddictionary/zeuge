/**
 * license/providers/polar — validates a licence key against Polar.sh, the merchant of record
 * and key issuer (spec §5).
 *
 * Endpoint contract: POST {host}/v1/customer-portal/license-keys/validate with JSON body
 * {key, organization_id}. Host is https://api.polar.sh in production, or
 * https://sandbox-api.polar.sh when POLAR_ENVIRONMENT=sandbox (process env, or the off-repo
 * .polar.local wire next to licence.json). The frozen spec this package implements
 * explicitly flagged Polar's exact endpoint, auth scheme, and request/response bodies as
 * "TBD — verify against current Polar documentation before implementing"; this adapter has
 * NOT been smoke-tested against a live Polar organization at implementation time. Treat it
 * as a best-effort shape to be confirmed against Polar's live API reference before it
 * gates a real purchase, not as a verified integration. The response body's exact fields
 * are interpreted conservatively: an explicit `status`/`valid` field maps to
 * VALID/REVOKED/INVALID; anything else observed on a non-2xx response is UNREACHABLE
 * (never silently treated as VALID).
 *
 * organization_id is NEVER hardcoded — it is resolved by the caller (license/state.ts) from
 * ZEUGE_POLAR_ORG or a previously-stored value in .zeuge/licence.json, and validate() itself
 * refuses (UNREACHABLE, no network call made) when none is supplied, rather than guessing one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sha256hex } from "../../canon";
import { keyIdFromSha256 } from "../provider";
import type { LicenseProvider, LicenseVerdict, ValidateParams } from "../provider";
import { resolveLicenseDir } from "../paths";

const POLAR_VALIDATE_PATH = "/v1/customer-portal/license-keys/validate";
export const POLAR_PRODUCTION_VALIDATE_URL = `https://api.polar.sh${POLAR_VALIDATE_PATH}`;
export const POLAR_SANDBOX_VALIDATE_URL = `https://sandbox-api.polar.sh${POLAR_VALIDATE_PATH}`;

export interface PolarProviderOptions {
  /** Injectable for tests; defaults to the global fetch (Node >=20 ships one). */
  fetchImpl?: typeof fetch;
  /** "sandbox" -> sandbox-api.polar.sh; anything else (including unset) -> api.polar.sh. */
  environment?: string;
}

function verdict(partial: Omit<LicenseVerdict, "schema" | "provider">): LicenseVerdict {
  return { schema: "zeuge.license.verdict.v1", provider: "polar", ...partial };
}

/** Production stays api.polar.sh. Only an explicit sandbox environment retargets the host. */
export function resolvePolarValidateUrl(environment?: string | null): string {
  return String(environment ?? "").trim().toLowerCase() === "sandbox"
    ? POLAR_SANDBOX_VALIDATE_URL
    : POLAR_PRODUCTION_VALIDATE_URL;
}

/**
 * File-based wire: .polar.local next to licence.json (resolved licence dir).
 * Reads POLAR_ENVIRONMENT only — never loads tokens or other secrets into process.env.
 */
function readPolarEnvironmentFromLocalFile(): string | undefined {
  try {
    const filePath = path.join(resolveLicenseDir().dir, ".polar.local");
    if (!fs.existsSync(filePath)) return undefined;
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== "POLAR_ENVIRONMENT") continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    /* unreadable wire file is not a hard failure — fall back to production */
  }
  return undefined;
}

function resolveEnvironment(opts: PolarProviderOptions): string | undefined {
  if (opts.environment != null && String(opts.environment).trim() !== "") return opts.environment;
  const fromEnv = process.env.POLAR_ENVIRONMENT;
  if (fromEnv != null && fromEnv.trim() !== "") return fromEnv;
  return readPolarEnvironmentFromLocalFile();
}

export function createPolarProvider(opts: PolarProviderOptions = {}): LicenseProvider {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);

  return {
    id: "polar",
    async validate(params: ValidateParams): Promise<LicenseVerdict> {
      const key_sha256 = sha256hex(params.key);
      const key_id = keyIdFromSha256(key_sha256);
      const checked_at = new Date().toISOString();
      const base = { key_id, key_sha256, checked_at, valid_until: null, grace_until: null, offline: false };

      if (!params.organizationId) {
        return verdict({ ...base, status: "UNREACHABLE", detail: "no organization_id configured (ZEUGE_POLAR_ORG or .zeuge/licence.json)" });
      }
      if (!fetchImpl) {
        return verdict({ ...base, status: "UNREACHABLE", detail: "no fetch implementation available in this runtime" });
      }

      const validateUrl = resolvePolarValidateUrl(resolveEnvironment(opts));

      let res: Response;
      try {
        res = await fetchImpl(validateUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: params.key, organization_id: params.organizationId }),
        });
      } catch (err) {
        return verdict({ ...base, status: "UNREACHABLE", detail: `network error: ${(err as Error).message}` });
      }

      if (res.status === 403 || res.status === 404) {
        return verdict({ ...base, status: "REVOKED", detail: `polar responded ${res.status}` });
      }
      if (!res.ok) {
        return verdict({ ...base, status: "UNREACHABLE", detail: `polar responded ${res.status}` });
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        return verdict({ ...base, status: "UNREACHABLE", detail: `unparseable polar response: ${(err as Error).message}` });
      }
      const b = (body ?? {}) as Record<string, unknown>;

      if (b.status === "granted" || b.valid === true) {
        const validUntil = typeof b.expires_at === "string" ? b.expires_at : null;
        return verdict({ ...base, status: "VALID", valid_until: validUntil, detail: "polar: granted" });
      }
      if (b.status === "revoked" || b.status === "disabled" || b.valid === false) {
        return verdict({ ...base, status: "REVOKED", detail: "polar: revoked" });
      }
      if (b.status === "expired") {
        return verdict({ ...base, status: "EXPIRED", detail: "polar: expired" });
      }
      const statusLabel = typeof b.status === "string" ? b.status : "unknown";
      return verdict({ ...base, status: "INVALID", detail: `polar: unrecognized status ${statusLabel}` });
    },
  };
}
