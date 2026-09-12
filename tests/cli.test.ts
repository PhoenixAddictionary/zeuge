import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { main } from "../src/cli";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const FIXTURES = path.join(__dirname, "..", "fixtures");

describe("cli", () => {
  it("--help prints usage and exits 0", () => {
    const c = capture();
    const code = main(["node", "zeuge", "--help"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toMatch(/Usage:/);
  });

  it("no args prints usage to stderr and exits 1", () => {
    const c = capture();
    const code = main(["node", "zeuge"], c.io);
    expect(code).toBe(1);
    expect(c.err()).toMatch(/Usage:/);
  });

  it("claim with no subcommand exits 2 naming the expected subcommands", () => {
    const c = capture();
    const code = main(["node", "zeuge", "claim"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toMatch(/hook \| detect \| rules/);
  });

  it("ledger with no subcommand exits 2 naming the expected subcommands", () => {
    const c = capture();
    const code = main(["node", "zeuge", "ledger"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toMatch(/append \| verify \| head \| hook/);
  });

  it("claim rules --sha256 prints a 64-hex digest", () => {
    const c = capture();
    const code = main(["node", "zeuge", "claim", "rules", "--sha256"], c.io);
    expect(code).toBe(0);
    expect(c.out().trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("unknown command exits 1", () => {
    const c = capture();
    const code = main(["node", "zeuge", "bogus"], c.io);
    expect(code).toBe(1);
  });

  it("P8: lint on the planted-finding fixture project, DEFAULT (no flags), exits 0 with 1 risk + 0 fault (instruction-order is off by default)", () => {
    const c = capture();
    const code = main(["node", "zeuge", "lint", path.join(FIXTURES, "sample-project"), "--json"], c.io);
    expect(code).toBe(0);
    const report = JSON.parse(c.out());
    expect(report.experimentalOrder).toBe(false);
    expect(report.totalFindings).toBe(1);
    expect(report.counts).toEqual({ fault: 0, risk: 1, review: 0 });
  });

  it("P8: the same project with --experimental-order surfaces the 2 tightened instruction-order findings too (all review), still exit 0 without --strict", () => {
    const c = capture();
    const code = main(["node", "zeuge", "lint", path.join(FIXTURES, "sample-project"), "--experimental-order", "--json"], c.io);
    expect(code).toBe(0);
    const report = JSON.parse(c.out());
    expect(report.totalFindings).toBe(3);
    expect(report.counts).toEqual({ fault: 0, risk: 1, review: 2 });
    expect(report.notes).toContain("heuristic: 12 findings over 696 public instruction files in the 2026-09-11 field test; expect false positives");
  });

  it("P8: --experimental-order --strict exits 1 on the same project (risk/review findings now gate)", () => {
    const c = capture();
    const code = main(["node", "zeuge", "lint", path.join(FIXTURES, "sample-project"), "--experimental-order", "--strict", "--json"], c.io);
    expect(code).toBe(1);
  });

  it("lint on the clean fixture project exits 0", () => {
    const c = capture();
    const code = main(["node", "zeuge", "lint", path.join(FIXTURES, "sample-project-clean"), "--json"], c.io);
    expect(code).toBe(0);
    const report = JSON.parse(c.out());
    expect(report.totalFindings).toBe(0);
  });

  it("lint text output includes a blind-spots line", () => {
    const c = capture();
    main(["node", "zeuge", "lint", path.join(FIXTURES, "sample-project-clean")], c.io);
    expect(c.out()).toMatch(/BLIND SPOTS/);
  });

  it("ledger verify --json without --expected-head reports head_binding UNBOUND with the truncation note (ok:true is not 'nothing missing')", () => {
    const c = capture();
    const ledgerPath = path.join(FIXTURES, "ledger", "truncated-tail.jsonl");
    const code = main(["node", "zeuge", "ledger", "verify", ledgerPath, "--json"], c.io);
    expect(code).toBe(0); // chain math is genuinely correct on the truncated file alone
    const report = JSON.parse(c.out());
    expect(report.ok).toBe(true);
    expect(report.head_binding).toBe("UNBOUND");
    expect(report.note).toMatch(/truncation is not detectable without --expected-head/);
  });

  it("ledger verify (human text) without --expected-head prints the UNBOUND line", () => {
    const c = capture();
    const ledgerPath = path.join(FIXTURES, "ledger", "truncated-tail.jsonl");
    main(["node", "zeuge", "ledger", "verify", ledgerPath], c.io);
    expect(c.out()).toMatch(/head binding: UNBOUND — truncation not detectable/);
  });

  it(" claim detect --stdin accepts a hook-payload-shaped JSON object, extracting last_assistant_message.text", () => {
    const c = capture();
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: { type: "text", text: "All tests pass. Deployed to production." },
    });
    const code = main(["node", "zeuge", "claim", "detect", "--stdin", "--json"], { ...c.io, readStdin: () => payload });
    expect(code).toBe(0);
    const report = JSON.parse(c.out());
    expect(report.claims).toHaveLength(2);
    expect(report.claims.map((cl: { claim_type: string }) => cl.claim_type).sort()).toEqual(["deployed", "tests_pass"]);
  });

  it(" claim detect --stdin still scans plain prose as literal text (unchanged contract)", () => {
    const c = capture();
    const code = main(["node", "zeuge", "claim", "detect", "--stdin", "--json"], { ...c.io, readStdin: () => "All tests pass." });
    expect(code).toBe(0);
    const report = JSON.parse(c.out());
    expect(report.claims).toHaveLength(1);
  });

  it(" claim detect exits 3 with a visible issue when the hook payload's transcript_path is unreadable", () => {
    const c = capture();
    const payload = JSON.stringify({ hook_event_name: "Stop", transcript_path: "/definitely/does/not/exist-zeuge.jsonl" });
    const code = main(["node", "zeuge", "claim", "detect", "--stdin"], { ...c.io, readStdin: () => payload });
    expect(code).toBe(3);
    expect(c.err()).toMatch(/transcript unreadable/);
  });

  it("ledger verify with --expected-head reports head_binding BOUND", () => {
    const okPath = path.join(FIXTURES, "ledger", "ledger-ok.jsonl");
    const c1 = capture();
    main(["node", "zeuge", "ledger", "head", okPath], c1.io);
    const headHash = c1.out().trim();

    const c2 = capture();
    const code = main(["node", "zeuge", "ledger", "verify", okPath, "--expected-head", headHash, "--json"], c2.io);
    expect(code).toBe(0);
    const report = JSON.parse(c2.out());
    expect(report.head_binding).toBe("BOUND");
    expect(report.note).toBeUndefined();
  });
});
