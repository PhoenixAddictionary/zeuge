#!/usr/bin/env node
// Fail when a pasted copy of the seat hook is not the cursor-relay blob.
// The rule is edited only in PhoenixAddictionary/cursor-relay.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const GROUPS = [
  {
    home: { repo: "cursor-relay", path: "hold.mjs" },
    copies: [
      { repo: "genesis-web", path: "relay/hold.mjs" },
      { repo: "memoria-service", path: "relay/hold.mjs" },
      { repo: "zeuge", path: "relay/hold.mjs" },
    ],
  },
  {
    home: { repo: "cursor-relay", path: "receipt.mjs" },
    copies: [
      { repo: "genesis-web", path: "relay/receipt.mjs" },
      { repo: "memoria-service", path: "relay/receipt.mjs" },
      { repo: "zeuge", path: "relay/receipt.mjs" },
    ],
  },
];

export function mismatches(groups) {
  const found = [];
  for (const group of groups) {
    for (const copy of group.copies) {
      if (copy.sha !== group.home.sha) {
        found.push(
          `${copy.repo} ${copy.path} is ${copy.sha || "missing"}, home ${group.home.repo} ${group.home.path} is ${group.home.sha}`,
        );
      }
    }
  }
  return found;
}

function blobSha(repo, path) {
  const out = execFileSync(
    "gh",
    ["api", `repos/PhoenixAddictionary/${repo}/contents/${path}`, "--jq", ".sha"],
    { encoding: "utf8" },
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(out)) throw new Error(`no blob sha for ${repo} ${path}`);
  return out;
}

function main() {
  const filled = GROUPS.map((group) => ({
    home: { ...group.home, sha: blobSha(group.home.repo, group.home.path) },
    copies: group.copies.map((copy) => ({ ...copy, sha: blobSha(copy.repo, copy.path) })),
  }));
  const found = mismatches(filled);
  if (found.length) {
    for (const line of found) console.error(line);
    process.exit(1);
  }
  console.log(`pins match cursor-relay (${filled.map((group) => group.home.sha.slice(0, 12)).join(", ")})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
