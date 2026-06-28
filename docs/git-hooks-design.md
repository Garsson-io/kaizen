# Git Hooks Design

This document captures the architecture, decision, and rollout of kaizen's mechanistic git-hook layer. See epic [#1059](https://github.com/Garsson-io/kaizen/issues/1059) for motivation and discussion.

## Problem

The kaizen review-gate mechanism previously relied on `PostToolUse`/`PreToolUse` hooks that parse the `Bash` tool's `command` string to detect git/gh operations. This approach is inherently fragile:

- Multi-line commands with `export PATH=...` prefix bypass the regex ([#1057](https://github.com/Garsson-io/kaizen/issues/1057))
- Heredoc-wrapped pushes bypassed `stripHeredocBody` (one incident fixed, but the category remains)
- Hook doesn't fire on `git push` in worktree / headless `-p` sessions ([#909](https://github.com/Garsson-io/kaizen/issues/909))
- New shell idioms (`hub`, web UI, `time`, `nice`, subshells) each need their own regex patch — arms race

This is one instance of the meta-pattern in [#943](https://github.com/Garsson-io/kaizen/issues/943): **enforcement verifies command detection, not outcomes**.

## Design

A native `pre-push` git hook fires whenever git pushes refs, regardless of how the push was invoked. The hook:

1. **Short-circuits for humans.** Exits 0 silently when no AI-agent env var is set (see "Agent-env gating" below).
2. **Queries PR state** via `gh pr list --head <branch> --state all`.
3. **Decides** from three actions:
   - `allow_silent` — no PR history, closed-not-merged, or explicit `--push-option kaizen-force`
   - `allow_gate` — open PR on this branch → creates `needs_review` state file (idempotent with `pr-review-loop.ts`)
   - `deny` — most-recent PR is `MERGED` with no newer open → blocks push with recovery message ([#1032](https://github.com/Garsson-io/kaizen/issues/1032), enforces invariant I7)
4. **Traces** every invocation to `$KAIZEN_HOOK_TRACE` as JSONL.

### Architecture

```
.githooks/pre-push                         (shell wrapper, tracked)
  └─ agent-env gate (exit 0 for humans)
  └─ exec npx tsx src/hooks/pre-push.ts
      ├─ parseStdin (git pre-push protocol)
      ├─ detectAgentEnv (TS-side, defense-in-depth)
      ├─ queryPrState (gh pr list)
      ├─ decide (pure function)
      ├─ applyDecision (writeStateFile if allow_gate)
      ├─ trace (JSONL)
      └─ exit 0 / 1 + stderr message
```

`src/hooks/pre-push.ts` is TypeScript, tested under vitest, and called by the shell wrapper — matching the established pattern of `src/hooks/stop-gate.ts` + `.claude/hooks/*.sh`.

### Agent-env gating

The hook runs **only for AI-agent sessions**. Gate at the top of the shell wrapper:

```bash
if [ -z "$CLAUDECODE" ] && [ -z "$CLAUDE_PROJECT_DIR" ] \
   && [ -z "$CODEX_SESSION" ] && [ -z "$KAIZEN_SESSION" ]; then
  exit 0
fi
```

**Why agent-only?** Git hooks fire for everyone by default — manual developer work, CI systems, etc. Kaizen's review gate only needs to enforce against AI agents. Gating on env vars:

- **Defuses `--no-verify` pressure** — humans never hit the gate, so no habit of bypassing develops.
- **Defuses host-project framework conflicts** — if a chained host hook fails for a human, kaizen isn't in the stack to confuse the error.
- **Simplifies debugging** — one audience (agents) means one set of failure modes.

**Verified**: Claude Code sets `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_EXECPATH=...` in the environment of every Bash tool call. These propagate into git hooks invoked from tool-call subshells, with no additional setup.

**Bypass paths** (deliberate, not accidental):
- `git push --no-verify` — skips all hooks. Flagged as a policy violation at the Claude Code `PreToolUse` layer (see `.claude/hooks/kaizen-prehook-no-verify.sh`).
- `env -i git push ...` — clears env vars → agent-env gate fails-open silently. Acceptable: `env -i` is an explicit escape hatch.
- `sudo` / `su` / container invocations that drop env vars → same category as `env -i`.

## Hook-owner strategy for host projects (Option C)

`core.hooksPath` has exactly one owner. Host projects may already use husky, lefthook, pre-commit, or a raw `.git/hooks/pre-push`. Kaizen implements **Option C — hybrid, raw fallback** (decided in [#1059](https://github.com/Garsson-io/kaizen/issues/1059)):

- **If host has a recognized framework** → inject into theirs (host owns `core.hooksPath`)
- **If host has none** → raw `.githooks/pre-push` with `git config core.hooksPath .githooks`

The detection order in `src/setup-git-hooks.ts`:

1. **pre-commit** (PRIMARY — most host repos use this) — `.pre-commit-config.yaml` present
2. **husky** — `.husky/` directory present
3. **lefthook** — `lefthook.yml` present
4. **raw** — existing `.git/hooks/pre-push` (user-maintained)
5. **none** — nothing detected → standalone `.githooks/pre-push` install

### Framework-specific injection

In every case, kaizen writes `.kaizen-hooks/pre-push` (a **thin wrapper** that execs the plugin-resident entry — see below) to the host project root, then registers it with whichever framework is present.

**pre-commit** (PRIMARY):

```yaml
repos:
  - repo: local
    hooks:
      - id: kaizen-pre-push
        name: Kaizen pre-push gate
        entry: .kaizen-hooks/pre-push
        language: script
        stages: [pre-push]
        always_run: true
        pass_filenames: false
        verbose: false
```

Post-install: `pre-commit install --hook-type pre-push` (pre-commit defaults only install the `pre-commit` stage; `pre-push` must be explicitly added).

**husky**:

```bash
# .husky/pre-push (existing content preserved)
...

# KAIZEN_CHAIN_START
if [ -x "$(dirname "$0")/../.kaizen-hooks/pre-push" ]; then
  "$(dirname "$0")/../.kaizen-hooks/pre-push" "$@" || exit $?
fi
# KAIZEN_CHAIN_END
```

**lefthook**:

```yaml
pre-push:
  commands:
    kaizen-pre-push:
      run: ./.kaizen-hooks/pre-push
```

**raw** `.git/hooks/pre-push` — appends a `KAIZEN_CHAIN_START`-marked block that execs `.kaizen-hooks/pre-push`.

**none** (no framework) — creates `.githooks/pre-push` that execs `.kaizen-hooks/pre-push`, then `git config core.hooksPath .githooks`.

All injection is **idempotent**: running `/kaizen-setup install-git-hooks` twice detects the `KAIZEN_CHAIN_START` marker (or hook `id: kaizen-pre-push` for structured configs) and skips.

### The `.kaizen-hooks/pre-push` thin wrapper (#1086)

`/kaizen-setup install-git-hooks` writes a **thin wrapper** (~25–35 lines) into the host repo at `.kaizen-hooks/pre-push`. It is NOT a copy of the gate logic — it only:

1. Resolves the kaizen plugin root: `$CLAUDE_PLUGIN_ROOT` → baked-in install path → `$HOME/.claude/plugins/cache` search → fail-open.
2. Exports the resolved root as `$CLAUDE_PLUGIN_ROOT`.
3. `exec`s the **plugin-resident** `$KAIZEN_ROOT/src/hooks/kaizen-host-entry.sh` with stdin and args passed through.

`kaizen-host-entry.sh` (inside the plugin) then runs the agent-env gate, resolves the runtime, and dispatches to `src/hooks/pre-push.ts`.

**Why a wrapper, not a copy (the self-updating property).** The earlier design wrote a ~66-line *copy* of `kaizen-host-entry.sh` into the host repo. That froze the host's pre-push logic at the kaizen version present when setup last ran — a gate fix learned from an incident could not reach the host until it re-ran `/kaizen-setup`, which most collaborators never do. The opposite of kaizen's continuous-improvement loop. With the wrapper, **all version-sensitive logic lives in the plugin**, so a plugin update reaches every host automatically. The wrapper is so minimal it almost never changes.

**No agent-env gate in the wrapper — deliberate.** `kaizen-host-entry.sh` already gates on the agent-env vars as its first action, and `src/hooks/agent-env-agreement.test.ts` pins that var list against `pre-push.ts` so it can't drift. Adding the gate to the wrapper would create a *third* copy of that list to keep in sync — the exact drift hazard the agreement test exists to prevent. In the common case the baked-in path resolves without a cache scan, so a human push still exits fast once it reaches the entry's gate.

**Migration is automatic.** `writeEntryScript` overwrites `.kaizen-hooks/pre-push` on every setup run, so the next `/kaizen-setup` on an existing host swaps the stale copy for the wrapper. No `.kaizen-hooks/` removal needed.

Builder: `buildThinWrapper(pluginRoot)` in `src/setup-git-hooks.ts`. The dispatch target template lives at `src/hooks/kaizen-host-entry.sh` in the kaizen plugin.

> Remote-repo hook references (pre-commit `repo:`/lefthook `remotes:`, #1087) would remove host-side code entirely. That is a larger architecture change tracked separately; the thin wrapper is the categorical fix for the *staleness* of the host-side file today.

## Worktree semantics

Git worktrees share the common git dir (`.git/objects`, refs, and `.git/hooks/` via gitfile). Hook setup semantics:

- Hooks installed at `.git/hooks/*` → **shared** across all worktrees automatically.
- `core.hooksPath=.githooks` is a **repo-level** config → shared across worktrees via `.git/config`.
- `.githooks/*` is a checked-out path → each worktree runs **its own copy** of `.githooks/pre-push` resolved against the working tree.
- If a worktree is on a branch that doesn't have `.githooks/` committed → git silently finds no hook and runs nothing.

Mitigation: `.claude/hooks/kaizen-worktree-setup.sh` (SessionStart) verifies `.githooks/pre-push` exists and is executable, and warns if `core.hooksPath` is unset. The same hook delegates to `src/hooks/worktree-integrity.ts` to normalize Claude Code EnterWorktree's sanitized `worktree-case+<date>-k<N>-...` branch shape back to canonical `case/<date>-k<N>-...` before issue binding.

### Per-worktree `kaizen.issue` binding (#1111)

`kaizen.issue` answers "which issue is **this** worktree's work for?" — inherently per-worktree state. But raw `git config kaizen.issue <N>` writes to the **shared** `.git/config`, so every worktree reads one global value. Two failure modes follow:

- **Leak** — a freshly provisioned run worktree inherits the *previous* run's `kaizen.issue` (observed: a run for #1099 inherited `1106`).
- **Clobber** — two concurrent runs overwrite each other's binding.

No shared-scope "unset on provisioning" is safe under concurrency (it would clear a sibling's legitimate binding). The categorical fix is to scope the binding to the worktree so the bad state cannot exist:

- `git config extensions.worktreeConfig true` enables per-worktree keys.
- `git config --worktree kaizen.issue <N>` writes a binding the merged read (`git config --get`) prefers over the shared value — independent per worktree.
- `src/issue-binding.ts` is the single read/write primitive; `src/cli-issue-binding.ts` exposes `bind` / `read` / `check-leak` so the harness and agents never touch raw shared config.
- The SessionStart guard in `kaizen-worktree-setup.sh` calls `src/hooks/worktree-integrity.ts`, which normalizes sanitized case branches, self-heals canonical case branches by writing the worktree-scoped binding, and detects inherited leaked bindings at the provisioning choke point (advisory — the #1106 edit-time hook still fail-closes as defense-in-depth).

## Coexistence with `pr-review-loop.ts`

`pr-review-loop.ts` (`PostToolUse` on `Bash`) is **retained** as a fallback. Its Bash command-string parsing catches `gh pr create` (extracting the PR URL from `gh`'s output — pre-push can't do this, as the PR doesn't exist yet at push time) and handles subsequent-push round bumping.

Pre-push and pr-review-loop coordinate via a shared state file (`state-utils.ts`):

- **First push** (before PR exists): pre-push sees no PR → `allow_silent`. No state written.
- **`gh pr create`**: pr-review-loop's TRIGGER 1 writes initial state (ROUND=1).
- **Subsequent pushes**: both hooks fire. Pre-push detects existing state and **does not overwrite** (see `applyDecision` guard in `src/hooks/pre-push.ts`). pr-review-loop bumps the round.

This lets pre-push serve as the mechanistic **outcome** signal (push happened) while pr-review-loop continues to own the **round logic** (bump, auto-pass, escalate).

## Trace observability

Every invocation that passes the agent-env gate writes a JSONL entry to `$KAIZEN_HOOK_TRACE` (default `/tmp/.kaizen-hook-trace.jsonl`):

```json
{"ts":"2026-04-16T12:34:56.789Z","hook":"pre-push","agent_detected":true,"env_vars_seen":["CLAUDECODE"],"action":"deny","reason":"merged_branch_push","branch":"feat/foo","mergedPr":41,"mergedPrUrl":"..."}
```

Agent-env-gated invocations (detected=false) are also traced — proves the hook ran and short-circuited.

## Testing

See `src/hooks/pre-push.test.ts` (38 unit tests) and `src/setup-git-hooks.test.ts` (32 unit tests). Behaviors × levels coverage in the epic test plan.

## References

- Epic: [#1059](https://github.com/Garsson-io/kaizen/issues/1059)
- Root incident: [#943](https://github.com/Garsson-io/kaizen/issues/943) (enforcement verifies command detection, not outcomes)
- Closed by this work: [#911](https://github.com/Garsson-io/kaizen/issues/911), [#909](https://github.com/Garsson-io/kaizen/issues/909), [#1057](https://github.com/Garsson-io/kaizen/issues/1057), [#1032](https://github.com/Garsson-io/kaizen/issues/1032)
