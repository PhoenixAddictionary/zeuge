#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".relay");
let config = {};
try { config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")); } catch { config = {}; }
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const counts = { hold: 0, sent: 0, bill: 0, included: 0, unknown: 0, saved: 0, all: 0 };
let lines = [];
try { lines = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean); } catch { lines = []; }
for (const line of lines) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (Number(row.savedUsd) > 0) counts.all += Number(row.savedUsd);
  if (Date.parse(row.t) < cutoff) continue;
  if (row.action === "hold") {
    counts.hold += 1;
    if (row.sent) counts.sent += 1;
    counts.saved += Number(row.savedUsd) || 0;
  } else if (row.why === "bill") counts.bill += 1;
  else if (row.why === "included") counts.included += 1;
  else if (row.why === "model-unknown") counts.unknown += 1;
}
console.log("Last 7 days");
console.log("Held: " + counts.hold);
console.log("Sent to your Cursor subscription: " + counts.sent);
console.log("Estimated kept off a metered key: $" + counts.saved.toFixed(2));
console.log("Since the router was installed: $" + counts.all.toFixed(2));
console.log("Allowed because you wrote bill this model: " + counts.bill);
console.log("Cursor already on Composer or Grok 4: " + counts.included);
console.log("Cursor allowed because the model name was missing: " + counts.unknown);
if (counts.sent === 0) console.log("The total stays at zero until Cursor accepts a task.");
