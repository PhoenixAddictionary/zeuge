/**
 * verify-dist — root-shape regression (the shape neither this monorepo checkout nor a plain
 * `git archive` export exercises, and precisely why the leading-slash defect survived every
 * check run against those two shapes).
 *
 * `scripts/verify-dist.js` builds the committed-file path as `HEAD:${pkgPrefix}/dist/${rel}`.
 * In THIS repo the package lives under `AI_Agency/witness-plugin/`, so `pkgPrefix` is
 * non-empty and the check works. In the PUBLISHED repository the package IS the root, so
 * `git rev-parse --show-prefix` returns "", and the interpolated path becomes
 * `HEAD:/dist/canon.js` — a leading slash, which git rejects outright:
 *
 *   fatal: path '/dist/canon.js' does not exist in 'HEAD'
 *
 * Because the check runs as `pretest`, that fatal (plus an uncaught-exception stack trace) is
 * the first thing a person sees after cloning the published repo and typing `npm test` —
 * before a single test runs. This test reproduces that exact shape: it exports HEAD via `git
 * archive` (the same mechanism a plugin install / git-sourced `npm publish` uses — see
 * plugin-distribution.test.ts), then re-roots it as its OWN git repository so the package
 * directory IS the repo root, and runs the real `scripts/verify-dist.js` from inside it.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { isGitCheckout } from "../scripts/git-checkout";

// Full builds (tsc, twice — once per test below) are slow on a loaded machine; give this suite
// the same generous budget plugin-distribution.test.ts uses for its own git-export tests.
const REPO_DIR = path.join(__dirname, "..");
const IS_GIT_CHECKOUT = isGitCheckout(REPO_DIR);
const NEEDS_GIT_CHECKOUT_NOTE =
  "needs a git checkout: this test exports HEAD via `git archive` and re-roots it as its own " +
  "repo, so it cannot run from a plain archive/zip of this monorepo";

const tmpDirs: string[] = [];
afterAll(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

/** Links (or, failing that, copies) REPO_DIR/node_modules into `dest`. The root-shaped repo's
 *  own committed tree never carries node_modules (it is gitignored, so `git archive` never
 *  includes it), but `scripts/verify-dist.js` needs `node_modules/typescript/bin/tsc` on disk
 *  relative to ITS OWN location to run a fresh build. */
function linkNodeModules(dest: string): void {
  const target = path.join(REPO_DIR, "node_modules");
  const link = path.join(dest, "node_modules");
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // No privilege to create the link (seen on some locked-down Windows accounts) — a real
    // copy keeps the test running rather than silently skipping the scenario it exists for.
    fs.cpSync(target, link, { recursive: true });
  }
}

/** Exports HEAD (git archive — identical mechanism to plugin-distribution.test.ts) into a
 *  fresh temp directory, then re-roots that export as its OWN git repository: the package
 *  directory becomes the repo ROOT, exactly like the published/standalone repository. Returns
 *  the directory once `git rev-parse --show-prefix` there is confirmed empty. */
function buildRootShapedCheckout(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "zeuge-root-shape-"));
  tmpDirs.push(dest);

  const tarPath = path.join(dest, "export.tar");
  execFileSync("git", ["archive", "-o", tarPath, "HEAD", "--", "."], { cwd: REPO_DIR });
  execFileSync("tar", ["-xf", "export.tar"], { cwd: dest });
  fs.unlinkSync(tarPath);

  // `git archive HEAD` exports the last COMMITTED script, not this working tree's edits — the
  // very fix under test would otherwise be invisible until committed. The script under test is
  // a plain file the check invokes off disk (never itself committed-vs-fresh-build compared),
  // so overwriting it here exercises the CURRENT source against the committed dist/ tree below.
  for (const f of ["verify-dist.js", "git-checkout.js"]) {
    fs.copyFileSync(path.join(REPO_DIR, "scripts", f), path.join(dest, "scripts", f));
  }

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dest });
  const entries = fs.readdirSync(dest).filter((e) => e !== ".git");
  execFileSync("git", ["add", "--", ...entries], { cwd: dest });
  execFileSync(
    "git",
    ["-c", "user.email=zeuge-test@example.invalid", "-c", "user.name=zeuge test", "commit", "-q", "-m", "root-shaped export", "--", ...entries],
    { cwd: dest }
  );

  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: dest, encoding: "utf8" }).trim();
  if (prefix !== "") throw new Error(`test setup bug: expected an empty prefix at the repo root, got ${JSON.stringify(prefix)}`);

  linkNodeModules(dest);
  return dest;
}

