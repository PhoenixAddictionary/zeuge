/**
 * plugin-distribution — P9 item 5: the check whose absence let a real bug through. Running the
 * CLI from the dev tree (as every other test in this repo does) proves nothing about what a
 * `claude plugin install` actually gets, because a Claude Code plugin install pulls from a git
 * export, not from this checked-out working tree with node_modules and an already-built dist/
 * sitting right there. This test performs the SAME export a real install performs — `git
 * archive HEAD` of this package — into an isolated temp directory, reads the REAL
 * hooks/hooks.json out of that export (not the source tree), substitutes
 * `${CLAUDE_PLUGIN_ROOT}` the way Claude Code would, and executes the resulting command
 * exactly as the harness would, with a real fixture payload on stdin.
 *
 * P9 item 6: a companion test asserts `npm pack --dry-run` actually includes every path the
 * plugin and the npm/npx install both need — dist/, bin/, README.md, LICENSE,
 * .claude-plugin/plugin.json, hooks/, skills/ — so a `files` whitelist regression is caught
 * the same way the missing-dist/ regression should have been.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { isGitCheckout } from "../scripts/git-checkout";
// These tests spawn real subprocesses and, in one case, run `git archive`. The default
// five-second per-test timeout is enough on an idle machine and not enough on a loaded one:
// running the suite four times concurrently made two of them time out with no assertion
// failure at all. A red build caused by a busy machine teaches a reader to ignore red builds,
// so the budget is stated here rather than inherited.
vi.setConfig({ testTimeout: 30000 });


const REPO_DIR = path.join(__dirname, "..");

// This whole describe block simulates a plugin install by running `git archive HEAD` on this
// package — see exportHeadToTempDir() below. That has no meaning outside a real git checkout
// (a downloaded archive/zip has no `.git` at all), so when this suite itself is not running
// from a checkout, its tests are skipped rather than failed — vitest's own skip mechanism, so
// the run reports them as "skipped", never as a silent pass. Skipping means: whatever these
// tests exist to prove — that a git-based plugin install (or `npm publish` from git sources)
// actually gets a working hooks.json, dist/, and bin/ — goes UNVERIFIED for this run.
const IS_GIT_CHECKOUT = isGitCheckout(REPO_DIR);
// Appended to each git-export test's own title (not just logged) so the reason survives into
// vitest's skipped-test line in the run output, in words a stranger can read without also
// having to find this file: what the test needs, and what a real install actually does.
const NEEDS_GIT_CHECKOUT_NOTE =
  "needs a git checkout: this test exports HEAD via `git archive`, the same mechanism a " +
  "plugin install and a git-sourced `npm publish` both use, so it cannot run from a plain " +
  "archive/zip of this repo";
const tmpDirs: string[] = [];
afterAll(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Exports the committed HEAD of this package (git archive — the same mechanism a Claude Code
 *  plugin install and `npm publish`'s git-based sources use) into a fresh temp directory. */
function exportHeadToTempDir(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-git-export-"));
  tmpDirs.push(dest);
  const tarPath = path.join(dest, "export.tar");
  execFileSync("git", ["archive", "-o", tarPath, "HEAD", "--", "."], { cwd: REPO_DIR });
  // Windows' built-in bsdtar misparses an absolute "C:\..." path as remote ssh-style host:path
  // syntax ("Cannot connect to C: resolve failed"). Passing a bare relative filename with cwd
  // set to the destination directory avoids ever handing tar a drive-letter-colon path at all.
  execFileSync("tar", ["-xf", "export.tar"], { cwd: dest });
  fs.unlinkSync(tarPath);
  return dest;
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}
interface HooksFile {
  hooks: { Stop?: HookEntry[]; PostToolUse?: HookEntry[] };
}

function readExportedHooks(exportedDir: string): HooksFile {
  const raw = fs.readFileSync(path.join(exportedDir, "hooks", "hooks.json"), "utf8");
  return JSON.parse(raw) as HooksFile;
}

/** Substitutes ${CLAUDE_PLUGIN_ROOT} the way Claude Code would (the plugin's own install root)
 *  and runs the resulting shell command with `stdinPayload` on stdin, returning {status,
 *  stdout}. Never throws on a non-zero exit — the caller asserts on `status` itself, exactly
 *  like the real harness would observe it. */
function runHookCommand(commandTemplate: string, pluginRoot: string, stdinPayload: string, cwd: string): { status: number; stdout: string } {
  const command = commandTemplate.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot);
  try {
    const stdout = execSync(command, { input: stdinPayload, cwd, encoding: "utf8" });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    return { status: e.status ?? 1, stdout: (e.stdout ?? "").toString() };
  }
}

