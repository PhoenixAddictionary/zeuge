/**
 * command-kind — regression test: `collectLedgerWitnesses` used to bind `tests_pass` to
 * ANY passing COMMAND_RUN event, so a passing `ls` witnessed "All tests pass." exactly as well
 * as a passing `npm test` did. `command_kind` (written by ledger/hook.ts, classified by
 * src/ledger/command-kind.ts) now gates that: only a COMMAND_RUN whose command classifies as
 * "test" backs a `tests_pass` claim. An event with NO `command_kind` at all (any ledger written
 * before this fix, or by any other producer) must not bind `tests_pass` either — absence of the
 * field is not evidence of a test run.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyCommandKind } from "../src/ledger/command-kind";
import { runLedgerHook } from "../src/ledger/hook";
import { collectLedgerWitnesses } from "../src/witness/sources/ledger";
import { appendEvent } from "../src/ledger/append";
import { rebindClaims } from "../src/receipt/bundle";
import { buildClaim } from "../src/claim/record";
import { detectClaims } from "../src/claim/detect";

const AGENT = { id: "agent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", vendor: "anthropic", model: "test", harness: "claude-code", harness_version: "test" };
const RULES_SHA = "c".repeat(64);

function testsPassClaim(sessionId: string) {
  const candidate = detectClaims("All tests pass.")[0];
  return buildClaim({ sessionId, agent: AGENT, candidate, source: "test", rulesSha256: RULES_SHA });
}

describe("ledger/command-kind — classifyCommandKind", () => {
  it("classifies known test-runner invocations as 'test'", () => {
    expect(classifyCommandKind("npm test")).toBe("test");
    expect(classifyCommandKind("npm run test:unit")).toBe("test");
    expect(classifyCommandKind("pnpm test")).toBe("test");
    expect(classifyCommandKind("yarn test")).toBe("test");
    expect(classifyCommandKind("npx vitest run")).toBe("test");
    expect(classifyCommandKind("npx jest --ci")).toBe("test");
    expect(classifyCommandKind("node --test")).toBe("test");
    expect(classifyCommandKind("pytest -q")).toBe("test");
    expect(classifyCommandKind("cargo test")).toBe("test");
    expect(classifyCommandKind("go test ./...")).toBe("test");
    expect(classifyCommandKind("dotnet test")).toBe("test");
    expect(classifyCommandKind("mvn -B test")).toBe("test");
    expect(classifyCommandKind("./gradlew test")).toBe("test");
    expect(classifyCommandKind("bundle exec rspec")).toBe("test");
    expect(classifyCommandKind("./vendor/bin/phpunit")).toBe("test");
  });

  it("classifies an unrelated command as 'other', never 'test'", () => {
    expect(classifyCommandKind("ls -la")).toBe("other");
    expect(classifyCommandKind("echo hello")).toBe("other");
    expect(classifyCommandKind("git status")).toBe("other");
    expect(classifyCommandKind("")).toBe("other");
  });

  it("classifies build and deploy commands into their own kinds", () => {
    expect(classifyCommandKind("npm run build")).toBe("build");
    expect(classifyCommandKind("cargo build")).toBe("build");
    expect(classifyCommandKind("vercel deploy --prod")).toBe("deploy");
    expect(classifyCommandKind("kubectl apply -f deploy.yaml")).toBe("deploy");
  });
});

// The classifier moved from whole-line substring regexes to a program+subcommand
// token match. Confirmed misses (must now be "test"), confirmed false positives (must now be
// "other"), and word-boundary regressions (testify/latest/contest/attestation) all live in one
// table so the whole contract is visible at a glance.
describe("ledger/command-kind — program+subcommand classification, not substring", () => {
  const POSITIVE_TEST_COMMANDS = [
    "npm test",
    "npm t",
    "npm run test:unit",
    "pnpm test",
    "yarn test",
    "npx vitest run",
    "npx vitest",
    "npx jest --ci",
    "node --test",
    "pytest -q",
    "cargo test",
    "go test ./...",
    "dotnet test",
    "mvn -B test",
    "./gradlew test",
    "bundle exec rspec",
    "./vendor/bin/phpunit",
    "bun test", // confirmed miss under the old regex table
    "deno test",
  ];

  const NEGATIVE_COMMANDS = [
    "ls -la",
    "echo hello",
    "git status",
    "npm run testify", // confirmed false positive under the old regex table
    "cat jest.config.js", // confirmed false positive under the old regex table
    "npm run testify:unit", // starts with "testify:", not "test:" — must not match the scoped prefix
    "npm run latest",
    "yarn run contest",
    "echo attestation",
    "grep -r jest src/",
    "tail -f test.log",
    "head -n 5 test-results.json",
    "code test.spec.ts",
    "less jest.config.js",
    "vim test_helper.rb",
  ];

  it.each(POSITIVE_TEST_COMMANDS)("classifies %j as test", (cmd) => {
    expect(classifyCommandKind(cmd)).toBe("test");
  });

  it.each(NEGATIVE_COMMANDS)("classifies %j as other, never test", (cmd) => {
    expect(classifyCommandKind(cmd)).not.toBe("test");
  });

  it("a pipeline/&&/;  chain classifies by its FIRST command only", () => {
    expect(classifyCommandKind("npm test && rm -rf dist")).toBe("test");
    expect(classifyCommandKind("echo hi && npm test")).toBe("other");
    expect(classifyCommandKind("npm test; echo done")).toBe("test");
    expect(classifyCommandKind("cat jest.config.js && npm test")).toBe("other");
    expect(classifyCommandKind("npm test | tee out.log")).toBe("test");
    // measured table's exact "first-command rule" case: the SECOND command (a build) never
    // retroactively promotes or demotes the classification of the first.
    expect(classifyCommandKind("npm test && npm run build")).toBe("test");
  });
});

// `python -m pytest -q` (and every other LAUNCHER shape
// that delegates to a program named later on the line) classified as "other" after the
// program+subcommand rewrite above, because the invoked program is the launcher (python, poetry, npx,
// ...), not the delegated one. Every case from the owner's measured table is asserted here
// explicitly, plus the required extension set (>= 20 positive, >= 20 negative across this file).
describe("ledger/command-kind — launcher delegation (python -m, poetry run, npx, ...)", () => {
  // The owner's measured table, asserted one by one (not folded into the tables below) so a
  // regression on any single measured case fails on its own line.
  it("measured table: python -m pytest -q classifies as test (the regression this fix closes)", () => {
    expect(classifyCommandKind("python -m pytest -q")).toBe("test");
  });
  it("measured table: npm test classifies as test", () => {
    expect(classifyCommandKind("npm test")).toBe("test");
  });
  it("measured table: bun test classifies as test", () => {
    expect(classifyCommandKind("bun test")).toBe("test");
  });
  it("measured table: deno test classifies as test", () => {
    expect(classifyCommandKind("deno test")).toBe("test");
  });
  it("measured table: npm t classifies as test", () => {
    expect(classifyCommandKind("npm t")).toBe("test");
  });
  it("measured table: npx vitest run classifies as test", () => {
    expect(classifyCommandKind("npx vitest run")).toBe("test");
  });
  it("measured table: npm run testify classifies as other", () => {
    expect(classifyCommandKind("npm run testify")).toBe("other");
  });
  it("measured table: cat jest.config.js classifies as other", () => {
    expect(classifyCommandKind("cat jest.config.js")).toBe("other");
  });
  it("measured table: ls -la classifies as other", () => {
    expect(classifyCommandKind("ls -la")).toBe("other");
  });
  it("measured table: echo npm test classifies as other", () => {
    expect(classifyCommandKind("echo npm test")).toBe("other");
  });
  it("measured table: npm run build classifies as build", () => {
    expect(classifyCommandKind("npm run build")).toBe("build");
  });
  it("measured table: npm test && npm run build classifies as test (first-command rule)", () => {
    expect(classifyCommandKind("npm test && npm run build")).toBe("test");
  });

  const LAUNCHER_POSITIVE_TEST_COMMANDS = [
    "python -m pytest -q",
    "python -m unittest",
    "python3 -m pytest",
    "py -m pytest",
    "poetry run pytest",
    "uv run pytest -q",
    "pdm run pytest",
    "pipenv run pytest",
    "hatch run pytest",
    "npx jest --ci",
    "pnpm exec vitest",
    "pnpm dlx jest",
    "yarn dlx jest",
    "bunx jest",
  ];

  const LAUNCHER_NEGATIVE_COMMANDS = [
    "python -m http.server", // launcher resolves, but "http" is not a test/build/deploy program
    "npx create-next-app", // launcher resolves, but "create-next-app" is not a test runner
    "poetry run black .", // launcher resolves, but "black" is a formatter, not a test runner
    "dotnet build", // dotnet is a launcher, but "build" is dotnet's own pre-existing subcommand rule
    "grep -r \"npm test\" .", // grep is an ARGUMENT_CONSUMER — never a launcher
    "vim jest.config.js", // vim is an ARGUMENT_CONSUMER — never a launcher
  ];

  it.each(LAUNCHER_POSITIVE_TEST_COMMANDS)("classifies %j as test (launcher delegation)", (cmd) => {
    expect(classifyCommandKind(cmd)).toBe("test");
  });

  it.each(LAUNCHER_NEGATIVE_COMMANDS)("classifies %j as other, never test", (cmd) => {
    expect(classifyCommandKind(cmd)).not.toBe("test");
  });

  it("dotnet build still classifies as build specifically (not just 'not test')", () => {
    expect(classifyCommandKind("dotnet build")).toBe("build");
  });

  it("a launcher only resolves as the FIRST command, never as an argument to one", () => {
    // "echo" is an ARGUMENT_CONSUMER; the fact that its argument LOOKS like a launcher
    // invocation must not make this line classify as test.
    expect(classifyCommandKind("echo python -m pytest")).toBe("other");
  });

  it("FOO=1 npm test classifies as test: a leading environment assignment is stripped before " +
    "program resolution, so the underlying command is exactly 'npm test' — the assignment " +
    "itself carries no program identity and must not suppress the real invocation", () => {
    expect(classifyCommandKind("FOO=1 npm test")).toBe("test");
  });

  it("sudo npm test classifies as test: a leading sudo is stripped as a wrapper, not a program", () => {
    expect(classifyCommandKind("sudo npm test")).toBe("test");
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-command-kind-"));
  tmpDirs.push(dir);
  return path.join(dir, "ledger.jsonl");
}

describe("ledger/hook — writes command_kind for a Bash COMMAND_RUN, only a label, never the command text", () => {
  it("an 'npm test' PostToolUse event is recorded with command_kind:'test'", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({ session_id: "session:s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } });
    const result = runLedgerHook({ stdinText: payload, ledgerPath });
    expect(result.exitCode).toBe(0);
    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).toContain('"command_kind":"test"');
    expect(raw).not.toContain("npm test"); // the command text itself is never stored
  });

  it("an 'ls -la' PostToolUse event is recorded with command_kind:'other'", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({ session_id: "session:s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, tool_response: { exitCode: 0 } });
    runLedgerHook({ stdinText: payload, ledgerPath });
    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).toContain('"command_kind":"other"');
    expect(raw).not.toContain("ls -la");
  });

  it("a non-Bash TOOL_INVOCATION carries no command_kind at all (no command concept)", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({ session_id: "session:s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "ok" });
    runLedgerHook({ stdinText: payload, ledgerPath });
    const raw = fs.readFileSync(ledgerPath, "utf8");
    expect(raw).not.toContain("command_kind");
  });
});

describe("witness/sources/ledger — tests_pass binds only via command_kind:'test'", () => {
  it("an 'ls'-shaped PASS event does NOT witness a tests_pass claim (binds command_ran only)", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({ session_id: "session:ls1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, tool_response: { exitCode: 0 } });
    runLedgerHook({ stdinText: payload, ledgerPath });

    const { witnesses } = collectLedgerWitnesses(ledgerPath);
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].binds).toEqual(["command_ran"]);

    const claim = testsPassClaim("session:ls1");
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("UNWITNESSED");
  });

  it("an 'npm test'-shaped PASS event DOES witness a tests_pass claim", () => {
    const ledgerPath = tmpLedgerPath();
    const payload = JSON.stringify({ session_id: "session:npm1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } });
    runLedgerHook({ stdinText: payload, ledgerPath });

    const { witnesses } = collectLedgerWitnesses(ledgerPath);
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].binds).toEqual(["command_ran", "tests_pass"]);

    const claim = testsPassClaim("session:npm1");
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("WITNESSED");
  });

  it("a LEGACY event with no command_kind field at all does NOT witness tests_pass (absence is not evidence)", () => {
    const ledgerPath = tmpLedgerPath();
    // Simulates an event written before this fix, or by a foreign producer: a passing
    // COMMAND_RUN with no command_kind in its body whatsoever.
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      body: { exit_code: 0, session_id: "session:legacy1" },
    });
    const { witnesses } = collectLedgerWitnesses(ledgerPath);
    expect(witnesses[0].binds).toEqual(["command_ran"]);

    const claim = testsPassClaim("session:legacy1");
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("UNWITNESSED");
  });
});
