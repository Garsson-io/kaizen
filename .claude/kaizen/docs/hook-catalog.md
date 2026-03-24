# Hook Catalog

Complete reference for all kaizen hooks. Every hook is registered in `.claude-plugin/plugin.json` (for all projects) or `.claude/settings.json` (kaizen repo only).

## Registration Sources

| Source | Scope | When it fires |
|--------|-------|---------------|
| `.claude-plugin/plugin.json` | All projects using kaizen plugin | Auto-detected from repo root OR project-scoped install |
| `.claude/settings.json` | Kaizen repo only | Repo-specific hooks not in the plugin |

Computer-level installation (`kaizen@kaizen` in `~/.claude/settings.json`) is **forbidden** — it causes every hook to fire twice, leading to OOM crashes. All hooks include `lib/scope-guard.sh` which detects and blocks this.

## SessionStart Hooks

| Hook | Level | Blocking | Source | Purpose |
|------|-------|----------|--------|---------|
| `kaizen-check-wip.sh` | L1 | No | plugin.json | Detects in-progress work (dirty worktrees, open PRs) when starting a new session in the main checkout. |
| `kaizen-session-cleanup-ts.sh` → `session-cleanup.ts` | L2 | No | plugin.json | Clears stale state files for merged/closed PRs. Migrated to TS in #786. |

## PreToolUse Hooks — Bash Matcher

