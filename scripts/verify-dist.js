#!/usr/bin/env node
"use strict";

/**
 * verify-dist — P9 item 1: dist/ is committed to git (a Claude Code plugin install pulls from
 * git, not npm, so an untracked dist/ leaves the plugin's own hook commands unable to find
 * their compiled code). A committed build artifact can drift from src/ if someone edits src/
 * and forgets to rebuild-and-commit. This script builds a FRESH copy into an isolated temp
 * directory (never touching the real dist/ on disk) and byte-compares every file against what
 * is ACTUALLY COMMITTED AT HEAD — read via `git ls-tree`/`git show`, never via a plain
 * `fs.readdir` of the working-tree dist/ directory. That distinction matters: a working-tree
 * comparison would pass even when dist/ has been rebuilt but not yet `git add`ed (or carries
 * stray untracked files) — exactly the silent-pass shape this check exists to catch, since
 * "the file exists on this machine's disk" and "the file is what a git-based install actually
 * gets" are different claims.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { isGitCheckout } = require("./git-checkout");

const ROOT = path.join(__dirname, "..");
// REPO_ROOT/PKG_PREFIX need a real git checkout to compute (see the no-checkout gate in main()),
// so they are resolved lazily rather than at module load — a plain `git archive` export has no
// `.git` at all and this whole module must still be `require`-able there.
// `git show <rev>:<path>` (unlike `git ls-tree -- <pathspec>`) requires <path> relative to the
// REPO ROOT, not the current working directory — a real asymmetry in git's own CLI, not a bug
// here. This package can be a subdirectory of a larger repo (a monorepo), so the prefix is
// computed rather than assumed to be empty.
function resolveRepoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf8" }).trim();
}

// The TypeScript package's own JS entry point, invoked via `node`, rather than the
// node_modules/.bin/tsc(.cmd) shim: execFileSync spawning a .cmd shim directly fails with
// EINVAL on some Windows Node builds (the shim needs a shell to interpret it); `node <bin.js>`
// works identically cross-platform without needing shell:true.
const TSC_JS = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

function listFiles(dir, rel = "") {
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relPath = rel ? path.join(rel, name) : name;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) out = out.concat(listFiles(abs, relPath));
    else out.push(relPath.split(path.sep).join("/"));
  }
  return out;
}

/** Every file path git has committed under dist/ at HEAD, relative to dist/ (forward slashes,
 *  matching git's own path convention regardless of host OS). */
function listCommittedDistFiles() {
  const raw = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "dist"], { cwd: ROOT, encoding: "utf8" });
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice("dist/".length));
}

/** The exact committed bytes of dist/<relPath> at HEAD — never the working-tree copy. `git
 *  show <rev>:<path>` needs <path> relative to the repo root (see resolveRepoRoot() above).
 *  `pkgPrefix` is "" when this package IS the repo root (e.g. the published/standalone repo,
 *  or `git rev-parse --show-prefix` returning empty) — interpolating it unconditionally would
 *  produce a leading slash (`HEAD:/dist/canon.js`), which git rejects outright ("fatal: path
 *  '/dist/canon.js' does not exist in 'HEAD'") rather than treating it as repo-root-relative. */
function distGitPath(pkgPrefix, relPath) {
  return pkgPrefix ? `${pkgPrefix}/dist/${relPath}` : `dist/${relPath}`;
}

function readCommittedDistFile(relPath, repoRoot, pkgPrefix) {
  return execFileSync("git", ["show", `HEAD:${distGitPath(pkgPrefix, relPath)}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  if (!isGitCheckout(ROOT)) {
    // No `.git` at all — this is a plain export (a downloaded archive, not a clone). The
    // committed-vs-fresh-build comparison needs `git show`/`git ls-tree` against HEAD, which
    // do not exist here, so skip rather than fail. Naming the exact consequence rather than
    // just "skipped": a stale committed dist/ cannot be caught from this vantage point.
    console.log(
      "zeuge verify:dist: no git checkout detected — skipping the build-output check " +
        "(it needs `git show`/`git ls-tree` against HEAD). This means a stale committed dist/ " +
        "cannot be detected from here; run this check from a clone to get that guarantee."
    );
    process.exit(0);
    return;
  }

  const REPO_ROOT = resolveRepoRoot();
  const PKG_PREFIX = path.relative(REPO_ROOT, ROOT).split(path.sep).join("/");

  let committedFiles;
  try {
    committedFiles = new Set(listCommittedDistFiles());
  } catch (err) {
    console.error(`zeuge verify:dist: cannot read committed dist/ from HEAD: ${err.message}`);
    process.exit(1);
    return;
  }
  if (committedFiles.size === 0) {
    console.error("zeuge verify:dist: HEAD has no committed dist/ at all — run `npm run build` and commit it.");
    process.exit(1);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-verify-dist-"));
  try {
    execFileSync(process.execPath, [TSC_JS, "-p", path.join(ROOT, "tsconfig.json"), "--outDir", tmpDir], { stdio: "inherit", cwd: ROOT });

    const freshFiles = new Set(listFiles(tmpDir));
    const drift = [];

    for (const rel of freshFiles) {
      if (!committedFiles.has(rel)) {
        drift.push(`MISSING from committed dist/ (HEAD): ${rel} (a fresh build produces this file — run \`git add\` and commit it)`);
        continue;
      }
      const fresh = fs.readFileSync(path.join(tmpDir, ...rel.split("/")));
      const committed = readCommittedDistFile(rel, REPO_ROOT, PKG_PREFIX);
      if (!fresh.equals(committed)) {
        drift.push(`STALE: ${rel} (the committed dist/ at HEAD does not match a fresh build byte-for-byte — rebuild and commit)`);
      }
    }
    for (const rel of committedFiles) {
      if (!freshFiles.has(rel)) {
        drift.push(`ORPHANED in committed dist/ (HEAD): ${rel} (a fresh build no longer produces this file — remove it and commit)`);
      }
    }

    if (drift.length > 0) {
      console.error("zeuge verify:dist — the dist/ committed at HEAD does not match a fresh build:");
      for (const d of drift) console.error("  " + d);
      console.error("\nRun `npm run build`, `git add` the result, and commit.");
      process.exit(1);
      return;
    }

    console.log(`zeuge verify:dist — the dist/ committed at HEAD matches a fresh build byte-for-byte (${freshFiles.size} file(s)).`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
