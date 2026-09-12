import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getFindingsTight } from "../src/lints/instruction-order";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "instruction-order-tight");
const manifest: Array<{ file: string; expected: number; name: string }> = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")
);

describe("instruction-order — getFindingsTight (P8: tightened rule, field-test 2026-09-11)", () => {
  for (const c of manifest) {
    it(`${c.name} -> ${c.expected} finding(s)`, () => {
      const lines = fs.readFileSync(path.join(FIXTURE_DIR, c.file), "utf8").split(/\r?\n/);
      const findings = getFindingsTight(lines);
      expect(findings.length).toBe(c.expected);
    });
  }

  it("at least 3 of the measured false-positive shapes are covered as negative cases", () => {
    const falsePositiveCases = manifest.filter((c) => c.name.startsWith("measured false positive") && c.expected === 0);
    expect(falsePositiveCases.length).toBeGreaterThanOrEqual(3);
  });

  it("every finding carries severity 'review'", () => {
    const lines = fs.readFileSync(path.join(FIXTURE_DIR, "04-tp-before-adjacent.md"), "utf8").split(/\r?\n/);
    const findings = getFindingsTight(lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("review");
  });

  it("does not fire when the clause word merely appears mid-sentence (loose rule would have)", () => {
    const lines = ["- Use `--cwd <absolute-path>` to set the working directory.", "- Use `unset CLAUDECODE` before `x` to avoid nested-session errors."];
    expect(getFindingsTight(lines)).toHaveLength(0);
  });

  it("still fires when the clause genuinely leads its own bullet, immediately after the action", () => {
    const lines = ["- Run the tests.", "- Before merging, check CI is green."];
    const findings = getFindingsTight(lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].actionLine).toBe(1);
    expect(findings[0].orderLine).toBe(2);
  });
});
