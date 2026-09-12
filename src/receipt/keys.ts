/**
 * receipt/keys — Ed25519 keypair for signing bundles, via Node's built-in node:crypto only
 * (zero runtime dependencies). Keys live under .zeuge/keys/ (mode 0600 where the OS honors
 * chmod; Windows ACLs are not managed here — a declared limitation, not a silent gap). The
 * private key never enters a bundle, a report, or a log.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, KeyObject } from "node:crypto";

export interface Keypair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

function keysDir(zeugeDir: string): string {
  return path.join(zeugeDir, "keys");
}

export function loadOrCreateKeypair(zeugeDir: string): Keypair {
  const dir = keysDir(zeugeDir);
  const privPath = path.join(dir, "private.pem");
  const pubPath = path.join(dir, "public.pem");

  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    const privateKey = { key: fs.readFileSync(privPath, "utf8"), format: "pem" as const };
    const publicKey = { key: fs.readFileSync(pubPath, "utf8"), format: "pem" as const };
    return {
      privateKey: require("node:crypto").createPrivateKey(privateKey),
      publicKey: require("node:crypto").createPublicKey(publicKey),
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.mkdirSync(dir, { recursive: true });
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });
  try {
    fs.chmodSync(privPath, 0o600);
  } catch {
    /* best-effort on platforms where chmod is a no-op (e.g. Windows without POSIX ACL support) */
  }
  return { publicKey, privateKey };
}

export function publicKeySpkiB64(publicKey: KeyObject): string {
  return (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

export function publicKeyFromSpkiB64(b64: string): KeyObject {
  const der = Buffer.from(b64, "base64");
  return require("node:crypto").createPublicKey({ key: der, format: "der", type: "spki" });
}

export function signMessage(message: Buffer, privateKey: KeyObject): string {
  return cryptoSign(null, message, privateKey).toString("base64");
}

export function verifySignature(message: Buffer, signatureB64: string, publicKey: KeyObject): boolean {
  try {
    return cryptoVerify(null, message, publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
