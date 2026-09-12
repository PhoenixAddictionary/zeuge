/**
 * receipt/report — a single-file HTML Claim Audit Report. No external assets, no scripts, no
 * network. The coverage block is the first thing after the title, not the claim
 * list — a report that cannot show its own coverage is refused outright (see renderReport).
 */

import type { Bundle } from "./bundle";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const THREATS = [
  "It binds what was witnessed, not that the code is correct. A WITNESSED tests_pass claim proves a command ran and exited 0 in a recorded environment. It says nothing about coverage, test quality, or whether the suite exercises the change. WITNESSED is not true.",
  "Local key custody. Keys are generated and held on the audited machine, so whoever controls it can sign a bundle describing events that did not happen. A signature proves custody continuity since signing, not honesty at signing time.",
  "Clock trust. recorded_at, valid_until and the grace window come from the local clock. Monotonicity is checked within a chain; absolute time is unverified. No trusted timestamping.",
  "Detection is regex-shaped. Unusual phrasing produces no claim, and an undetected claim looks exactly like a claim that never existed. Table coverage is a declared blind spot, not a silent one.",
  "Hash chains detect tampering, not prevent it. Rewriting the whole ledger and re-signing yields a consistent artefact; only an externally held head hash catches that.",
  "Omission is invisible. Nothing forces an agent to emit events. Silence is not evidence an action did not occur.",
  "Third-party receipts carry their own assumptions. A verified external signature proves their key signed their record — their threat model, not this one.",
  "No authority. A receipt grants no merge, deploy, publish or payment right. It is evidence handed to whoever holds that authority.",
  // Kept as an exact, precisely worded sentence — this is a threat-model limitation, not a paraphrase:
  "A writer who rewrites rows and recomputes all hashes with monotone timestamps is undetectable without an external anchor; the P5 bundle signature does not remove this (the key is local).",
];

const BLIND_SPOTS = [
  "instruction-order and hook-matcher lints are lexical and single-file; see their own reported blind-spot lines.",
  "Claim binding matches by claim_type membership, session_id (when the witness carries one), and a 30-minute time window around the claim. A witness recorded with no session_id at all (an event predating this binding, or from a source that cannot determine one) still binds on claim_type + time window alone, permissively — absence of a session signal is not treated as a different session.",
  "protect-mcp witnesses are never signature-verified by this package (kind:\"external_receipt\", verified:false, always).",
];

export type ReportResult = { ok: true; html: string } | { ok: false; reason: string };

export function renderReport(bundle: Bundle): ReportResult {
  if (!bundle.coverage) {
    return { ok: false, reason: "REPORT_WITHOUT_COVERAGE: bundle carries no coverage block; refusing to render a report that cannot show its own coverage." };
  }

  const cov = bundle.coverage;
  const coverageHtml = `
    <section class="coverage">
      <h2>Coverage</h2>
      <table>
        <tr><td>statements total</td><td>${esc(cov.statements_total)}</td></tr>
        <tr><td>turns scanned</td><td>${esc(cov.turns_scanned)}</td></tr>
        <tr><td>statements classified</td><td>${esc(cov.statements_classified)}</td></tr>
        <tr><td>statements matched</td><td>${esc(JSON.stringify(cov.statements_matched))}</td></tr>
        ${cov.statements_skipped ? `<tr><td>statements skipped</td><td>${esc(JSON.stringify(cov.statements_skipped))}</td></tr>` : ""}
        <tr><td>probe</td><td class="probe-${esc(cov.probe)}">${esc(cov.probe)}</td></tr>
        ${cov.transcript_unreadable ? `<tr><td>transcript unreadable</td><td>${esc(cov.transcript_unreadable_class ?? "true")}</td></tr>` : ""}
      </table>
    </section>`;

  const rows = bundle.claims
    .map((c) => {
      const witnessLocators = c.witnesses
        .map((wid) => bundle.witnesses.find((w) => w.witness_id === wid))
        .filter(Boolean)
        .map((w) => `${esc(w!.kind)}:${esc(w!.locator)}`)
        .join(", ");
      return `<tr class="status-${esc(c.status)}"><td>${esc(c.claim_type)}</td><td>${esc(c.statement ?? "(redacted)")}</td><td>${esc(c.status)}</td><td>${witnessLocators || "&mdash;"}</td></tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Zeuge Claim Audit Report</title>
<style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;margin:0.5rem 0}
td,th{border:1px solid #ccc;padding:0.4rem 0.6rem;text-align:left;font-size:0.9rem;vertical-align:top}
.probe-ALIVE{color:#0a7a2f} .probe-DEAD{color:#b00020;font-weight:bold}
.status-WITNESSED{background:#f0fdf4} .status-UNWITNESSED{background:#fff7ed} .status-REFUTED{background:#fef2f2}
.authenticity{font-weight:bold;color:#b00020}
ul{font-size:0.85rem}
</style></head>
<body>
<h1>Zeuge Claim Audit Report</h1>
<p>bundle_id: ${esc(bundle.bundle_id)} &middot; produced_at: ${esc(bundle.produced_at)} &middot; authenticity: <span class="authenticity">LOCAL_ONLY</span></p>
${coverageHtml}
<section class="claims">
  <h2>Claims &times; Witnesses</h2>
  <table>
    <thead><tr><th>type</th><th>statement</th><th>status</th><th>witness(es)</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">(no claims in this session)</td></tr>'}</tbody>
  </table>
  <p>summary: ${esc(bundle.summary.claims_total)} total, ${esc(bundle.summary.witnessed)} witnessed, ${esc(bundle.summary.unwitnessed)} unwitnessed, ${esc(bundle.summary.refuted)} refuted, min trust ${esc(bundle.summary.min_trust_level)}.</p>
</section>
<section class="blind-spots">
  <h2>Blind spots</h2>
  <ul>${BLIND_SPOTS.map((b) => `<li>${esc(b)}</li>`).join("\n")}</ul>
</section>
<section class="threats">
  <h2>THREATS — what this receipt does not prove</h2>
  <ul>${THREATS.map((t) => `<li>${esc(t)}</li>`).join("\n")}</ul>
</section>
</body></html>
`;

  return { ok: true, html };
}
