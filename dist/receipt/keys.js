"use strict";
/**
 * receipt/keys — Ed25519 keypair for signing bundles, via Node's built-in node:crypto only
 * (zero runtime dependencies). Keys live under .zeuge/keys/ (mode 0600 where the OS honors
 * chmod; Windows ACLs are not managed here — a declared limitation, not a silent gap). The
 * private key never enters a bundle, a report, or a log.
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
exports.loadOrCreateKeypair = loadOrCreateKeypair;
exports.publicKeySpkiB64 = publicKeySpkiB64;
exports.publicKeyFromSpkiB64 = publicKeyFromSpkiB64;
exports.signMessage = signMessage;
exports.verifySignature = verifySignature;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
function keysDir(zeugeDir) {
    return path.join(zeugeDir, "keys");
}
function loadOrCreateKeypair(zeugeDir) {
    const dir = keysDir(zeugeDir);
    const privPath = path.join(dir, "private.pem");
    const pubPath = path.join(dir, "public.pem");
    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
        const privateKey = { key: fs.readFileSync(privPath, "utf8"), format: "pem" };
        const publicKey = { key: fs.readFileSync(pubPath, "utf8"), format: "pem" };
        return {
            privateKey: require("node:crypto").createPrivateKey(privateKey),
            publicKey: require("node:crypto").createPublicKey(publicKey),
        };
    }
    const { publicKey, privateKey } = (0, node_crypto_1.generateKeyPairSync)("ed25519");
    fs.mkdirSync(dir, { recursive: true });
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const pubPem = publicKey.export({ type: "spki", format: "pem" });
    fs.writeFileSync(privPath, privPem, { mode: 0o600 });
    fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });
    try {
        fs.chmodSync(privPath, 0o600);
    }
    catch {
        /* best-effort on platforms where chmod is a no-op (e.g. Windows without POSIX ACL support) */
    }
    return { publicKey, privateKey };
}
function publicKeySpkiB64(publicKey) {
    return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}
function publicKeyFromSpkiB64(b64) {
    const der = Buffer.from(b64, "base64");
    return require("node:crypto").createPublicKey({ key: der, format: "der", type: "spki" });
}
function signMessage(message, privateKey) {
    return (0, node_crypto_1.sign)(null, message, privateKey).toString("base64");
}
function verifySignature(message, signatureB64, publicKey) {
    try {
        return (0, node_crypto_1.verify)(null, message, publicKey, Buffer.from(signatureB64, "base64"));
    }
    catch {
        return false;
    }
}
