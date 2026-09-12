import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent } from "../src/ledger/append";
import { collectLedgerWitnesses } from "../src/witness/sources/ledger";
import { rebindClaims } from "../src/receipt/bundle";
import { buildClaim } from "../src/claim/record";
import { detectClaims } from "../src/claim/detect";

const AGENT = { id: "agent:33333333333333333333333333333333", vendor: "anthropic", model: "test", harness: "claude-code", harness_version: "test" };
const RULES_SHA = "b".repeat(64);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpLedger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-witness-session-"));
  tmpDirs.push(dir);
  return path.join(dir, "ledger.jsonl");
}

function claimFor(sessionId: string, text = "All tests pass.") {
  const candidate = detectClaims(text)[0];
  return buildClaim({ sessionId, agent: AGENT, candidate, source: "test", rulesSha256: RULES_SHA });
}

// Note: every appendEvent below now sets `command_kind: "test"` on
// purpose. These tests exercise SESSION binding (the P5.3 mechanism), and their claims are
// `tests_pass` claims — without `command_kind: "test"` on the ledger event, the witness/
// sources/ledger.ts fix would exclude these events from backing `tests_pass` regardless of
// session, which is not what this file is testing. Adding the field keeps the test isolating
// session/time-window behavior, which is what changed behavior genuinely requires here.
describe("receipt/bundle — claim -> witness binding uses session_id + claim_type + time window", () => {
  it("same claim_type from ANOTHER session must NOT witness", () => {
    const ledgerPath = tmpLedger();
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:44444444444444444444444444444444" },
      body: { exit_code: 0, session_id: "session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", command_kind: "test" },
    });
    const { witnesses } = collectLedgerWitnesses(ledgerPath);
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].session_id).toBe("session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const claim = claimFor("session:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("UNWITNESSED");
    expect(rebound.witnesses).toEqual([]);
  });

  it("a within-session, recent event DOES witness", () => {
    const ledgerPath = tmpLedger();
    const sessionId = "session:cccccccccccccccccccccccccccccccc";
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:55555555555555555555555555555555" },
      body: { exit_code: 0, session_id: sessionId, command_kind: "test" },
    });
    const { witnesses } = collectLedgerWitnesses(ledgerPath);

    const claim = claimFor(sessionId);
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("WITNESSED");
    expect(rebound.witnesses).toEqual([witnesses[0].witness_id]);
  });

  it("outside the time window (>30 min apart), the same session does NOT witness", () => {
    const ledgerPath = tmpLedger();
    const sessionId = "session:dddddddddddddddddddddddddddddddd";
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:66666666666666666666666666666666" },
      body: { exit_code: 0, session_id: sessionId, command_kind: "test" },
      recordedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    });
    const { witnesses } = collectLedgerWitnesses(ledgerPath);

    const claim = claimFor(sessionId); // occurred_at defaults to "now"
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("UNWITNESSED");
  });

  it("a witness with no session_id at all still binds permissively (declared residual, backward compatible)", () => {
    const ledgerPath = tmpLedger();
    appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: { kind: "SYSTEM", id: "agent:77777777777777777777777777777777" },
      body: { exit_code: 0, command_kind: "test" }, // no session_id in the body at all
    });
    const { witnesses } = collectLedgerWitnesses(ledgerPath);
    expect(witnesses[0].session_id).toBeUndefined();

    const claim = claimFor("session:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    const [rebound] = rebindClaims([claim], witnesses);
    expect(rebound.status).toBe("WITNESSED");
  });
});
