/**
 * cli-session — `claim detect --session <id>` stamps a real session on
 * emitted claims, and `bundle --session <id>` refuses (exit 3, SESSION_MISMATCH) rather than
 * silently accepting a claim whose own KNOWN session differs from the bundle's.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-cli-session-"));
  tmpDirs.push(d);
  return d;
}

describe("claim detect --session", () => {
  it("stamps the given session id on every emitted claim", () => {
    const c = capture();
    const code = main(["node", "zeuge", "claim", "detect", "--stdin", "--json", "--session", "session:real-abc"], {
      ...c.io,
      readStdin: () => "All tests pass.",
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(parsed.claims.length).toBeGreaterThan(0);
    for (const claim of parsed.claims) expect(claim.session_id).toBe("session:real-abc");
  });

  it("defaults to the placeholder session when --session is omitted", () => {
    const c = capture();
    const code = main(["node", "zeuge", "claim", "detect", "--stdin", "--json"], { ...c.io, readStdin: () => "All tests pass." });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(parsed.claims[0].session_id).toBe("session:00000000000000000000000000000000");
  });
});

describe("bundle --session — item 4: known-session mismatch is an integrity failure, not a silent skip", () => {
  function writeClaimsAndCoverage(dir: string, sessionId: string): { claimsPath: string; coveragePath: string } {
    const c = capture();
    main(["node", "zeuge", "claim", "detect", "--stdin", "--json", "--session", sessionId], { ...c.io, readStdin: () => "All tests pass." });
    const parsed = JSON.parse(c.out());
    const claimsPath = path.join(dir, "claims.json");
    const coveragePath = path.join(dir, "coverage.json");
    fs.writeFileSync(claimsPath, JSON.stringify(parsed.claims));
    fs.writeFileSync(coveragePath, JSON.stringify(parsed.coverage));
    return { claimsPath, coveragePath };
  }

  it("exits 3 with SESSION_MISMATCH when the claim's known session differs from --session", () => {
    const dir = tmpDir();
    const { claimsPath, coveragePath } = writeClaimsAndCoverage(dir, "session:claim-owns-this-one");
    const outPath = path.join(dir, "bundle.json");
    const c = capture();
    const code = main(["node", "zeuge", "bundle", "--claims", claimsPath, "--coverage", coveragePath, "--out", outPath, "--session", "session:a-different-one"], c.io);
    expect(code).toBe(3);
    expect(c.err()).toMatch(/SESSION_MISMATCH/);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("succeeds when the claim's session matches --session", () => {
    const dir = tmpDir();
    const { claimsPath, coveragePath } = writeClaimsAndCoverage(dir, "session:same-one");
    const outPath = path.join(dir, "bundle.json");
    const c = capture();
    const code = main(["node", "zeuge", "bundle", "--claims", claimsPath, "--coverage", coveragePath, "--out", outPath, "--session", "session:same-one"], c.io);
    expect(code).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("succeeds when the claim carries only the placeholder (unknown) session, regardless of --session", () => {
    const dir = tmpDir();
    const { claimsPath, coveragePath } = writeClaimsAndCoverage(dir, "session:00000000000000000000000000000000");
    const outPath = path.join(dir, "bundle.json");
    const c = capture();
    const code = main(["node", "zeuge", "bundle", "--claims", claimsPath, "--coverage", coveragePath, "--out", outPath, "--session", "session:whatever-the-bundle-is"], c.io);
    expect(code).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
  });
});
