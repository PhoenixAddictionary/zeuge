import * as fs from "node:fs";
import * as path from "node:path";
import {
  getFindingsTight,
  InstructionOrderFinding,
  BLIND_SPOTS as INSTRUCTION_ORDER_BLIND_SPOTS,
  FIELD_TEST_NOTE,
} from "./lints/instruction-order";
import { scanFile as scanHookMatcherFile, HookMatcherViolation, BLIND_SPOTS as HOOK_MATCHER_BLIND_SPOTS } from "./lints/hook-matcher";
import { emptyCounts, SeverityCounts } from "./severity";

export interface LintReportEntry {
  lint: "instruction-order" | "hook-matcher";
  file: string;
  findings: InstructionOrderFinding[] | HookMatcherViolation[];
  parseError?: string;
}

export interface LintRunOptions {
  /** instruction-order is off by default (measured too noisy — see FIELD_TEST_NOTE).
   *  When true, CLAUDE.md/AGENTS.md are scanned with the TIGHTENED rule only. */
  experimentalOrder?: boolean;
  /** Without --strict, only a "fault" finding affects the exit code; risk/review
   *  findings are printed and counted but exit 0. With --strict, any finding exits 1. */
  strict?: boolean;
}

export interface LintReport {
  root: string;
  scanned: string[];
  entries: LintReportEntry[];
  totalFindings: number;
  counts: SeverityCounts;
  parseErrors: number;
  nothingScanned: boolean;
  blindSpots: string[];
  notes: string[];
  experimentalOrder: boolean;
  strict: boolean;
  /** 0 clean (or findings present but not "fault", without --strict) · 1 a "fault" finding, or
   *  any finding at all under --strict · 3 integrity failure (parse error, or nothing to scan) */
  exitCode: 0 | 1 | 3;
  reason?: "NOTHING_SCANNED";
}

function findSettingsFiles(claudeDir: string): string[] {
  if (!fs.existsSync(claudeDir) || !fs.statSync(claudeDir).isDirectory()) return [];
  return fs
    .readdirSync(claudeDir)
    .filter((name: string) => name.startsWith("settings") && name.endsWith(".json"))
    .map((name: string) => path.join(claudeDir, name))
    .sort();
}

/**
 * Runs the hook-matcher lint over <root>/.claude/settings*.json always, and the
 * instruction-order lint over <root>/CLAUDE.md and <root>/AGENTS.md only when
 * `opts.experimentalOrder` is set (off by default; the tightened rule only).
 */
export function runLint(root: string, opts: LintRunOptions = {}): LintReport {
  const experimentalOrder = opts.experimentalOrder ?? false;
  const strict = opts.strict ?? false;
  const scanned: string[] = [];
  const entries: LintReportEntry[] = [];
  const counts = emptyCounts();

  if (experimentalOrder) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) continue;
      scanned.push(file);
      const findings = getFindingsTight(fs.readFileSync(file, "utf8").split(/\r?\n/));
      entries.push({ lint: "instruction-order", file, findings });
      for (const f of findings) counts[f.severity]++;
    }
  }

  const settingsFiles = findSettingsFiles(path.join(root, ".claude"));
  for (const file of settingsFiles) {
    scanned.push(file);
    const result = scanHookMatcherFile(file);
    entries.push({ lint: "hook-matcher", file, findings: result.violations, parseError: result.parseError });
    for (const v of result.violations) counts[v.severity]++;
  }

  const totalFindings = counts.fault + counts.risk + counts.review;
  const parseErrors = entries.filter((e) => e.parseError).length;
  const nothingScanned = scanned.length === 0;

  // Exit-code precedence (uniform across zeuge, see ZEUGE_SPEC §1): 3 = integrity
  // failure outranks everything. An unparseable settings file is not "0 findings" — it is a
  // file this lint could not read at all, a stronger and different claim than "read it, found
  // nothing." Below that: a "fault" always exits 1; risk/review need --strict to.
  let exitCode: 0 | 1 | 3 = 0;
  let reason: "NOTHING_SCANNED" | undefined;
  if (nothingScanned) {
    exitCode = 3;
    reason = "NOTHING_SCANNED";
  } else if (parseErrors > 0) {
    exitCode = 3;
  } else if (counts.fault > 0) {
    exitCode = 1;
  } else if (strict && totalFindings > 0) {
    exitCode = 1;
  }

  return {
    root,
    scanned,
    entries,
    totalFindings,
    counts,
    parseErrors,
    nothingScanned,
    exitCode,
    reason,
    experimentalOrder,
    strict,
    blindSpots: [...INSTRUCTION_ORDER_BLIND_SPOTS, ...HOOK_MATCHER_BLIND_SPOTS],
    notes: experimentalOrder ? [FIELD_TEST_NOTE] : [],
  };
}

