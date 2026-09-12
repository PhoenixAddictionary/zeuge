import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectClaims } from "../src/claim/detect";
import { buildClaim } from "../src/claim/record";
import { buildBundle, finalizeBundle, Bundle } from "../src/receipt/bundle";
import { verifyBundle } from "../src/receipt/verify";
import { renderReport } from "../src/receipt/report";
import { adaptProtectMcpReceipt } from "../src/witness/sources/protect-mcp";
import { collectLedgerWitnesses } from "../src/witness/sources/ledger";
import { appendEvent } from "../src/ledger/append";
import type { CoverageBlock } from "../src/claim/probe";

const AGENT = { id: "agent:11111111111111111111111111111111", vendor: "anthropic", model: "test", harness: "claude-code", harness_version: "test" };
const RULES_SHA = "a".repeat(64);
const COVERAGE_ALIVE: CoverageBlock = { turns_scanned: 1, statements_total: 2, statements_classified: 2, statements_matched: { tests_pass: 1, deployed: 1 }, probe: "ALIVE" };
const COVERAGE_DEAD: CoverageBlock = { turns_scanned: 1, statements_total: 0, statements_classified: 0, statements_matched: {}, probe: "DEAD", probe_missing: ["done"] };

function makeClaims(sessionId: string) {
  const candidates = detectClaims("All tests pass. Deployed to production.");
  return candidates.map((c) => buildClaim({ sessionId, agent: AGENT, candidate: c, source: "test", rulesSha256: RULES_SHA }));
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-receipt-"));
  tmpDirs.push(d);
  return d;
}