describe("verify-dist — root-shaped repository (package IS the repo root, prefix is empty)", () => {
  it.skipIf(!IS_GIT_CHECKOUT)(
    `succeeds when the committed dist/ matches a fresh build, exactly as it does in this monorepo (${NEEDS_GIT_CHECKOUT_NOTE})`,
    () => {
      const dest = buildRootShapedCheckout();

      const result = spawnSync(process.execPath, [path.join(dest, "scripts", "verify-dist.js")], { cwd: dest, encoding: "utf8" });

      // Pre-fix, this failed with exit 1 (an uncaught exception) and stderr carrying:
      //   fatal: path '/dist/<file>.js' does not exist in 'HEAD'
      //   Error: Command failed: git show HEAD:/dist/<file>.js
      // — never reaching the drift comparison at all. Asserting the negative alongside the
      // positive keeps this failure mode nameable if it ever regresses.
      //
      // The `.toBe(0)` below carries an explicit message: a bare `expect(result.status).toBe(0)`
      // fails with only "expected 1 to be 0", handing the reader a number instead of the reason
      // — exactly the gap that cost a full round once already. The inner process's own stderr
      // and stdout are the reason; put them in the assertion so they land in the failure output.
      const innerReport = `--- inner stderr ---\n${result.stderr}\n--- inner stdout ---\n${result.stdout}`;
      expect(result.stderr).not.toMatch(/fatal: path '\/dist\//);
      expect(result.status, innerReport).toBe(0);
      expect(result.stdout).toMatch(/matches a fresh build byte-for-byte/);
    },
    60000
  );

  it.skipIf(!IS_GIT_CHECKOUT)(
    `still fails a genuinely stale committed dist/ at the repo root — the fix must not weaken drift detection (${NEEDS_GIT_CHECKOUT_NOTE})`,
    () => {
      const dest = buildRootShapedCheckout();

      // Corrupt one committed dist file so it diverges from what a fresh build of the
      // unchanged src/ produces, then commit that corruption — simulating "someone edited
      // src/ and forgot to rebuild" at the exact shape this test targets.
      const committedFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "dist"], { cwd: dest, encoding: "utf8" })
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      expect(committedFiles.length).toBeGreaterThan(0);
      const target = path.join(dest, ...committedFiles[0].split("/"));
      fs.appendFileSync(target, "\n// stale-drift regression fixture\n");
      execFileSync("git", ["add", "--", committedFiles[0]], { cwd: dest });
      execFileSync(
        "git",
        ["-c", "user.email=zeuge-test@example.invalid", "-c", "user.name=zeuge test", "commit", "-q", "-m", "introduce stale dist/", "--", committedFiles[0]],
        { cwd: dest }
      );

      const result = spawnSync(process.execPath, [path.join(dest, "scripts", "verify-dist.js")], { cwd: dest, encoding: "utf8" });

      const innerReport = `--- inner stderr ---\n${result.stderr}\n--- inner stdout ---\n${result.stdout}`;
      expect(result.status, innerReport).toBe(1);
      expect(result.stderr).toMatch(/STALE/);
      expect(result.stderr).not.toMatch(/fatal: path '\/dist\//);
    },
    60000
  );
});
