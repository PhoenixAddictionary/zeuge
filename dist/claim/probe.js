"use strict";
/**
 * claim/probe — a positive control run before every
 * real scan. An undetected claim is indistinguishable from an absent one, so before trusting
 * the detector on real text, run it on one built-in planted sentence per claim_type. If any
 * planted sentence is not detected, the whole run reports probe: DEAD and — for a non-hook
 * caller — refuses to emit claim records at all (exit 3): a probe that cannot fire proves
 * nothing (lineage: a check whose failure mode is silence is not a check).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLANTED_SENTENCES = void 0;
exports.runProbe = runProbe;
const detect_1 = require("./detect");
exports.PLANTED_SENTENCES = [
    { claim_type: "tests_pass", text: "All tests pass." },
    { claim_type: "deployed", text: "Deployed to production." },
    { claim_type: "fixed", text: "Fixed the bug." },
    { claim_type: "done", text: "Done." },
];
function runProbe(rules = detect_1.DEFAULT_RULES) {
    const missing = [];
    for (const planted of exports.PLANTED_SENTENCES) {
        const found = (0, detect_1.detectClaims)(planted.text, rules).some((c) => c.claim_type === planted.claim_type);
        if (!found)
            missing.push(planted.claim_type);
    }
    return { probe: missing.length === 0 ? "ALIVE" : "DEAD", missing };
}
