/**
 * claim/detect — table-driven regex rules -> claim candidates.
 *
 * Detection is regex over turn text, sentence by sentence: claim TYPE is machine-detectable,
 * claim TRUTH is the witness layer's job. This is a declared blind spot, not a silent
 * one (spec §6.4): unusual phrasing produces no claim, and an undetected claim looks exactly
 * like a claim that never existed.
 *
 * The bare marker regexes on their own fired on imperatives ("make sure it is done"),
 * conditionals ("if tests pass we deploy", "once deployed"), negations ("not fixed yet",
 * "never deployed"), questions ("is it deployed?"), and quoted/backticked mentions of the
 * word. A sentence-level guard now runs BEFORE a marker match is accepted as a claim
 * candidate; guarded-out sentences are counted in coverage.statements_skipped by reason so
 * the report shows the denominator instead of a bare count with no visible "what didn't make
 * it."
 *
 * Measured against 5.8MB of real agent-authored status prose (702 matches / ~78k sentences):
 * recall was good (5/5 true claims caught) but five false-positive shapes were confirmed,
 * plus one real sentence-splitting defect:
 *   1-2. A negation sitting inside a parenthetical aside or right after a list marker (e.g.
 *        "(NOT done", "(not fixed") was invisible: the old lookback only stripped TRAILING
 *        punctuation from a token, so a leading "(" on "(not" hid the match, and the lookback
 *        was capped at 4 tokens. Fixed: negation now scans every token in the whole clause
 *        before the marker, stripping punctuation from BOTH ends of each token.
 *   3. A hyphenated compound ("already-fixed", "pre-fixed") reads as a bare `\bfixed\b` word
 *      match because `-` is a non-word character, so a word boundary sits on either side of
 *      it. Fixed: a marker immediately preceded by `-` is now itself a negation-class guard —
 *      narration about an EARLIER state is not a claim about this turn.
 *   4. A noun-phrase use ("Deployed copy: ...") is grammatically an adjective modifying a
 *      following noun, not a verb asserting the agent's own action. New "noun_phrase" guard:
 *      the marker immediately followed by one of a small closed list of nouns it commonly
 *      modifies (copy, version, branch, file, build) is not a claim.
 *   5. A third-party subject ("Their CI pipeline deployed...") describes someone else's
 *      action. New "third_party" guard: scans the clause before the marker for a subject
 *      pronoun/possessive OTHER than I/we/me/our/us (they/their/them/he/she/it/vendor/
 *      upstream/someone), and does not fire if a first-person pronoun sits closer to the
 *      marker (handles "We deployed, and their CI also ran" correctly favoring the near
 *      subject).
 *   Separately: `splitSentences` cut on ANY `.!?`, so a filename or path with an embedded dot
 *   not followed by whitespace ("ledger.jsonl", "%USERPROFILE%\.zeuge\...") was shattered into
 *   bogus fragment "sentences". Fixed: a `.!?` only ends a sentence when followed by
 *   whitespace or end-of-input, and never while inside a backticked span.
 */

import rulesData from "./rules.json";
import { canonicalHash } from "../canon";
import type { ClaimType } from "../vocab";

export interface ClaimRule {
  rule_id: string;
  claim_type: ClaimType;
  pattern: string;
  flags?: string;
  note?: string;
}

export const DEFAULT_RULES: ClaimRule[] = rulesData as ClaimRule[];

export function rulesSha256(rules: ClaimRule[] = DEFAULT_RULES): string {
  return canonicalHash(rules);
}

export interface ClaimCandidate {
  claim_type: ClaimType;
  rule_id: string;
  statement: string; // verbatim span (the sentence carrying the match), max 2000 chars
  span: { start: number; end: number }; // offsets into the ORIGINAL source text
}

interface Sentence {
  text: string;
  start: number;
  end: number;
}

/** Spans (as [start,end) char offsets) covered by a backticked span in the ORIGINAL text —
 *  shared by sentence splitting (never end a sentence on a `.` inside a code span) and the
 *  existing quoted-span guard. */
function backtickSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /`[^`]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function isInsideAnySpan(idx: number, spans: Array<[number, number]>): boolean {
  return spans.some(([s, e]) => idx >= s && idx < e);
}

/**
 * Splits on sentence-ending punctuation, trimming whitespace but preserving offsets.
 *
 * A `.`/`!`/`?` only ends a sentence when it is followed by whitespace or the end of
 * the input, and never while it sits inside a backticked span. The previous version split on
 * ANY occurrence of that punctuation, so a path or filename with an embedded, non-whitespace-
 * followed dot ("ledger.jsonl", "%USERPROFILE%\.zeuge\...") was shattered into bogus fragment
 * "sentences" at every internal dot.
 */