const SEVERITY_ORDER: Array<"fault" | "risk" | "review"> = ["fault", "risk", "review"];
const SEVERITY_LABEL: Record<"fault" | "risk" | "review", string> = { fault: "FAULT", risk: "RISK", review: "REVIEW" };

function findingLine(entry: LintReportEntry, finding: InstructionOrderFinding | HookMatcherViolation): string[] {
  if (entry.lint === "instruction-order") {
    const f = finding as InstructionOrderFinding;
    return [
      `  ${entry.file}`,
      `  line ${f.orderLine}: ordering clause after the action on line ${f.actionLine}`,
      `     action  : ${f.action.slice(0, 96)}`,
      `     ordering: ${f.order.slice(0, 96)}`,
    ];
  }
  const v = finding as HookMatcherViolation;
  return [`  ${entry.file}`, `  group[${v.index}] ${v.message}`, `     matcher : ${v.matcher}`, `     gates   : ${v.tools || "(n/a)"}`];
}

export function formatReport(report: LintReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("zeuge lint — instruction-order (opt-in) and hook-matcher");
  lines.push("=".repeat(78));

  if (report.nothingScanned) {
    lines.push("");
    lines.push(`NOTHING_SCANNED — no .claude/settings*.json under ${report.root}${report.experimentalOrder ? ", and no CLAUDE.md/AGENTS.md" : ""}`);
    lines.push("  this is an integrity failure, not a clean pass: a lint that scanned nothing has verified");
    lines.push("  nothing, and reporting exit 0 for that would look identical to a genuinely clean tree.");
  }

  for (const entry of report.entries) {
    if (entry.parseError) {
      lines.push("");
      lines.push(`${entry.file}  (INTEGRITY FAILURE — unparseable JSON: ${entry.parseError})`);
      lines.push("     this file could not be checked at all; that is not the same claim as \"checked, clean.\"");
    }
  }

  // Grouped by severity: a fault first, a risk next, a review last — never a flat list
  // where a heuristic reads the same as a real defect.
  for (const severity of SEVERITY_ORDER) {
    const groupLines: string[] = [];
    for (const entry of report.entries) {
      for (const f of entry.findings) {
        if ((f as InstructionOrderFinding | HookMatcherViolation).severity !== severity) continue;
        groupLines.push(...findingLine(entry, f));
      }
    }
    if (groupLines.length === 0) continue;
    lines.push("");
    lines.push(`${SEVERITY_LABEL[severity]} (${report.counts[severity]}):`);
    lines.push(...groupLines);
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("NOTES:");
    for (const n of report.notes) lines.push(`  ${n}`);
  }

  lines.push("");
  lines.push("=".repeat(78));
  lines.push("BLIND SPOTS (part of the verdict, not a footnote):");
  for (const b of report.blindSpots) lines.push(`  - ${b}`);
  if (!report.experimentalOrder) {
    lines.push("  - instruction-order is OFF by default this run; pass --experimental-order to enable the tightened rule.");
  }
  lines.push("");
  lines.push(
    `summary: ${report.totalFindings} finding(s) [fault:${report.counts.fault} risk:${report.counts.risk} review:${report.counts.review}], ${report.parseErrors} integrity failure(s), across ${report.scanned.length} scanned file(s). exit ${report.exitCode}${report.strict ? " (--strict)" : ""}.`
  );
  return lines.join("\n");
}
