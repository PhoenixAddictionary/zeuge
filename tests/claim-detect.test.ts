import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectClaims, detectClaimsWithSkips } from "../src/claim/detect";
import { buildClaim } from "../src/claim/record";
import { markReplays } from "../src/claim/replay";
import { runProbe } from "../src/claim/probe";
import { runClaimPass } from "../src/claim/run";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "claims");
const read = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");

const AGENT = { id: "agent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", vendor: "anthropic", model: "test", harness: "claude-code", harness_version: "test" };

describe("claim/detect", () => {
  it("detection (positive): tests-pass.txt -> [tests_pass]", () => {
    const found = detectClaims(read("tests-pass.txt")).map((c) => c.claim_type);
    expect(found).toEqual(["tests_pass"]);
  });

  it("detection (negative): imperative.txt ('please run the tests') -> []", () => {
    expect(detectClaims(read("imperative.txt"))).toEqual([]);
  });

  it("multi-claim (positive): mixed.txt -> 3 types, stable order", () => {
    const found = detectClaims(read("mixed.txt")).map((c) => c.claim_type);
    expect(found).toEqual(["tests_pass", "deployed", "fixed"]);
  });

  it("multi-claim (negative): discussion.txt (structurally not a claim) -> []", () => {
    expect(detectClaims(read("discussion.txt"))).toEqual([]);
  });

  it("replay (positive): same statement_sha256+session_id yields one claim, replay:true on the repeat", () => {
    const fixture = JSON.parse(read("replayed-claim.json"));
    const candidate = detectClaims(fixture.text)[0];
    const claim1 = buildClaim({ sessionId: fixture.session_id, agent: AGENT, candidate, source: "test", rulesSha256: "x".repeat(64) });
    const claim2 = buildClaim({ sessionId: fixture.session_id, agent: AGENT, candidate, source: "test", rulesSha256: "x".repeat(64) });

    const pass1 = markReplays([claim1]);
    const pass2 = markReplays([claim2], pass1.seen);

    expect(pass1.claims[0].replay).toBeUndefined();
    expect(pass2.claims[0].replay).toBe(true);
  });

  it("replay (negative fixture): replayed-claim.json's claim is flagged, never double-counted", () => {
    const fixture = JSON.parse(read("replayed-claim.json"));
    const candidate = detectClaims(fixture.text)[0];
    const claim = buildClaim({ sessionId: fixture.session_id, agent: AGENT, candidate, source: "test", rulesSha256: "x".repeat(64) });

    let seen = new Set<string>();
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const pass = markReplays([claim], seen);
      seen = pass.seen;
      total += pass.claims.filter((c) => !c.replay).length;
    }
    expect(total).toBe(1); // one distinct claim across three feeds of the identical statement
  });

  it("redaction: HASH_ONLY drops statement, keeps statement_sha256", () => {
    const candidate = detectClaims("Done.")[0];
    const claim = buildClaim({ sessionId: "session:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agent: AGENT, candidate, source: "test", rulesSha256: "x".repeat(64), redaction: "HASH_ONLY" });
    expect("statement" in claim).toBe(false);
    expect(claim.statement_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redaction: NONE (default) keeps the statement", () => {
    const candidate = detectClaims("Done.")[0];
    const claim = buildClaim({ sessionId: "session:cccccccccccccccccccccccccccccccc", agent: AGENT, candidate, source: "test", rulesSha256: "x".repeat(64) });
    expect(claim.statement).toBe("Done.");
  });

  it("positive control: the probe is ALIVE against the shipped rules", () => {
    expect(runProbe().probe).toBe("ALIVE");
  });

  it("positive control (negative): a broken rule set that cannot detect a planted sentence reports DEAD", () => {
    const brokenRules = [{ rule_id: "broken.v1", claim_type: "tests_pass" as const, pattern: "this-will-never-match-anything-xyz" }];
    const result = runProbe(brokenRules);
    expect(result.probe).toBe("DEAD");
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

describe("claim/detect — coverage denominator (statements_total)", () => {
  it("classified_sentences + sum(skipped) + unmatched_sentences === total, by construction", () => {
    const text = "All tests pass. Make sure it is done before you leave. The sky is blue today. Deployed to production.";
    const result = detectClaimsWithSkips(text);
    const skippedTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0);

    expect(result.total).toBe(4);
    expect(result.classified_sentences).toBe(2); // "All tests pass." and "Deployed to production."
    expect(skippedTotal).toBe(1); // "Make sure it is done before you leave." (imperative)
    expect(result.unmatched_sentences).toBe(1); // "The sky is blue today."
    expect(result.classified_sentences + skippedTotal + result.unmatched_sentences).toBe(result.total);
  });

  it("empty text: total 0, every bucket 0", () => {
    const result = detectClaimsWithSkips("");
    expect(result.total).toBe(0);
    expect(result.classified_sentences).toBe(0);
    expect(result.unmatched_sentences).toBe(0);
    expect(Object.keys(result.skipped)).toHaveLength(0);
  });

  it("runClaimPass's coverage block exposes statements_total, matching the detector's own total, and shows classified as a sentence count", () => {
    const pass = runClaimPass({
      text: "All tests pass. The sky is blue today.",
      sessionId: "session:00000000000000000000000000000000",
      agent: AGENT,
      source: "test",
    });
    expect(pass.coverage.statements_total).toBe(2);
    expect(pass.coverage.statements_classified).toBe(1);
  });

  it("a probe-DEAD run reports statements_total: 0 (no real scanning happened)", () => {
    const brokenRules = [{ rule_id: "broken.v1", claim_type: "tests_pass" as const, pattern: "this-will-never-match-anything-xyz" }];
    const pass = runClaimPass({
      text: "All tests pass.",
      sessionId: "session:00000000000000000000000000000000",
      agent: AGENT,
      source: "test",
      rules: brokenRules,
    });
    expect(pass.coverage.probe).toBe("DEAD");
    expect(pass.coverage.statements_total).toBe(0);
  });
});