function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const codeSpans = backtickSpans(text);
  let start = 0;

  const pushSpan = (rawStart: number, rawEnd: number) => {
    const raw = text.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const s = rawStart + leading;
    sentences.push({ text: trimmed, start: s, end: s + trimmed.length });
  };

  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i])) continue;
    if (isInsideAnySpan(i, codeSpans)) continue;
    const next = text[i + 1];
    const isBoundary = next === undefined || /\s/.test(next);
    if (!isBoundary) continue;
    let end = i + 1;
    while (end < text.length && /[.!?]/.test(text[end])) end++; // swallow "..." / "?!" runs
    pushSpan(start, end);
    start = end;
  }
  if (start < text.length) pushSpan(start, text.length);

  return sentences;
}

export type SkipReason = "question" | "imperative" | "conditional" | "negation" | "quoted" | "noun_phrase" | "third_party";

const IMPERATIVE_LEADS = ["make sure", "ensure", "please", "let's", "should", "must", "need to", "todo"];
const CONDITIONAL_LEADS = ["if", "unless", "once", "when", "would", "could", "should", "will", "going to"];
const NEGATION_TOKEN = /^(not|no|never|nicht|kein|keine|keinen)$/i;
const CONTRACTION_NEGATION = /n't$/i;

// Nouns a claim-type marker commonly modifies adjectivally ("Deployed copy: ...",
// "Fixed version available"), rather than asserting the agent's own action this turn. Kept
// deliberately small and closed — the measured false positives all followed one of these.
const NOUN_AFTER_MARKER = new Set(["copy", "version", "branch", "file", "build"]);

// A subject pronoun/possessive OTHER than the agent itself. "it"/"its" and "the"
// (for "the vendor"/"the team") are included; a bare "the" alone is too broad to use on its
// own, so THIRD_PARTY only fires on these more specific tokens.
const THIRD_PARTY_SUBJECTS = new Set(["they", "their", "theirs", "them", "he", "him", "his", "she", "her", "hers", "it", "its", "someone", "vendor", "upstream"]);
const FIRST_PERSON_SUBJECTS = new Set(["i", "we", "me", "our", "ours", "us", "myself", "ourselves"]);

function startsWithLead(low: string, leads: string[]): boolean {
  return leads.some((lead) => low.startsWith(lead + " ") || low === lead);
}

function containsWholeWord(low: string, word: string): boolean {
  return new RegExp(`(?<![\\w-])${word}(?![\\w-])`, "i").test(low);
}

function stripPunct(token: string): string {
  return token.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "");
}

/** Scans the WHOLE clause before the marker (not a fixed token window) for a
 *  negation token, stripping punctuation from both ends of each token so a parenthetical aside
 *  or a token right after a list marker ("(NOT", "(not") is still recognized. Also treats a
 *  marker immediately preceded by a hyphen ("already-fixed", "pre-fixed") as negated: that
 *  shape is narration about an earlier state, not a claim about this turn. */
function isNegated(sentence: string, matchIndex: number): boolean {
  if (sentence[matchIndex - 1] === "-") return true;
  const before = sentence.slice(0, matchIndex);
  const tokens = before.trim().split(/\s+/).filter(Boolean);
  return tokens.some((t) => {
    const stripped = stripPunct(t);
    return NEGATION_TOKEN.test(stripped) || CONTRACTION_NEGATION.test(t);
  });
}

/** True when the marker is immediately followed (after any punctuation/whitespace right at
 *  the match boundary, e.g. a colon) by one of a small closed list of nouns it commonly
 *  modifies, rather than being the agent's own verb claim. */
