# Install

**Replace `<owner>/<repo>` below with wherever this package's repository is actually hosted.**
The maintainer substitutes the real path before publishing; as checked out here it is a
placeholder, not a copy-pasteable value.

```
claude plugin marketplace add <owner>/<repo>
claude plugin install zeuge@zeuge
```

Or, without a plugin, in any project:

```
npx zeuge lint .
```

## Verify it is working

Once the plugin is installed, have the agent say something like "All tests pass." with nothing
to back it up. On its next turn, zeuge's Stop hook adds a note to that effect — something like:

```
[zeuge] 1 claim(s) without a witness: tests_pass. Missing witness: no ledger found at
<project>/.zeuge/ledger.jsonl. Name the witness or say NOT CHECKED.
```

It never blocks the turn — the agent can still finish — but the note is now on the record. Once
a matching command has actually run and been recorded in the ledger (wired automatically via the
`PostToolUse` hook below), the same claim stops getting nudged. See the README's "Sixty seconds"
section for the exact same check run by hand, with exact commands and output, no agent required.

## How it is wired

Claude Code auto-loads the package's `hooks/hooks.json` (the ONLY hooks file; do not also
list it under `plugin.json` `hooks` or the plugin fails with a duplicate-hooks error). It runs `node "${CLAUDE_PLUGIN_ROOT}/bin/zeuge.js" claim hook
--event Stop` on `Stop` and `node "${CLAUDE_PLUGIN_ROOT}/bin/zeuge.js" ledger hook --event
PostToolUse` on `Bash|Write|Edit`. Both are read-only at the plugin layer: they never block a
tool call or a turn (exit 0 always). `${CLAUDE_PLUGIN_ROOT}` is quoted in every command so an
install path containing a space still works; `Stop` carries no `matcher` (matchers are for tool
events, not `Stop`).

Everything the plugin needs at runtime — `bin/zeuge.js` and the compiled `dist/` it requires —
is committed to this repository (a plugin install pulls from git, not from the npm registry, so
an untracked `dist/` would leave the hook commands unable to find their own compiled code;
`npm run verify:dist` fails the build if the committed `dist/` ever drifts from a fresh
`tsc` output). The same `dist/`/`bin/` pair is also exactly what `npm publish` ships, per
`package.json`'s `files` list `["dist", "bin", "README.md", "LICENSE"]` — a plugin install and
an `npm install`/`npx` install draw from the same compiled artifact, never from `src/`.

The `marketplace/.claude-plugin/marketplace.json` in this repo is an example of the marketplace
manifest a host needs; a real distribution keeps that file at the marketplace repo's own root,
not nested under the package it points to.

### For maintainers: wiring without a plugin

Wire the hooks yourself in the target project's `.claude/settings.json` (or an equivalent
Claude Code hooks configuration), adapting `hooks/hooks.json` from this repo: replace
`node "${CLAUDE_PLUGIN_ROOT}/bin/zeuge.js"` with `npx --no-install zeuge` in each command (the
`claim hook --event Stop` / `ledger hook --event PostToolUse` arguments and the `Bash|Write|Edit`
matcher stay the same).
