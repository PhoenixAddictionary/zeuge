import * as fs from "node:fs";
import * as path from "node:path";
import { runLint, formatReport } from "./lint-runner";
import { runClaimPass } from "./claim/run";
import { runClaimHook, resolveTurnText } from "./claim/hook";
import { DEFAULT_RULES, rulesSha256 } from "./claim/detect";
import { appendEvent } from "./ledger/append";
import { verifyLedgerFile } from "./ledger/verify";
import { runLedgerHook } from "./ledger/hook";
import type { AgentInfo, ClaimRecord } from "./claim/record";
import { collectLedgerWitnesses } from "./witness/sources/ledger";
import { buildBundle, finalizeBundle, writeBundle, Bundle } from "./receipt/bundle";
import { verifyBundle } from "./receipt/verify";
import { renderReport } from "./receipt/report";
import type { Witness } from "./witness/source";
import type { CoverageBlock } from "./claim/probe";
import { setLicenseKey, resolveLocalLicenseState, refreshLicenseStatus, resolveOrganizationId } from "./license/state";
import { createPolarProvider } from "./license/providers/polar";
import { resolveLicenseDir, licenseDirWarning } from "./license/paths";
import { PLACEHOLDER_SESSION, isUnknownSession } from "./witness/binding";

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

function printHelp(write: (s: string) => void): void {
  write(HELP);
}

function defaultLedgerPath(): string {
  return path.join(process.cwd(), ".zeuge", "ledger.jsonl");
}

