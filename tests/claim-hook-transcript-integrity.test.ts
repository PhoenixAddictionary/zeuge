/**
 * claim-hook-transcript-integrity — malformed-line counting and bounded-tail-read regressions.
 *
 * A JSON.parse failure on a transcript line used to be swallowed with a bare
 * `continue`, so a corrupted transcript was indistinguishable from an empty one. Malformed
 * lines encountered while scanning for the last assistant entry must now be counted and
 * reported via `coverage.transcript_malformed_lines`, and named in the hook's
 * `additionalContext` whenever the count is greater than zero.
 *
 * The transcript file used to be read whole with `readFileSync`. Real transcript
 * files on this platform exceed 80 MB. A file larger than `TRANSCRIPT_READ_BUDGET_BYTES` must
 * be read as a bounded tail, that boundedness must be visible on `coverage`, and the last
 * assistant entry (near the end of the file, exactly where the Stop hook needs it) must still
 * be found.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runClaimHook, resolveTurnText, TRANSCRIPT_READ_BUDGET_BYTES } from "../src/claim/hook";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpZeugeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-transcript-integrity-"));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge");
}
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-transcript-file-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

function assistantLine(text: string): string {
  return JSON.stringify({ type: "assistant", uuid: "u", parentUuid: null, timestamp: new Date().toISOString(), sessionId: "s", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function stopPayloadWithTranscriptPath(transcriptPath: string): string {
  return JSON.stringify({ session_id: "session:ti1", cwd: "/irrelevant", hook_event_name: "Stop", stop_hook_active: false, transcript_path: transcriptPath });
}

describe("malformed transcript lines are counted, not silently swallowed", () => {
  it("resolveTurnText: two trailing malformed lines are counted while the real assistant text beneath them is still found", () => {
    const transcriptPath = tmpFile("transcript.jsonl");
    // The two malformed lines are AFTER the real entry physically, so the backward scan visits
    // (and counts) them before it reaches the valid line.
    const content = [assistantLine("All tests pass."), "{this is not valid json", "{neither is this,"].join("\n") + "\n";
    fs.writeFileSync(transcriptPath, content, "utf8");

    const resolved = resolveTurnText({ hook_event_name: "Stop", transcript_path: transcriptPath });
    expect(resolved.text).toBe("All tests pass.");
    expect(resolved.malformedLines).toBe(2);
  });

  it("runClaimHook: coverage.transcript_malformed_lines is set and additionalContext names it", () => {
    const zeugeDir = tmpZeugeDir();
    const transcriptPath = tmpFile("transcript.jsonl");
    const content = [assistantLine("All tests pass."), "{broken 1", "{broken 2"].join("\n") + "\n";
    fs.writeFileSync(transcriptPath, content, "utf8");

    const result = runClaimHook({ stdinText: stopPayloadWithTranscriptPath(transcriptPath), zeugeDir, now: 1000, jsonMode: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.transcript_malformed_lines).toBe(2);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/2 malformed line\(s\)/);
  });

  it("a fully clean transcript reports no transcript_malformed_lines field at all", () => {
    const zeugeDir = tmpZeugeDir();
    const transcriptPath = tmpFile("transcript.jsonl");
    fs.writeFileSync(transcriptPath, assistantLine("Fixed the bug.") + "\n", "utf8");

    const result = runClaimHook({ stdinText: stopPayloadWithTranscriptPath(transcriptPath), zeugeDir, now: 1000, jsonMode: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.transcript_malformed_lines).toBeUndefined();
  });
});

describe("the real transcript file is read as a bounded tail past the byte budget", () => {
  it("a transcript file larger than TRANSCRIPT_READ_BUDGET_BYTES is read bounded and still finds the last assistant message", () => {
    const transcriptPath = tmpFile("big-transcript.jsonl");
    const paddingLine = JSON.stringify({ type: "user", padding: "x".repeat(200) });
    const linesNeeded = Math.ceil((TRANSCRIPT_READ_BUDGET_BYTES * 1.5) / (paddingLine.length + 1));
    const fd = fs.openSync(transcriptPath, "w");
    try {
      for (let i = 0; i < linesNeeded; i++) fs.writeSync(fd, paddingLine + "\n");
      fs.writeSync(fd, assistantLine("All tests pass.") + "\n");
    } finally {
      fs.closeSync(fd);
    }

    const size = fs.statSync(transcriptPath).size;
    expect(size).toBeGreaterThan(TRANSCRIPT_READ_BUDGET_BYTES);

    const resolved = resolveTurnText({ hook_event_name: "Stop", transcript_path: transcriptPath });
    expect(resolved.text).toBe("All tests pass.");
    expect(resolved.readBounded).toBe(true);
    expect(resolved.readBudgetBytes).toBe(TRANSCRIPT_READ_BUDGET_BYTES);
  });

  it("runClaimHook surfaces transcript_read_bounded and the exact byte budget on coverage", () => {
    const zeugeDir = tmpZeugeDir();
    const transcriptPath = tmpFile("big-transcript.jsonl");
    const paddingLine = JSON.stringify({ type: "user", padding: "x".repeat(200) });
    const linesNeeded = Math.ceil((TRANSCRIPT_READ_BUDGET_BYTES * 1.5) / (paddingLine.length + 1));
    const fd = fs.openSync(transcriptPath, "w");
    try {
      for (let i = 0; i < linesNeeded; i++) fs.writeSync(fd, paddingLine + "\n");
      fs.writeSync(fd, assistantLine("All tests pass.") + "\n");
    } finally {
      fs.closeSync(fd);
    }

    const result = runClaimHook({ stdinText: stopPayloadWithTranscriptPath(transcriptPath), zeugeDir, now: 1000, jsonMode: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.coverage.transcript_read_bounded).toBe(true);
    expect(parsed.coverage.transcript_read_budget_bytes).toBe(TRANSCRIPT_READ_BUDGET_BYTES);
    expect(parsed.claims.length).toBeGreaterThan(0);
  });

  it("a transcript file within budget reports no bounded-read fields at all", () => {
    const transcriptPath = tmpFile("small-transcript.jsonl");
    fs.writeFileSync(transcriptPath, assistantLine("Done.") + "\n", "utf8");

    const resolved = resolveTurnText({ hook_event_name: "Stop", transcript_path: transcriptPath });
    expect(resolved.readBounded).toBeUndefined();
    expect(resolved.readBudgetBytes).toBeUndefined();
  });
});
