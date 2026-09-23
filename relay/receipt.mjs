#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const dir = join(homedir(), ".relay");
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const counts = { hold: 0, sent: 0, saved: 0, all: 0 };
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
  }
}
console.log("This week: $" + counts.saved.toFixed(2));
console.log("Since the router was installed: $" + counts.all.toFixed(2));
console.log("Sent to your Cursor subscription: " + counts.sent);
if (counts.sent === 0) console.log("The total stays at zero until Cursor accepts a task.");
