import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createStubProvider } from "../src/license/providers/stub";
import { createPolarProvider, resolvePolarValidateUrl, POLAR_PRODUCTION_VALIDATE_URL, POLAR_SANDBOX_VALIDATE_URL } from "../src/license/providers/polar";
import { setLicenseKey, refreshLicenseStatus, resolveLocalLicenseState, resolveState, RefreshResult } from "../src/license/state";
import { writeLicenseCache, readLicenseCache, computeGraceUntil, GRACE_MS, effectiveNow, isClockMovedBackward, advanceMaxObservedAt } from "../src/license/cache";
import { resolveLicenseDir, defaultUserConfigDir, licenseDirWarning, isInsideGitWorkTree, legacyLicenseKeyPath, ZEUGE_LICENSE_DIR_ENV } from "../src/license/paths";
import { main } from "../src/cli";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpZeugeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-license-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge");
}

const KEY = "zeuge-test-key-1234567890";

describe("license: valid", () => {
  it("a VALID provider verdict caches status VALID with a 14-day grace_until, and reports state VALID", async () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const provider = createStubProvider({ status: "VALID" });
    const result = (await refreshLicenseStatus(zeugeDir, provider)) as RefreshResult;
    expect(result.state).toBe("VALID");

    const cacheRead = readLicenseCache(zeugeDir, KEY);
    expect(cacheRead.ok).toBe(true);
    if (!cacheRead.ok) return;
    expect(cacheRead.cache.status).toBe("VALID");
    expect(cacheRead.cache.grace_until).toBe(computeGraceUntil(cacheRead.cache.validated_at));

    const gate = resolveLocalLicenseState(zeugeDir);
    expect(gate.blocked).toBe(false);
  });
});

describe("license: revoked", () => {
  it("a REVOKED provider verdict takes effect at once, with no grace, and blocks the gate", async () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    // Establish a VALID cache first, to prove revocation actually CLEARS the prior grace credit.
    await refreshLicenseStatus(zeugeDir, createStubProvider({ status: "VALID" }));

    const result = (await refreshLicenseStatus(zeugeDir, createStubProvider({ status: "REVOKED" }))) as RefreshResult;
    expect(result.state).toBe("REVOKED");

    const cacheRead = readLicenseCache(zeugeDir, KEY);
    expect(cacheRead.ok).toBe(true);
    if (!cacheRead.ok) return;
    expect(cacheRead.cache.status).toBe("REVOKED");
    expect(cacheRead.cache.grace_until).toBeNull();

    const gate = resolveLocalLicenseState(zeugeDir);
    expect(gate.state).toBe("REVOKED");
    expect(gate.blocked).toBe(true);
  });
});

describe("license: expired-in-grace / expired-out-of-grace", () => {
  it("a cached VALID record, 10 days old (within the 14-day window), resolves GRACE and does not block", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    const gate = resolveLocalLicenseState(zeugeDir);
    expect(gate.state).toBe("GRACE");
    expect(gate.blocked).toBe(false);
    expect(gate.message).toMatch(/grace/);
  });

  it("a cached VALID record, 20 days old (past the 14-day window), resolves EXPIRED and blocks", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    const gate = resolveLocalLicenseState(zeugeDir);
    expect(gate.state).toBe("EXPIRED");
    expect(gate.blocked).toBe(true);
  });

  it("resolveState's pure grace math: exactly at grace_until is still within grace; one ms past is not", () => {
    const validatedAt = new Date(0).toISOString();
    const graceUntil = computeGraceUntil(validatedAt);
    const atBoundary = Date.parse(graceUntil);
    const cache = { schema: "zeuge.license.cache.v1" as const, provider: "stub", key_sha256: "a".repeat(64), status: "VALID" as const, validated_at: validatedAt, expires_at: null, grace_until: graceUntil };
    expect(resolveState(cache, { now: atBoundary })).toBe("GRACE");
    expect(resolveState(cache, { now: atBoundary + 1 })).toBe("EXPIRED");
    expect(GRACE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("license: tampered cache", () => {
  it("a hand-edited cache (e.g. extending grace_until) fails its HMAC check and is treated as EXPIRED, never trusted", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // already past grace
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    // Hand-edit: extend grace_until far into the future WITHOUT recomputing the HMAC (exactly
    // what an attacker without the real key would do — they can edit the file but not the MAC).
    const cachePath = path.join(zeugeDir, "licence-cache.json");
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    raw.grace_until = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(raw), "utf8");

    const read = readLicenseCache(zeugeDir, KEY);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("TAMPERED");

    const gate = resolveLocalLicenseState(zeugeDir);
    expect(gate.state).toBe("EXPIRED");
    expect(gate.blocked).toBe(true);
  });

  it("without the real key, a fresh HMAC cannot be forged (attacker does not control the key file)", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    writeLicenseCache(zeugeDir, KEY, { provider: "stub", key_sha256: "b".repeat(64), status: "VALID", validated_at: new Date().toISOString(), expires_at: null, grace_until: computeGraceUntil(new Date().toISOString()) });
    const wrongKeyRead = readLicenseCache(zeugeDir, "a-completely-different-key");
    expect(wrongKeyRead.ok).toBe(false);
  });
});

