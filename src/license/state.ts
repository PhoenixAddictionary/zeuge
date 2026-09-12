/**
 * license/state — the local key store (.zeuge/licence.json), organization_id resolution, and
 * the resolved LicenseState machine (VALID | GRACE | EXPIRED | REVOKED | UNKNOWN) gated
 * commands actually branch on.
 *
 * Two entry points matter to callers:
 *   - `refreshLicenseStatus` — used ONLY by `zeuge licence status` (and `licence set`'s own
 *     verification, if it chooses to check immediately). This is the ONLY place in the whole
 *     package, besides `set`, that may make a network call.
 *   - `resolveLocalLicenseState` — used by every Pro-gated command's own gate (`report --html`,
 *     `verify --require-witnessed`). It NEVER calls a provider; it only reads the local key
 *     file and the HMAC-checked cache, does grace-window arithmetic, and may
 *     advance the cache's clock-rollback high-water mark — a local file write, still no network
 *     call. This is what makes "no network call anywhere except licence status/set" true by
 *     construction — a gate that physically cannot reach a provider cannot phone home even if a
 *     future edit forgot to check a flag.
 *
 * VALID vs GRACE is deliberately never conflated: VALID is reported only by
 * `refreshLicenseStatus` in the instant a live provider call itself returned VALID. Every other
 * read (including the very next command, and always for the local gate) is, honestly, relying
 * on a CACHED answer rather than a fresh one — so it resolves to GRACE (still within the
 * 14-day window) or EXPIRED (past it), never a re-asserted VALID it did not itself confirm.
 * Both VALID and GRACE unlock a Pro-gated command; only the label differs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LicenseProvider, LicenseVerdict } from "./provider";
import {
  computeGraceUntil,
  isWithinGrace,
  readLicenseCache,
  writeLicenseCache,
  LicenseCacheRecord,
  effectiveNow,
  isClockMovedBackward,
  advanceMaxObservedAt,
} from "./cache";

export type LicenseState = "VALID" | "GRACE" | "EXPIRED" | "REVOKED" | "UNKNOWN";

export interface LicenseKeyFile {
  schema: "zeuge.licence.key.v1";
  key: string;
  organization_id?: string;
}

function keyFilePath(zeugeDir: string): string {
  return path.join(zeugeDir, "licence.json");
}

export function setLicenseKey(zeugeDir: string, key: string, organizationId?: string): void {
  fs.mkdirSync(zeugeDir, { recursive: true });
  const record: LicenseKeyFile = { schema: "zeuge.licence.key.v1", key, ...(organizationId ? { organization_id: organizationId } : {}) };
  fs.writeFileSync(keyFilePath(zeugeDir), JSON.stringify(record), { mode: 0o600 });
  try {
    fs.chmodSync(keyFilePath(zeugeDir), 0o600);
  } catch {
    /* best-effort on platforms where chmod is a no-op */
  }
}

