/**
 * license/paths — where the licence key (and its co-located cache) lives on disk.
 *
 * The key file used to live unconditionally at
 * `<project>/.zeuge/licence.json`, in clear text. The realistic harm is not that the key is
 * unencrypted (normal for a licence key) but that this directory sits inside whatever the
 * current working directory is, which is very likely a git work tree — so the key is one
 * `git add -A` away from a public remote.
 *
 * Fix: resolve a licence directory in this order —
 *   1. `ZEUGE_LICENSE_DIR` env override, if set (documented escape hatch, e.g. for CI or a
 *      shared machine layout).
 *   2. An EXISTING project-local `<cwd>/.zeuge/licence.json` (upgrade path — nobody loses
 *      their key just because this package started writing new keys elsewhere; a warning
 *      fires instead, see below).
 *   3. The platform's own per-user config directory: `%LOCALAPPDATA%\zeuge` on Windows,
 *      `$XDG_CONFIG_HOME/zeuge` (falling back to `~/.config/zeuge`) everywhere else. This is
 *      where a fresh `licence set` writes by default.
 *
 * When (2) applies AND that project directory is inside a git work tree, callers should surface
 * a one-line warning naming the risk and the fix (see `licenseDirWarning` below) — the actual
 * printing is the CLI's job (it owns write/writeErr), this module only decides WHETHER to warn.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ZEUGE_LICENSE_DIR_ENV = "ZEUGE_LICENSE_DIR";

function legacyProjectZeugeDir(cwd: string): string {
  return path.join(cwd, ".zeuge");
}

export function legacyLicenseKeyPath(cwd: string): string {
  return path.join(legacyProjectZeugeDir(cwd), "licence.json");
}

/** The platform default, ignoring any legacy project-local file and the env override — exposed
 *  separately so tests can exercise the per-platform branch directly without touching disk. */
export function defaultUserConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "zeuge");
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "zeuge");
}

export type LicenseDirSource = "env" | "legacy-project" | "default-user-config";

export interface ResolvedLicenseDir {
  dir: string;
  source: LicenseDirSource;
}

/** The single resolution function every licence-file caller should use instead of a bare
 *  `path.join(cwd, ".zeuge")`. Pure with respect to its explicit params (cwd/env/platform),
 *  only touching the filesystem to check whether a legacy key file already exists. */
export function resolveLicenseDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ResolvedLicenseDir {
  const override = env[ZEUGE_LICENSE_DIR_ENV];
  if (override) return { dir: override, source: "env" };

  try {
    if (fs.existsSync(legacyLicenseKeyPath(cwd))) {
      return { dir: legacyProjectZeugeDir(cwd), source: "legacy-project" };
    }
  } catch {
    /* fall through to the default — an unreadable cwd is not this function's problem */
  }

  return { dir: defaultUserConfigDir(env, platform), source: "default-user-config" };
}

/** Walks upward from `startDir` looking for a `.git` entry (a directory for a normal clone, or
 *  a file for a linked worktree/submodule — either is sufficient evidence of "inside a git work
 *  tree"). Stops at the filesystem root. Read-only; never throws. */
export function isInsideGitWorkTree(startDir: string): boolean {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return true;
    } catch {
      /* unreadable path segment — treat as "no .git found here" and keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false; // reached the filesystem root
    dir = parent;
  }
}

/** The one-line warning this risk calls for, or null when none is warranted. Fires exactly when
 *  the resolved directory is the legacy project-local one AND it is inside a git work tree —
 *  never for the env override or the new default (both are, by construction, outside any
 *  project the key's own git history could pick up). */
export function licenseDirWarning(resolved: ResolvedLicenseDir): string | null {
  if (resolved.source !== "legacy-project") return null;
  if (!isInsideGitWorkTree(resolved.dir)) return null;
  const keyPath = path.join(resolved.dir, "licence.json");
  return (
    `[zeuge] warning: licence key found at ${keyPath}, inside a git work tree — it is one ` +
    `\`git add\` away from a public remote. Move it: delete this file and re-run ` +
    `\`zeuge licence set <key>\` (it will be written to the default per-user location instead), ` +
    `or set ${ZEUGE_LICENSE_DIR_ENV} to a directory outside any repository. Also add \`.zeuge/\` ` +
    `to this project's .gitignore.\n`
  );
}
