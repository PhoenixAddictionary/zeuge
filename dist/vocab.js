"use strict";
/**
 * vocab — frozen enums shared by the claim and ledger schemas.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTOR_KINDS = exports.EVENT_FAMILIES = exports.TRUST_LEVELS = exports.CLAIM_STATUS = exports.OUTCOMES = exports.ACTION_TYPES = exports.CLAIM_TYPES = void 0;
exports.CLAIM_TYPES = ["tests_pass", "deployed", "fixed", "done", "file_exists", "command_ran", "other"];
exports.ACTION_TYPES = [
    "TOOL_INVOCATION",
    "COMMAND_RUN",
    "FILE_WRITE",
    "CLAIM_EMITTED",
    "CLAIM_VERIFIED",
    "CLAIM_REFUTED",
    "LICENSE_CHECK",
    "SEGMENT_OPEN",
];
exports.OUTCOMES = ["PASS", "FAILED", "BLOCKED", "REFUSED", "NO_RESULT", "PENDING", "UNKNOWN", "NOT_APPLICABLE"];
exports.CLAIM_STATUS = ["UNWITNESSED", "WITNESSED", "REFUTED"];
exports.TRUST_LEVELS = ["L0", "L1", "L2", "L3", "L4"];
exports.EVENT_FAMILIES = ["CLAIM", "ACTION", "RESULT", "VERIFICATION", "CONTROL", "LIFECYCLE"];
exports.ACTOR_KINDS = ["MODEL", "HUMAN", "TOOL", "SYSTEM"];
