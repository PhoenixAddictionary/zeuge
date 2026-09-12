"use strict";
/**
 * ledger/command-kind — lexical classification of a command STRING into a coarse
 * `command_kind` label, computed once by the PostToolUse ledger hook and stored on the ledger
 * event instead of the command text itself (ledger/hook.ts's body never carries raw command
 * text — only hashes and this derived label).
 *
 * Root cause this file fixes: `collectLedgerWitnesses` used to bind the claim type
 * `tests_pass` to ANY COMMAND_RUN event with outcome PASS — a passing `ls` witnessed the
 * sentence "All tests pass." exactly as well as a passing `npm test` did. That contradicts the
 * package's own premise, that a claim is only as strong as the thing that actually witnessed
 * it. `command_kind` lets the binding pass (witness/sources/ledger.ts) require something that
 * at least LOOKS like a test invocation before it backs a `tests_pass` claim.
 *
 * The ORIGINAL classifier matched a small table of REGEXES against
 * the WHOLE command string, which was both evadable and trigger-happy. Confirmed misses: `bun
 * test` (no rule at all). Confirmed false positives: `npm run testify` (the substring "test" at
 * the front of a longer, unrelated script name) and `cat jest.config.js` (a command that merely
 * mentions a test tool's config file as an ARGUMENT to an unrelated program).
 *
 * The classifier now works on the INVOKED PROGRAM and its SUBCOMMAND — tokens of the first
 * simple command in the line — rather than a substring of the raw text:
 *   - A program known to consume another program's name only as an argument (cat, grep, ls,
 *     echo, less, head, tail, code, vim) short-circuits straight to "other": whatever
 *     runner-shaped text appears later on the line is not an invocation of it.
 *   - Every remaining check compares whole tokens (exact string equality, or an npm-style
 *     "test:*" scoped-script prefix) — never a substring — so "testify", "latest", "contest",
 *     and "attestation" can never match "test" by accident.
 *   - A pipeline or `&&`/`||`/`;` chain classifies by its FIRST command only (documented choice:
 *     see classifyCommandKind). `npm test && rm -rf dist` classifies as "test"; `echo hi && npm
 *     test` classifies as "other". Rationale: crediting a witness to a command that never
 *     actually reached the runner (because pipeline/`&&` short-circuited on an earlier failure)
 *     is a worse failure for this package's purpose than under-classifying a compound line as
 *     "other" — "when in doubt, return other."
 *
 * The program+subcommand rewrite above stopped matching a
 * program invoked THROUGH A LAUNCHER — `python -m pytest -q` classified as "other" because the
 * invoked program is `python`, not `pytest`, and no rule looked past it. That is a false
 * negative on one of the most common test invocations in the world. The classifier now also
 * resolves a small, documented set of LAUNCHERS that delegate to another program named later on
 * the same line, and classifies on the DELEGATED tokens in addition to the literal ones:
 *   - `python`/`python3`/`py -m <module>` — the module's first dotted segment is the effective
 *     program (`python -m pytest` -> `pytest`; `python -m unittest` -> `unittest`).
 *   - `poetry|uv|pdm|pipenv|hatch run <cmd>`, `pnpm exec|dlx <cmd>`, `yarn dlx <cmd>`,
 *     `npx|bunx|dotnet <cmd>` — the next token is the effective program.
 *   - `cargo`/`go` keep their pre-existing direct subcommand handling (unchanged).
 * A launcher only resolves when it is the line's FIRST command (after the existing &&/;/| split
 * and leading-noise stripping below) — it never turns an ARGUMENT into a program, so `cat
 * jest.config.js` and `echo npm test` are unaffected: `cat`/`echo` are not launchers, and the
 * ARGUMENT_CONSUMERS short-circuit still fires on them first. Classification runs on the
 * literal tokens AND (when a launcher matched) the delegated tokens — either one recognizing a
 * test/build/deploy shape wins — so no pre-existing direct rule (e.g. `dotnet test`) had to move.
 *
 * Also stripped before any of the above: leading environment assignments (`FOO=bar npm test`)
 * and a single leading `sudo`/`time` — cheap, single-pass, no shell-quoting semantics attempted.
 *
 * THREAT (declared, not fixed): this is still a lexical, not a semantic, classification. A
 * command matching the "test" table is not proof the suite ran meaningfully, exited for the
 * right reason, or covered anything — it is only stronger evidence than "some command exited
 * 0." A wrapper or alias whose name doesn't match this table (or a shell function/alias named
 * "test" that actually does something else) is classified by surface text, not by runtime
 * behavior. The ARGUMENT_CONSUMERS list and the runner tables below are a small, documented set
 * for common ecosystems, not an exhaustive one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyCommandKind = classifyCommandKind;
function tokenize(cmd) {
    return cmd.trim().split(/\s+/).filter(Boolean);
}
/** The bare program name a token invokes, stripping a leading path (`./gradlew` -> `gradlew`,
 *  `./vendor/bin/phpunit` -> `phpunit`) and a common Windows executable suffix, lowercased for
 *  matching. Declared gap: this does not attempt full shell-quoting/escaping semantics — same
 *  lexical-not-semantic spirit as the rest of this module. */