function runLintCommand(args: string[], write: (s: string) => void): number {
  const jsonFlag = args.includes("--json");
  const experimentalOrder = args.includes("--experimental-order");
  const strict = args.includes("--strict");
  const positional = args.filter((a) => a !== "--json" && a !== "--experimental-order" && a !== "--strict");
  const target = positional[0] ?? ".";
  const root = path.resolve(target);

  const report = runLint(root, { experimentalOrder, strict });

  if (jsonFlag) {
    write(
      JSON.stringify(
        {
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
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(formatReport(report) + "\n");
  }

  return report.exitCode;
}

const CLI_DEFAULT_AGENT: AgentInfo = {
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
function looksLikeHookPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
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
function resolveDetectInput(raw: string): { text: string; transcriptUnreadable?: { errorClass: string } } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { text: raw }; // not actually JSON — fall through to literal-text scanning
    }
    if (looksLikeHookPayload(parsed)) {
      const resolved = resolveTurnText(parsed);
      return { text: resolved.text, transcriptUnreadable: resolved.transcriptUnreadable };
    }
  }
  return { text: raw };
}

function runClaimDetectCommand(
  args: string[],
  write: (s: string) => void,
  writeErr: (s: string) => void,
  readStdin: () => string
): number {
  const jsonFlag = args.includes("--json");
  const stdinFlag = args.includes("--stdin");
  const sessionIdx = args.indexOf("--session");
  const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : PLACEHOLDER_SESSION;
  const positional = args.filter((a, i) => a !== "--json" && a !== "--stdin" && a !== "--session" && args[i - 1] !== "--session");

  let raw: string;
  if (stdinFlag || positional.length === 0) {
    raw = readStdin();
  } else {
    try {
      raw = fs.readFileSync(positional[0], "utf8");
    } catch (err) {
      writeErr(`zeuge claim detect: cannot read ${positional[0]}: ${(err as Error).message}\n`);
      return 2;
    }
  }

  const { text, transcriptUnreadable } = resolveDetectInput(raw);
  if (transcriptUnreadable) {
    writeErr(`zeuge claim detect: transcript unreadable: ${transcriptUnreadable.errorClass} — cannot check claims this turn\n`);
    return 3;
  }

  const result = runClaimPass({
    text,
    sessionId,
    agent: CLI_DEFAULT_AGENT,
    source: "cli.detect",
  });

  if (jsonFlag) {
    write(JSON.stringify({ coverage: result.coverage, claims: result.claims }) + "\n");
  } else {
    write(`probe: ${result.coverage.probe}\n`);
    if (result.coverage.probe === "DEAD") {
      writeErr(`zeuge claim detect: probe DEAD, missing ${JSON.stringify(result.coverage.probe_missing)} — no claim records emitted\n`);
    } else {
      for (const c of result.claims) write(`${c.claim_type}\t${c.statement}\n`);
    }
  }

  // A run whose own positive control cannot fire proves nothing about the rest
  // of the run, so it is an integrity failure, not "zero findings."
  if (result.coverage.probe === "DEAD") return 3;
  return 0;
}

function runClaimRulesCommand(args: string[], write: (s: string) => void): number {
  if (args.includes("--sha256")) {
    write(rulesSha256(DEFAULT_RULES) + "\n");
    return 0;
  }
  write(JSON.stringify(DEFAULT_RULES, null, 2) + "\n");
  return 0;
}

function runClaimHookCommand(args: string[], write: (s: string) => void, readStdin: () => string): number {
  const jsonFlag = args.includes("--json");
  const eventIdx = args.indexOf("--event");
  const eventName = eventIdx >= 0 ? args[eventIdx + 1] : "Stop";
  const result = runClaimHook({ stdinText: readStdin(), eventName, jsonMode: jsonFlag });
  write(result.stdout);
  return result.exitCode;
}

function runClaimCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void, readStdin: () => string): number {
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

function runLedgerAppendCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): number {
  const jsonFlag = args.includes("--json");
  const eventIdx = args.indexOf("--event");
  const ledgerIdx = args.indexOf("--ledger");
  if (eventIdx < 0 || !args[eventIdx + 1]) {
    writeErr("zeuge ledger append: --event <file> is required\n");
    return 2;
  }
  const ledgerPath = ledgerIdx >= 0 ? args[ledgerIdx + 1] : defaultLedgerPath();
  let params: unknown;
  try {
    params = JSON.parse(fs.readFileSync(args[eventIdx + 1], "utf8"));
  } catch (err) {
    writeErr(`zeuge ledger append: cannot read event file: ${(err as Error).message}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const p = params as { eventFamily: string; actionType: string; outcome: string; actor: { kind: string; id: string }; body: Record<string, unknown> };
  const result = appendEvent(ledgerPath, {
    eventFamily: p.eventFamily as never,
    actionType: p.actionType,
    outcome: p.outcome,
    actor: p.actor as never,
    body: p.body,
  });
  if (!result.ok) {
    // A lock-contention refusal carries a machine-readable issueCode
    // (currently only "LOCK_HELD") alongside the human `reason`, visible in --json.
    if (jsonFlag) {
      write(
        JSON.stringify({
          ok: false,
          code: result.code,
          reason: result.reason,
          issueCode: result.issueCode,
          ...(result.issueCode === "LOCK_HELD" ? { lockHolderPid: result.lockHolderPid, lockDetail: result.lockDetail } : {}),
        }) + "\n"
      );
    } else {
      writeErr(`zeuge ledger append: ${result.reason}\n`);
    }
    return 3;
  }
  if (jsonFlag) {
    write(JSON.stringify({ ok: true, event: result.event }) + "\n");
  } else {
    write(JSON.stringify(result.event) + "\n");
  }
  return 0;
}

function runLedgerVerifyCommand(args: string[], write: (s: string) => void): number {
  const jsonFlag = args.includes("--json");
  const headIdx = args.indexOf("--expected-head");
  const expectedHead = headIdx >= 0 ? args[headIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--expected-head");
  const ledgerPath = positional[0] ?? defaultLedgerPath();

  const result = verifyLedgerFile(ledgerPath, { expectedHead });

  // A ledger with no --expected-head can verify ok:true while missing a truncated tail —
  // the chain math is genuinely correct, but "correct" and "intact" are different claims.
  // head_binding makes that gap visible instead of letting ok:true read as "nothing missing."
  const headBinding = expectedHead !== undefined ? "BOUND" : "UNBOUND";
  const unboundNote = "truncation is not detectable without --expected-head; bind the head out of band";

  if (jsonFlag) {
    write(
      JSON.stringify({
        ok: result.ok,
        event_count: result.event_count,
        head_hash: result.head_hash,
        issues: result.issues,
        head_binding: headBinding,
        ...(headBinding === "UNBOUND" ? { note: unboundNote } : {}),
      }) + "\n"
    );
  } else {
    write(`ok: ${result.ok}\nevent_count: ${result.event_count}\nhead_hash: ${result.head_hash}\n`);
    if (headBinding === "UNBOUND") {
      write(`head binding: UNBOUND — truncation not detectable\n`);
    } else {
      write(`head binding: BOUND\n`);
    }
    for (const i of result.issues) write(`  issue at seq ${i.seq ?? "-"}: ${i.message}\n`);
  }
  return result.ok ? 0 : 3;
}

function runLedgerHeadCommand(args: string[], write: (s: string) => void): number {
  const ledgerPath = args.filter((a) => !a.startsWith("--"))[0] ?? defaultLedgerPath();
  const result = verifyLedgerFile(ledgerPath);
  write(result.head_hash + "\n");
  return result.ok ? 0 : 3;
}

function runLedgerHookCommand(write: (s: string) => void, readStdin: () => string): number {
  const result = runLedgerHook({ stdinText: readStdin() });
  write(result.stdout);
  return result.exitCode;
}

function runLedgerCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void, readStdin: () => string): number {
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

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function runBundleCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): number {
  const claimsPath = argValue(args, "--claims");
  const coveragePath = argValue(args, "--coverage");
  const ledgerPath = argValue(args, "--ledger");
  const sessionId = argValue(args, "--session") ?? PLACEHOLDER_SESSION;
  const outPath = argValue(args, "--out");
  const sign = args.includes("--sign");

  if (!claimsPath || !coveragePath || !outPath) {
    writeErr("zeuge bundle: --claims <file>, --coverage <file>, and --out <file> are required (--ledger, --session, --sign optional)\n");
    return 2;
  }

  let claims: ClaimRecord[];
  let coverage: CoverageBlock;
  try {
    claims = readJsonFile<ClaimRecord[]>(claimsPath);
    coverage = readJsonFile<CoverageBlock>(coveragePath);
  } catch (err) {
    writeErr(`zeuge bundle: cannot read input: ${(err as Error).message}\n`);
    return 2;
  }

  // Item 4: a claim carrying a KNOWN session that DIFFERS from the bundle's own (also known)
  // --session is an integrity failure, not a silent skip — bundling it anyway would let a
  // claim from one session ride inside a bundle labeled with another. Only fires when the
  // bundle's own session is itself known (real --session given); an unknown bundle session has
  // nothing confirmed to disagree with.
  if (!isUnknownSession(sessionId)) {
    const mismatched = claims.find((c) => !isUnknownSession(c.session_id) && c.session_id !== sessionId);
    if (mismatched) {
      writeErr(
        `zeuge bundle: SESSION_MISMATCH — claim ${mismatched.claim_id} carries session_id "${mismatched.session_id}", which differs from --session "${sessionId}"; refusing to bundle a claim under the wrong session\n`
      );
      return 3;
    }
  }

  let witnesses: Witness[] = [];
  let referencedLedgerEvents: unknown[] = [];
  let ledgerSummary = { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] as Array<{ name: string; head_hash: string }> };

  if (ledgerPath) {
    const verification = verifyLedgerFile(ledgerPath);
    if (!verification.ok) {
      writeErr("zeuge bundle: ledger does not verify; refusing to bundle witnesses from an invalid ledger\n");
      return 3;
    }
    const collected = collectLedgerWitnesses(ledgerPath);
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

  const unsigned = buildBundle({
    sessionId,
    agent: {},
    subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/unknown", dirty: false, dirty_paths_sha256: null },
    claims,
    witnesses,
    ledger: ledgerSummary,
    coverage,
    referencedLedgerEvents,
  });
  const bundle = finalizeBundle(unsigned, { sign, zeugeDir: path.join(process.cwd(), ".zeuge") });
  writeBundle(bundle, outPath);
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
function resolveLicenseZeugeDir(writeErr: (s: string) => void): string {
  const resolved = resolveLicenseDir();
  const warning = licenseDirWarning(resolved);
  if (warning) writeErr(warning);
  return resolved.dir;
}

/**
 * The licence gate every Pro-gated command calls. Purely local — resolveLocalLicenseState
 * never makes a network call (that is `licence status`'s job alone) — so a Pro command's own
 * gate check can never be the thing that phones home. Prints the one stderr line the spec
 * calls for (grace remaining, or the block reason) and returns whether to proceed.
 */
function checkLicenseGate(writeErr: (s: string) => void): { blocked: boolean } {
  const zeugeDir = resolveLicenseZeugeDir(writeErr);
  const gate = resolveLocalLicenseState(zeugeDir);
  if (gate.message) writeErr(`[zeuge] licence: ${gate.message}\n`);
  return { blocked: gate.blocked };
}

function runVerifyCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): number {
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

  let bundle: Bundle;
  try {
    bundle = readJsonFile<Bundle>(bundlePath);
  } catch (err) {
    writeErr(`zeuge verify: cannot parse bundle: ${(err as Error).message}\n`);
    return 3;
  }

  const verdict = verifyBundle(bundle, { requireWitnessed });

  if (jsonFlag) {
    write(JSON.stringify({ ok: verdict.ok, issues: verdict.issues, authenticity: "LOCAL_ONLY" }) + "\n");
  } else {
    write(`ok: ${verdict.ok}\nauthenticity: LOCAL_ONLY\n`);
    for (const i of verdict.issues) write(`  [${i.code}] ${i.message}\n`);
  }

  if (verdict.integrityFailure) return 3;
  if (verdict.gateFinding) return 1;
  return 0;
}

function runReportCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): number {
  const flagValueIndices = new Set<number>();
  ["--html", "--out"].forEach((flag) => {
    const i = args.indexOf(flag);
    if (i >= 0) flagValueIndices.add(i + 1);
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

  let bundle: Bundle;
  try {
    bundle = readJsonFile<Bundle>(bundlePath);
  } catch (err) {
    writeErr(`zeuge report: cannot parse bundle: ${(err as Error).message}\n`);
    return 3;
  }

  const result = renderReport(bundle);
  if (!result.ok) {
    writeErr(`zeuge report: ${result.reason}\n`);
    return 1;
  }
  fs.writeFileSync(outPath, result.html, "utf8");
  write(`report written: ${outPath}\n`);
  return 0;
}

/** `zeuge licence set <key> [--org <id>]` — stores the key locally. Never touches the network. */
function runLicenceSetCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): number {
  const org = argValue(args, "--org");
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--org");
  const key = positional[0];
  if (!key) {
    writeErr("zeuge licence set: <key> is required\n");
    return 2;
  }
  const zeugeDir = resolveLicenseZeugeDir(writeErr);
  setLicenseKey(zeugeDir, key, org);
  write(`licence key stored${org ? ` (organization_id: ${org})` : ""} at ${path.join(zeugeDir, "licence.json")}\n`);
  return 0;
}

// Said once here and echoed on every human-facing `licence status` run: offline
// licence validation is a convenience for honest users, not a security boundary. The source is
// open (MIT) and the check is trivially removable; revocation only takes effect the next time
// this command can reach the provider. Never call this mechanism "secure", "protected", or
// "tamper-proof" — see src/license/cache.ts's header for the full reasoning.
const LICENSE_TRUTH_NOTE =
  "note: offline licence validation is a convenience for honest users, not a security boundary. " +
  "This package is open source (MIT) and the check can be removed from a local copy in minutes. " +
  "Revocation only takes effect the next time this command can reach the provider.";

/**
 * `zeuge licence status [--json]` — the ONLY command (besides `set`, which makes no network
 * call at all) that ever reaches the network: refreshLicenseStatus calls the Polar provider
 * unless ZEUGE_OFFLINE=1. This command itself is never gated — a locked-out user must always
 * be able to ask why.
 */
async function runLicenceStatusCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  const jsonFlag = args.includes("--json");
  const zeugeDir = resolveLicenseZeugeDir(writeErr);
  const provider = createPolarProvider();
  const result = await refreshLicenseStatus(zeugeDir, provider);
  const clock = result.clockMovedBackward ? "CLOCK_MOVED_BACKWARD" : "OK";

  if (jsonFlag) {
    write(
      JSON.stringify({
        state: result.state,
        verdict: result.verdict,
        organization_id: resolveOrganizationId(zeugeDir) ?? null,
        clock,
        note: LICENSE_TRUTH_NOTE,
      }) + "\n"
    );
  } else {
    write(`state: ${result.state}\nprovider: ${result.verdict.provider}\ndetail: ${result.verdict.detail}\nclock: ${clock}\n`);
    if (result.clockMovedBackward) {
      write("  system clock reads earlier than a previously observed time — grace held steady, not extended\n");
    }
    write(`${LICENSE_TRUTH_NOTE}\n`);
  }
  return 0;
}

function runLicenceCommand(args: string[], write: (s: string) => void, writeErr: (s: string) => void): number | Promise<number> {
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

function defaultReadStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function main(
  argv: string[],
  io: { write: (s: string) => void; writeErr: (s: string) => void; readStdin?: () => string } = {
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  }
): number | Promise<number> {
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
