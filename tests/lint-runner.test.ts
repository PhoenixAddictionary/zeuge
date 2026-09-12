import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runLint } from "../src/lint-runner";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-lint-runner-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("lint-runner integrity handling ()", () => {
  it("an unparseable settings JSON is an integrity failure: exit 3, even with zero findings", () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "{ not valid json", "utf8");

    const report = runLint(dir);
    expect(report.parseErrors).toBe(1);
    expect(report.totalFindings).toBe(0);
    expect(report.exitCode).toBe(3);
    expect(report.entries[0].parseError).toBeTruthy();
  });

  it("a directory with nothing to scan is NOTHING_SCANNED, exit 3 — never a silent exit 0", () => {
    const dir = makeTmpDir();
    const report = runLint(dir);
    expect(report.nothingScanned).toBe(true);
    expect(report.reason).toBe("NOTHING_SCANNED");
    expect(report.exitCode).toBe(3);
    expect(report.scanned).toHaveLength(0);
  });

  it("a clean, non-empty scan still exits 0 (P8: instruction-order needs --experimental-order to be scanned at all)", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# H\n- Zuerst pruefen.\n- Gib die Antwort.\n", "utf8");
    const report = runLint(dir, { experimentalOrder: true });
    expect(report.exitCode).toBe(0);
    expect(report.nothingScanned).toBe(false);
    expect(report.parseErrors).toBe(0);
  });

  it("P8: a lone review-severity finding (instruction-order, no --strict) still exits 0, not 1 — only a fault forces exit 1 by default", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# H\n- Gib die Antwort.\n- Zuerst pruefen.\n", "utf8");
    const report = runLint(dir, { experimentalOrder: true });
    expect(report.counts.review).toBe(1);
    expect(report.counts.fault).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it("P8: that same lone review finding exits 1 under --strict", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# H\n- Gib die Antwort.\n- Zuerst pruefen.\n", "utf8");
    const report = runLint(dir, { experimentalOrder: true, strict: true });
    expect(report.exitCode).toBe(1);
  });

  it("findings alone (a genuine fault, no integrity failure) still exit 1, not 3", () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".claude"));
    // An invalid regex matcher is severity "fault" (hook-matcher.ts) — exits 1 with no --strict.
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read(" }] } }), "utf8");
    const report = runLint(dir);
    expect(report.counts.fault).toBe(1);
    expect(report.exitCode).toBe(1);
  });

  it("integrity failure outranks a plain finding: a bad settings file plus a clean CLAUDE.md still exits 3", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# H\n- Zuerst pruefen.\n- Gib die Antwort.\n", "utf8");
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "not json at all", "utf8");
    const report = runLint(dir);
    expect(report.exitCode).toBe(3);
  });
});
