import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runLedgerHook } from "../src/ledger/hook";
import { verifyLedgerFile } from "../src/ledger/verify";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-ledger-hook-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge", "ledger.jsonl");
}

describe("ledger/hook — PostToolUse wiring", () => {
  it("a valid PostToolUse payload appends one COMMAND_RUN event and exits 0", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({
      session_id: "session:1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "ok", stderr: "", exitCode: 0 },
    });
    const result = runLedgerHook({ stdinText: payload, ledgerPath });
    expect(result.exitCode).toBe(0);
    expect(result.appended).toBe(true);

    const verification = verifyLedgerFile(ledgerPath);
    expect(verification.ok).toBe(true);
    expect(verification.event_count).toBe(1);
  });

  it("never captures stdout/stderr text, only hashes of it", () => {
    const ledgerPath = tmpLedgerPath();
    const secretOutput = "super secret build output";
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: { stdout: secretOutput, stderr: "", exitCode: 0 },
    });
    runLedgerHook({ stdinText: payload, ledgerPath });
    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).not.toContain(secretOutput);
  });

  it("malformed stdin exits 0 and appends nothing", () => {
    const ledgerPath = tmpLedgerPath();
    const result = runLedgerHook({ stdinText: "{not json", ledgerPath });
    expect(result.exitCode).toBe(0);
    expect(result.appended).toBe(false);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it("a failed tool run is recorded with outcome FAILED, never blocking", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({ tool_name: "Bash", tool_response: { exitCode: 1 } });
    const result = runLedgerHook({ stdinText: payload, ledgerPath });
    expect(result.exitCode).toBe(0);
    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).toContain('"outcome":"FAILED"');
  });
});

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "claims");
const read = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");

describe("ledger/hook — P3.1: real PostToolUse contract (tool_use_id, string-or-object tool_response)", () => {
  it("records tool_use_id and hashes the canonicalized tool_input, with a string tool_response", () => {
    const ledgerPath = tmpLedgerPath();
    const result = runLedgerHook({ stdinText: read("posttooluse-real-shape.json"), ledgerPath });
    expect(result.exitCode).toBe(0);
    expect(result.appended).toBe(true);

    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).toContain("toolu_01AbCdEfGhIjKlMnOpQrStUv");
    // The raw string tool_response ("Tests passed: 42/42") is never stored verbatim.
    expect(raw).not.toContain("Tests passed: 42/42");
    const event = JSON.parse(raw.trim());
    expect(event.body.tool_use_id).toBe("toolu_01AbCdEfGhIjKlMnOpQrStUv");
    expect(event.body.tool_input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(event.body.tool_response_sha256).toMatch(/^[0-9a-f]{64}$/);

    const verification = verifyLedgerFile(ledgerPath);
    expect(verification.ok).toBe(true);
  });

  it("hashes an object-shaped tool_response the same way, never storing its content verbatim", () => {
    const ledgerPath = tmpLedgerPath();
    const result = runLedgerHook({ stdinText: read("posttooluse-real-shape-object-response.json"), ledgerPath });
    expect(result.exitCode).toBe(0);
    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).not.toContain("/work/README.md");
    expect(raw).not.toContain("content_length");
    const event = JSON.parse(raw.trim());
    expect(event.body.tool_use_id).toBe("toolu_02XyZaBcDeFgHiJkLmNoPqRs");
    expect(event.body.tool_response_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
