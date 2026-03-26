# Kaizen — Continuous Improvement Plugin

Standalone Claude Code plugin for recursive process improvement. Works on any project.

## Quick Context

Kaizen provides enforcement hooks, reflection workflows, and dev workflow skills. Host projects configure via `kaizen.config.json`. Kaizen uses kaizen on itself (self-dogfood).

## Key Files

| File | Purpose |
|------|---------|
| `kaizen.config.json` | Self-dogfood config (kaizen repo points to itself) |
| `.claude/kaizen/zen.md` | Philosophy — run `/kaizen-zen` |
| `.claude/kaizen/policies.md` | Generic enforcement policies |
| `.claude/kaizen/workflow.md` | Dev work skill chain |
| `.claude/kaizen/verification.md` | Verification discipline |
| `.claude/hooks/` | All enforcement hooks (kaizen- prefixed) |
| `.claude/hooks/lib/` | Shared hook libraries |
| `.claude/hooks/tests/` | Hook test infrastructure |
| `src/hooks/` | TypeScript hooks |
| `src/hooks/lib/gate-manager.ts` | Unified stop gate — read/format/clear all pending gates |
| `src/hooks/stop-gate.ts` | Unified stop hook entry point (replaces 3 bash stop hooks) |
| `.claude/hooks/kaizen-worktree-setup.sh` | SessionStart hook — symlinks node_modules/dist from main repo into fresh worktrees |
| `.claude-plugin/plugin.json` | Plugin manifest with hook registrations |
| `docs/hooks-design.md` | Hooks patterns, anti-patterns, regex traps, gate design, testing conventions |
| `docs/hook-test-dry-spec.md` | DRY refactoring spec for hook test infrastructure |
| `docs/test-ladder-spec.md` | Test maturity levels and testing methodology |
| `docs/worktree-first-tooling-spec.md` | Worktree-safe tooling patterns |
| `docs/kaizen-cases-unification-spec.md` | Kaizen issue + case system unification |
| `docs/kaizen-ipc-architecture.md` | IPC architecture for kaizen-cases |
| `docs/case-create-auto-adopt-worktree-spec.md` | Worktree adoption for case system |
| `docs/test-side-effects-and-kaizen-escalation-spec.md` | Test side-effects and L1→L2 escalation patterns |
| `docs/auto-dent-operations.md` | Auto-dent operational guide — how to run, monitor, debug batch operations |
| `docs/artifact-lifecycle.md` | Artifact chain — where outputs live, who consumes them, recursive loops |
| `scripts/review-fix.ts` | CLI: review → fix → re-review cycle with state persistence and resume |
| `src/cli-dimensions.ts` | Dimension CLI: list/show/add/validate `prompts/review-*.md` files |
| `src/section-editor.ts` | **Structured PRs and issues** — list/read/add/replace/remove named `##` sections in PR/issue bodies without full read/rewrite. The general-purpose capability. |
| `src/cli-section-editor.ts` | CLI for structured PR/issue editing |
| `src/plan-store.ts` | Plan/metadata storage on GitHub issues — uses marker comments for plan, testplan, and YAML metadata. Built on the structured issues capability. |
| `src/cli-plan-store.ts` | CLI: store/retrieve plan, testplan, metadata, query connected issues |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/kaizen-reflect` | Post-work reflection — classify impediments, file issues |
| `/kaizen-pick` | Select next issue from backlog |
| `/kaizen-gaps` | Strategic analysis — tooling gaps, horizon concentration |
| `/kaizen-evaluate` | Scope gate — evaluate issue before implementation |
| `/kaizen-implement` | Spec-to-code executor |
| `/kaizen-deep-dive` | Autonomous root-cause fix across a category |
| `/kaizen-audit-issues` | Taxonomy audit — label coverage, epic health |
| `/kaizen-prd` | Problem mapping — iterative discovery to spec |
| `/kaizen-plan` | Break large work into sequenced PRs |
| `/kaizen-review-pr` | Self-review checklist |
| `/kaizen-write-pr` | Write a PR body using the Story Spine narrative arc |
| `/kaizen-sections` | Structured PRs and issues — manage named sections in bodies and attachments on issues/PRs |
| `/kaizen-dimensions` | List, inspect, and manage review battery dimensions |
| `/kaizen-file-issue` | Fast incident-to-issue capture (2 min) |
| `/kaizen-zen` | Print the Zen of Kaizen |
| `/kaizen-wip` | Show in-progress work |
| `/kaizen-cleanup` | Disk usage analysis and safe cleanup |
| `/kaizen-setup` | Install & configure plugin for a host project |
| `/kaizen-update` | Pull updates from kaizen repo |

## Mandatory Practices

**PR bodies**: Always use `/kaizen-write-pr` when creating or editing PR descriptions. Never write a bare `gh pr create --body` with a few bullet points. The Story Spine narrative makes PRs reviewable without reading the diff.

**Structured PRs and issues**: Use `npx tsx src/cli-section-editor.ts` to read/write named `##` sections in PR bodies and issue bodies. This avoids full body read/rewrite (saves tokens). Available commands: `list-sections`, `read-section`, `add-section`, `replace-section`, `remove-section`. When updating a PR body, prefer editing individual sections over rewriting the entire body.

**Plan storage**: Use `npx tsx src/cli-plan-store.ts` to store/retrieve plans, test plans, and YAML metadata on GitHub issues. Plans stored this way are auto-loaded by `reviewBattery()` for plan-dependent review dimensions. Store plans immediately after creating them — don't rely on context window persistence.

**PR review dimensions**: When running `/kaizen-review-pr`, bundle dimensions by shared data needs (use the briefing from `npx tsx src/cli-dimensions.ts briefing --lines N`). Don't spawn one agent per dimension — batch dims with identical `needs` into single agents.

## Configuration

All skills and hooks read `kaizen.config.json` from the host project root:

```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
```

## Development

```bash
npm install          # Install deps
npm run build        # Compile TypeScript
npm test             # Run TS tests
npm run test:hooks   # Run shell hook tests
```

## Testing — Behavioral vs Structural

Some things CANNOT be tested with unit tests or grep patterns:
- **SKILL.md / prompt changes** — the "code" runs inside Claude's context. The only real test is `claude -p` with the skill invoked in a `SyntheticProject`.
- **Issue routing / config-dependent behavior** — must be tested in a realistic host project context where `KAIZEN_REPO != HOST_REPO`.
- **Hook interaction flows** — must simulate the full event sequence, not just one hook in isolation.

Use `Garsson-io/kaizen-test-fixture` as the host repo for E2E tests. Never test against real user repos. See `src/e2e/setup-live.test.ts` and `src/e2e/issue-routing.test.ts` for patterns.

**Kaizen is a plugin for host projects.** Every skill, hook, and test must work when `KAIZEN_REPO != HOST_REPO` (host project mode), not just when they're equal (self-dogfood mode).

## The Three Levels

- **L1 (Instructions):** CLAUDE.md, SKILL.md, docs. No enforcement.
- **L2 (Hooks):** Automated checks that block actions. Deterministic.
- **L3 (Mechanistic):** Built into architecture. Can't be bypassed.

When L1 fails, escalate to L2. When L2 is bypassed, escalate to L3.

## Issue Routing (Three-Way)

Kaizen reflections produce three types of insights:
1. **Meta-kaizen** — improving kaizen itself → file in kaizen repo
2. **Host-kaizen** — improving the host project → file in host repo with `kaizen` label
3. **Generalized pattern** — reusable lesson → file in kaizen repo with `type:pattern` label
