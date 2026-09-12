import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkSilence, CapturedRun, SilenceVerdict } from "../src/lints/silence-guard";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "silence-guard");
const manifest: Array<{ file: string; expected: SilenceVerdict; name: string }> = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")
);

describe("silence-guard", () => {
  for (const c of manifest) {
    it(`${c.name} -> ${c.expected}`, () => {
      const run: CapturedRun = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, c.file), "utf8"));
      expect(checkSilence(run)).toBe(c.expected);
    });
  }

  it("is known to produce FAIL, not a silent pass, on a non-zero exit", () => {
    const failCase = manifest.find((c) => c.expected === "FAIL");
    expect(failCase).toBeDefined();
  });

  it("does not confuse UNPROVEN with PASS", () => {
    expect(checkSilence({ stdout: "", stderr: "", exitCode: 0 })).not.toBe("PASS");
  });
});
