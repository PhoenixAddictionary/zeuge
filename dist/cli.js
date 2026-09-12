"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const lint_runner_1 = require("./lint-runner");
const run_1 = require("./claim/run");
const hook_1 = require("./claim/hook");
const detect_1 = require("./claim/detect");
const append_1 = require("./ledger/append");
const verify_1 = require("./ledger/verify");
const hook_2 = require("./ledger/hook");
const ledger_1 = require("./witness/sources/ledger");
const bundle_1 = require("./receipt/bundle");
const verify_2 = require("./receipt/verify");
const report_1 = require("./receipt/report");
const state_1 = require("./license/state");
const polar_1 = require("./license/providers/polar");
const paths_1 = require("./license/paths");
const binding_1 = require("./witness/binding");
const HELP = `zeuge — a verification and receipt layer for AI coding agents

Usage:
  zeuge --help
  zeuge lint <path> [--json] [--experimental-order] [--strict]
  zeuge claim hook --event <Stop|PostToolUse> [--json]
  zeuge claim detect [<file>] [--stdin] [--json] [--session <id>]
  zeuge claim rules --list|--sha256
  zeuge ledger append --event <file> [--ledger <path>]
  zeuge ledger verify [<path>] [--expected-head <hex>] [--json]
  zeuge ledger head [<path>]
  zeuge licence set <key> [--org <id>]
  zeuge licence status [--json]

Commands:
  lint          Scan <path> for hook-matcher findings (always) and, with
                --experimental-order, the tightened instruction-order rule
                (off by default — see FIELD_TEST_NOTE / README). Every
                finding carries a severity (fault|risk|review); exit 1 by
                default only on a fault, or on any finding with --strict.
                Exit 0 clean · 1 finding(s) · 3 integrity failure.
  claim hook    Stdin JSON in (a Stop/PostToolUse hook payload), stdout
                hookSpecificOutput out. Exit 0 always; never blocks.
  claim detect  Detect claim candidates in <file> or stdin. Runs the
                positive-control probe first: exit 3 and no
                claim records if the probe is DEAD. --session stamps a
                real session id on every emitted claim (default: the
                placeholder "unknown session" id) so a later bundle
                pass can bind it against same-session witnesses.
  claim rules   List the detection rules, or print their combined sha256.
  ledger append Append one hash-chained event. Refuses (exit 3) onto an
                already-invalid ledger, leaving it byte-identical.
  ledger verify Re-derive every hash; report {ok,event_count,head_hash,issues}.
  ledger head   Print the current head_hash.
  bundle        Assemble+sign a zeuge.bundle.v1 from --claims/--coverage/--ledger.
  verify        Verify a bundle offline. Exit 0 clean · 1 gate · 3 integrity failure.
                --require-witnessed is Pro-gated: exit 4 if the licence state is
                EXPIRED/REVOKED/UNKNOWN. Plain verify (no flag) is free.
  report        Render a single-file HTML Claim Audit Report from a bundle.
                Pro-gated: exit 4 if the licence state is EXPIRED/REVOKED/UNKNOWN.
  licence set   Store a licence key locally (.zeuge/licence.json).
  licence status  Validate the stored key against Polar (the only network call
                anywhere in this package) and cache the result with a 14-day
                offline grace window. lint/claim/ledger are never gated.

Options:
  --json  Machine-readable output.
  --help  Show this message.
`;
function printHelp(write) {
    write(HELP);
}
function defaultLedgerPath() {
    return path.join(process.cwd(), ".zeuge", "ledger.jsonl");
}
function runLintCommand(args, write) {
    const jsonFlag = args.includes("--json");
    const experimentalOrder = args.includes("--experimental-order");
    const strict = args.includes("--strict");
    const positional = args.filter((a) => a !== "--json" && a !== "--experimental-order" && a !== "--strict");
    const target = positional[0] ?? ".";
    const root = path.resolve(target);
    const report = (0, lint_runner_1.runLint)(root, { experimentalOrder, strict });
    if (jsonFlag) {
        write(JSON.stringify({
            root: report.root,
            scanned: report.scanned,
            totalFindings: report.totalFindings,
            counts: report.counts,
            parseErrors: report.parseErrors,
            nothingScanned: report.nothingScanned,
            reason: report.reason,
            entries: report.entries,
            blindSpots: report.blindSpots,
            notes: report.notes,
            experimentalOrder: report.experimentalOrder,
            strict: report.strict,
            exitCode: report.exitCode,
        }, null, 2) + "\n");
    }
    else {
        write((0, lint_runner_1.formatReport)(report) + "\n");
    }
    return report.exitCode;
}
const CLI_DEFAULT_AGENT = {
    id: "agent:00000000000000000000000000000000",
    vendor: "anthropic",
    model: "unknown",
    harness: "claude-code",
    harness_version: "unknown",
};
/** True for a parsed JSON value that looks like a Claude Code hook payload (Stop/PostToolUse
 *  shape), as opposed to an arbitrary JSON object that happens to be the text under test. Only
 *  these fields trigger payload extraction — anything else falls through and is scanned as
 *  literal text, same as always. */
function looksLikeHookPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const obj = value;
    return "last_assistant_message" in obj || "transcript_path" in obj || "transcript" in obj || "hook_event_name" in obj;
}
/** `claim detect` accepts either raw text (the original contract) or a
 *  hook-payload-shaped JSON object (the same shape claim/hook.ts's Stop wiring receives) on
 *  --stdin or from a file. When the input parses as JSON and looks like a hook payload, the
 *  turn text is extracted via the SAME resolveTurnText logic the real Stop hook uses (so a
 *  human can rehearse detection against a captured hook payload without hand-extracting the
 *  text first); a resolution failure (an unreadable transcript_path) is reported, not silently
 *  treated as "no text." Anything else — plain prose, or JSON that is not hook-shaped — is
 *  scanned as literal text, unchanged from before. */
function resolveDetectInput(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            return { text: raw }; // not actually JSON — fall through to literal-text scanning
        }
        if (looksLikeHookPayload(parsed)) {
            const resolved = (0, hook_1.resolveTurnText)(parsed);
            return { text: resolved.text, transcriptUnreadable: resolved.transcriptUnreadable };
        }
    }
    return { text: raw };
}
function runClaimDetectCommand(args, write, writeErr, readStdin) {
    const jsonFlag = args.includes("--json");
    const stdinFlag = args.includes("--stdin");
    const sessionIdx = args.indexOf("--session");
    const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : binding_1.PLACEHOLDER_SESSION;
    const positional = args.filter((a, i) => a !== "--json" && a !== "--stdin" && a !== "--session" && args[i - 1] !== "--session");
    let raw;
    if (stdinFlag || positional.length === 0) {
        raw = readStdin();
    }
    else {
        try {
            raw = fs.readFileSync(positional[0], "utf8");
        }
        catch (err) {
            writeErr(`zeuge claim detect: cannot read ${positional[0]}: ${err.message}\n`);
            return 2;
        }
    }
    const { text, transcriptUnreadable } = resolveDetectInput(raw);
    if (transcriptUnreadable) {
        writeErr(`zeuge claim detect: transcript unreadable: ${transcriptUnreadable.errorClass} — cannot check claims this turn\n`);
        return 3;
    }
    const result = (0, run_1.runClaimPass)({
        text,
        sessionId,
        agent: CLI_DEFAULT_AGENT,
        source: "cli.detect",
    });
    if (jsonFlag) {
        write(JSON.stringify({ coverage: result.coverage, claims: result.claims }) + "\n");
    }
    else {
        write(`probe: ${result.coverage.probe}\n`);
        if (result.coverage.probe === "DEAD") {
            writeErr(`zeuge claim detect: probe DEAD, missing ${JSON.stringify(result.coverage.probe_missing)} — no claim records emitted\n`);
        }
        else {
            for (const c of result.claims)
                write(`${c.claim_type}\t${c.statement}\n`);
        }
    }
    // A run whose own positive control cannot fire proves nothing about the rest
    // of the run, so it is an integrity failure, not "zero findings."
    if (result.coverage.probe === "DEAD")
        return 3;
    return 0;
}
function runClaimRulesCommand(args, write) {
    if (args.includes("--sha256")) {
        write((0, detect_1.rulesSha256)(detect_1.DEFAULT_RULES) + "\n");
        return 0;
    }
    write(JSON.stringify(detect_1.DEFAULT_RULES, null, 2) + "\n");
    return 0;
}
function runClaimHookCommand(args, write, readStdin) {
    const jsonFlag = args.includes("--json");
    const eventIdx = args.indexOf("--event");
    const eventName = eventIdx >= 0 ? args[eventIdx + 1] : "Stop";
    const result = (0, hook_1.runClaimHook)({ stdinText: readStdin(), eventName, jsonMode: jsonFlag });
    write(result.stdout);
    return result.exitCode;
}
function runClaimCommand(args, write, writeErr, readStdin) {
    const [sub, ...rest] = args;
    switch (sub) {
        case "hook":
            return runClaimHookCommand(rest, write, readStdin);
        case "detect":
            return runClaimDetectCommand(rest, write, writeErr, readStdin);
        case "rules":
            return runClaimRulesCommand(rest, write);
        default:
            writeErr(`zeuge claim: unknown subcommand "${sub ?? ""}" (expected hook | detect | rules)\n`);
            return 2;
    }
}
function runLedgerAppendCommand(args, write, writeErr) {
    const jsonFlag = args.includes("--json");
    const eventIdx = args.indexOf("--event");
    const ledgerIdx = args.indexOf("--ledger");
    if (eventIdx < 0 || !args[eventIdx + 1]) {
        writeErr("zeuge ledger append: --event <file> is required\n");
        return 2;
    }
    const ledgerPath = ledgerIdx >= 0 ? args[ledgerIdx + 1] : defaultLedgerPath();
    let params;
    try {
        params = JSON.parse(fs.readFileSync(args[eventIdx + 1], "utf8"));
    }
    catch (err) {
        writeErr(`zeuge ledger append: cannot read event file: ${err.message}\n`);
        return 2;
    }
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const p = params;
    const result = (0, append_1.appendEvent)(ledgerPath, {
        eventFamily: p.eventFamily,
        actionType: p.actionType,
        outcome: p.outcome,
        actor: p.actor,
        body: p.body,
    });
    if (!result.ok) {
        // A lock-contention refusal carries a machine-readable issueCode
        // (currently only "LOCK_HELD") alongside the human `reason`, visible in --json.
        if (jsonFlag) {
            write(JSON.stringify({
                ok: false,
                code: result.code,
                reason: result.reason,
                issueCode: result.issueCode,
                ...(result.issueCode === "LOCK_HELD" ? { lockHolderPid: result.lockHolderPid, lockDetail: result.lockDetail } : {}),
            }) + "\n");
        }
        else {
            writeErr(`zeuge ledger append: ${result.reason}\n`);
        }
        return 3;
    }
    if (jsonFlag) {
        write(JSON.stringify({ ok: true, event: result.event }) + "\n");
    }
    else {
        write(JSON.stringify(result.event) + "\n");
    }
    return 0;
}
function runLedgerVerifyCommand(args, write) {
    const jsonFlag = args.includes("--json");
    const headIdx = args.indexOf("--expected-head");
    const expectedHead = headIdx >= 0 ? args[headIdx + 1] : undefined;
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--expected-head");
    const ledgerPath = positional[0] ?? defaultLedgerPath();
    const result = (0, verify_1.verifyLedgerFile)(ledgerPath, { expectedHead });
    // A ledger with no --expected-head can verify ok:true while missing a truncated tail —
    // the chain math is genuinely correct, but "correct" and "intact" are different claims.
    // head_binding makes that gap visible instead of letting ok:true read as "nothing missing."
    const headBinding = expectedHead !== undefined ? "BOUND" : "UNBOUND";
    const unboundNote = "truncation is not detectable without --expected-head; bind the head out of band";
    if (jsonFlag) {
        write(JSON.stringify({
            ok: result.ok,
            event_count: result.event_count,
            head_hash: result.head_hash,
            issues: result.issues,
            head_binding: headBinding,
            ...(headBinding === "UNBOUND" ? { note: unboundNote } : {}),
        }) + "\n");
    }
    else {
        write(`ok: ${result.ok}\nevent_count: ${result.event_count}\nhead_hash: ${result.head_hash}\n`);
        if (headBinding === "UNBOUND") {
            write(`head binding: UNBOUND — truncation not detectable\n`);
        }
        else {
            write(`head binding: BOUND\n`);
        }
        for (const i of result.issues)
            write(`  issue at seq ${i.seq ?? "-"}: ${i.message}\n`);
    }
    return result.ok ? 0 : 3;
}
function runLedgerHeadCommand(args, write) {
    const ledgerPath = args.filter((a) => !a.startsWith("--"))[0] ?? defaultLedgerPath();
    const result = (0, verify_1.verifyLedgerFile)(ledgerPath);
    write(result.head_hash + "\n");
    return result.ok ? 0 : 3;
}
function runLedgerHookCommand(write, readStdin) {
    const result = (0, hook_2.runLedgerHook)({ stdinText: readStdin() });
    write(result.stdout);
    return result.exitCode;
}
function runLedgerCommand(args, write, writeErr, readStdin) {
    const [sub, ...rest] = args;
    switch (sub) {
        case "append":
            return runLedgerAppendCommand(rest, write, writeErr);
        case "verify":
            return runLedgerVerifyCommand(rest, write);
        case "head":
            return runLedgerHeadCommand(rest, write);
        case "hook":
            return runLedgerHookCommand(write, readStdin);
        default:
            writeErr(`zeuge ledger: unknown subcommand "${sub ?? ""}" (expected append | verify | head | hook)\n`);
            return 2;
    }
}
function argValue(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}
function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function runBundleCommand(args, write, writeErr) {
    const claimsPath = argValue(args, "--claims");
    const coveragePath = argValue(args, "--coverage");
    const ledgerPath = argValue(args, "--ledger");
    const sessionId = argValue(args, "--session") ?? binding_1.PLACEHOLDER_SESSION;
    const outPath = argValue(args, "--out");
    const sign = args.includes("--sign");
    if (!claimsPath || !coveragePath || !outPath) {
        writeErr("zeuge bundle: --claims <file>, --coverage <file>, and --out <file> are required (--ledger, --session, --sign optional)\n");
        return 2;
    }
    let claims;
    let coverage;
    try {
        claims = readJsonFile(claimsPath);
        coverage = readJsonFile(coveragePath);
    }
    catch (err) {
        writeErr(`zeuge bundle: cannot read input: ${err.message}\n`);
        return 2;
    }
    // Item 4: a claim carrying a KNOWN session that DIFFERS from the bundle's own (also known)
    // --session is an integrity failure, not a silent skip — bundling it anyway would let a
    // claim from one session ride inside a bundle labeled with another. Only fires when the
    // bundle's own session is itself known (real --session given); an unknown bundle session has
    // nothing confirmed to disagree with.
    if (!(0, binding_1.isUnknownSession)(sessionId)) {
        const mismatched = claims.find((c) => !(0, binding_1.isUnknownSession)(c.session_id) && c.session_id !== sessionId);
        if (mismatched) {
            writeErr(`zeuge bundle: SESSION_MISMATCH — claim ${mismatched.claim_id} carries session_id "${mismatched.session_id}", which differs from --session "${sessionId}"; refusing to bundle a claim under the wrong session\n`);
            return 3;
        }
    }
    let witnesses = [];
    let referencedLedgerEvents = [];
    let ledgerSummary = { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] };
    if (ledgerPath) {
        const verification = (0, verify_1.verifyLedgerFile)(ledgerPath);
        if (!verification.ok) {
            writeErr("zeuge bundle: ledger does not verify; refusing to bundle witnesses from an invalid ledger\n");
            return 3;
        }
        const collected = (0, ledger_1.collectLedgerWitnesses)(ledgerPath);
        witnesses = collected.witnesses;
        const referencedIds = new Set(witnesses.map((w) => w.locator));
        referencedLedgerEvents = collected.events.filter((e) => referencedIds.has(e.event_id));
        ledgerSummary = {
            ledger_id: collected.events[0]?.ledger_id ?? "ledger:none",
            head_hash: verification.head_hash,
            event_count: verification.event_count,
            segments: Array.from({ length: verification.segments }, (_, i) => ({ name: `segment-${i}`, head_hash: verification.head_hash })),
        };
    }
    const unsigned = (0, bundle_1.buildBundle)({
        sessionId,
        agent: {},
        subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/unknown", dirty: false, dirty_paths_sha256: null },
        claims,
        witnesses,
        ledger: ledgerSummary,
        coverage,
        referencedLedgerEvents,
    });
    const bundle = (0, bundle_1.finalizeBundle)(unsigned, { sign, zeugeDir: path.join(process.cwd(), ".zeuge") });
    (0, bundle_1.writeBundle)(bundle, outPath);
    write(`bundle written: ${outPath}\nbundle_id: ${bundle.bundle_id}\nbundle_sha256: ${bundle.bundle_sha256}\n`);
    return 0;
}
/**
 * Where the licence key (and its co-located cache) actually lives — resolved via
 * license/paths.ts instead of a bare `path.join(process.cwd(), ".zeuge")`, so a fresh `licence
 * set` writes to the platform's per-user config directory by default, never into whatever
 * project happens to be the current working directory. An existing project-local key is still
 * read (upgrade path), but flagged with a one-line warning when that project is a git work tree
 * — printed via writeErr exactly once per call site that resolves it.
 */
