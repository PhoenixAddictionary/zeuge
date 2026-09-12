/**
 * witness-binding — root-cause regression: a claim built with the PLACEHOLDER session
 * (what every un-sessioned `claim detect`/`claim hook` call stamps) must bind against a witness
 * that carries a real, different session id — because "placeholder" means "unknown", not "a
 * confirmed different session". Before this fix, `receipt/bundle.ts`'s own binding test treated
 * an ABSENT witness session_id as unknown-and-permissive but a PLACEHOLDER claim session as
 * known-and-different, so `zeuge claim detect` (no --session) piped into `zeuge bundle --ledger`
 * produced a bundle whose own claim was UNWITNESSED against its own witness.
 */
import { describe, it, expect } from "vitest";
import { isUnknownSession, witnessBacksClaim, PLACEHOLDER_SESSION } from "../src/witness/binding";
import { buildClaim } from "../src/claim/record";
import { detectClaims } from "../src/claim/detect";
import type { Witness } from "../src/witness/source";

const AGENT = { id: "agent:11111111111111111111111111111111", vendor: "anthropic", model: "test", harness: "claude-code", harness_version: "test" };
const RULES_SHA = "a".repeat(64);

function claimWithSession(sessionId: string) {
  const candidate = detectClaims("All tests pass.")[0];
  return buildClaim({ sessionId, agent: AGENT, candidate, source: "test", rulesSha256: RULES_SHA });
}

function witnessWithSession(sessionId: string | undefined): Witness {
  return {
    witness_id: "witness:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "LEDGER_EVENT",
    source: "zeuge.ledger",
    locator: "event:1",
    content_sha256: "b".repeat(64),
    observed_at: new Date().toISOString(),
    binds: ["tests_pass", "command_ran"],
    trust_level: "L2",
    verification: "VERIFIED",
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}

describe("isUnknownSession", () => {
  it("is true for undefined, empty string, and the placeholder", () => {
    expect(isUnknownSession(undefined)).toBe(true);
    expect(isUnknownSession("")).toBe(true);
    expect(isUnknownSession(PLACEHOLDER_SESSION)).toBe(true);
  });
  it("is false for a real-looking session id", () => {
    expect(isUnknownSession("session:s9")).toBe(false);
  });
});

describe("witnessBacksClaim — P11: unknown session on EITHER side is permissive, never a hard exclusion", () => {
  it("a PLACEHOLDER-session claim binds against a witness with a real, different session (the exact P11 bug)", () => {
    const claim = claimWithSession(PLACEHOLDER_SESSION);
    const witness = witnessWithSession("session:real-session-s9");
    expect(witnessBacksClaim(witness, claim)).toBe(true);
  });

  it("a real-session claim binds against a witness with NO session_id at all", () => {
    const claim = claimWithSession("session:real-session-s9");
    const witness = witnessWithSession(undefined);
    expect(witnessBacksClaim(witness, claim)).toBe(true);
  });

  it("two DIFFERENT, KNOWN sessions still hard-exclude (the exclusion must keep working)", () => {
    const claim = claimWithSession("session:real-session-A");
    const witness = witnessWithSession("session:real-session-B");
    expect(witnessBacksClaim(witness, claim)).toBe(false);
  });

  it("two matching, KNOWN sessions bind", () => {
    const claim = claimWithSession("session:real-session-A");
    const witness = witnessWithSession("session:real-session-A");
    expect(witnessBacksClaim(witness, claim)).toBe(true);
  });

  it("claim_type not in witness.binds never binds, regardless of session", () => {
    const claim = claimWithSession(PLACEHOLDER_SESSION);
    const witness: Witness = { ...witnessWithSession(PLACEHOLDER_SESSION), binds: ["deployed"] };
    expect(witnessBacksClaim(witness, claim)).toBe(false);
  });
});
