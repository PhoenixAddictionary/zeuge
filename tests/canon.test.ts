import { describe, it, expect } from "vitest";
import { canonicalize, canonicalHash, sha256hex } from "../src/canon";

describe("canon — JCS-ish canonicalisation", () => {
  it("basic object key ordering and escaping", () => {
    expect(canonicalize({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
  });

  it("an undefined-valued object property is OMITTED, matching JSON.stringify", () => {
    const withUndefined = { a: 1, b: undefined, c: 3 };
    expect(canonicalize(withUndefined)).toBe(canonicalize(JSON.parse(JSON.stringify(withUndefined))));
    expect(canonicalize(withUndefined)).toBe('{"a":1,"c":3}');
  });

  it("an undefined ARRAY element becomes null, matching JSON.stringify", () => {
    // eslint-disable-next-line no-sparse-arrays
    const arr = [1, undefined, 3];
    expect(canonicalize(arr)).toBe(canonicalize(JSON.parse(JSON.stringify(arr))));
    expect(canonicalize(arr)).toBe("[1,null,3]");
  });

  it("write/read round trip: a hash computed before JSON.stringify equals one computed after JSON.parse(JSON.stringify(x))", () => {
    const doc = { id: "x", tool_use_id: undefined, nested: { keep: 1, drop: undefined }, list: [undefined, "a"] };
    const before = canonicalHash(doc);
    const after = canonicalHash(JSON.parse(JSON.stringify(doc)));
    expect(before).toBe(after);
  });

  //  (1): property-based-ish check across 50 generated documents covering
  // undefined/null/nested/unicode/float values.
  function randomValue(depth: number): unknown {
    const choices = [
      () => undefined,
      () => null,
      () => Math.random() < 0.5,
      () => Math.floor(Math.random() * 1000) - 500,
      () => Math.random() * 1000 - 500, // float
      () => "ünïcödé 🚀 " + Math.random().toString(36).slice(2),
      () => (depth > 2 ? "leaf" : randomArray(depth + 1)),
      () => (depth > 2 ? "leaf" : randomObject(depth + 1)),
    ];
    return choices[Math.floor(Math.random() * choices.length)]();
  }
  function randomArray(depth: number): unknown[] {
    const len = Math.floor(Math.random() * 4);
    return Array.from({ length: len }, () => randomValue(depth));
  }
  function randomObject(depth: number): Record<string, unknown> {
    const keys = ["a", "b", "c", "déjà", "z_1"];
    const obj: Record<string, unknown> = {};
    for (const k of keys) {
      if (Math.random() < 0.7) obj[k] = randomValue(depth);
    }
    return obj;
  }

  it("50 generated documents: sha256(canonicalize(x)) === sha256(canonicalize(JSON.parse(JSON.stringify(x))))", () => {
    for (let i = 0; i < 50; i++) {
      const doc = randomObject(0);
      const direct = sha256hex(canonicalize(doc));
      const roundTripped = sha256hex(canonicalize(JSON.parse(JSON.stringify(doc))));
      expect(direct, `mismatch on generated doc #${i}: ${JSON.stringify(doc)}`).toBe(roundTripped);
    }
  });
});