| Hook | Level | Blocking | Purpose |
|------|-------|----------|---------|
| `kaizen-enforce-pr-review-ts.sh` → `enforce-pr-review.ts` | L3 | Yes (deny) | **Gate**: Blocks Bash commands when PR review is pending (`needs_review` state). Issue #775. |
| `kaizen-enforce-case-worktree.sh` | L1 | No (advisory) | Warns on `git commit`/`push` outside a worktree. |
| `kaizen-pr-quality-checks-ts.sh` → `pr-quality-checks.ts` | L1 | No (advisory) | Consolidated PR quality advisories: test coverage (#8), verification (#10), code quality (#89), practices (#210). Consolidation #800. |
| `kaizen-check-dirty-files-ts.sh` → `check-dirty-files.ts` | L3 | Yes (deny on PR create) / Warn (push/merge) | Dirty file check. Push downgraded to warn. Skips during merge. Issue #775. |
| `kaizen-enforce-pr-reflect-ts.sh` → `enforce-pr-reflect.ts` | L3 | Yes (deny) | **Gate**: Blocks Bash until kaizen reflection is done (`needs_pr_kaizen` state). Issue #775. |
| `kaizen-block-git-rebase.sh` | L2 | Yes (deny) | Blocks `git rebase`. Allows `--abort`/`--continue`/`--skip`. Issue #296. |
| `kaizen-bump-plugin-version-ts.sh` → `bump-plugin-version.ts` | L1 | No (advisory) | Auto-bumps plugin version before PR. **Kaizen repo only** (settings.json). Issue #775. |

## PreToolUse Hooks — Edit|Write Matcher

| Hook | Level | Blocking | Purpose |
|------|-------|----------|---------|
| `kaizen-enforce-worktree-writes.sh` | L3 | Yes (deny) | Blocks source edits in main checkout on main branch. |
| `kaizen-enforce-case-exists.sh` | L2 | Yes (deny) | Blocks edits in worktrees without a kaizen case. Issue #94. |
| `kaizen-enforce-pr-review-tools.sh` | L3 | Yes (deny) | **Gate**: Blocks Edit/Write during PR review. Issue #46. |

## PreToolUse Hooks — Agent Matcher

| Hook | Level | Blocking | Purpose |
|------|-------|----------|---------|
| `kaizen-enforce-pr-review-tools.sh` | L3 | Yes (deny) | Blocks Agent tool during PR review. |

## PostToolUse Hooks — Bash Matcher

| Hook | Level | Impl | Purpose |
|------|-------|------|---------|
| `pr-review-loop-ts.sh` | L2 | TypeScript | Multi-round PR self-review. Triggers on `gh pr create`/`git push`/`gh pr diff`/`gh pr merge`. Issue #29. |
| `kaizen-reflect-ts.sh` | L2 | TypeScript | Triggers kaizen reflection after PR create/merge. Sets `needs_pr_kaizen` gate. Issue #9. |
| `kaizen-post-merge-clear-ts.sh` → `post-merge-clear.ts` | L2 | TypeScript | Clears post-merge gate when `/kaizen-reflect` is invoked. Migrated to TS in #786. |
| `pr-kaizen-clear-ts.sh` | L3 | TypeScript | Clears `needs_pr_kaizen` gate on valid `KAIZEN_IMPEDIMENTS` JSON. Issues #57, #113, #140, #162. |
| `kaizen-capture-worktree-context.sh` | L1 | Bash | Writes `.worktree-context.json` on PR creation. |

## PostToolUse Hooks — Skill Matcher

| Hook | Level | Purpose |
|------|-------|---------|
| `kaizen-post-merge-clear-ts.sh` | L2 | Also fires on Skill to clear gate for `/kaizen-reflect`. |

## Stop Hooks

| Hook | Level | Blocking | Purpose |
|------|-------|----------|---------|
| `kaizen-stop-gate.sh` → `stop-gate.ts` | L3 | Yes (block) | Unified stop gate — reads all pending gates (review, reflection, post-merge) and shows one rich message. Supports `KAIZEN_UNFINISHED` escape. Issue #775. |
| `kaizen-verify-before-stop.sh` | L2 | No (advisory) | Reminds about `npm test` / `tsc --noEmit` for modified TS files. |
| `kaizen-check-cleanup-on-stop.sh` | L1 | No (advisory) | Warns about orphaned worktrees. |

## Gate Pattern Summary

| Gate | Set by | Cleared by | Enforced by (Pre) | Enforced by (Stop) |
|------|--------|------------|-------------------|-------------------|
| `needs_review` | `pr-review-loop-ts.sh` | `pr-review-loop-ts.sh` | `enforce-pr-review.ts` | `stop-gate.ts` |
| `needs_pr_kaizen` | `kaizen-reflect-ts.sh` | `pr-kaizen-clear-ts.sh` | `enforce-pr-reflect.ts` | `stop-gate.ts` |
| `needs_post_merge` | `kaizen-reflect-ts.sh` | `post-merge-clear.ts` | — | `stop-gate.ts` |
| All gates | — | `KAIZEN_UNFINISHED` (via `pr-kaizen-clear.ts`) | — | `stop-gate.ts` shows escape option |

## TS Migration Status

All enforcement hooks are now in TypeScript. Each `-ts.sh` shim is a thin bash wrapper (~5 lines) that calls `npx tsx` to invoke the TypeScript implementation.

| Registered shim | TS implementation | Tests |
|-----------------|-------------------|-------|
| `kaizen-reflect-ts.sh` | `src/hooks/kaizen-reflect.ts` | 21 |
| `pr-review-loop-ts.sh` | `src/hooks/pr-review-loop.ts` | 22 |
| `pr-kaizen-clear-ts.sh` | `src/hooks/pr-kaizen-clear.ts` | 84 |
| `kaizen-stop-gate.sh` | `src/hooks/stop-gate.ts` + `src/hooks/lib/gate-manager.ts` | 21 |
| `kaizen-enforce-pr-review-ts.sh` | `src/hooks/enforce-pr-review.ts` | 6 |
| `kaizen-enforce-pr-reflect-ts.sh` | `src/hooks/enforce-pr-reflect.ts` | 8 |
| `kaizen-check-dirty-files-ts.sh` | `src/hooks/check-dirty-files.ts` | 13 |
| `kaizen-bump-plugin-version-ts.sh` | `src/hooks/bump-plugin-version.ts` | 5 |
| `kaizen-post-merge-clear-ts.sh` | `src/hooks/post-merge-clear.ts` | — |
| `kaizen-session-cleanup-ts.sh` | `src/hooks/session-cleanup.ts` | — |
| `kaizen-pr-quality-checks-ts.sh` | `src/hooks/pr-quality-checks.ts` | — |

Shared TS libraries: `src/hooks/hook-io.ts` (stdin/stdout, getCurrentBranch), `src/hooks/lib/allowlist.ts` (command allowlists, 35 tests), `src/hooks/lib/gate-manager.ts` (unified gate reading/formatting).

## Shared Libraries

All hook libraries are in `.claude/hooks/lib/`:

| Library | Purpose |
|---------|---------|
| `scope-guard.sh` | Blocks hooks when kaizen is installed at computer level. Sourced by every hook. |
| `parse-command.sh` | Parses hook stdin JSON, extracts command. |
| `input-utils.sh` | `read_hook_input`, `get_command` helpers. |
| `hook-output.sh` | `emit_deny()`, `emit_stop_block()`, `render_prompt()`. |
| `allowlist.sh` | Command allowlisting for gate enforcement. |
| `read-config.sh` | Reads `kaizen.config.json`. |
| `hook-timing-sentinel.sh` | Performance monitoring for hook execution time. |

## The Three Levels

- **L1 (Advisory):** Outputs warnings/prompts. Never blocks.
- **L2 (Enforcement):** Blocks via `deny` or `block`. Can be bypassed with `--bare`.
- **L3 (Mechanistic):** Gate architecture — creates state that other hooks enforce.
