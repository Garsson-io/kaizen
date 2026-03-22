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
| `kaizen-session-cleanup.sh` | L2 | No | plugin.json | Clears stale state files for merged/closed PRs. Moved out of PreToolUse hot path in #452. |

## PreToolUse Hooks — Bash Matcher

| Hook | Level | Blocking | Purpose |
|------|-------|----------|---------|
| `kaizen-enforce-pr-review.sh` | L3 | Yes (deny) | **Gate**: Blocks Bash commands when PR review is pending (`needs_review` state). |
| `kaizen-enforce-case-worktree.sh` | L1 | No (advisory) | Warns on `git commit`/`push` outside a worktree. |
| `kaizen-check-test-coverage.sh` | L1 | No (advisory) | Warns when changed source files lack test coverage. Issue #8. |
| `kaizen-check-verification.sh` | L1 | No (advisory) | Warns when PR body lacks Verification section. Issue #10. |
| `kaizen-check-dirty-files.sh` | L3 | Yes (deny) | Forces agent to address every dirty file before commit/push. |
| `kaizen-enforce-pr-reflect.sh` | L3 | Yes (deny) | **Gate**: Blocks Bash until kaizen reflection is done (`needs_pr_kaizen` state). Issue #57. |
| `kaizen-warn-code-quality.sh` | L1 | No (advisory) | Warns about excessive mocks, large files, duplicate code. Issue #89. |
| `kaizen-check-practices.sh` | L1 | No (advisory) | Shows relevant practices before PR creation. Issue #210. |
| `kaizen-block-git-rebase.sh` | L2 | Yes (deny) | Blocks `git rebase`. Allows `--abort`/`--continue`/`--skip`. Issue #296. |
| `kaizen-bump-plugin-version.sh` | L1 | No (advisory) | Auto-bumps plugin version before PR. **Kaizen repo only** (settings.json). |

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
| `kaizen-post-merge-clear.sh` | L2 | Bash | Clears post-merge gate when `/kaizen-reflect` is invoked. Issue #96. |
| `pr-kaizen-clear-ts.sh` | L3 | TypeScript | Clears `needs_pr_kaizen` gate on valid `KAIZEN_IMPEDIMENTS` JSON. Issues #57, #113, #140, #162. |
| `kaizen-capture-worktree-context.sh` | L1 | Bash | Writes `.worktree-context.json` on PR creation. |

## PostToolUse Hooks — Skill Matcher

| Hook | Level | Purpose |
|------|-------|---------|
| `kaizen-post-merge-clear.sh` | L2 | Also fires on Skill to clear gate for `/kaizen-reflect`. |

## Stop Hooks

| Hook | Level | Blocking | Purpose |
|------|-------|----------|---------|
| `kaizen-enforce-pr-review-stop.sh` | L3 | Yes (block) | Blocks stop when PR review pending. Issue #46. |
| `kaizen-enforce-post-merge-stop.sh` | L2 | Yes (block) | Blocks stop when post-merge steps pending. Issues #96, #279. |
| `kaizen-verify-before-stop.sh` | L2 | Yes (block) | Runs `tsc --noEmit` + `vitest run` on modified TS. Capped at 2 workers. |
| `kaizen-check-cleanup-on-stop.sh` | L1 | No (advisory) | Warns about orphaned worktrees. |
| `kaizen-enforce-reflect-stop.sh` | L2 | Yes (block) | Blocks stop when kaizen reflection pending. Issue #312. |

## Gate Pattern Summary

| Gate | Set by | Cleared by | Enforced by (Pre) | Enforced by (Stop) |
|------|--------|------------|-------------------|-------------------|
| `needs_review` | `pr-review-loop-ts.sh` | `pr-review-loop-ts.sh` | `enforce-pr-review.sh`, `enforce-pr-review-tools.sh` | `enforce-pr-review-stop.sh` |
| `needs_pr_kaizen` | `kaizen-reflect-ts.sh` | `pr-kaizen-clear-ts.sh` | `enforce-pr-reflect.sh` | `enforce-reflect-stop.sh` |
| `needs_post_merge` | `kaizen-reflect-ts.sh` | `post-merge-clear.sh` | — | `enforce-post-merge-stop.sh` |

## TS Migration Status

Three hooks migrated from bash to TypeScript for better testability (Phase 3 of #320):

| Registered shim | TS implementation | Tests |
|-----------------|-------------------|-------|
| `kaizen-reflect-ts.sh` | `src/hooks/kaizen-reflect.ts` | 21 |
| `pr-review-loop-ts.sh` | `src/hooks/pr-review-loop.ts` | 22 |
| `pr-kaizen-clear-ts.sh` | `src/hooks/pr-kaizen-clear.ts` | 39 |

Each `-ts.sh` shim is a thin bash wrapper that calls `npx tsx` to invoke the TypeScript implementation.

## Shared Libraries

All hook libraries are in `.claude/hooks/lib/`:

| Library | Purpose |
|---------|---------|
| `scope-guard.sh` | Blocks hooks when kaizen is installed at computer level. Sourced by every hook. |
| `parse-command.sh` | Parses hook stdin JSON, extracts command. |
| `input-utils.sh` | `read_hook_input`, `get_command` helpers. |
| `hook-output.sh` | `emit_deny()`, `emit_stop_block()`, `render_prompt()`. |
| `state-utils.sh` | State file management for gates. |
| `allowlist.sh` | Command allowlisting for gate enforcement. |
| `read-config.sh` | Reads `kaizen.config.json`. |
| `resolve-main-checkout.sh` | Resolves main checkout path from a worktree. |
| `resolve-project-root.sh` | Resolves project root (handles worktrees). |
| `send-notification.sh` | Telegram notifications via IPC. |
| `hook-timing-sentinel.sh` | Performance monitoring for hook execution time. |

## The Three Levels

- **L1 (Advisory):** Outputs warnings/prompts. Never blocks.
- **L2 (Enforcement):** Blocks via `deny` or `block`. Can be bypassed with `--bare`.
- **L3 (Mechanistic):** Gate architecture — creates state that other hooks enforce.
