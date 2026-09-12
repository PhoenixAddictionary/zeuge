"use strict";
/**
 * hook-matcher — flags a PreToolUse hook matcher in a Claude Code settings file that would
 * gate Read, Grep, or Glob (a guard that locks out its own repair).
 *
 * Ported from tools/hook-matcher-lint.ps1, then corrected (2026-09-11) once it became clear that
 * Claude Code evaluates a matcher as a REGULAR EXPRESSION
 * against the tool name, not as a literal "|"-split alternative list. `(Read|Grep)`, `Read.*`,
 * and `^Read$` all gate Read even though none of them is the literal alternative "Read" that
 * the naive split-on-"|" port (and the pwsh original) checked for. The lint now asks the same
 * question Claude Code's matcher engine asks: for each diagnostic tool name, does the matcher
 * match it as a regex anchored to the whole string?
 */
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
exports.BLIND_SPOTS = void 0;
exports.getMatcherViolations = getMatcherViolations;
exports.scanFile = scanFile;
const fs = __importStar(require("node:fs"));
// The tools an agent needs to diagnose a misfiring guard. Gating these is what makes a guard
// self-locking. Mutation tools (Write/Edit/Bash/...) are deliberately NOT in this set.
const DIAGNOSTIC_TOOLS = ["Read", "Grep", "Glob"];
/**
 * Field-tested against 10 public hook files (2026-09-11): one MATCHER_ABSENT finding, no
 * INVALID_REGEX. Both GATES_DIAGNOSTIC_TOOL and MATCHER_ABSENT are severity "risk", not
 * "fault" — a PreToolUse hook that matches Read/Grep/Glob is only a self-lockout if it ALSO
 * blocks (a non-blocking/logging hook here is harmless), and this lint cannot see what the
 * matched hook script actually does. INVALID_REGEX is a "fault": a matcher that cannot even
 * compile is a defect regardless of what it was meant to gate.
 */
const SELF_LOCKOUT_MESSAGE = "matcher gates diagnostic tools — a blocking hook here can lock the agent out of its own repair path";
function severityFor(kind) {
    return kind === "INVALID_REGEX" ? "fault" : "risk";
}
function messageFor(kind) {
    return kind === "INVALID_REGEX" ? "matcher does not compile as a regular expression" : SELF_LOCKOUT_MESSAGE;
}
/**
 * Tests whether `matcher`, evaluated the way Claude Code evaluates a PreToolUse matcher (a
 * regular expression anchored to the whole tool name), matches `toolName`.
 * Returns "INVALID" if the matcher is not a well-formed regex — an invalid regex is reported
 * as its own finding, never silently skipped, because a matcher that cannot even compile is
 * a defect a human needs to see regardless of how the harness happens to fail on it.
 */
function matchesTool(matcher, toolName) {
    try {
        const re = new RegExp("^(?:" + matcher + ")$");
        return re.test(toolName);
    }
    catch {
        return "INVALID";
    }
}
/**
 * Returns one violation per offending matcher group. For each PreToolUse matcher, every
 * diagnostic tool name is tested against it as an anchored regex (matching Claude Code's own
 * evaluation semantics). A matcher that fails to compile as a regex is reported as
 * INVALID_REGEX rather than silently skipped.
 */
function getMatcherViolations(settings) {
    const found = [];
    if (!settings || typeof settings !== "object")
        return found;
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== "object")
        return found;
    const pre = hooks.PreToolUse;
    if (pre === undefined || pre === null)
        return found;
    const groups = Array.isArray(pre) ? pre : [pre];
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const matcher = group && group.matcher !== undefined && group.matcher !== null ? String(group.matcher) : "";
        if (!matcher.trim()) {
            // An empty or missing `matcher`
            // is not "no opinion" in Claude Code — it matches EVERY tool name, Read/Grep/Glob
            // included. The previous `continue` here treated this as clean; it is the single worst
            // case the lint exists to catch, silently skipped.
            found.push({
                event: "PreToolUse",
                index: i,
                matcher,
                tools: DIAGNOSTIC_TOOLS.join(", "),
                kind: "MATCHER_ABSENT",
                severity: severityFor("MATCHER_ABSENT"),
                message: messageFor("MATCHER_ABSENT"),
            });
            continue;
        }
        let invalid = false;
        const hits = [];
        for (const tool of DIAGNOSTIC_TOOLS) {
            const result = matchesTool(matcher, tool);
            if (result === "INVALID") {
                invalid = true;
                break;
            }
            if (result)
                hits.push(tool);
        }
        if (invalid) {
            found.push({ event: "PreToolUse", index: i, matcher, tools: "", kind: "INVALID_REGEX", severity: severityFor("INVALID_REGEX"), message: messageFor("INVALID_REGEX") });
        }
        else if (hits.length > 0) {
            found.push({
                event: "PreToolUse",
                index: i,
                matcher,
                tools: hits.join(", "),
                kind: "GATES_DIAGNOSTIC_TOOL",
                severity: severityFor("GATES_DIAGNOSTIC_TOOL"),
                message: messageFor("GATES_DIAGNOSTIC_TOOL"),
            });
        }
    }
    return found;
}
function scanFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    try {
        const parsed = JSON.parse(raw);
        return { file: filePath, violations: getMatcherViolations(parsed) };
    }
    catch (err) {
        return { file: filePath, violations: [], parseError: err instanceof Error ? err.message : String(err) };
    }
}
exports.BLIND_SPOTS = [
    "hook-matcher: only PreToolUse is checked, not other hook events.",
    "hook-matcher: the matcher is evaluated as a regex anchored to the whole tool name (Claude Code's own semantics), but only against the three diagnostic tool names — a matcher that gates a diagnostic-adjacent MCP tool of a different name is invisible.",
    "hook-matcher: an unparseable matcher regex is reported as its own finding (INVALID_REGEX), but this lint does not know whether the harness fails open or closed on such a matcher at runtime.",
    "hook-matcher: it does not evaluate what the matched hook script actually does, only whether the matcher would gate a diagnostic tool.",
];