describe("license: no-phone-home", () => {
  it("lint, claim detect, ledger verify, and plain verify (no --require-witnessed) never call fetch", () => {
    const originalFetch = (global as unknown as { fetch?: typeof fetch }).fetch;
    let calls = 0;
    (global as unknown as { fetch: typeof fetch }).fetch = (() => {
      calls++;
      throw new Error("no command below should ever call fetch");
    }) as typeof fetch;

    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-nophone-"));
      tmpDirs.push(dir);
      const cwdBefore = process.cwd();
      try {
        process.chdir(dir);
        const io = { write: () => {}, writeErr: () => {} };
        main(["node", "zeuge", "lint", dir, "--json"], io);
        main(["node", "zeuge", "claim", "detect", "--stdin", "--json"], { ...io, readStdin: () => "All tests pass." });
        fs.writeFileSync(path.join(dir, "bundle.json"), JSON.stringify({ schema: "zeuge.bundle.v1", claims: [], witnesses: [], bundle_sha256: "x", signatures: [] }));
        main(["node", "zeuge", "verify", path.join(dir, "bundle.json"), "--json"], io);
      } finally {
        process.chdir(cwdBefore);
      }
    } finally {
      (global as unknown as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    expect(calls).toBe(0);
  });

  it("`report` and `verify --require-witnessed` are Pro-gated (exit 4) with no licence key set, and STILL never call fetch", () => {
    const originalFetch = (global as unknown as { fetch?: typeof fetch }).fetch;
    let calls = 0;
    (global as unknown as { fetch: typeof fetch }).fetch = (() => {
      calls++;
      throw new Error("the gate must never phone home");
    }) as typeof fetch;

    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-nophone-gate-"));
      tmpDirs.push(dir);
      const cwdBefore = process.cwd();
      // The gate no longer resolves its licence dir from a bare `<cwd>/.zeuge` —
      // pin it to this test's own tmp dir via the documented override so this test stays
      // hermetic (isolated from whatever the real per-user config directory holds on the
      // machine actually running the suite) instead of accidentally reading/writing it.
      const licenseDirBefore = process.env.ZEUGE_LICENSE_DIR;
      try {
        process.chdir(dir);
        process.env.ZEUGE_LICENSE_DIR = path.join(dir, ".zeuge");
        const out: string[] = [];
        const err: string[] = [];
        const io = { write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
        const bundlePath = path.join(dir, "bundle.json");
        fs.writeFileSync(bundlePath, JSON.stringify({ schema: "zeuge.bundle.v1", claims: [], witnesses: [], coverage: { turns_scanned: 0, statements_total: 0, statements_classified: 0, statements_matched: {}, probe: "ALIVE" }, bundle_sha256: "x", signatures: [] }));

        const reportCode = main(["node", "zeuge", "report", bundlePath, "--html", path.join(dir, "out.html")], io);
        expect(reportCode).toBe(4);

        const verifyCode = main(["node", "zeuge", "verify", bundlePath, "--require-witnessed"], io);
        expect(verifyCode).toBe(4);
      } finally {
        process.chdir(cwdBefore);
        if (licenseDirBefore === undefined) delete process.env.ZEUGE_LICENSE_DIR;
        else process.env.ZEUGE_LICENSE_DIR = licenseDirBefore;
      }
    } finally {
      (global as unknown as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    expect(calls).toBe(0);
  });
});

describe("license/providers/polar — adapter (network stubbed via injectable fetchImpl)", () => {
  function fakeFetch(status: number, body: unknown): typeof fetch {
    return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response) as typeof fetch;
  }

  it("refuses (UNREACHABLE, no call attempted) when no organization_id is configured", async () => {
    let called = false;
    const provider = createPolarProvider({ fetchImpl: (async () => { called = true; throw new Error("must not be called"); }) as typeof fetch });
    const verdict = await provider.validate({ key: KEY });
    expect(verdict.status).toBe("UNREACHABLE");
    expect(called).toBe(false);
  });

  it("maps a granted response to VALID", async () => {
    const provider = createPolarProvider({ fetchImpl: fakeFetch(200, { status: "granted", expires_at: "2027-01-01T00:00:00.000Z" }) });
    const verdict = await provider.validate({ key: KEY, organizationId: "org_123" });
    expect(verdict.status).toBe("VALID");
    expect(verdict.valid_until).toBe("2027-01-01T00:00:00.000Z");
  });

  it("maps a 403 to REVOKED", async () => {
    const provider = createPolarProvider({ fetchImpl: fakeFetch(403, {}) });
    const verdict = await provider.validate({ key: KEY, organizationId: "org_123" });
    expect(verdict.status).toBe("REVOKED");
  });

  it("maps a network error to UNREACHABLE, never throwing", async () => {
    const provider = createPolarProvider({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    const verdict = await provider.validate({ key: KEY, organizationId: "org_123" });
    expect(verdict.status).toBe("UNREACHABLE");
  });

  it("every verdict carries key_sha256, never the raw key", async () => {
    const provider = createPolarProvider({ fetchImpl: fakeFetch(200, { status: "granted" }) });
    const verdict = await provider.validate({ key: KEY, organizationId: "org_123" });
    expect(verdict.key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(verdict)).not.toContain(KEY);
  });

  it("resolvePolarValidateUrl uses production unless environment is sandbox", () => {
    expect(resolvePolarValidateUrl()).toBe(POLAR_PRODUCTION_VALIDATE_URL);
    expect(resolvePolarValidateUrl("production")).toBe(POLAR_PRODUCTION_VALIDATE_URL);
    expect(resolvePolarValidateUrl("sandbox")).toBe(POLAR_SANDBOX_VALIDATE_URL);
    expect(resolvePolarValidateUrl(" SANDBOX ")).toBe(POLAR_SANDBOX_VALIDATE_URL);
    expect(POLAR_PRODUCTION_VALIDATE_URL).toBe("https://api.polar.sh/v1/customer-portal/license-keys/validate");
    expect(POLAR_SANDBOX_VALIDATE_URL).toBe("https://sandbox-api.polar.sh/v1/customer-portal/license-keys/validate");
  });

  it("posts to sandbox-api.polar.sh when environment is sandbox", async () => {
    let url = "";
    const provider = createPolarProvider({
      environment: "sandbox",
      fetchImpl: (async (input: RequestInfo | URL) => {
        url = String(input);
        return { ok: true, status: 200, json: async () => ({ status: "granted" }) } as Response;
      }) as typeof fetch,
    });
    const verdict = await provider.validate({ key: KEY, organizationId: "org_123" });
    expect(verdict.status).toBe("VALID");
    expect(url).toBe(POLAR_SANDBOX_VALIDATE_URL);
  });

  it("posts to production api.polar.sh when environment is production", async () => {
    let url = "";
    const provider = createPolarProvider({
      environment: "production",
      fetchImpl: (async (input: RequestInfo | URL) => {
        url = String(input);
        return { ok: true, status: 200, json: async () => ({ status: "granted" }) } as Response;
      }) as typeof fetch,
    });
    await provider.validate({ key: KEY, organizationId: "org_123" });
    expect(url).toBe(POLAR_PRODUCTION_VALIDATE_URL);
  });

  it("honors process.env.POLAR_ENVIRONMENT=sandbox", async () => {
    const prev = process.env.POLAR_ENVIRONMENT;
    process.env.POLAR_ENVIRONMENT = "sandbox";
    try {
      let url = "";
      const provider = createPolarProvider({
        fetchImpl: (async (input: RequestInfo | URL) => {
          url = String(input);
          return { ok: true, status: 200, json: async () => ({ status: "granted" }) } as Response;
        }) as typeof fetch,
      });
      await provider.validate({ key: KEY, organizationId: "org_123" });
      expect(url).toBe(POLAR_SANDBOX_VALIDATE_URL);
    } finally {
      if (prev === undefined) delete process.env.POLAR_ENVIRONMENT;
      else process.env.POLAR_ENVIRONMENT = prev;
    }
  });

  it("reads POLAR_ENVIRONMENT from .polar.local in the licence dir when env is unset", async () => {
    const dir = tmpZeugeDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".polar.local"), "POLAR_ENVIRONMENT=sandbox\nPOLAR_ACCESS_TOKEN=should-not-be-required\n");
    const prevEnv = process.env.POLAR_ENVIRONMENT;
    const prevDir = process.env.ZEUGE_LICENSE_DIR;
    delete process.env.POLAR_ENVIRONMENT;
    process.env.ZEUGE_LICENSE_DIR = dir;
    try {
      let url = "";
      const provider = createPolarProvider({
        fetchImpl: (async (input: RequestInfo | URL) => {
          url = String(input);
          return { ok: true, status: 200, json: async () => ({ status: "granted" }) } as Response;
        }) as typeof fetch,
      });
      await provider.validate({ key: KEY, organizationId: "org_123" });
      expect(url).toBe(POLAR_SANDBOX_VALIDATE_URL);
    } finally {
      if (prevEnv === undefined) delete process.env.POLAR_ENVIRONMENT;
      else process.env.POLAR_ENVIRONMENT = prevEnv;
      if (prevDir === undefined) delete process.env.ZEUGE_LICENSE_DIR;
      else process.env.ZEUGE_LICENSE_DIR = prevDir;
    }
  });
});

describe("license/cache — clock-rollback primitives (pure)", () => {
  it("effectiveNow is a no-op when there is no prior high-water mark", () => {
    expect(effectiveNow(undefined, 1000)).toBe(1000);
    expect(effectiveNow(null, 1000)).toBe(1000);
  });

  it("effectiveNow never drops below the stored high-water mark", () => {
    const mark = new Date(5000).toISOString();
    expect(effectiveNow(mark, 6000)).toBe(6000); // forward time: raw now wins
    expect(effectiveNow(mark, 1000)).toBe(5000); // rolled back: floor at the mark
  });

  it("isClockMovedBackward fires exactly when raw now is earlier than the mark", () => {
    const mark = new Date(5000).toISOString();
    expect(isClockMovedBackward(mark, 6000)).toBe(false);
    expect(isClockMovedBackward(mark, 5000)).toBe(false); // equal is not "backward"
    expect(isClockMovedBackward(mark, 4999)).toBe(true);
    expect(isClockMovedBackward(undefined, 0)).toBe(false);
  });

  it("advanceMaxObservedAt only ever moves forward, and is a cheap no-op when nothing advances", () => {
    const mark = new Date(5000).toISOString();
    expect(advanceMaxObservedAt(mark, 4000)).toBe(mark); // rolled back: unchanged, same string
    expect(advanceMaxObservedAt(mark, 6000)).toBe(new Date(6000).toISOString());
    expect(advanceMaxObservedAt(undefined, 1000)).toBe(new Date(1000).toISOString());
  });
});

describe("license — acceptance: clock rollback does not extend or renew grace", () => {
  it("normal forward time behaves exactly as before (no regression from the rollback defense)", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days in
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    const gate = resolveLocalLicenseState(zeugeDir);
    expect(gate.state).toBe("GRACE");
    expect(gate.blocked).toBe(false);
    expect(gate.clockMovedBackward).toBe(false);
    expect(gate.message).not.toMatch(/CLOCK_MOVED_BACKWARD/);
  });

  it("a clock set backward after a legitimate check freezes grace instead of granting it forever, and is named CLOCK_MOVED_BACKWARD", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days in: real grace already EXPIRED
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    // An honest forward check first establishes the high-water mark at "now" (real time: EXPIRED).
    const honestNow = Date.now();
    const honestGate = resolveLocalLicenseState(zeugeDir, honestNow);
    expect(honestGate.state).toBe("EXPIRED");
    expect(honestGate.blocked).toBe(true);

    // The attacker now rolls the system clock back to day 5 (still within the original 14-day
    // window if taken at face value) and re-checks. Without the defense this would resolve
    // GRACE forever by keeping the clock there; with it, the high-water mark (>= honestNow,
    // itself already past grace_until) floors the effective time, so it still resolves EXPIRED —
    // rollback bought nothing — and the rollback itself is named in the output.
    const rolledBackNow = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const rolledGate = resolveLocalLicenseState(zeugeDir, rolledBackNow);
    expect(rolledGate.clockMovedBackward).toBe(true);
    expect(rolledGate.state).toBe("EXPIRED");
    expect(rolledGate.blocked).toBe(true);
    expect(rolledGate.message).toMatch(/CLOCK_MOVED_BACKWARD/);
  });

  it("rolling the clock back WHILE still genuinely within grace freezes the remaining days instead of resetting to a fresh 14, and does not block", () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days in, 9 legitimately remain
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    const honestNow = Date.now();
    const before = resolveLocalLicenseState(zeugeDir, honestNow);
    expect(before.state).toBe("GRACE");

    // Roll the clock back to before validated_at entirely — an attacker's cheapest move, trying
    // to look like day 0 again for a fresh 14-day window.
    const rolledBackNow = Date.parse(validatedAt) - 24 * 60 * 60 * 1000;
    const after = resolveLocalLicenseState(zeugeDir, rolledBackNow);
    expect(after.clockMovedBackward).toBe(true);
    expect(after.state).toBe("GRACE"); // still unlocked — no lockout of a paying customer
    expect(after.blocked).toBe(false);
    // "9 day(s) remaining", not a reset-to-14 — days are computed from the frozen high-water
    // mark (honestNow), not from the rolled-back clock.
    expect(after.message).toMatch(/9 day\(s\) remaining/);
    expect(after.message).toMatch(/CLOCK_MOVED_BACKWARD/);
  });

  it("refreshLicenseStatus's UNREACHABLE offline fallback applies the same clock-rollback defense and reports it on RefreshResult", async () => {
    const zeugeDir = tmpZeugeDir();
    setLicenseKey(zeugeDir, KEY);
    const validatedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    writeLicenseCache(zeugeDir, KEY, {
      provider: "stub",
      key_sha256: "a".repeat(64),
      status: "VALID",
      validated_at: validatedAt,
      expires_at: null,
      grace_until: computeGraceUntil(validatedAt),
    });

    // Establish the high-water mark via an honest local check first.
    resolveLocalLicenseState(zeugeDir);

    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() - 3 * 24 * 60 * 60 * 1000; // rolled back 3 days
      const provider = createStubProvider({ status: "UNREACHABLE" });
      const result = (await refreshLicenseStatus(zeugeDir, provider)) as RefreshResult;
      expect(result.clockMovedBackward).toBe(true);
      expect(result.state).toBe("GRACE"); // still not a lockout
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("license/paths — licence file location", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("default resolution per platform: LOCALAPPDATA on win32, XDG_CONFIG_HOME (else ~/.config) elsewhere", () => {
    const win = defaultUserConfigDir({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } as NodeJS.ProcessEnv, "win32");
    expect(win).toBe(path.join("C:\\Users\\test\\AppData\\Local", "zeuge"));

    const posixXdg = defaultUserConfigDir({ XDG_CONFIG_HOME: "/home/test/.config" } as NodeJS.ProcessEnv, "linux");
    expect(posixXdg).toBe(path.join("/home/test/.config", "zeuge"));

    const posixFallback = defaultUserConfigDir({} as NodeJS.ProcessEnv, "linux");
    expect(posixFallback).toBe(path.join(os.homedir(), ".config", "zeuge"));
  });

  it("ZEUGE_LICENSE_DIR overrides everything, including an existing legacy project file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-paths-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".zeuge"), { recursive: true });
    fs.writeFileSync(legacyLicenseKeyPath(dir), "{}");

    const override = path.join(dir, "custom-license-dir");
    const resolved = resolveLicenseDir(dir, { [ZEUGE_LICENSE_DIR_ENV]: override } as NodeJS.ProcessEnv, "linux");
    expect(resolved).toEqual({ dir: override, source: "env" });
  });

  it("an existing project-local licence.json is still read (upgrade path), taking priority over the platform default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-paths-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".zeuge"), { recursive: true });
    fs.writeFileSync(legacyLicenseKeyPath(dir), "{}");

    const resolved = resolveLicenseDir(dir, {} as NodeJS.ProcessEnv, "linux");
    expect(resolved).toEqual({ dir: path.join(dir, ".zeuge"), source: "legacy-project" });
  });

  it("with no override and no legacy file, resolves to the platform default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-paths-"));
    tmpDirs.push(dir);

    const resolved = resolveLicenseDir(dir, { XDG_CONFIG_HOME: "/home/test/.config" } as NodeJS.ProcessEnv, "linux");
    expect(resolved).toEqual({ dir: path.join("/home/test/.config", "zeuge"), source: "default-user-config" });
  });

  it("isInsideGitWorkTree finds a .git directory in an ancestor, and reports false when there is none up to the filesystem root", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-git-"));
    tmpDirs.push(repo);
    fs.mkdirSync(path.join(repo, ".git"));
    const nested = path.join(repo, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    expect(isInsideGitWorkTree(nested)).toBe(true);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-nogit-"));
    tmpDirs.push(bare);
    expect(isInsideGitWorkTree(bare)).toBe(false);
  });

  it("the warning fires exactly when the resolved directory is legacy-project AND inside a git work tree — never for env or the default", () => {
    expect(licenseDirWarning({ dir: "/anywhere", source: "env" })).toBeNull();
    expect(licenseDirWarning({ dir: "/anywhere", source: "default-user-config" })).toBeNull();

    const repoNoGitLegacy = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-warn-nogit-"));
    tmpDirs.push(repoNoGitLegacy);
    const legacyDirNoGit = path.join(repoNoGitLegacy, ".zeuge");
    fs.mkdirSync(legacyDirNoGit, { recursive: true });
    expect(licenseDirWarning({ dir: legacyDirNoGit, source: "legacy-project" })).toBeNull();

    const repoWithGit = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-warn-git-"));
    tmpDirs.push(repoWithGit);
    fs.mkdirSync(path.join(repoWithGit, ".git"));
    const legacyDirInGit = path.join(repoWithGit, ".zeuge");
    fs.mkdirSync(legacyDirInGit, { recursive: true });
    const warning = licenseDirWarning({ dir: legacyDirInGit, source: "legacy-project" });
    expect(warning).toMatch(/git work tree/);
    expect(warning).toMatch(/licence\.json/);
  });

  it("`zeuge licence set` and the Pro-gated gate warn on stderr exactly when a legacy project-local key sits inside a git work tree", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-cli-warn-"));
    tmpDirs.push(repo);
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, ".zeuge"), { recursive: true });
    fs.writeFileSync(legacyLicenseKeyPath(repo), JSON.stringify({ schema: "zeuge.licence.key.v1", key: KEY }));

    const cwdBefore = process.cwd();
    try {
      process.chdir(repo);
      const err: string[] = [];
      const io = { write: () => {}, writeErr: (s: string) => err.push(s) };
      const bundlePath = path.join(repo, "bundle.json");
      fs.writeFileSync(
        bundlePath,
        JSON.stringify({ schema: "zeuge.bundle.v1", claims: [], witnesses: [], coverage: { turns_scanned: 0, statements_total: 0, statements_classified: 0, statements_matched: {}, probe: "ALIVE" }, bundle_sha256: "x", signatures: [] })
);
      main(["node", "zeuge", "report", bundlePath, "--html", path.join(repo, "out.html")], io);
      expect(err.some((s) => s.includes("git work tree"))).toBe(true);
    } finally {
      process.chdir(cwdBefore);
    }
  });
});
