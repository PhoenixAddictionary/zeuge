#!/usr/bin/env node
// Prints the last 7 days from ~/.relay/log.jsonl. No network. No key.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".relay");
let config = {};
try {
  config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
} catch {
  config = {};
}

const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const counts = { hold: 0, sent: 0, bill: 0, included: 0, unknown: 0, saved: 0, all: 0, stops: 0, list: 0 };
let lines = [];
try {
  lines = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean);
} catch {
  lines = [];
}

for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (Number(row.savedUsd) > 0) counts.all += Number(row.savedUsd);
  if (Date.parse(row.t) < cutoff) continue;
  if (row.action === "stop" || row.why === "owner-gate") {
    counts.stops += 1;
    counts.list += Number(row.listUsd) || 0;
    continue;
  }
  if (row.action === "hold") {
    counts.hold += 1;
    if (row.sent) counts.sent += 1;
    counts.saved += Number(row.savedUsd) || 0;
  } else if (row.why === "bill") counts.bill += 1;
  else if (row.why === "included") counts.included += 1;
  else if (row.why === "model-unknown") counts.unknown += 1;
}

const cursorPool = Number(config.cursorPool);
const otherPool = Number(config.otherPool);
console.log(`Last 7 days`);
console.log(`Stopped: ${counts.stops}`);
console.log(`List price of what did not run: $${counts.list.toFixed(2)}`);
console.log(`Estimate, not a bill.`);
console.log(`Held: ${counts.hold}`);
console.log(`Sent to your Cursor subscription: ${counts.sent}`);
console.log(`Estimated kept off a metered key: $${counts.saved.toFixed(2)}`);
console.log(`Since the router was installed: $${counts.all.toFixed(2)}`);
console.log(`Allowed because you wrote bill this model: ${counts.bill}`);
console.log(`Cursor already on Composer or Grok 4: ${counts.included}`);
console.log(`Cursor allowed because the model name was missing: ${counts.unknown}`);
console.log(
  Number.isFinite(cursorPool)
    ? `Cursor Models, as you last typed it: ${cursorPool}%`
    : "Cursor Models: not set. Read it on the spending page and put cursorPool in ~/.relay/config.json.",
);
console.log(
  Number.isFinite(otherPool)
    ? `Other Models, as you last typed it: ${otherPool}%`
    : "Other Models: not set.",
);
if (counts.hold === 0 && counts.stops === 0) console.log("No stops yet. The hook is not seeing prompts, or this is a new log.");
