#!/usr/bin/env node
"use strict";

/**
 * Shared "are we inside a git checkout" detector.
 *
 * Both `scripts/verify-dist.js` (the pretest build-output check) and
 * `tests/plugin-distribution.test.ts` (the git-archive export simulation) need to know whether
 * a real git checkout is available before they can do their real work — `verify-dist.js` reads
 * `git show HEAD:...`, and the export test runs `git archive HEAD`. Neither works when this
 * package has been extracted from a downloaded archive (e.g. GitHub's "Download ZIP") rather
 * than cloned: there is no `.git` at all in that case.
 *
 * We ask git itself rather than looking for a `.git` directory, because a linked worktree's
 * `.git` is a FILE (a gitdir pointer), not a directory, and a bare export has neither — a
 * directory-existence check would misclassify the worktree case. `git rev-parse
 * --is-inside-work-tree` is the same question git itself answers internally before any command
 * that needs a work tree, so asking it directly is exact rather than a heuristic.
 */

const { execFileSync } = require("node:child_process");

let cached; // undefined = not yet checked; boolean thereafter.

/** True when the current working directory is inside a real git work tree (a clone or
 *  worktree), false for a plain export (e.g. `git archive` output, a downloaded zip). Cheap:
 *  runs the actual git check once per process and caches the result. */
function isGitCheckout(cwd) {
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: cwd || __dirname + "/..",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    cached = out.trim() === "true";
  } catch {
    cached = false;
  }
  return cached;
}

module.exports = { isGitCheckout };