function resolveLicenseZeugeDir(writeErr) {
    const resolved = (0, paths_1.resolveLicenseDir)();
    const warning = (0, paths_1.licenseDirWarning)(resolved);
    if (warning)
        writeErr(warning);
    return resolved.dir;
}
/**
 * The licence gate every Pro-gated command calls. Purely local — resolveLocalLicenseState
 * never makes a network call (that is `licence status`'s job alone) — so a Pro command's own
 * gate check can never be the thing that phones home. Prints the one stderr line the spec
 * calls for (grace remaining, or the block reason) and returns whether to proceed.
 */
function checkLicenseGate(writeErr) {
    const zeugeDir = resolveLicenseZeugeDir(writeErr);
    const gate = (0, state_1.resolveLocalLicenseState)(zeugeDir);
    if (gate.message)
        writeErr(`[zeuge] licence: ${gate.message}\n`);
    return { blocked: gate.blocked };
}
function runVerifyCommand(args, write, writeErr) {
    const jsonFlag = args.includes("--json");
    const requireWitnessed = args.includes("--require-witnessed");
    const positional = args.filter((a) => !a.startsWith("--"));
    const bundlePath = positional[0];
    if (!bundlePath) {
        writeErr("zeuge verify: <bundle.json> is required\n");
        return 2;
    }
    // Pro-gated ONLY under --require-witnessed (spec §6): plain `verify` stays free.
    if (requireWitnessed && checkLicenseGate(writeErr).blocked) {
        return 4;
    }
    let bundle;
    try {
        bundle = readJsonFile(bundlePath);
    }
    catch (err) {
        writeErr(`zeuge verify: cannot parse bundle: ${err.message}\n`);
        return 3;
    }
    const verdict = (0, verify_2.verifyBundle)(bundle, { requireWitnessed });
    if (jsonFlag) {
        write(JSON.stringify({ ok: verdict.ok, issues: verdict.issues, authenticity: "LOCAL_ONLY" }) + "\n");
    }
    else {
        write(`ok: ${verdict.ok}\nauthenticity: LOCAL_ONLY\n`);
        for (const i of verdict.issues)
            write(`  [${i.code}] ${i.message}\n`);
    }
    if (verdict.integrityFailure)
        return 3;
    if (verdict.gateFinding)
        return 1;
    return 0;
}
function runReportCommand(args, write, writeErr) {
    const flagValueIndices = new Set();
    ["--html", "--out"].forEach((flag) => {
        const i = args.indexOf(flag);
        if (i >= 0)
            flagValueIndices.add(i + 1);
    });
    const positional = args.filter((a, i) => !a.startsWith("--") && !flagValueIndices.has(i));
    const bundlePath = positional[0];
    const outPath = argValue(args, "--html") ?? argValue(args, "--out");
    if (!bundlePath || !outPath) {
        writeErr("zeuge report: <bundle.json> --html <out.html> are required\n");
        return 2;
    }
    // `report` is Pro-gated outright (spec §6).
    if (checkLicenseGate(writeErr).blocked) {
        return 4;
    }
    let bundle;
    try {
        bundle = readJsonFile(bundlePath);
    }
    catch (err) {
        writeErr(`zeuge report: cannot parse bundle: ${err.message}\n`);
        return 3;
    }
    const result = (0, report_1.renderReport)(bundle);
    if (!result.ok) {
        writeErr(`zeuge report: ${result.reason}\n`);
        return 1;
    }
    fs.writeFileSync(outPath, result.html, "utf8");
    write(`report written: ${outPath}\n`);
    return 0;
}
/** `zeuge licence set <key> [--org <id>]` — stores the key locally. Never touches the network. */
function runLicenceSetCommand(args, write, writeErr) {
    const org = argValue(args, "--org");
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--org");
    const key = positional[0];
    if (!key) {
        writeErr("zeuge licence set: <key> is required\n");
        return 2;
    }
    const zeugeDir = resolveLicenseZeugeDir(writeErr);
    (0, state_1.setLicenseKey)(zeugeDir, key, org);
    write(`licence key stored${org ? ` (organization_id: ${org})` : ""} at ${path.join(zeugeDir, "licence.json")}\n`);
    return 0;
}
// Said once here and echoed on every human-facing `licence status` run: offline
// licence validation is a convenience for honest users, not a security boundary. The source is
// open (MIT) and the check is trivially removable; revocation only takes effect the next time
// this command can reach the provider. Never call this mechanism "secure", "protected", or
// "tamper-proof" — see src/license/cache.ts's header for the full reasoning.
const LICENSE_TRUTH_NOTE = "note: offline licence validation is a convenience for honest users, not a security boundary. " +
    "This package is open source (MIT) and the check can be removed from a local copy in minutes. " +
    "Revocation only takes effect the next time this command can reach the provider.";
