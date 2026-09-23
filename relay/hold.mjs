#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
const JUDGMENT = /\b(verdict|ruling|constitution|red-team|red team|abstain|citation|primary source|is this true)\b/i;
const BILL = /\bbill this model\b/i;
const INCLUDED = /^(composer-|grok-4)/i;
const REFUSED = /fast|auto|claude|gpt|gemini|opus|sonnet|codex/i;
const tool = process.argv[2] || "claude";
const raw = readFileSync(0, "utf8");
let body = {};
try { body = JSON.parse(raw || "{}"); } catch { body = { prompt: raw }; }
const prompt = String(body.prompt || body.user_prompt || body.text || "");
const dir = join(homedir(), ".relay");
function loadConfig() { try { return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")); } catch { return {}; } }
function note(entry) { try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ t: new Date().toISOString(), tool, ...entry }) + "\n"); } catch { /* keep the block */ } }
function estimate(text) { return (Math.ceil(text.length / 4) / 1_000_000) * 2 + (800 / 1_000_000) * 10; }
function totals() {
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sums = { week: 0, all: 0 };
  try {
    for (const line of readFileSync(join(dir, "log.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      const amount = Number(row.savedUsd) || 0;
      if (amount <= 0) continue;
      sums.all += amount;
      if (Date.parse(row.t) >= week) sums.week += amount;
    }
  } catch { /* zero */ }
  return sums;
}
function allow(why) { note({ action: "allow", why }); process.exit(0); }
const config = loadConfig();
if (!prompt.trim()) allow("empty");
if (BILL.test(prompt)) allow("bill");
const model = String(body.model || body.model_id || "");
if (tool === "cursor" && model && INCLUDED.test(model) && !REFUSED.test(model)) allow("included");
const pinned = JUDGMENT.test(prompt) ? "grok-4.7" : "composer-2.5";
const key = process.env.CURSOR_API_KEY || String(config.cursorKey || "");
let repo = process.env.RELAY_REPO || String(config.repo || "");
if (!repo) { try { const url = execSync("git remote get-url origin", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/); if (match) repo = "https://github.com/" + match[1]; } catch { /* no remote */ } }
const branch = process.env.RELAY_BRANCH || String(config.branch || "main");
let sent = false;
let handoff = " Not sent. Put the Cursor key in CURSOR_API_KEY or ~/.relay/config.json.";
if (key.startsWith("crsr_") && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)) {
  try {
    const response = await fetch("https://api.cursor.com/v1/agents", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: { text: prompt.slice(0, 12000) }, model: pinned.startsWith("composer") ? { id: pinned, params: [{ id: "fast", value: "false" }] } : { id: pinned }, repos: [{ url: repo.replace(/\/$/, ""), startingRef: branch }], autoCreatePR: false }) });
    sent = response.ok;
    handoff = response.ok ? " Handed to " + pinned + "." : " Cursor did not take it (" + response.status + ").";
  } catch { handoff = " Cursor could not be reached."; }
}
const added = sent ? estimate(prompt) : 0;
note({ action: "hold", pinned, sent, savedUsd: added });
const saved = totals();
const message = "Held for your Cursor subscription (" + pinned + ")." + handoff + " This prompt kept $" + added.toFixed(2) + " off Sonnet 5's list price. This week $" + saved.week.toFixed(2) + ". Since the router was installed $" + saved.all.toFixed(2) + ". Estimate, not a bill.";
if (tool === "cursor") { process.stdout.write(JSON.stringify({ continue: false, user_message: message })); process.exit(0); }
process.stderr.write(message + "\n");
process.exit(2);
