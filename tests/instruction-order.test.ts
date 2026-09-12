import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getFindingsLoose as getFindings } from "../src/lints/instruction-order";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "instruction-order");
const manifest: Array<{ file: string; expected: number; name: string }> = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")
);

describe("instruction-order — getFindingsLoose (parity with tools/instruction-order-lint.ps1 -SelfTest; P8: renamed from getFindings, no longer wired into `zeuge lint`, kept for its own regression fixtures)", () => {
  for (const c of manifest) {
    it(`${c.name} -> ${c.expected} finding(s)`, () => {
      const lines = fs.readFileSync(path.join(FIXTURE_DIR, c.file), "utf8").split(/\r?\n/);
      const findings = getFindings(lines);
      expect(findings.length).toBe(c.expected);
    });
  }

  it("at least one fixture is known to make the check fail (findings > 0)", () => {
    const withFindings = manifest.filter((c) => c.expected > 0);
    expect(withFindings.length).toBeGreaterThan(0);
  });

  it("reports 1-based line numbers pointing at the real lines", () => {
    const lines = fs
      .readFileSync(path.join(FIXTURE_DIR, "02-order-after-action.md"), "utf8")
      .split(/\r?\n/);
    const findings = getFindings(lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].actionLine).toBe(2);
    expect(findings[0].orderLine).toBe(3);
  });
});
