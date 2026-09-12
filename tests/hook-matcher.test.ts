import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getMatcherViolations } from "../src/lints/hook-matcher";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "hook-matcher");
const manifest: Array<{ file: string; expected: number; name: string }> = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")
);

describe("hook-matcher (parity with tools/hook-matcher-lint.ps1 -SelfTest)", () => {
  for (const c of manifest) {
    it(`${c.name} -> ${c.expected} violation(s)`, () => {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, c.file), "utf8"));
      const violations = getMatcherViolations(parsed);
      expect(violations.length).toBe(c.expected);
    });
  }

  it("at least one fixture is known to make the check fail (violations > 0)", () => {
    const withViolations = manifest.filter((c) => c.expected > 0);
    expect(withViolations.length).toBeGreaterThan(0);
  });

  it("does not flag a substring lookalike like ReadFile", () => {
    const parsed = { hooks: { PreToolUse: [{ matcher: "ReadFile|Bash" }] } };
    expect(getMatcherViolations(parsed)).toHaveLength(0);
  });

  it("gates Read via regex alternation (Read|Grep), not just a literal split", () => {
    const parsed = { hooks: { PreToolUse: [{ matcher: "(Read|Grep)" }] } };
    const violations = getMatcherViolations(parsed);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("GATES_DIAGNOSTIC_TOOL");
    expect(violations[0].tools).toContain("Read");
  });

  it("gates Read via a regex wildcard (Read.*)", () => {
    const parsed = { hooks: { PreToolUse: [{ matcher: "Read.*" }] } };
    expect(getMatcherViolations(parsed)).toHaveLength(1);
  });

  it("reports an invalid regex as its own finding, never silently skipped", () => {
    const parsed = { hooks: { PreToolUse: [{ matcher: "Read(" }] } };
    const violations = getMatcherViolations(parsed);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("INVALID_REGEX");
  });

  it(" (4): a missing matcher key gates every diagnostic tool, kind MATCHER_ABSENT", () => {
    const parsed = { hooks: { PreToolUse: [{ hooks: [] }] } };
    const violations = getMatcherViolations(parsed);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("MATCHER_ABSENT");
    expect(violations[0].tools).toBe("Read, Grep, Glob");
  });

  it(" (4): an explicit empty-string matcher is the same defect as a missing key", () => {
    const parsed = { hooks: { PreToolUse: [{ matcher: "" }] } };
    const violations = getMatcherViolations(parsed);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("MATCHER_ABSENT");
  });
});