function programName(token) {
    if (!token)
        return "";
    const base = token.split(/[\\/]/).pop() ?? token;
    return base.replace(/\.(bat|cmd|exe|sh)$/i, "").toLowerCase();
}
/** Programs that consume another program's NAME only as an argument (a filename, a search
 *  pattern) — never as an invocation of it. If the invoked program is one of these, the line
 *  classifies as "other" immediately, before any runner table is even consulted. */
const ARGUMENT_CONSUMERS = new Set(["cat", "grep", "ls", "echo", "less", "head", "tail", "code", "vim"]);
/** A leading environment assignment (`FOO=bar cmd`) never IS the program; strip any number of
 *  them, then at most one leading `sudo`/`time` (a wrapper program, not the delegated one), then
 *  any environment assignments that followed it (`sudo FOO=bar cmd`). Cheap and single-pass —
 *  no attempt at full shell-quoting/escaping semantics, same declared-gap spirit as the rest of
 *  this module. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const LEADING_WRAPPER_PROGRAMS = new Set(["sudo", "time"]);
function stripLeadingNoise(tokens) {
    let i = 0;
    while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i]))
        i++;
    if (i < tokens.length && LEADING_WRAPPER_PROGRAMS.has(programName(tokens[i]))) {
        i++;
        while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i]))
            i++;
    }
    return tokens.slice(i);
}
/** Launchers that delegate to another program named later on the line. A launcher
 *  only resolves against the FIRST token of the (already noise-stripped) command — it is never
 *  matched against an argument, so it cannot be smuggled in past `cat`/`echo`/etc. */
const PY_MODULE_LAUNCHERS = new Set(["python", "python3", "py"]);
const RUN_SUBCOMMAND_LAUNCHERS = new Set(["poetry", "uv", "pdm", "pipenv", "hatch"]);
const TWO_WORD_EXEC_LAUNCHERS = new Set(["pnpm exec", "pnpm dlx", "yarn dlx"]);
const ONE_WORD_EXEC_LAUNCHERS = new Set(["npx", "bunx", "dotnet"]);
/** Resolves a launcher's FIRST token into the tokens of the command it DELEGATES to, so
 *  classification can run against the program actually doing the work (`python -m pytest -q`
 *  -> `["pytest", "-q"]`). Returns null when tokens[0] is not a recognized launcher shape;
 *  callers then fall back to classifying the literal tokens only. */
