#!/usr/bin/env node
const JUDGMENT = /\b(verdict|ruling|constitution|red-team|red team|abstain|citation|primary source|is this true)\b/i;
const BILL = /\bbill this model\b/i;
const INCLUDED = /^(composer-|grok-4)/i;
const REFUSED = /fast|auto|claude|gpt|gemini|opus|sonnet|codex/i;
function ownerGate(text) {
  const s = text.toLowerCase();
  if (/\bfable\b|fable-\d/.test(s)) return "fable";
  if (/opus[\w.-]*max|\bmax[\s-]*mode\b/.test(s)) return "max";
  if (/\bastra\b/.test(s)) return "astra";
  if (/\bo3-pro\b|gpt[-\w.]*pro\b/.test(s)) return "pro";
  return "";
}
