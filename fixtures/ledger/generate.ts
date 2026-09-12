/**
 * Generates the static P4 ledger fixtures under fixtures/ledger/. Run once with:
 *   npx tsx fixtures/ledger/generate.ts
 * These fixtures are committed as plain .jsonl files; this script exists for provenance and
 * to regenerate them if the event schema ever changes. It deliberately reuses the real
 * src/ledger/event.ts hashing so the "positive" fixture is a genuinely valid chain — the
 * negative fixtures are then derived by a single, documented, targeted mutation of a copy.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildEvent, recomputeEventHash, LedgerEvent } from "../../src/ledger/event";
import { makeId } from "../../src/ids";
import { ZERO_HASH } from "../../src/canon";

const OUT_DIR = path.join(__dirname);
const LEDGER_ID = "ledger:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR = { kind: "SYSTEM" as const, id: "agent:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

function baseChain(n: number, startTime = Date.parse("2026-09-11T08:00:00.000Z")): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  let prevHash = ZERO_HASH;
  for (let i = 1; i <= n; i++) {
    const e = buildEvent({
      ledgerId: LEDGER_ID,
      seq: i,
      prevHash,
      eventFamily: "ACTION",
      actionType: "COMMAND_RUN",
      outcome: "PASS",
      actor: ACTOR,
      body: { command_sha256: "c".repeat(64), exit_code: 0, duration_ms: 10 * i },
      recordedAt: new Date(startTime + i * 1000).toISOString(),
    });
    events.push(e);
    prevHash = e.event_hash;
  }
  return events;
}

function write(name: string, events: LedgerEvent[]): void {
  fs.writeFileSync(path.join(OUT_DIR, name), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

// 1. ledger-ok.jsonl — a genuinely valid 5-event chain.
const ok = baseChain(5);
write("ledger-ok.jsonl", ok);

// 2. tamper-body.jsonl — one byte changed inside event 3's body, event_hash left as-is.
const tampered = ok.map((e) => JSON.parse(JSON.stringify(e)) as LedgerEvent);
tampered[2] = { ...tampered[2], body: { ...tampered[2].body, exit_code: 99 } };
write("tamper-body.jsonl", tampered);

// 3. swapped-seq.jsonl — physically swap rows 3 and 4 (their content, including seq, travels
//    with them) so the physical position no longer matches the carried seq.
const swapped = ok.map((e) => JSON.parse(JSON.stringify(e)) as LedgerEvent);
[swapped[2], swapped[3]] = [swapped[3], swapped[2]];
write("swapped-seq.jsonl", swapped);

// 4. truncated-tail.jsonl — drop the last 2 events. Internally consistent on its own; only
//    catchable against an externally held --expected-head.
write("truncated-tail.jsonl", ok.slice(0, 3));

// 5. inserted-row.jsonl — a self-consistent extra row (own hash correct) whose prev_hash does
//    not match the row physically before it (points at row 1's hash instead of row 3's).
const withInsertion = ok.slice(0, 3).map((e) => JSON.parse(JSON.stringify(e)) as LedgerEvent);
const inserted = buildEvent({
  ledgerId: LEDGER_ID,
  seq: 4,
  prevHash: withInsertion[0].event_hash, // WRONG on purpose: should be withInsertion[2].event_hash
  eventFamily: "ACTION",
  actionType: "COMMAND_RUN",
  outcome: "PASS",
  actor: ACTOR,
  body: { command_sha256: "d".repeat(64), exit_code: 0, duration_ms: 40 },
  recordedAt: new Date(Date.parse("2026-09-11T08:00:04.000Z")).toISOString(),
});
withInsertion.push(inserted);
write("inserted-row.jsonl", withInsertion);

// 6. backdated.jsonl — row 3's recorded_at moved before row 2's, re-hashed so ONLY the clock
//    check fires (not also an event-hash mismatch).
const backdatedBase = ok.slice(0, 3).map((e) => JSON.parse(JSON.stringify(e)) as LedgerEvent);
const row3 = backdatedBase[2];
const earlier = new Date(Date.parse(backdatedBase[1].recorded_at) - 60_000).toISOString();
const { event_hash: _drop, ...row3Rest } = row3;
const row3Recomputed: LedgerEvent = { ...row3Rest, recorded_at: earlier, event_hash: "" };
row3Recomputed.event_hash = recomputeEventHash(row3Recomputed);
backdatedBase[2] = row3Recomputed;
write("backdated.jsonl", backdatedBase);

// 7. segment-head-broken.jsonl — a small chain with a SEGMENT_OPEN row whose carried
//    previous_segment_head_hash does not match the real predecessor's hash.
const smallChain = baseChain(2);
const brokenOpen = buildEvent({
  ledgerId: LEDGER_ID,
  seq: 3,
  prevHash: smallChain[1].event_hash,
  eventFamily: "LIFECYCLE",
  actionType: "SEGMENT_OPEN",
  outcome: "NOT_APPLICABLE",
  actor: ACTOR,
  body: { previous_segment_head_hash: ZERO_HASH }, // WRONG: should be smallChain[1].event_hash
});
const afterOpen = buildEvent({
  ledgerId: LEDGER_ID,
  seq: 4,
  prevHash: brokenOpen.event_hash,
  eventFamily: "ACTION",
  actionType: "COMMAND_RUN",
  outcome: "PASS",
  actor: ACTOR,
  body: { command_sha256: "e".repeat(64), exit_code: 0, duration_ms: 5 },
});
write("segment-head-broken.jsonl", [...smallChain, brokenOpen, afterOpen]);

console.log("wrote ledger fixtures to", OUT_DIR);
