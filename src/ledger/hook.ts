/**
 * ledger/hook — the PostToolUse side of hooks.json: stdin JSON in (a tool invocation result),
 * one COMMAND_RUN/TOOL_INVOCATION ledger event appended, exit 0 always. Bodies carry hashes,
 * never captured content (spec §3): tool_input and tool_response are hashed, not stored.
 *
 * Verified against real PostToolUse fields: tool_name, tool_input (object),
 * tool_use_id, tool_response (STRING or OBJECT — content-model tools return a string,
 * structured tools an object; both are canonicalized-then-hashed uniformly: a string is
 * sha256'd directly, an object is JCS-canonicalized first so key order never perturbs the
 * hash). tool_use_id is recorded verbatim in the body — it is an identifier, not content.
 *
 * Same invariant discipline as claim/hook.ts: invalid stdin, an unwritable ledger, or a
 * refused append (the ledger is already invalid) all mean "exit 0, do nothing more" — this
 * hook must never block a tool call.
 *
 * Lock contention is reported, not silent: a LOCK_HELD refusal from appendEvent
 * is surfaced via hookSpecificOutput.additionalContext, same shape as claim/hook.ts's nudges —
 * still exit 0 (never blocks), but a live agent (and a human reading the transcript) can see
 * that this particular tool outcome was NOT recorded, rather than silently believing it was.
 *
 * The session_id is carried into the body: when the PostToolUse payload carries a
 * session_id, it is recorded in the event body so a later claim -> witness binding pass
 * (receipt/bundle.ts) can require the witnessing event to belong to the SAME session as the
 * claim it backs, not merely the same claim_type.
 *
 * For a Bash command, the body also carries `command_kind` — a
 * lexical classification ("test" | "build" | "deploy" | "other", see ./command-kind.ts) of the
 * command string. The command string itself is NEVER stored (that privacy property is
 * unchanged); only the derived label is. This is what lets witness/sources/ledger.ts stop
 * binding `tests_pass` to any passing command whatsoever — a passing `ls` is no longer
 * indistinguishable from a passing `npm test`.
 */

import * as path from "node:path";
import { sha256hex, canonicalHash } from "../canon";
import { appendEvent } from "./append";
import { classifyCommandKind, CommandKind } from "./command-kind";

export interface RunLedgerHookParams {
  stdinText: string;
  ledgerPath?: string; // override for tests; default <cwd>/.zeuge/ledger.jsonl
  /** Test-only override of the lock-acquisition timeout, so a live-lock-contention test does
   *  not have to wait out the production default (see ledger/lock.ts). */
  lockTimeoutMs?: number;
}

export interface RunLedgerHookResult {
  exitCode: 0;
  stdout: string;
  appended: boolean;
}

/** Hashes a value the way every zeuge body hash does: a string is sha256'd directly (its
 *  bytes ARE the content); anything else is JCS-canonicalized first so key order and
 *  formatting never change the hash. */
function hashToolField(value: unknown): string {
  if (typeof value === "string") return sha256hex(value);
  return canonicalHash(value ?? {});
}

/** A tool_response object MAY carry an exit code under a couple of plausible names; when it
 *  does not (most non-Bash tools), the outcome defaults to PASS — absence of a signal is not
 *  evidence of failure. */
function exitCodeFrom(response: unknown): number | undefined {
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (typeof r.exitCode === "number") return r.exitCode;
    if (typeof r.exit_code === "number") return r.exit_code;
  }
  return undefined;
}

/** Pulls only the command TEXT out of a Bash tool_input, for classification purposes — the
 *  text is used to derive `command_kind` and is never itself written to the ledger. Returns ""
 *  (classifies as "other") when tool_input isn't the expected shape. */
function bashCommandTextFrom(toolInput: unknown): string {
  if (toolInput && typeof toolInput === "object") {
    const command = (toolInput as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  return "";
}

export function runLedgerHook(params: RunLedgerHookParams): RunLedgerHookResult {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(params.stdinText);
    if (!parsed || typeof parsed !== "object") return { exitCode: 0, stdout: "", appended: false };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { exitCode: 0, stdout: "", appended: false };
  }

  const cwd = typeof payload.cwd === "string" ? (payload.cwd as string) : process.cwd();
  const ledgerPath = params.ledgerPath ?? path.join(cwd, ".zeuge", "ledger.jsonl");
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
  const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const exitCode = exitCodeFrom(payload.tool_response);
  const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "PostToolUse";
  // Classified for EVERY Bash invocation (COMMAND_RUN), never for other tools: a
  // TOOL_INVOCATION has no "command" concept, and witness/sources/ledger.ts never binds
  // tests_pass to a TOOL_INVOCATION regardless of this field. Computed from the command text
  // but the text itself is discarded immediately after — only the label survives.
  const commandKind: CommandKind | undefined = toolName === "Bash" ? classifyCommandKind(bashCommandTextFrom(payload.tool_input)) : undefined;

  try {
    const result = appendEvent(ledgerPath, {
      eventFamily: "ACTION",
      actionType: toolName === "Bash" ? "COMMAND_RUN" : "TOOL_INVOCATION",
      outcome: exitCode === undefined || exitCode === 0 ? "PASS" : "FAILED",
      actor: { kind: "MODEL", id: typeof payload.agent_id === "string" ? (payload.agent_id as string) : "agent:00000000000000000000000000000000" },
      body: {
        tool_name: toolName,
        tool_input_sha256: hashToolField(payload.tool_input),
        tool_response_sha256: hashToolField(payload.tool_response),
        ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        ...(commandKind !== undefined ? { command_kind: commandKind } : {}),
      },
    }, { lockTimeoutMs: params.lockTimeoutMs });
    if (!result.ok && result.issueCode === "LOCK_HELD") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: "[zeuge] ledger locked — event not recorded" } }) + "\n",
        appended: false,
      };
    }
    return { exitCode: 0, stdout: "", appended: result.ok };
  } catch {
    // Never let a ledger-write problem block the tool call this hook runs after.
    return { exitCode: 0, stdout: "", appended: false };
  }
}
