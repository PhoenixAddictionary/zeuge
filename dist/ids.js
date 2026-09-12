"use strict";
/**
 * ids — opaque identifiers: /^[a-z][a-z0-9_-]{1,31}:[0-9a-f]{32,64}$/
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ID_RE = void 0;
exports.makeId = makeId;
exports.isValidId = isValidId;
const node_crypto_1 = require("node:crypto");
exports.ID_RE = /^[a-z][a-z0-9_-]{1,31}:[0-9a-f]{32,64}$/;
function makeId(prefix) {
    return `${prefix}:${(0, node_crypto_1.randomBytes)(16).toString("hex")}`;
}
function isValidId(value, prefix) {
    if (!exports.ID_RE.test(value))
        return false;
    if (prefix && !value.startsWith(prefix + ":"))
        return false;
    return true;
}