function isNounPhraseUse(sentence: string, matchIndex: number, matchLength: number): boolean {
  const after = sentence.slice(matchIndex + matchLength);
  const nextWordMatch = after.match(/^\s*([A-Za-z][A-Za-z'-]*)/);
  if (!nextWordMatch) return false;
  return NOUN_AFTER_MARKER.has(nextWordMatch[1].toLowerCase());
}

/** True when a third-party subject (they/their/he/she/it/vendor/upstream/someone) appears
 *  before the marker in the same clause, and no first-person pronoun (I/we/me/our/us) sits
 *  closer to the marker than that third-party word — so "We deployed, and their CI also ran"
 *  still correctly favors the near, first-person subject. */
function hasThirdPartySubject(sentence: string, matchIndex: number): boolean {
  const before = sentence.slice(0, matchIndex);
  const tokens = before.trim().split(/\s+/).filter(Boolean).map(stripPunct).map((t) => t.toLowerCase());
  let lastThirdParty = -1;
  let lastFirstPerson = -1;
  tokens.forEach((t, i) => {
    if (THIRD_PARTY_SUBJECTS.has(t)) lastThirdParty = i;
    if (FIRST_PERSON_SUBJECTS.has(t)) lastFirstPerson = i;
  });
  return lastThirdParty !== -1 && lastThirdParty > lastFirstPerson;
}

/** Spans (as [start,end) char offsets) covered by backticks or quotes in the sentence. */
function quotedSpans(sentence: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [...backtickSpans(sentence)];
  const patterns = [/"[^"]*"/g, /'[^']*'/g, /“[^”]*”/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence))) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}

/** Returns a skip reason if the sentence/match should NOT count as a claim, else null. */
function guardReason(sentence: string, matchIndex: number, matchLength: number): SkipReason | null {
  const trimmed = sentence.trim();
  const low = trimmed.toLowerCase();

  if (trimmed.endsWith("?")) return "question";
  if (startsWithLead(low, IMPERATIVE_LEADS)) return "imperative";
  if (CONDITIONAL_LEADS.some((w) => containsWholeWord(low, w))) return "conditional";

  // Quoted/backticked is checked before the clause-scanning guards below: a marker enclosed in
  // quotes is unambiguously not a live assertion regardless of what subject word happens to sit
  // earlier in the sentence (e.g. "He said `fixed` in the ticket." — "He" would otherwise read
  // as a third-party subject, which is the right conclusion for the wrong reason).
  const spans = quotedSpans(sentence);
  const matchEnd = matchIndex + matchLength;
  if (spans.some(([s, e]) => matchIndex >= s && matchEnd <= e)) return "quoted";

  if (isNegated(sentence, matchIndex)) return "negation";
  if (isNounPhraseUse(sentence, matchIndex, matchLength)) return "noun_phrase";
  if (hasThirdPartySubject(sentence, matchIndex)) return "third_party";

  return null;
}

export interface DetectResult {
  candidates: ClaimCandidate[];
  skipped: Record<string, number>;
  /** The coverage denominator: every sentence `splitSentences` found in the input,
   *  regardless of outcome. Every sentence falls into exactly one of three buckets —
   *  `classified_sentences` (produced >=1 accepted candidate), a skip reason inside `skipped`
   *  (matched a marker but was guarded out, and produced no accepted candidate), or
   *  `unmatched_sentences` (no rule pattern matched at all) — so
   *  `classified_sentences + sum(Object.values(skipped)) + unmatched_sentences === total`
   *  by construction. A sentence that both produces an accepted candidate (from one rule) AND
   *  is guarded out under a different rule counts as classified, never double-booked into skip
   *  as well — it already produced a claim. */
  total: number;
  classified_sentences: number;
  unmatched_sentences: number;
}

export function detectClaimsWithSkips(text: string, rules: ClaimRule[] = DEFAULT_RULES): DetectResult {
  const skipped: Record<string, number> = {};
  if (!text) return { candidates: [], skipped, total: 0, classified_sentences: 0, unmatched_sentences: 0 };
  const sentences = splitSentences(text);
  const candidates: ClaimCandidate[] = [];
  let classifiedSentences = 0;
  let unmatchedSentences = 0;

  for (const sentence of sentences) {
    let matchedAnyRule = false;
    let producedCandidate = false;
    let firstSkipReason: SkipReason | null = null;

    for (const rule of rules) {
      const flags = (rule.flags ?? "").replace("g", "") + "g";
      const re = new RegExp(rule.pattern, flags);
      const m = re.exec(sentence.text);
      if (!m) continue;
      matchedAnyRule = true;

      const reason = guardReason(sentence.text, m.index, m[0].length);
      if (reason) {
        if (firstSkipReason === null) firstSkipReason = reason;
        continue;
      }

      producedCandidate = true;
      candidates.push({
        claim_type: rule.claim_type,
        rule_id: rule.rule_id,
        statement: sentence.text.slice(0, 2000),
        span: { start: sentence.start, end: sentence.end },
      });
    }

    if (producedCandidate) {
      classifiedSentences++;
    } else if (matchedAnyRule && firstSkipReason !== null) {
      skipped[firstSkipReason] = (skipped[firstSkipReason] ?? 0) + 1;
    } else {
      unmatchedSentences++;
    }
  }

  // Stable order: by position of the carrying sentence in the source text.
  candidates.sort((a, b) => a.span.start - b.span.start);
  return { candidates, skipped, total: sentences.length, classified_sentences: classifiedSentences, unmatched_sentences: unmatchedSentences };
}

export function detectClaims(text: string, rules: ClaimRule[] = DEFAULT_RULES): ClaimCandidate[] {
  return detectClaimsWithSkips(text, rules).candidates;
}
