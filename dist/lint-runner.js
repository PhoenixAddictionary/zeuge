"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runLint = runLint;
exports.formatReport = formatReport;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const instruction_order_1 = require("./lints/instruction-order");
const hook_matcher_1 = require("./lints/hook-matcher");
const severity_1 = require("./severity");
function findSettingsFiles(claudeDir) {
    if (!fs.existsSync(claudeDir) || !fs.statSync(claudeDir).isDirectory())
        return [];
    return fs
        .readdirSync(claudeDir)
        .filter((name) => name.startsWith("settings") && name.endsWith(".json"))
        .map((name) => path.join(claudeDir, name))
        .sort();
}
/**
 * Runs the hook-matcher lint over <root>/.claude/settings*.json always, and the
 * instruction-order lint over <root>/CLAUDE.md and <root>/AGENTS.md only when
 * `opts.experimentalOrder` is set (off by default; the tightened rule only).
 */
function runLint(root, opts = {}) {
    const experimentalOrder = opts.experimentalOrder ?? false;
    const strict = opts.strict ?? false;
    const scanned = [];
    const entries = [];
    const counts = (0, severity_1.emptyCounts)();
    if (experimentalOrder) {
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
            const file = path.join(root, name);
            if (!fs.existsSync(file))
                continue;
            scanned.push(file);
            const findings = (0, instruction_order_1.getFindingsTight)(fs.readFileSync(file, "utf8").split(/\r?\n/));
            entries.push({ lint: "instruction-order", file, findings });
            for (const f of findings)
                counts[f.severity]++;
        }
    }
    const settingsFiles = findSettingsFiles(path.join(root, ".claude"));
    for (const file of settingsFiles) {
        scanned.push(file);
        const result = (0, hook_matcher_1.scanFile)(file);
        entries.push({ lint: "hook-matcher", file, findings: result.violations, parseError: result.parseError });
        for (const v of result.violations)
            counts[v.severity]++;
    }
    const totalFindings = counts.fault + counts.risk + counts.review;
    const parseErrors = entries.filter((e) => e.parseError).length;
    const nothingScanned = scanned.length === 0;
    // Exit-code precedence (uniform across zeuge, see ZEUGE_SPEC §1): 3 = integrity
    // failure outranks everything. An unparseable settings file is not "0 findings" — it is a
    // file this lint could not read at all, a stronger and different claim than "read it, found
    // nothing." Below that: a "fault" always exits 1; risk/review need --strict to.
    let exitCode = 0;
    let reason;
    if (nothingScanned) {
        exitCode = 3;
        reason = "NOTHING_SCANNED";
    }
    else if (parseErrors > 0) {
        exitCode = 3;
    }
    else if (counts.fault > 0) {
        exitCode = 1;
    }
    else if (strict && totalFindings > 0) {
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
        blindSpots: [...instruction_order_1.BLIND_SPOTS, ...hook_matcher_1.BLIND_SPOTS],
        notes: experimentalOrder ? [instruction_order_1.FIELD_TEST_NOTE] : [],
    };
}
const SEVERITY_ORDER = ["fault", "risk", "review"];
const SEVERITY_LABEL = { fault: "FAULT", risk: "RISK", review: "REVIEW" };
function findingLine(entry, finding) {
    if (entry.lint === "instruction-order") {
        const f = finding;
        return [
            `  ${entry.file}`,
            `  line ${f.orderLine}: ordering clause after the action on line ${f.actionLine}`,
            `     action  : ${f.action.slice(0, 96)}`,
            `     ordering: ${f.order.slice(0, 96)}`,
        ];
    }
    const v = finding;
    return [`  ${entry.file}`, `  group[${v.index}] ${v.message}`, `     matcher : ${v.matcher}`, `     gates   : ${v.tools || "(n/a)"}`];
}
function formatReport(report) {
    const lines = [];
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
        const groupLines = [];
        for (const entry of report.entries) {
            for (const f of entry.findings) {
                if (f.severity !== severity)
                    continue;
                groupLines.push(...findingLine(entry, f));
            }
        }
        if (groupLines.length === 0)
            continue;
        lines.push("");
        lines.push(`${SEVERITY_LABEL[severity]} (${report.counts[severity]}):`);
        lines.push(...groupLines);
    }
    if (report.notes.length > 0) {
        lines.push("");
        lines.push("NOTES:");
        for (const n of report.notes)
            lines.push(`  ${n}`);
    }
    lines.push("");
    lines.push("=".repeat(78));
    lines.push("BLIND SPOTS (part of the verdict, not a footnote):");
    for (const b of report.blindSpots)
        lines.push(`  - ${b}`);
    if (!report.experimentalOrder) {
        lines.push("  - instruction-order is OFF by default this run; pass --experimental-order to enable the tightened rule.");
    }
    lines.push("");
    lines.push(`summary: ${report.totalFindings} finding(s) [fault:${report.counts.fault} risk:${report.counts.risk} review:${report.counts.review}], ${report.parseErrors} integrity failure(s), across ${report.scanned.length} scanned file(s). exit ${report.exitCode}${report.strict ? " (--strict)" : ""}.`);
    return lines.join("\n");
}