/**
 * `zeuge licence status [--json]` — the ONLY command (besides `set`, which makes no network
 * call at all) that ever reaches the network: refreshLicenseStatus calls the Polar provider
 * unless ZEUGE_OFFLINE=1. This command itself is never gated — a locked-out user must always
 * be able to ask why.
 */
async function runLicenceStatusCommand(args, write, writeErr) {
    const jsonFlag = args.includes("--json");
    const zeugeDir = resolveLicenseZeugeDir(writeErr);
    const provider = (0, polar_1.createPolarProvider)();
    const result = await (0, state_1.refreshLicenseStatus)(zeugeDir, provider);
    const clock = result.clockMovedBackward ? "CLOCK_MOVED_BACKWARD" : "OK";
    if (jsonFlag) {
        write(JSON.stringify({
            state: result.state,
            verdict: result.verdict,
            organization_id: (0, state_1.resolveOrganizationId)(zeugeDir) ?? null,
            clock,
            note: LICENSE_TRUTH_NOTE,
        }) + "\n");
    }
    else {
        write(`state: ${result.state}\nprovider: ${result.verdict.provider}\ndetail: ${result.verdict.detail}\nclock: ${clock}\n`);
        if (result.clockMovedBackward) {
            write("  system clock reads earlier than a previously observed time — grace held steady, not extended\n");
        }
        write(`${LICENSE_TRUTH_NOTE}\n`);
    }
    return 0;
}
function runLicenceCommand(args, write, writeErr) {
    const [sub, ...rest] = args;
    switch (sub) {
        case "set":
            return runLicenceSetCommand(rest, write, writeErr);
        case "status":
            return runLicenceStatusCommand(rest, write, writeErr);
        default:
            writeErr(`zeuge licence: unknown subcommand "${sub ?? ""}" (expected set | status)\n`);
            return 2;
    }
}
function defaultReadStdin() {
    try {
        return fs.readFileSync(0, "utf8");
    }
    catch {
        return "";
    }
}
function main(argv, io = {
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
}) {
    const args = argv.slice(2);
    const readStdin = io.readStdin ?? defaultReadStdin;
    if (args.length === 0) {
        printHelp(io.writeErr);
        return 1;
    }
    if (args.includes("--help") || args.includes("-h")) {
        printHelp(io.write);
        return 0;
    }
    const [cmd, ...rest] = args;
    switch (cmd) {
        case "lint":
            return runLintCommand(rest, io.write);
        case "claim":
            return runClaimCommand(rest, io.write, io.writeErr, readStdin);
        case "ledger":
            return runLedgerCommand(rest, io.write, io.writeErr, readStdin);
        case "bundle":
            return runBundleCommand(rest, io.write, io.writeErr);
        case "verify":
            return runVerifyCommand(rest, io.write, io.writeErr);
        case "report":
            return runReportCommand(rest, io.write, io.writeErr);
        case "licence":
            // The only command whose implementation can be async (licence status's live network
            // call). Every other command above stays a plain, synchronously-returned number, so
            // every existing caller that does `const code = main(...)` without awaiting is
            // unaffected — `await` on a plain number is a no-op that yields the number itself.
            return runLicenceCommand(rest, io.write, io.writeErr);
        default:
            io.writeErr(`zeuge: unknown command "${cmd}"\n`);
            printHelp(io.writeErr);
            return 1;
    }
}