describe("plugin distribution — P9: git-export simulation (the check whose absence let missing dist/ through)", () => {
  it.skipIf(!IS_GIT_CHECKOUT)(`a git-archive export of HEAD contains the compiled dist/ and bin/ the plugin's hook commands need (${NEEDS_GIT_CHECKOUT_NOTE})`, () => {
    const exported = exportHeadToTempDir();
    expect(fs.existsSync(path.join(exported, "bin", "zeuge.js"))).toBe(true);
    expect(fs.existsSync(path.join(exported, "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(path.join(exported, "hooks", "hooks.json"))).toBe(true);
    // Exactly one hooks file ships (P9 item 4) — the old root hooks.json artifact is gone.
    expect(fs.existsSync(path.join(exported, "hooks.json"))).toBe(false);
  });

  it.skipIf(!IS_GIT_CHECKOUT)(`the exported hooks.json's real Stop command runs against a fixture payload: exit 0, parseable hookSpecificOutput (${NEEDS_GIT_CHECKOUT_NOTE})`, () => {
    const exported = exportHeadToTempDir();
    const hooksFile = readExportedHooks(exported);
    const stopEntry = hooksFile.hooks.Stop?.[0];
    expect(stopEntry).toBeDefined();
    expect(stopEntry!.hooks).toHaveLength(1);
    // P9 item 3: Stop carries no matcher (matchers are for tool events, not Stop).
    expect(stopEntry!.matcher).toBeUndefined();

    const payload = JSON.stringify({
      session_id: "session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hook_event_name: "Stop",
      stop_hook_active: false,
      cwd: exported,
      last_assistant_message: { type: "text", text: "All tests pass." },
    });

    const result = runHookCommand(stopEntry!.hooks[0].command, exported, payload, exported);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput).toBeTruthy();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  }, 20000);

  it.skipIf(!IS_GIT_CHECKOUT)(`the exported hooks.json's real PostToolUse (ledger) command runs against a fixture payload: exit 0 (${NEEDS_GIT_CHECKOUT_NOTE})`, () => {
    const exported = exportHeadToTempDir();
    const hooksFile = readExportedHooks(exported);
    const postEntry = hooksFile.hooks.PostToolUse?.[0];
    expect(postEntry).toBeDefined();
    expect(postEntry!.matcher).toBe("Bash|Write|Edit");

    const payload = JSON.stringify({
      session_id: "session:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      hook_event_name: "PostToolUse",
      cwd: exported,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "ok", stderr: "", exitCode: 0 },
    });

    const result = runHookCommand(postEntry!.hooks[0].command, exported, payload, exported);
    expect(result.status).toBe(0);
    if (result.stdout.trim()) expect(() => JSON.parse(result.stdout)).not.toThrow();
    // The compiled code actually ran and wrote a real ledger row — proof this exercised the
    // exported dist/, not merely "the command returned 0."
    expect(fs.existsSync(path.join(exported, ".zeuge", "ledger.jsonl"))).toBe(true);
  }, 20000);

  it.skipIf(!IS_GIT_CHECKOUT)(`every command in the exported hooks.json quotes \${CLAUDE_PLUGIN_ROOT} (P9 item 3: an unquoted path breaks on a space in the install path) (${NEEDS_GIT_CHECKOUT_NOTE})`, () => {
    const exported = exportHeadToTempDir();
    const hooksFile = readExportedHooks(exported);
    const allCommands = [...(hooksFile.hooks.Stop ?? []), ...(hooksFile.hooks.PostToolUse ?? [])].flatMap((e) => e.hooks.map((h) => h.command));
    expect(allCommands.length).toBeGreaterThan(0);
    for (const command of allCommands) {
      expect(command).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/zeuge.js"');
    }
  });
});

describe("npm pack — P9 item 6: the published tarball carries everything both install paths need", () => {
  it("npm pack --dry-run --json includes dist/, bin/, README.md, LICENSE, .claude-plugin/plugin.json, hooks/, and skills/", () => {
    const raw = execSync("npm pack --dry-run --json", { cwd: REPO_DIR, encoding: "utf8" });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const files = parsed[0].files.map((f) => f.path.replace(/\\/g, "/"));

    expect(files.some((f) => f.startsWith("dist/"))).toBe(true);
    expect(files.some((f) => f.startsWith("bin/"))).toBe(true);
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain(".claude-plugin/plugin.json");
    expect(files.some((f) => f.startsWith("hooks/"))).toBe(true);
    expect(files.some((f) => f.startsWith("skills/"))).toBe(true);
  }, 20000);
});