function resolveDelegatedTokens(tokens) {
    if (tokens.length === 0)
        return null;
    const prog = programName(tokens[0]);
    // python/python3/py -m <module>[.<...>] [args...] -> classify on the module's first dotted
    // segment (python -m pytest -> pytest; python -m unittest -> unittest).
    if (PY_MODULE_LAUNCHERS.has(prog) && tokens[1] === "-m" && tokens.length >= 3) {
        const moduleFirstSegment = tokens[2].split(".")[0] || tokens[2];
        return [moduleFirstSegment, ...tokens.slice(3)];
    }
    // poetry|uv|pdm|pipenv|hatch run <cmd> [args...] -> classify on <cmd>.
    if (RUN_SUBCOMMAND_LAUNCHERS.has(prog) && tokens[1] === "run" && tokens.length >= 3) {
        return tokens.slice(2);
    }
    // pnpm exec|dlx, yarn dlx <cmd> [args...] -> classify on <cmd>.
    if (tokens.length >= 3 && TWO_WORD_EXEC_LAUNCHERS.has(`${prog} ${(tokens[1] ?? "").toLowerCase()}`)) {
        return tokens.slice(2);
    }
    // npx, bunx, dotnet <cmd> [args...] -> classify on <cmd>.
    if (ONE_WORD_EXEC_LAUNCHERS.has(prog) && tokens.length >= 2) {
        return tokens.slice(1);
    }
    return null;
}
const NPM_LIKE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** Matches `<mgr> <scriptName>` (an npm-ecosystem bare script alias — pnpm/yarn support this
 *  for any script; npm only for a caller-supplied set of aliases, e.g. "test"/"t") or
 *  `<mgr> run[-script] <scriptName>[:<anything>]` — a colon-scoped npm script name (e.g.
 *  "test:unit") counts, a DIFFERENT script that merely starts with the same letters (e.g.
 *  "testify") does not, because the comparison is against the WHOLE token, not a substring. */
function isScriptInvocation(tokens, scriptName, opts = {}) {
    if (tokens.length < 2)
        return false;
    const mgr = programName(tokens[0]);
    if (!NPM_LIKE_MANAGERS.has(mgr))
        return false;
    const second = tokens[1];
    if (mgr === "npm") {
        if (opts.npmBareAliases?.includes(second))
            return true;
    }
    else if (opts.bareAliasForOthers !== false && second === scriptName) {
        return true;
    }
    if ((second === "run" || second === "run-script") && tokens.length >= 3) {
        const script = tokens[2];
        return script === scriptName || script.startsWith(`${scriptName}:`);
    }
    return false;
}
// "unittest" is included for the `python -m unittest` delegated form — it has no
// meaningful standalone CLI of its own, so this only ever fires via resolveDelegatedTokens.
const STANDALONE_TEST_PROGRAMS = new Set(["vitest", "jest", "pytest", "rspec", "phpunit", "unittest"]);
function isStandaloneTestProgram(tokens) {
    if (tokens.length === 0)
        return false;
    const prog = programName(tokens[0]);
    if (STANDALONE_TEST_PROGRAMS.has(prog))
        return true;
    if (prog === "bundle" && tokens[1] === "exec" && programName(tokens[2]) === "rspec")
        return true; // bundle exec rspec
    return false;
}
function isNpxTestInvocation(tokens) {
    if (tokens.length < 2 || programName(tokens[0]) !== "npx")
        return false;
    const target = programName(tokens[1]);
    return target === "vitest" || target === "jest";
}
/** `<program> <subcommand>` runners whose subcommand token must appear EXACTLY (word-boundary
 *  by construction — this is an array-membership / equality check, never a regex substring). */