describe("receipt/bundle + verify — round trip", () => {
  it("an unsigned bundle verifies structurally (ok:true)", () => {
    const claims = makeClaims("session:aaaa");
    const unsigned = buildBundle({
      sessionId: "session:aaaa",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned);
    expect(bundle.signatures).toHaveLength(0);
    const verdict = verifyBundle(bundle);
    expect(verdict.ok).toBe(true);
    expect(verdict.integrityFailure).toBe(false);
  });

  it("a signed bundle verifies (signature checked)", () => {
    const dir = tmpDir();
    const claims = makeClaims("session:bbbb");
    const unsigned = buildBundle({
      sessionId: "session:bbbb",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned, { sign: true, zeugeDir: path.join(dir, ".zeuge") });
    expect(bundle.signatures).toHaveLength(1);
    const verdict = verifyBundle(bundle);
    expect(verdict.ok).toBe(true);
  });

  it("NEGATIVE (wrong signature): corrupted signature bytes fail verification against their own embedded key", () => {
    const dir = tmpDir();
    const claims = makeClaims("session:cccc");
    const unsigned = buildBundle({
      sessionId: "session:cccc",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned, { sign: true, zeugeDir: path.join(dir, ".zeuge") });
    // Flip a middle base64 character of the signature (not the last, whose low bits can be
    // padding-insensitive) — same embedded public key, unambiguously different decoded bytes.
    const goodSig = bundle.signatures[0].signature_b64;
    const mid = Math.floor(goodSig.length / 2);
    const midChar = goodSig[mid];
    const replacement = midChar === "A" ? "B" : "A";
    const flipped = goodSig.slice(0, mid) + replacement + goodSig.slice(mid + 1);
    const tampered: Bundle = { ...bundle, signatures: [{ ...bundle.signatures[0], signature_b64: flipped }] };
    const verdict = verifyBundle(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.integrityFailure).toBe(true);
    expect(verdict.issues.some((i) => i.code === "SIGNATURE_INVALID")).toBe(true);
  });

  it("NEGATIVE (edited bundle body): changing a claim's statement after hashing fails BUNDLE_HASH_MISMATCH", () => {
    const claims = makeClaims("session:dddd");
    const unsigned = buildBundle({
      sessionId: "session:dddd",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned);
    const edited: Bundle = { ...bundle, claims: [{ ...bundle.claims[0], statement: "EDITED AFTER SIGNING" }, ...bundle.claims.slice(1)] };
    const verdict = verifyBundle(edited);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.code === "BUNDLE_HASH_MISMATCH")).toBe(true);
  });

  it("NEGATIVE (missing referenced event): a witness pointing at a ledger event not embedded in the bundle fails MISSING_REFERENCED_EVENT", () => {
    const dir = tmpDir();
    const ledgerPath = path.join(dir, "ledger.jsonl");
    appendEvent(ledgerPath, { eventFamily: "ACTION", actionType: "COMMAND_RUN", outcome: "PASS", actor: { kind: "SYSTEM", id: "agent:22222222222222222222222222222222" }, body: { exit_code: 0 } });
    const { witnesses, events } = collectLedgerWitnesses(ledgerPath);
    expect(witnesses.length).toBeGreaterThan(0);

    const claims = makeClaims("session:eeee");
    const unsigned = buildBundle({
      sessionId: "session:eeee",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses,
      ledger: { ledger_id: events[0].ledger_id, head_hash: events[events.length - 1].event_hash, event_count: events.length, segments: [{ name: "segment-0", head_hash: events[events.length - 1].event_hash }] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [], // deliberately NOT embedding the event the witness references
    });
    const bundle = finalizeBundle(unsigned);
    const verdict = verifyBundle(bundle);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.code === "MISSING_REFERENCED_EVENT")).toBe(true);
  });

  it("a claim IS witnessed when a ledger event backs it, and --require-witnessed then passes", () => {
    const dir = tmpDir();
    const ledgerPath = path.join(dir, "ledger.jsonl");
    // This test binds a `tests_pass` claim ("All tests pass."), which
    // after the fix requires `command_kind: "test"` on the ledger event — without it the event
    // would only back `command_ran`, and this test's own assertion (`status` -> "WITNESSED")
    // would no longer hold for a reason unrelated to what this test is checking.
    appendEvent(ledgerPath, { eventFamily: "ACTION", actionType: "COMMAND_RUN", outcome: "PASS", actor: { kind: "SYSTEM", id: "agent:33333333333333333333333333333333" }, body: { exit_code: 0, command_kind: "test" } });
    const { witnesses, events } = collectLedgerWitnesses(ledgerPath);

    const candidates = detectClaims("All tests pass.");
    const claims = candidates.map((c) => buildClaim({ sessionId: "session:ffff", agent: AGENT, candidate: c, source: "test", rulesSha256: RULES_SHA }));

    const unsigned = buildBundle({
      sessionId: "session:ffff",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses,
      ledger: { ledger_id: events[0].ledger_id, head_hash: events[events.length - 1].event_hash, event_count: events.length, segments: [{ name: "segment-0", head_hash: events[events.length - 1].event_hash }] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: events,
    });
    const bundle = finalizeBundle(unsigned);
    expect(bundle.claims[0].status).toBe("WITNESSED");
    const verdict = verifyBundle(bundle, { requireWitnessed: true });
    expect(verdict.ok).toBe(true);
  });

  it("NEGATIVE --require-witnessed: an unwitnessed tests_pass/done claim is a gate finding, exit-class 1 not 3", () => {
    const claims = makeClaims("session:gggg");
    const unsigned = buildBundle({
      sessionId: "session:gggg",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned);
    const verdict = verifyBundle(bundle, { requireWitnessed: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.integrityFailure).toBe(false);
    expect(verdict.gateFinding).toBe(true);
    expect(verdict.issues.some((i) => i.code === "UNWITNESSED_GATED_CLAIM")).toBe(true);
  });

  it("coverage/probe DEAD gate: default mode is an integrity failure, --require-witnessed mode is a gate finding (the coverage rule)", () => {
    const claims: ReturnType<typeof makeClaims> = [];
    const unsigned = buildBundle({
      sessionId: "session:hhhh",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_DEAD,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned);

    const defaultVerdict = verifyBundle(bundle);
    expect(defaultVerdict.integrityFailure).toBe(true);

    const gateVerdict = verifyBundle(bundle, { requireWitnessed: true });
    expect(gateVerdict.integrityFailure).toBe(false);
    expect(gateVerdict.gateFinding).toBe(true);
  });
});

describe("witness/sources/protect-mcp — adapter", () => {
  it("maps only the six named fields; everything else goes to extra, never interpreted", () => {
    const receipt = { tool_name: "Bash", input_hash: "i".repeat(64), output_hash: "o".repeat(64), parent_receipt_id: "receipt:1", public_key: "pk", signature: "sig", weird_upstream_field: 42 };
    const { witness, missingRequired } = adaptProtectMcpReceipt(receipt);
    expect(missingRequired).toHaveLength(0);
    expect(witness.kind).toBe("external_receipt");
    expect(witness.verified).toBe(false);
    expect(witness.verification).toBe("UNVERIFIED");
    expect(witness.extra).toEqual({ weird_upstream_field: 42 });
    expect(witness.receipt).toEqual({
      tool_name: "Bash",
      input_hash: "i".repeat(64),
      output_hash: "o".repeat(64),
      parent_receipt_id: "receipt:1",
      public_key: "pk",
      signature: "sig",
    });
  });

  it("NEGATIVE: a receipt missing a required field (output_hash) is reported, never silently guessed", () => {
    const receipt = { tool_name: "Bash", parent_receipt_id: "receipt:2" };
    const { missingRequired } = adaptProtectMcpReceipt(receipt);
    expect(missingRequired).toContain("output_hash");
  });

  it("never verifies the embedded signature (out of scope): verified is always false", () => {
    const receipt = { tool_name: "Read", output_hash: "f".repeat(64), signature: "totally-bogus" };
    const { witness } = adaptProtectMcpReceipt(receipt);
    expect(witness.verified).toBe(false);
  });
});

describe("receipt/report — HTML report", () => {
  it("coverage is the first section after the title; no external assets or scripts", () => {
    const claims = makeClaims("session:iiii");
    const unsigned = buildBundle({
      sessionId: "session:iiii",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned);
    const result = renderReport(bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const html = result.html;
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf("Coverage"));
    expect(html.indexOf("Coverage")).toBeLessThan(html.indexOf("Claims"));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bsrc=/i);
    expect(html).toContain("authenticity");
    expect(html).toContain("LOCAL_ONLY");
    expect(html).toContain("undetectable without an external anchor");
  });

  it("NEGATIVE (report without coverage): a bundle with no coverage block is refused, not silently rendered", () => {
    const claims = makeClaims("session:jjjj");
    const unsigned = buildBundle({
      sessionId: "session:jjjj",
      agent: AGENT,
      subject: { repo_head: "0".repeat(40), branch_ref: "refs/heads/main", dirty: false, dirty_paths_sha256: null },
      claims,
      witnesses: [],
      ledger: { ledger_id: "ledger:none", head_hash: "0".repeat(64), event_count: 0, segments: [] },
      coverage: COVERAGE_ALIVE,
      referencedLedgerEvents: [],
    });
    const bundle = finalizeBundle(unsigned);
    const { coverage: _drop, ...withoutCoverage } = bundle as unknown as Record<string, unknown>;
    const result = renderReport(withoutCoverage as unknown as Bundle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/REPORT_WITHOUT_COVERAGE/);
  });
});
