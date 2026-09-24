#!/usr/bin/env node
// Stops a metered tool unless the prompt says "bill this model".
// Fable, Opus Max, GPT Pro, and Astra do not start unless the task accepts that model by name.
// Code is for Composer standard. A reading is for Grok 4.7.
// Writes one line per decision to ~/.relay/log.jsonl. Never writes the key or the prompt.
// ~/.relay/config.json may hold repo, branch, cursorKey, cursorPool, otherPool.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
  if (gate === "max") return "Opus Max";
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

function repoFromGit() {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return match ? `https://github.com/${match[1]}` : "";
  } catch {
    return "";
  }
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

const gate = ownerGate(heard);
if (gate && !ownerAccepted(prompt, gate)) {
  const price = listPrice(prompt || heard, gate);
  const phrase = gate === "fable" ? "I accept fable" : gate === "max" ? "I accept max" : gate === "astra" ? "I accept astra" : "I accept pro";
  note({ action: "stop", pinned: gate, sent: false, savedUsd: 0, listUsd: price, why: "owner-gate" });
  const stopped = stoppedThisWeek();
  const message = `Stopped. ${gateName(gate)} tried to start. Nothing was called. It does not start until this task says "${phrase}". List price of this prompt if it had run: ${money(price)}. Stopped this week: ${stopped.n}. List price of what did not run: ${money(stopped.list)}. Estimate, not a bill.`;
  if (tool === "cursor") stopCursor(message);
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
if (gate) allow("owner-accepted");

if (BILL.test(prompt)) allow("bill");

if (tool === "cursor" && event !== "prompt") allow("included");

const model = String(body.model || body.model_id || "");
if (tool === "cursor") {
  if (model && INCLUDED.test(model) && !REFUSED.test(model)) allow("included");
}

const pinned = JUDGMENT.test(prompt) ? "grok-4.7" : "composer-2.5";
const key = process.env.CURSOR_API_KEY || String(config.cursorKey || "");
const repo = process.env.RELAY_REPO || String(config.repo || "") || repoFromGit();
const branch = process.env.RELAY_BRANCH || String(config.branch || "main");
let handoff = "";
let sent = false;

if (key.startsWith("crsr_") && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)) {
  try {
    const response = await fetch("https://api.cursor.com/v1/agents", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: { text: prompt.slice(0, 12000) },
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

note({ action: "hold", pinned, sent, savedUsd: sent ? estimate(prompt) : 0 });
const saved = totals();
const added = sent ? estimate(prompt) : 0;
const message = `Held for your Cursor subscription (${pinned}).${handoff} This prompt kept ${money(added)} off Sonnet 5's list price. This week ${money(saved.week)}. Since the router was installed ${money(saved.all)}. Estimate, not a bill.${poolWarning(config)} Write "bill this model" only if you mean to spend this tool.`;

if (tool === "cursor") {
  process.stdout.write(JSON.stringify({ continue: false, user_message: message }));
  process.exit(0);
}

process.stderr.write(`${message}\n`);
process.exit(2);