function isSubcommandTestInvocation(tokens) {
    if (tokens.length < 2)
        return false;
    const prog = programName(tokens[0]);
    if (prog === "node" && tokens[1] === "--test")
        return true;
    if (prog === "deno" && tokens[1] === "test")
        return true;
    if (prog === "bun" && tokens[1] === "test")
        return true;
    if (prog === "cargo" && tokens[1] === "test")
        return true;
    if (prog === "go" && tokens[1] === "test")
        return true;
    if (prog === "dotnet" && tokens[1] === "test")
        return true;
    if (prog === "mvn" && tokens.includes("test"))
        return true; // e.g. "mvn -B test", "mvn clean test"
    if (prog === "gradlew" && tokens.slice(1).includes("test"))
        return true; // ./gradlew test, gradlew.bat test
    return false;
}
function isTestInvocation(tokens) {
    return (isScriptInvocation(tokens, "test", { npmBareAliases: ["test", "t"] }) ||
        isNpxTestInvocation(tokens) ||
        isStandaloneTestProgram(tokens) ||
        isSubcommandTestInvocation(tokens));
}
function isBuildInvocation(tokens) {
    if (isScriptInvocation(tokens, "build", { npmBareAliases: [] }))
        return true; // npm: run-only, matches original scope
    const prog = programName(tokens[0]);
    if (prog === "tsc")
        return true;
    if (prog === "webpack")
        return true;
    if (prog === "vite" && tokens[1] === "build")
        return true;
    if (prog === "cargo" && tokens[1] === "build")
        return true;
    if (prog === "go" && tokens[1] === "build")
        return true;
    if (prog === "dotnet" && tokens[1] === "build")
        return true;
    if (prog === "mvn" && tokens.includes("package"))
        return true;
    if (prog === "gradlew" && tokens.slice(1).includes("build"))
        return true;
    if (prog === "make" && tokens[1] === "build")
        return true;
    return false;
}
function isDeployInvocation(tokens) {
    if (isScriptInvocation(tokens, "deploy", { npmBareAliases: [], bareAliasForOthers: false }))
        return true; // npm run deploy only, matches original scope
    const prog = programName(tokens[0]);
    if (prog === "vercel" && tokens[1] === "deploy")
        return true;
    if (prog === "netlify" && tokens[1] === "deploy")
        return true;
    if (prog === "git" && tokens[1] === "push" && tokens[2] === "heroku")
        return true;
    if (prog === "kubectl" && tokens[1] === "apply")
        return true;
    if (prog === "terraform" && tokens[1] === "apply")
        return true;
    if (prog === "cdk" && tokens[1] === "deploy")
        return true;
    if (prog === "serverless" && tokens[1] === "deploy")
        return true;
    if (prog === "sls" && tokens[1] === "deploy")
        return true;
    if (prog === "fly" && tokens[1] === "deploy")
        return true;
    return false;
}
/** Classifies a raw command string into one of the four coarse kinds. Never called with, and
 *  never returns, the command text itself — only the label. An empty, unrecognized, or
 *  ambiguous command classifies as "other": absence of a recognizable shape is not evidence
 *  either way, and a missed classification is the SAFER failure mode here than a
 *  false one (see module doc). */
function classifyCommandKind(command) {
    const normalized = command.trim();
    if (normalized.length === 0)
        return "other";
    // A pipeline or &&/||/; chain classifies by its FIRST command only (documented in the module
    // doc) — a later stage never retroactively makes the whole line a "test" run.
    const firstSegment = normalized.split(/&&|\|\||;|\|/)[0]?.trim() ?? "";
    if (firstSegment.length === 0)
        return "other";
    const rawTokens = tokenize(firstSegment);
    if (rawTokens.length === 0)
        return "other";
    const tokens = stripLeadingNoise(rawTokens);
    if (tokens.length === 0)
        return "other";
    if (ARGUMENT_CONSUMERS.has(programName(tokens[0])))
        return "other";
    // Also classify on the launcher's DELEGATED tokens (python -m pytest -> pytest,
    // npx jest -> jest, ...). Either the literal tokens or the delegated ones matching wins — a
    // pre-existing direct rule (e.g. dotnet test) still fires on the literal tokens unchanged.
    const delegated = resolveDelegatedTokens(tokens);
    if (isTestInvocation(tokens) || (delegated !== null && isTestInvocation(delegated)))
        return "test";
    if (isBuildInvocation(tokens) || (delegated !== null && isBuildInvocation(delegated)))
        return "build";
    if (isDeployInvocation(tokens) || (delegated !== null && isDeployInvocation(delegated)))
        return "deploy";
    return "other";
}
