#!/usr/bin/env node
// Stops a metered tool unless the prompt says "bill this model".
// Fable, Opus Max, GPT Pro, and Astra do not start unless the task accepts that model by name.
// Code is for Composer standard. A reading is for Grok 4.7.
// Writes one line per decision to ~/.relay/log.jsonl. Never writes the key or the prompt.
// ~/.relay/config.json may hold repo, branch, cursorKey, cursorPool, otherPool.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const JUDGMENT = /\b(verdict|ruling|constitution|red-team|red team|abstain|citation|primary source|is this true)\b/i;
const BILL = /\bbill this model\b/i;
const INCLUDED = /^(composer-|grok-4)/i;
const REFUSED = /fast|auto|claude|gpt|gemini|opus|sonnet|codex/i;

function ownerGate(text) {
  const s = text.toLowerCase();
  if (/\bfable\b|fable-\d/.test(s)) return "fable";
  if (/opus[\w.-]*max|\bmax[\s-]*mode\b/.test(s)) return "max";
  if (/opus/.test(s) && /\b(effort|thinking)\b[^\n]{0,16}\bmax\b/.test(s)) return "max";
  if (/(?:opus|gpt|o[13]|gemini|grok|claude|sol)[\w.-]*-max\b/.test(s)) return "max";
  if (/\bastra\b/.test(s)) return "astra";
  if (/\bo3-pro\b|gpt[-\w.]*pro\b/.test(s)) return "pro";
  return "";
}

function ownerAccepted(prompt, gate) {
  const phrase = gate === "fable" ? "i accept fable" : gate === "max" ? "i accept max" : gate === "astra" ? "i accept astra" : "i accept pro";
  return prompt.toLowerCase().includes(phrase);
}

function listPrice(text, gate) {
  const input = Math.ceil(String(text).length / 4);
  const rates = { fable: [10, 50], max: [5, 25], pro: [30, 180], astra: [10, 50] };
  const pair = rates[gate] || [10, 50];
  return (input / 1_000_000) * pair[0] + (800 / 1_000_000) * pair[1];
}

function gateName(gate) {
  if (gate === "fable") return "Fable";
  if (gate === "max") return "The max model";
  if (gate === "astra") return "Astra";
  return "GPT Pro";
}

const tool = process.argv[2] || "claude";
const event = process.argv[3] || "prompt";
const raw = readFileSync(0, "utf8");
let body = {};
try {
  body = JSON.parse(raw || "{}");
} catch {
  body = { prompt: raw };
}
const prompt = String(body.prompt || body.user_prompt || body.text || body.task || "");
const params = Array.isArray(body.model_params)
  ? body.model_params.map((item) => `${item && item.id} ${item && item.value}`).join("\n")
  : "";
const toolModel = body.tool_input && (body.tool_input.model || body.tool_input.model_id || "");
const heard = [body.model, body.model_id, body.subagent_model, toolModel, params, prompt].filter(Boolean).join("\n");
const dir = join(homedir(), ".relay");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function note(entry) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), tool, ...entry })}\n`);
  } catch {
    // A failed log must not turn a block into a spend.
  }
}

function estimate(text) {
  const inputTokens = Math.ceil(text.length / 4);
  const outputTokens = 800;
  return (inputTokens / 1_000_000) * 2 + (outputTokens / 1_000_000) * 10;
}

function roots() {
  const found = [];
  if (Array.isArray(body.workspace_roots)) found.push(...body.workspace_roots);
  if (typeof body.cwd === "string") found.push(body.cwd);
  if (typeof body.workspace_root === "string") found.push(body.workspace_root);
  return found.map(String).filter(Boolean);
}

function repoFromGit(cwd) {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...(cwd ? { cwd } : {}),
    }).trim();
    const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return match ? `https://github.com/${match[1]}` : "";
  } catch {
    return "";
  }
}

function discoverRepo() {
  for (const root of roots()) {
    const found = repoFromGit(root);
    if (found) return found;
  }
  return repoFromGit();
}

function treeDirty() {
  const places = roots();
  if (!places.length) places.push("");
  for (const root of places) {
    try {
      const out = execSync("git status --porcelain", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        ...(root ? { cwd: root } : {}),
      });
      if (out.trim()) return true;
    } catch {
      // not a checkout
    }
  }
  return false;
}

