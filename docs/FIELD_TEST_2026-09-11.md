# Zeuge field test on public third-party instruction files (2026-09-11)

Executed by the integrator (Opus 5) against a frozen copy of the build at HEAD 81cd9ad,
`dist/` copied to a scratchpad so a concurrent maker build could not race the measurement.
Corpus: every `SKILL.md` / `CLAUDE.md` / `AGENTS.md` and every `hooks.json` /
`settings*.json` under the locally installed public plugin marketplaces (two marketplaces,
plus one vendor plugin tree). No workspace-owned file is in the corpus. Network egress from
the shell is denied in this session, so GitHub-hosted files could not be fetched; this local
public corpus is the substitute and its provenance is stated rather than implied.

| Measure | Value |
|---|---|
| Markdown instruction files scanned | 696 |
| Files with at least one instruction-order finding | 210 (30 %) |
| Instruction-order findings, current rule | 457 |
| …of those, action and clause on adjacent lines | 107 |
| …of those, separated by a blank line | 49 (11 %) |
| Findings surviving a tightened rule (clause must LEAD its bullet, no blank line between) | **12** (reduction 97.4 %) |
| Files affected under the tightened rule | 9 |
| Hook JSON files scanned | 10 |
| Hook-matcher findings | 1 |
| Hook JSON parse errors | 0 |

## What this means, stated plainly

**The instruction-order lint as shipped is a noise generator.** Hand-reading the examples:
`- Use \`--cwd <path>\`` followed by `- Use \`unset CLAUDECODE\` before \`x\`` is reported,
but the word "before" there is ordinary prose, not a clause governing the previous bullet.
Of the ten adjacent-line examples inspected, ten are false positives. A 30 % file hit rate
at that precision would make the first check a user meets useless, and "lexical, never
semantic" in the blind-spot line does not excuse it.

**The tightened rule is defensible but narrow.** 12 findings over 696 files, and several of
those are numbered steps whose natural phrasing is "5. Before each edit pass, …" — a step,
not a misordered qualifier. Expect the true-positive count in this corpus to be near zero.
That is an honest result: the fault class is real (it was measured twice in this workspace in
one day) but it is rare in published instruction files.

**The hook-matcher check earned its place.** One finding in ten public hook files: a
PreToolUse group with an empty matcher, which Claude Code treats as matching every tool,
including the agent's own Read/Grep/Glob. That is precisely the self-lockout shape, it was
added only because an independent verdict demanded it, and it is a risk signal rather than a
proven fault — a non-blocking hook on all tools is harmless. The lint must say "risk", not
"fault".

## Consequences for the product (binding for Run 1)

1. **Severity model, not a flat finding list.** Every check emits `severity: fault |
   risk | review`. Default exit 1 only on `fault`. `risk` and `review` need `--strict`.
   Instruction-order emits `review`; MATCHER_ABSENT emits `risk`; an unparsable settings file
   and a dead probe stay integrity failures (exit 3).
2. **Instruction-order is demoted** to the tightened rule, off by default, enabled with
   `--experimental-order`. Its output carries the measured numbers from this file.
3. **The headline is the claim audit, not the lints.** Positioning is corrected accordingly:
   what is unique and measured is "the agent said done, nothing witnessed it". The lints are
   supporting checks.
4. **Ship the measurement.** The README links this page. A dev-tool that publishes its own
   false-positive rate is a stronger claim than one that hides it — and it is the only
   posture consistent with the product's own premise.

Reproduce: `scratchpad/field/fieldtest2.mjs`, `precision.mjs`, `precision2.mjs` against a
frozen `dist/`. Corpus paths are local installs; the scripts take the roots as arguments.
