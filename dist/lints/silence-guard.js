"use strict";
/**
 * silence-guard — a command that exited 0 with empty output, and did not declare itself
 * expected-silent, is UNPROVEN, not a pass. A check whose failure mode is silence fails
 * invisibly: an empty result and a check that never ran look identical from the outside.
 *
 * New in zeuge (no PowerShell original); small by design.
 *
 * UNPROVEN is severity "risk" (a caller should look, but this module has no evidence of
 * an actual defect — the command DID exit 0). This is exposed via `silenceSeverity` for
 * whatever aggregates silence-guard results into a severity-counted report; the function itself
 * stays a pure classifier with no severity plumbing of its own.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLIND_SPOTS = void 0;
exports.silenceSeverity = silenceSeverity;
exports.checkSilence = checkSilence;
/** UNPROVEN is "risk"; PASS and FAIL are not findings needing a severity at all (PASS is clean,
 *  FAIL is a hard failure the caller already treats as such on its own terms). */
function silenceSeverity(verdict) {
    return verdict === "UNPROVEN" ? "risk" : null;
}
function checkSilence(run) {
    if (run.exitCode !== 0)
        return "FAIL";
    const combined = (run.stdout ?? "") + (run.stderr ?? "");
    const isEmpty = combined.trim().length === 0;
    if (isEmpty && !run.expectedSilent)
        return "UNPROVEN";
    return "PASS";
}
exports.BLIND_SPOTS = [
    "silence-guard: it cannot distinguish a check that ran and legitimately found nothing to say from one that never ran at all — that is exactly why silence is UNPROVEN rather than PASS, but a caller that mislabels expectedSilent defeats it.",
];
