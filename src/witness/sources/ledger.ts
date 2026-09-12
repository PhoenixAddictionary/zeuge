/**
 * witness/sources/ledger — turns verified ledger events into Witness records.
 *
 * LedgerEvent's body (spec §3's body is open-shaped) carries an optional
 * `session_id`, populated by ledger/hook.ts from the real PostToolUse payload. When an event
 * carries one, it is copied onto the resulting Witness so receipt/bundle.ts's claim -> witness
 * binding pass can require the SAME session, not merely the same claim_type — closing a gap
 * an earlier version of this file declared ("this source cannot do the spec's full
 * session_id match ... that correlation is not implemented"). The residual, still-declared
 * limitation: an event recorded before this fix, or by any other caller that never supplies
 * session_id, produces a witness with no session_id at all, which binds permissively
 * (claim_type + time window only) rather than being excluded outright — absence of a signal is
 * not evidence of a different session, but it is also weaker proof than a confirmed match.
 *
 * What this source provides: for every hash-verified COMMAND_RUN/TOOL_INVOCATION event with
 * outcome PASS, a witness that binds "command_ran" — and, ONLY for a COMMAND_RUN event whose
 * body carries `command_kind: "test"`, ALSO "tests_pass".
 *
 * Before this, EVERY passing COMMAND_RUN bound both "command_ran"
 * AND "tests_pass" regardless of what actually ran — a passing `ls` witnessed "All tests
 * pass." exactly as well as a passing `npm test` did, which contradicted the package's own
 * premise that a claim is only as strong as what witnessed it. `command_kind` is written by
 * ledger/hook.ts (see its module doc and ./command-kind.ts) as a lexical classification of the
 * command string, and ONLY the label — never the command text — is stored. An event recorded
 * before this field existed (or by any other producer that never sets it) carries no
 * `command_kind` at all; absence is NOT evidence of a test run, so such an event binds
 * "command_ran" only, never "tests_pass" — a strictly more conservative default than before.
 *
 * THREAT (declared, not fixed): `command_kind: "test"` is a lexical match (see
 * ./command-kind.ts), not proof the suite ran meaningfully or covered anything. It is stronger
 * evidence than "some command exited 0", not proof of coverage or correctness.
 */

import { makeId } from "../../ids";
import { verifyLedgerFile } from "../../ledger/verify";
import { LedgerEvent } from "../../ledger/event";
import type { Witness } from "../source";
import * as fs from "node:fs";

export function collectLedgerWitnesses(ledgerPath: string): { witnesses: Witness[]; events: LedgerEvent[] } {
  const verification = verifyLedgerFile(ledgerPath);
  if (!verification.ok) return { witnesses: [], events: [] };

  const rows: LedgerEvent[] = fs
    .readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const witnesses: Witness[] = [];
  for (const event of rows) {
    if (event.action_type !== "COMMAND_RUN" && event.action_type !== "TOOL_INVOCATION") continue;
    if (event.outcome !== "PASS") continue;
    const sessionId = typeof event.body?.session_id === "string" ? (event.body.session_id as string) : undefined;
    // A COMMAND_RUN binds "tests_pass" ONLY when its command_kind is exactly "test" — never on
    // absence of the field (a pre-fix or foreign-producer event), and never for a
    // TOOL_INVOCATION (no command concept at all). See the module doc above.
    const isTestCommand = event.action_type === "COMMAND_RUN" && event.body?.command_kind === "test";
    witnesses.push({
      witness_id: makeId("witness"),
      kind: "LEDGER_EVENT",
      source: "zeuge.ledger",
      locator: event.event_id,
      content_sha256: event.event_hash,
      observed_at: event.recorded_at,
      binds: isTestCommand ? ["command_ran", "tests_pass"] : ["command_ran"],
      trust_level: "L2",
      verification: "VERIFIED",
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    });
  }
  return { witnesses, events: rows };
}
