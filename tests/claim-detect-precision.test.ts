import { describe, it, expect } from "vitest";
import { detectClaims, detectClaimsWithSkips } from "../src/claim/detect";

/**
 * P10 — measured precision gaps (coordinator's run against 5.8MB of real agent-authored status
 * prose, 702 matches / ~78k sentences). Five false-positive shapes, each executed and
 * confirmed against the pre-P10 build; five true-positive shapes (including one the
 * coordinator initially mislabelled as a false positive and then corrected) that must keep
 * matching after the fixes.
 */

const FALSE_POSITIVE_SHAPES: Array<{ text: string; reason: string }> = [
  { text: "- OPEN (NOT done this turn): run-all has not been executed.", reason: "negation inside a parenthetical, right after a list marker" },
  { text: "DEFECTS FOUND (not fixed here): the index is stale.", reason: "negation inside a parenthetical" },
  { text: "A WIP rescue reintroduced an already-fixed regression last week.", reason: "hyphenated compound narrating an earlier state" },
  { text: "Deployed copy: the profile directory now holds the hook.", reason: "noun-phrase use, not a verb claim" },
  { text: "Their CI pipeline deployed the release yesterday.", reason: "third-party subject, not the agent's own act" },
];

const TRUE_POSITIVE_SHAPES: Array<{ text: string; claimType: string }> = [
  { text: "All tests pass.", claimType: "tests_pass" },
  { text: "Deployed to production.", claimType: "deployed" },
  { text: "Fixed the parser bug.", claimType: "fixed" },
  { text: "Done.", claimType: "done" },
  { text: "Tests passed locally.", claimType: "tests_pass" },
];

// The coordinator's own honest correction: initially mislabelled a false positive, then
// confirmed it IS a genuine claim of having fixed something. Kept matching, added here as its
// own fixture rather than folded into TRUE_POSITIVE_SHAPES so the correction stays visible.
const CORRECTED_TRUE_POSITIVE = "The lint was fixed in tools/PLATFORM_DECISIONS.md and the index updated.";

describe("claim/detect — P10: precision fixtures (0/5 false positives, 5/5 true positives)", () => {
  for (const { text, reason } of FALSE_POSITIVE_SHAPES) {
    it(`does NOT fire (${reason}): "${text}"`, () => {
      const result = detectClaimsWithSkips(text);
      expect(result.candidates).toHaveLength(0);
    });
  }

  for (const { text, claimType } of TRUE_POSITIVE_SHAPES) {
    it(`still fires (${claimType}): "${text}"`, () => {
      const found = detectClaims(text);
      expect(found.length).toBeGreaterThan(0);
      expect(found.some((c) => c.claim_type === claimType)).toBe(true);
    });
  }

  it("corrected fixture: a path containing a dot does not shatter the sentence, and 'fixed' still fires", () => {
    const found = detectClaims(CORRECTED_TRUE_POSITIVE);
    expect(found.some((c) => c.claim_type === "fixed")).toBe(true);
    // The whole sentence is carried verbatim — proof the embedded ".md" dot did not truncate it.
    const fixedClaim = found.find((c) => c.claim_type === "fixed");
    expect(fixedClaim?.statement).toBe(CORRECTED_TRUE_POSITIVE);
  });

  it("precision summary: exactly 0 of 5 false-positive shapes match, 5 of 5 true-positive shapes match", () => {
    const fpMatches = FALSE_POSITIVE_SHAPES.filter((s) => detectClaims(s.text).length > 0).length;
    const tpMatches = TRUE_POSITIVE_SHAPES.filter((s) => detectClaims(s.text).some((c) => c.claim_type === s.claimType)).length;
    expect(fpMatches).toBe(0);
    expect(tpMatches).toBe(5);
  });

  it("each false-positive guard increments its own statements_skipped reason", () => {
    const negation1 = detectClaimsWithSkips(FALSE_POSITIVE_SHAPES[0].text);
    expect(negation1.skipped.negation).toBeGreaterThan(0);
    const negation2 = detectClaimsWithSkips(FALSE_POSITIVE_SHAPES[1].text);
    expect(negation2.skipped.negation).toBeGreaterThan(0);
    const hyphen = detectClaimsWithSkips(FALSE_POSITIVE_SHAPES[2].text);
    expect(hyphen.skipped.negation).toBeGreaterThan(0);
    const nounPhrase = detectClaimsWithSkips(FALSE_POSITIVE_SHAPES[3].text);
    expect(nounPhrase.skipped.noun_phrase).toBeGreaterThan(0);
    const thirdParty = detectClaimsWithSkips(FALSE_POSITIVE_SHAPES[4].text);
    expect(thirdParty.skipped.third_party).toBeGreaterThan(0);
  });
});

describe("claim/detect — P10: sentence splitting no longer shatters on a non-whitespace-followed dot", () => {
  it("a Windows path with an embedded dot stays inside one sentence, never split mid-filename", () => {
    const text = "Deployed copy: %USERPROFILE%\\.zeuge\\ledger.jsonl was written. Done.";
    const result = detectClaimsWithSkips(text);
    expect(result.total).toBe(2); // exactly two real sentences, not shattered at every embedded dot
  });

  it("a period inside a backticked span is never treated as a sentence boundary", () => {
    const text = "Run `git commit -m \"done.\"` now to finish.";
    const result = detectClaimsWithSkips(text);
    expect(result.total).toBe(1);
  });

  it("a dot followed by whitespace still ends a sentence normally", () => {
    const result = detectClaimsWithSkips("All tests pass. Done.");
    expect(result.total).toBe(2);
  });
});