function taskKey(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

function recentlySent(text) {
  try {
    const id = taskKey(text);
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").slice(-30);
    const now = Date.now();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const row = JSON.parse(lines[i]);
      if (now - Date.parse(row.t) > 60_000) break;
      if (row.sent && row.task === id) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function poolWarning(config) {
  const cursorPool = Number(config.cursorPool);
  const otherPool = Number(config.otherPool);
  const parts = [];
  if (Number.isFinite(cursorPool) && cursorPool >= 80) {
    parts.push(`Cursor Models is ${cursorPool}% used. At 100%, Composer draws the smaller pool.`);
  }
  if (Number.isFinite(otherPool) && otherPool >= 90) {
    parts.push(`Other Models is ${otherPool}% used.`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function stoppedThisWeek() {
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sums = { n: 0, list: 0 };
  try {
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.action !== "stop" && row.why !== "owner-gate") continue;
      if (Date.parse(row.t) < week) continue;
      sums.n += 1;
      sums.list += Number(row.listUsd) || 0;
    }
  } catch {
    // No log yet.
  }
  return sums;
}

function totals() {
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sums = { week: 0, all: 0 };
  try {
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line);
      const amount = Number(row.savedUsd) || 0;
      if (amount <= 0) continue;
      sums.all += amount;
      if (Date.parse(row.t) >= week) sums.week += amount;
    }
  } catch {
    // No log yet. The counter stays at zero.
  }
  return sums;
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

function allow(why) {
  note({ action: "allow", why });
  if (tool === "cursor" && event !== "prompt") {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
  }
  process.exit(0);
}

function stopCursor(message) {
  const reply = event === "prompt" ? { continue: false, user_message: message } : { permission: "deny", user_message: message };
  process.stdout.write(JSON.stringify(reply));
  process.exit(0);
}

const config = loadConfig();
if (!heard.trim()) allow("empty");

let refused = "";
let phrase = "";
const gate = ownerGate(heard);
if (gate && !ownerAccepted(prompt, gate)) {
  phrase = gate === "fable" ? "I accept fable" : gate === "max" ? "I accept max" : gate === "astra" ? "I accept astra" : "I accept pro";
  const price = listPrice(prompt || heard, gate);
  if ((tool === "cursor" && event === "tool") || !prompt.trim()) {
    note({ action: "stop", pinned: gate, sent: false, savedUsd: 0, listUsd: price, why: "owner-gate" });
    const stopped = stoppedThisWeek();
    const message = `Stopped. ${gateName(gate)} did not start. This call was not sent on. Write "${phrase}" in the task if you mean it. Stopped this week: ${stopped.n}.`;
    if (tool === "cursor") stopCursor(message);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
  refused = gate;
}
if (gate && !refused) allow("owner-accepted");

if (BILL.test(prompt)) allow("bill");

if (!refused && tool === "cursor" && event !== "prompt") allow("included");

const model = String(body.model || body.model_id || "");
if (!refused && tool === "cursor") {
  if (model && INCLUDED.test(model) && !REFUSED.test(model)) allow("included");
}

const pinned = JUDGMENT.test(prompt) ? "grok-4.7" : "composer-2.5";
const key = process.env.CURSOR_API_KEY || String(config.cursorKey || "");
const repo = process.env.RELAY_REPO || String(config.repo || "") || discoverRepo();
const branch = process.env.RELAY_BRANCH || String(config.branch || "main");
let handoff = "";
let sent = false;
let skip = "";
if (refused && tool === "cursor") {
  skip = " Not sent to a cloud agent. This chat already has the files. Switch the picker to Composer.";
} else if (treeDirty()) {
  skip = " Not sent to a cloud agent. This checkout has changes GitHub does not have.";
} else if (recentlySent(prompt)) {
  skip = " Already handed on. A second agent was not started.";
}

const outbound = refused
  ? `Do this on ${pinned} only. Do not call Fable, Opus Max, GPT Pro, or Astra.\n\n${prompt}`
  : prompt;

if (skip) {
  handoff = skip;
} else if (key.startsWith("crsr_") && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)) {
  try {
    const response = await fetch("https://api.cursor.com/v1/agents", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: { text: outbound.slice(0, 12000) },
        model: pinned.startsWith("composer")
          ? { id: pinned, params: [{ id: "fast", value: "false" }] }
          : { id: pinned },
        repos: [{ url: repo.replace(/\/$/, ""), startingRef: branch }],
        autoCreatePR: false,
      }),
    });
    const data = await response.json().catch(() => ({}));
    sent = response.ok;
    handoff = response.ok
      ? ` Handed to ${pinned}. ${data.agent?.url || data.agent?.id || "Cursor accepted it."}`
      : ` Cursor did not take it (${response.status}).`;
  } catch {
    handoff = " Cursor could not be reached.";
  }
} else {
  handoff = key.startsWith("crsr_")
    ? " Not sent. The repo in ~/.relay/config.json is missing or not a github.com URL."
    : repo
      ? " Not sent. The Cursor key is not in CURSOR_API_KEY or cursorKey."
      : " Not sent. Set repo and the Cursor key in ~/.relay/config.json.";
}

if (refused) {
  note({ action: "stop", pinned: refused, sent, savedUsd: 0, listUsd: listPrice(prompt, refused), why: "owner-gate", task: taskKey(prompt) });
  const stopped = stoppedThisWeek();
  const message = `${sent ? `Stopped. ${gateName(refused)} did not start. The task went to ${pinned}.${handoff}` : `Stopped. ${gateName(refused)} did not start. The task was not started.${handoff}`} Write "${phrase}" if you mean ${gateName(refused)}. Stopped this week: ${stopped.n}.`;
  if (tool === "cursor" && event !== "prompt") {
    process.stdout.write(JSON.stringify({ permission: "deny", user_message: message }));
    process.exit(0);
  }
  if (tool === "cursor") {
    process.stdout.write(JSON.stringify({ continue: false, user_message: message }));
    process.exit(0);
  }
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

note({ action: "hold", pinned, sent, savedUsd: sent ? estimate(prompt) : 0, task: taskKey(prompt) });
const message = `${sent ? `Held. On ${pinned}, inside the Cursor seat.${handoff}` : `Held. Nothing metered was called.${handoff}`}${poolWarning(config)}`;

if (tool === "cursor") {
  process.stdout.write(JSON.stringify({ continue: false, user_message: message }));
  process.exit(0);
}

process.stderr.write(`${message}\n`);
process.exit(2);
