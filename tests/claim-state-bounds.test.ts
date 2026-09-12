import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256hex } from "../src/canon";
import { runClaimHook } from "../src/claim/hook";
import {
  loadState,
  saveState,
  isInCooldown,
  statePath,
  COOLDOWN_MS,
  STATE_RETENTION_MS,
  STATE_MAX_ENTRIES,
  ClaimState,
} from "../src/claim/state";
import { loadSeen, saveSeen, SEEN_RETENTION_MS, SEEN_MAX_ENTRIES } from "../src/claim/seen-store";

// --- contract renamed to match reality (statement-keyed, not claim_type-keyed) ---

const tmpDirs: string[] = [];
function tmpZeugeDir(prefix = "zeuge-p52-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return path.join(dir, ".zeuge");
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("claim/state — statement-keyed contract, named and enforced", () => {
  it("two DIFFERENT statement_sha256 keys (standing in for two different statements of the same claim_type) are independently NOT in cooldown", () => {
    const zeugeDir = tmpZeugeDir();
    const state = loadState(zeugeDir);
    const shaA = sha256hex("All tests pass.");
    const shaB = sha256hex("Tests passed locally.");
    state.last_nudged_by_statement[shaA] = 1_000_000;
    // shaB was never nudged: must not be suppressed just because shaA (same claim_type) was.
    expect(isInCooldown(state, shaA, 1_000_000 + 60_000)).toBe(true);
    expect(isInCooldown(state, shaB, 1_000_000 + 60_000)).toBe(false);
  });

  it("the SAME statement_sha256 repeated inside COOLDOWN_MS is suppressed; after it, it is not", () => {
    const state: ClaimState = { last_nudged_by_statement: {} };
    const sha = sha256hex("All tests pass.");
    state.last_nudged_by_statement[sha] = 0;
    expect(isInCooldown(state, sha, COOLDOWN_MS - 1)).toBe(true);
    expect(isInCooldown(state, sha, COOLDOWN_MS)).toBe(false);
  });

  it("migration: an old-shape file (field `last_nudged`) is honored — entries survive under the new field", () => {
    const zeugeDir = tmpZeugeDir();
    fs.mkdirSync(zeugeDir, { recursive: true });
    const sha = sha256hex("All tests pass.");
    fs.writeFileSync(statePath(zeugeDir), JSON.stringify({ last_nudged: { [sha]: 1_000_000 } }), "utf8");

    const migrated = loadState(zeugeDir);
    expect(migrated.last_nudged_by_statement[sha]).toBe(1_000_000);
    expect(isInCooldown(migrated, sha, 1_000_000 + 60_000)).toBe(true);

    // Saving after migration writes the corrected field name going forward.
    saveState(zeugeDir, migrated, 1_000_000 + 60_000);
    const onDisk = JSON.parse(fs.readFileSync(statePath(zeugeDir), "utf8"));
    expect(onDisk.last_nudged_by_statement[sha]).toBe(1_000_000);
    expect(onDisk.last_nudged).toBeUndefined();
  });

  it("fail-open: a corrupt state file loads as empty (no cooldown), never crashes", () => {
    const zeugeDir = tmpZeugeDir();
    fs.mkdirSync(zeugeDir, { recursive: true });
    fs.writeFileSync(statePath(zeugeDir), "{ not json", "utf8");
    const state = loadState(zeugeDir);
    expect(state.last_nudged_by_statement).toEqual({});
    expect(isInCooldown(state, sha256hex("anything"), 0)).toBe(false);
  });
});

describe("claim/hook — end-to-end: two different statements both nudge, the repeat does not (module contract, not just claim_type)", () => {
  function stopPayload(text: string, sessionId = "session:same"): string {
    return JSON.stringify({
      session_id: sessionId,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: { type: "text", text },
    });
  }

  it("A, then a different same-type statement, then A again: first two nudge, third is silent", () => {
    const zeugeDir = tmpZeugeDir();
    const a1 = runClaimHook({ stdinText: stopPayload("All tests pass."), zeugeDir, now: 0, jsonMode: true });
    const b = runClaimHook({ stdinText: stopPayload("Tests passed locally."), zeugeDir, now: 60_000, jsonMode: true });
    const a2 = runClaimHook({ stdinText: stopPayload("All tests pass."), zeugeDir, now: 120_000, jsonMode: true });

    expect(JSON.parse(a1.stdout).hookSpecificOutput).not.toBeNull();
    expect(JSON.parse(b.stdout).hookSpecificOutput).not.toBeNull();
    expect(JSON.parse(a2.stdout).hookSpecificOutput).toBeNull();
  });
});

// --- both stores are bounded, and pruning never touches a live cooldown entry ---

describe("claim/state — bounded cooldown store", () => {
  it("retention: an entry older than STATE_RETENTION_MS is pruned on save; a fresh one survives", () => {
    const zeugeDir = tmpZeugeDir();
    const oldSha = sha256hex("stale statement");
    const freshSha = sha256hex("fresh statement");
    const now = 10_000_000;
    const state: ClaimState = {
      last_nudged_by_statement: {
        [oldSha]: now - STATE_RETENTION_MS - 1,
        [freshSha]: now - 1000,
      },
    };
    saveState(zeugeDir, state, now);
    const onDisk = JSON.parse(fs.readFileSync(statePath(zeugeDir), "utf8"));
    expect(onDisk.last_nudged_by_statement[oldSha]).toBeUndefined();
    expect(onDisk.last_nudged_by_statement[freshSha]).toBe(now - 1000);
  });

  it("a future timestamp (clock moved backward) is never pruned as stale", () => {
    const zeugeDir = tmpZeugeDir();
    const sha = sha256hex("time traveler");
    const now = 1000;
    const state: ClaimState = { last_nudged_by_statement: { [sha]: now + 5_000_000 } };
    saveState(zeugeDir, state, now);
    const onDisk = JSON.parse(fs.readFileSync(statePath(zeugeDir), "utf8"));
    expect(onDisk.last_nudged_by_statement[sha]).toBe(now + 5_000_000);
  });

  it("cap: over STATE_MAX_ENTRIES survivors, oldest are evicted first, but nothing inside COOLDOWN_MS is ever evicted", () => {
    const zeugeDir = tmpZeugeDir();
    const now = 100_000_000;
    const entries: Record<string, number> = {};
    // STATE_MAX_ENTRIES old-but-fresh-enough-to-survive-retention entries, all older than
    // COOLDOWN_MS so none of them are cooldown-protected.
    for (let i = 0; i < STATE_MAX_ENTRIES; i++) {
      entries[`old-${i}`] = now - COOLDOWN_MS - 1000 - i; // strictly increasing age
    }
    // One MORE entry that is still inside COOLDOWN_MS — must survive the cap even though it
    // would otherwise push the map over STATE_MAX_ENTRIES.
    const protectedKey = "protected-live-cooldown";
    entries[protectedKey] = now - 10;
    saveState(zeugeDir, { last_nudged_by_statement: entries }, now);
    const onDisk = JSON.parse(fs.readFileSync(statePath(zeugeDir), "utf8"));
    expect(onDisk.last_nudged_by_statement[protectedKey]).toBe(now - 10);
    expect(Object.keys(onDisk.last_nudged_by_statement).length).toBeLessThanOrEqual(STATE_MAX_ENTRIES + 1);
    // The single oldest of the "old-*" entries must have been evicted to make room.
    expect(onDisk.last_nudged_by_statement[`old-${STATE_MAX_ENTRIES - 1}`]).toBeUndefined();
  });
});

describe("claim/seen-store — bounded replay store", () => {
  it("legacy bare-array format still loads (migration), with entries usable as the seen set", () => {
    const zeugeDir = tmpZeugeDir();
    fs.mkdirSync(zeugeDir, { recursive: true });
    const key = "session:xxxx:" + sha256hex("legacy entry");
    fs.writeFileSync(path.join(zeugeDir, "claim-seen.json"), JSON.stringify([key]), "utf8");

    const loaded = loadSeen(zeugeDir, 1000);
    expect(loaded.keys.has(key)).toBe(true);

    // Saving after a legacy load writes the new bounded { entries } shape.
    saveSeen(zeugeDir, loaded.keys, loaded, 1000);
    const onDisk = JSON.parse(fs.readFileSync(path.join(zeugeDir, "claim-seen.json"), "utf8"));
    expect(onDisk.entries[key]).toBe(1000);
  });

  it("retention: an entry older than SEEN_RETENTION_MS is pruned; a fresh one survives", () => {
    const zeugeDir = tmpZeugeDir();
    const now = 10_000_000;
    const oldKey = "old:" + sha256hex("stale seen");
    const freshKey = "fresh:" + sha256hex("fresh seen");
    fs.mkdirSync(zeugeDir, { recursive: true });
    fs.writeFileSync(
      path.join(zeugeDir, "claim-seen.json"),
      JSON.stringify({ entries: { [oldKey]: now - SEEN_RETENTION_MS - 1, [freshKey]: now - 1000 } }),
      "utf8"
);
    const loaded = loadSeen(zeugeDir, now);
    saveSeen(zeugeDir, loaded.keys, loaded, now);
    const onDisk = JSON.parse(fs.readFileSync(path.join(zeugeDir, "claim-seen.json"), "utf8"));
    expect(onDisk.entries[oldKey]).toBeUndefined();
    expect(onDisk.entries[freshKey]).toBe(now - 1000);
  });

  it("cap: over SEEN_MAX_ENTRIES survivors, oldest are evicted first, but nothing inside COOLDOWN_MS is ever evicted", () => {
    const zeugeDir = tmpZeugeDir();
    const now = 100_000_000;
    const entries: Record<string, number> = {};
    for (let i = 0; i < SEEN_MAX_ENTRIES; i++) {
      entries[`old-${i}`] = now - COOLDOWN_MS - 1000 - i;
    }
    const protectedKey = "protected-live-cooldown";
    entries[protectedKey] = now - 10;
    fs.mkdirSync(zeugeDir, { recursive: true });
    fs.writeFileSync(path.join(zeugeDir, "claim-seen.json"), JSON.stringify({ entries }), "utf8");
    const loaded = loadSeen(zeugeDir, now);
    saveSeen(zeugeDir, loaded.keys, loaded, now);
    const onDisk = JSON.parse(fs.readFileSync(path.join(zeugeDir, "claim-seen.json"), "utf8"));
    expect(onDisk.entries[protectedKey]).toBe(now - 10);
    expect(Object.keys(onDisk.entries).length).toBeLessThanOrEqual(SEEN_MAX_ENTRIES + 1);
    expect(onDisk.entries[`old-${SEEN_MAX_ENTRIES - 1}`]).toBeUndefined();
  });

  it("fail-open: a corrupt seen file loads as empty (nothing seen), never crashes", () => {
    const zeugeDir = tmpZeugeDir();
    fs.mkdirSync(zeugeDir, { recursive: true });
    fs.writeFileSync(path.join(zeugeDir, "claim-seen.json"), "not json at all", "utf8");
    const loaded = loadSeen(zeugeDir, 0);
    expect(loaded.keys.size).toBe(0);
  });
});