export function readLicenseKey(zeugeDir: string): LicenseKeyFile | null {
  try {
    const raw = fs.readFileSync(keyFilePath(zeugeDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.key === "string") return parsed as LicenseKeyFile;
    return null;
  } catch {
    return null;
  }
}

/** organization_id resolution order, exactly as specified: env ZEUGE_POLAR_ORG first, then
 *  whatever was stored alongside the key on `licence set`. Never a hardcoded default. */
export function resolveOrganizationId(zeugeDir: string): string | undefined {
  const fromEnv = process.env.ZEUGE_POLAR_ORG;
  if (fromEnv) return fromEnv;
  return readLicenseKey(zeugeDir)?.organization_id;
}

/** Pure function of a cache record (or its absence) and the current time — no I/O, no network.
 *  `justConfirmed` is true only in the instant a live provider call itself said VALID; every
 *  other caller (including every Pro-gated command's gate) omits it and gets an honestly-
 *  labeled GRACE/EXPIRED instead of a re-asserted VALID it did not itself check. */
export function resolveState(cache: LicenseCacheRecord | null, opts: { justConfirmed?: boolean; now?: number } = {}): LicenseState {
  const now = opts.now ?? Date.now();
  if (!cache) return "UNKNOWN";
  if (cache.status === "VALID") {
    if (opts.justConfirmed) return "VALID";
    return isWithinGrace(cache.grace_until, now) ? "GRACE" : "EXPIRED";
  }
  if (cache.status === "REVOKED") return "REVOKED";
  // EXPIRED, INVALID, or (should it ever be persisted) UNREACHABLE all fail closed as EXPIRED —
  // none of them is evidence of current entitlement.
  return "EXPIRED";
}

export interface GateResult {
  state: LicenseState;
  blocked: boolean;
  /** Set when blocked (EXPIRED/REVOKED/UNKNOWN) or when allowed-via-grace — the one stderr line
   *  a Pro command should print either way, per spec. */
  message?: string;
  /** True exactly when the system clock has moved backward since this cache was
   *  last checked. Never turns a paying customer's remaining grace into a lockout — it only
   *  means grace was evaluated against the last-known-good time instead of the (untrustworthy)
   *  raw clock reading. Named `CLOCK_MOVED_BACKWARD` in `message` and in `licence status`. */
  clockMovedBackward?: boolean;
}

const CLOCK_ROLLBACK_NOTE =
  " (CLOCK_MOVED_BACKWARD: system clock reads earlier than a previously observed time — grace held steady, not extended)";

/** The local-only gate every Pro-gated command calls. No network call, ever — reads only the
 *  key file (to know whether a key exists / to HMAC-verify the cache against it) and the cache.
 *
 * It now ALSO does one small local write — advancing the cache's
 * `max_observed_at` high-water mark when this check's `now` is the most-forward time seen so
 * far. That write never touches the network, never lowers the mark, and is the only way the
 * clock-rollback defense stays effective for a user who only ever runs Pro-gated commands and
 * never calls `zeuge licence status` again after the first `licence set` — without it, the
 * high-water mark would stay pinned at the original validation time forever, and rolling the
 * clock back to just after that moment would show full grace indefinitely. */
export function resolveLocalLicenseState(zeugeDir: string, now = Date.now()): GateResult {
  const keyFile = readLicenseKey(zeugeDir);
  if (!keyFile) {
    return { state: "UNKNOWN", blocked: true, message: "no licence key set — run `zeuge licence set <key>`" };
  }
  const read = readLicenseCache(zeugeDir, keyFile.key);
  if (!read.ok) {
    const reason = read.reason === "TAMPERED" ? "licence cache failed its integrity check" : "licence never validated — run `zeuge licence status`";
    return { state: "EXPIRED", blocked: true, message: reason };
  }

  const clockMovedBackward = isClockMovedBackward(read.cache.max_observed_at, now);
  const effNow = effectiveNow(read.cache.max_observed_at, now);
  const advanced = advanceMaxObservedAt(read.cache.max_observed_at, now);
  if (advanced !== read.cache.max_observed_at) {
    writeLicenseCache(zeugeDir, keyFile.key, { ...read.cache, max_observed_at: advanced });
  }

  const state = resolveState(read.cache, { now: effNow });
  const clockNote = clockMovedBackward ? CLOCK_ROLLBACK_NOTE : "";
  if (state === "GRACE") {
    const daysLeft = read.cache.grace_until ? Math.max(0, Math.ceil((Date.parse(read.cache.grace_until) - effNow) / (24 * 60 * 60 * 1000))) : 0;
    return { state, blocked: false, message: `licence offline grace: ${daysLeft} day(s) remaining${clockNote}`, clockMovedBackward };
  }
  if (state === "VALID") return { state, blocked: false, clockMovedBackward };
  const messages: Record<LicenseState, string> = {
    VALID: "",
    GRACE: "",
    EXPIRED: "licence expired — run `zeuge licence status`",
    REVOKED: "licence revoked",
    UNKNOWN: "no licence key set",
  };
  return { state, blocked: true, message: `${messages[state]}${clockNote}`, clockMovedBackward };
}

export interface RefreshResult {
  state: LicenseState;
  verdict: LicenseVerdict;
  /** True when `licence status` resolved from a cached/offline fallback (a live
   *  UNREACHABLE) whose grace math detected the system clock reading earlier than a previously
   *  observed time. Always false when a live provider call itself returned VALID/REVOKED/
   *  EXPIRED/INVALID — those are fresh evidence, not clock-dependent cache arithmetic. */
  clockMovedBackward: boolean;
}

/** The ONLY function (besides a provider's own validate()) that makes a network call. Called by
 *  `zeuge licence status`. ZEUGE_OFFLINE=1 skips the call entirely and resolves from the
 *  existing cache alone (same math the local gate uses). */
export function refreshLicenseStatus(zeugeDir: string, provider: LicenseProvider): Promise<RefreshResult> | RefreshResult {
  const keyFile = readLicenseKey(zeugeDir);
  if (!keyFile) {
    return { state: "UNKNOWN", verdict: offlineSkippedVerdict("no licence key set"), clockMovedBackward: false };
  }
  if (process.env.ZEUGE_OFFLINE === "1") {
    const read = readLicenseCache(zeugeDir, keyFile.key);
    if (!read.ok) {
      return { state: "UNKNOWN", verdict: offlineSkippedVerdict("ZEUGE_OFFLINE=1: skipped network check, resolved from cache"), clockMovedBackward: false };
    }
    const now = Date.now();
    const clockMovedBackward = isClockMovedBackward(read.cache.max_observed_at, now);
    const effNow = effectiveNow(read.cache.max_observed_at, now);
    const advanced = advanceMaxObservedAt(read.cache.max_observed_at, now);
    if (advanced !== read.cache.max_observed_at) {
      writeLicenseCache(zeugeDir, keyFile.key, { ...read.cache, max_observed_at: advanced });
    }
    const state = resolveState(read.cache, { now: effNow });
    return { state, verdict: offlineSkippedVerdict("ZEUGE_OFFLINE=1: skipped network check, resolved from cache"), clockMovedBackward };
  }

  const organizationId = resolveOrganizationId(zeugeDir);
  return provider.validate({ key: keyFile.key, organizationId }).then((verdict) => {
    return applyVerdict(zeugeDir, keyFile.key, provider.id, verdict);
  });
}

function offlineSkippedVerdict(detail: string): LicenseVerdict {
  return {
    schema: "zeuge.license.verdict.v1",
    status: "UNREACHABLE",
    provider: "none",
    key_id: "key:00000000000000000000000000000000",
    key_sha256: "0".repeat(64),
    checked_at: new Date().toISOString(),
    valid_until: null,
    grace_until: null,
    offline: true,
    detail,
  };
}

function applyVerdict(zeugeDir: string, key: string, providerId: string, verdict: LicenseVerdict): RefreshResult {
  // Carry the high-water mark forward across every branch below (never reset it to nothing on
  // a fresh write) — a live check's own checked_at is itself evidence of "at least this much
  // real time has passed," so it can only ever raise the mark, never lower it.
  const priorRead = readLicenseCache(zeugeDir, key);
  const priorMax = priorRead.ok ? priorRead.cache.max_observed_at : undefined;
  const checkedAtMs = Date.parse(verdict.checked_at);
  const carriedMax = Number.isFinite(checkedAtMs) ? advanceMaxObservedAt(priorMax, checkedAtMs) : priorMax;

  if (verdict.status === "VALID") {
    const grace_until = computeGraceUntil(verdict.checked_at);
    writeLicenseCache(zeugeDir, key, {
      provider: providerId,
      key_sha256: verdict.key_sha256,
      status: "VALID",
      validated_at: verdict.checked_at,
      expires_at: verdict.valid_until,
      grace_until,
      max_observed_at: carriedMax,
    });
    return { state: "VALID", verdict, clockMovedBackward: false };
  }

  if (verdict.status === "REVOKED" || verdict.status === "INVALID") {
    // "REVOKED/INVALID take effect at once and clear the cache — a revoked key gets no grace."
    // Overwriting with grace_until:null (rather than deleting the file outright) means the
    // local gate can later report the SPECIFIC reason (REVOKED) instead of degrading to the
    // more ambiguous "never validated" EXPIRED message.
    writeLicenseCache(zeugeDir, key, {
      provider: providerId,
      key_sha256: verdict.key_sha256,
      status: "REVOKED",
      validated_at: verdict.checked_at,
      expires_at: null,
      grace_until: null,
      max_observed_at: carriedMax,
    });
    return { state: "REVOKED", verdict, clockMovedBackward: false };
  }

  if (verdict.status === "EXPIRED") {
    writeLicenseCache(zeugeDir, key, {
      provider: providerId,
      key_sha256: verdict.key_sha256,
      status: "EXPIRED",
      validated_at: verdict.checked_at,
      expires_at: null,
      grace_until: null,
      max_observed_at: carriedMax,
    });
    return { state: "EXPIRED", verdict, clockMovedBackward: false };
  }

  // UNREACHABLE: fall back to whatever the existing cache already says, applying grace math —
  // this is the ONLY path that can resolve to GRACE from inside `licence status` itself. The
  // clock-rollback defense applies here exactly as it does to the local gate: use effectiveNow for the grace check,
  // and persist the high-water mark forward so a subsequently rolled-back clock cannot re-widen
  // the window that this genuine check just observed.
  if (!priorRead.ok) return { state: "UNKNOWN", verdict, clockMovedBackward: false };
  const now = Date.now();
  const clockMovedBackward = isClockMovedBackward(priorRead.cache.max_observed_at, now);
  const effNow = effectiveNow(priorRead.cache.max_observed_at, now);
  const advanced = advanceMaxObservedAt(priorRead.cache.max_observed_at, now);
  if (advanced !== priorRead.cache.max_observed_at) {
    writeLicenseCache(zeugeDir, key, { ...priorRead.cache, max_observed_at: advanced });
  }
  const state = resolveState(priorRead.cache, { now: effNow });
  return { state, verdict, clockMovedBackward };
}
