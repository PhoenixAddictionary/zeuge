/**
 * severity — the shared severity vocabulary every check reports against (measured in a
 * 2026-09-11 field test: the instruction-order lint's original rule produced 457 findings
 * across 210/696 public instruction files, and the inspected examples were false positives —
 * a flat finding list with one exit code cannot distinguish "this will misfire" from "this is
 * worth a human's attention" from "this is a real defect."
 *
 * Only a `fault` finding exits 1 by default. `risk` and `review` findings are always printed
 * and always counted, but only affect the exit code under `--strict`. Integrity failures —
 * unparsable input, NOTHING_SCANNED, a claim-detector's own positive-control probe reporting
 * DEAD — are NOT severities and are unaffected by `--strict`: they stay exit 3 always, because
 * they are not a judgment about a finding's importance, they are "this check could not run."
 */

export type FindingSeverity = "fault" | "risk" | "review";

export interface SeverityCounts {
  fault: number;
  risk: number;
  review: number;
}

export function emptyCounts(): SeverityCounts {
  return { fault: 0, risk: 0, review: 0 };
}

export function tallyCounts(severities: FindingSeverity[]): SeverityCounts {
  const counts = emptyCounts();
  for (const s of severities) counts[s] += 1;
  return counts;
}
