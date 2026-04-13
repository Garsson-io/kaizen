# Kaizen — Continuous Improvement Plugin

Standalone Claude Code plugin for recursive process improvement. Works on any project.

<!-- agentsync:agent-config-layout:start -->
## Agent config layout

`.agents/` is the canonical source for shared instructions, skills, and commands in this project.

- Instructions: `.agents/AGENTS.md` is the canonical instructions file, and these `symlink` targets reflect it directly in `CLAUDE.md`, `.github/copilot-instructions.md`, `GEMINI.md`, `OPENCODE.md`, `AGENTS.md`.

- Skills: `.agents/skills/` is the canonical skills directory.
  - `.claude/skills` reflects `.agents/skills/` directly because this target uses `symlink`.
  - `.codex/skills` reflects `.agents/skills/` directly because this target uses `symlink`.
  - `.gemini/skills` reflects `.agents/skills/` directly because this target uses `symlink`.
  - `.opencode/skills` reflects `.agents/skills/` directly because this target uses `symlink`.

- Commands: `.agents/commands/` is the canonical commands directory, and `agentsync apply` populates command entries into `.claude/commands`, `.gemini/commands`, `.opencode/command`.

<!-- agentsync:agent-config-layout:end -->

## Quick Context

Kaizen provides enforcement hooks, reflection workflows, and dev workflow skills. Host projects configure via `kaizen.config.json`. Kaizen uses kaizen on itself (self-dogfood).

## Key Files

| File | Purpose |
|------|---------|
| `kaizen.config.json` | Self-dogfood config (kaizen repo points to itself) |
| `.agents/kaizen/zen.md` | Philosophy — run `/kaizen-zen` |
| `.agents/kaizen/policies.md` | Generic enforcement policies |
| `.agents/kaizen/workflow.md` | Dev work skill chain |
| `.agents/kaizen/verification.md` | Verification discipline |
| `.claude/hooks/` | All enforcement hooks (kaizen- prefixed) |
| `.claude/hooks/lib/` | Shared hook libraries |
| `.claude/hooks/tests/` | Hook test infrastructure |
| `src/hooks/` | TypeScript hooks |
| `src/hooks/lib/gate-manager.ts` | Unified stop gate — read/format/clear all pending gates |
| `src/hooks/stop-gate.ts` | Unified stop hook entry point (replaces 3 bash stop hooks) |
| `.claude/hooks/kaizen-worktree-setup.sh` | SessionStart hook — symlinks node_modules/dist from main repo into fresh worktrees; warns if `.worktree-will-delete` sentinel is present (worktree marked for deletion, #934) |
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
| `scripts/review-fix.ts` | CLI: review → fix → re-review cycle with state persistence and resume. `resolveStateDir(gitCommonDir)` stores state in the **main repo** (never inside a worktree) — survives worktree deletion (#929, #934) |
| `scripts/auto-dent-artifacts.ts` | Run artifact manifest + bundle — `buildRunManifest`, `writeRunManifest`, `bundleArtifacts` (auto-called at run completion) |
| `src/cli-dimensions.ts` | Dimension CLI: list/show/add/validate `prompts/review-*.md` files |
| `src/structured-data.ts` | **Structured data API**: reviews, plans, metadata, connected issues, PR sections, iteration state |
| `src/cli-structured-data.ts` | CLI for structured data — the primary interface for skills |
| `src/section-editor.ts` | Low-level: sections (## in bodies) + attachments (marker comments) — CRUD primitives |
| `src/plan-store.ts` | Plan-specific helpers (extractPlanText, re-exports from structured-data) |

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

**Structured data**: Use `npx tsx src/cli-structured-data.ts` as the primary interface for storing and retrieving structured data on PRs and issues. Key commands:
- Reviews: `store-review-finding`, `store-review-summary`, `list-review-rounds`, `read-review-finding`
- Plans: `store-plan`, `retrieve-plan`, `store-testplan`, `retrieve-testplan`
- Metadata: `store-metadata`, `query-connected`, `query-pr`
- PR sections: `update-pr-section --name "Validation" --text "..."`
- Iteration: `store-iteration`, `retrieve-iteration`

`store-review-finding` canonical payload:
`{"dimension":"correctness","verdict":"pass|fail","summary":"...","findings":[{"requirement":"...","status":"DONE|PARTIAL|MISSING","detail":"..."}]}`
Legacy fields are normalized (`status/result`, `item/description`, missing `findings`).

Store plans immediately after creating them. Review findings are stored per-round per-dimension (e.g., `review/r5/correctness`). Use `list-review-rounds` to count rounds mechanistically. For low-level section/attachment operations, use `cli-section-editor.ts`.

**PR review dimensions**: When running `/kaizen-review-pr`, bundle dimensions by shared data needs (use the briefing from `npx tsx src/cli-dimensions.ts briefing --lines N`). Don't spawn one agent per dimension — batch dims with identical `needs` into single agents.

**Codify learnings publicly, not just in memory**: Local auto-memory (`~/.claude/projects/.../memory/`) is per-machine and does NOT sync across devices. When an admin corrects you or teaches a rule, memory is the FIRST step, never the only step. You MUST also codify the learning in at least one visible artifact:
- **Durable rules** → add to this file (`.agents/AGENTS.md`) or a dedicated policy doc under `.agents/kaizen/`
- **Actionable bugs / follow-ups** → file a GitHub issue
- **Workflow changes** → update the relevant SKILL.md
Memory-only retention means the next session on a different machine repeats the same mistake.

### Branch & PR hygiene

- **Never push new commits to a branch whose most recent PR was already merged with no subsequent open PR.** Commits pushed to such a branch can get orphaned and the review-loop state file points at the merged PR, not the new work. Always create a new branch (via `EnterWorktree` or `git checkout -b`) for follow-up work.
- **Detect merged-branch state before pushing.** Run:
  ```bash
  gh pr list --repo <repo> --head <branch> --state all --json number,state --jq '.[0]'
  ```
  If the most recent PR is `MERGED` and there's no newer `OPEN` PR on the branch, you must branch off before pushing. If an `OPEN` PR already exists on the branch, pushing to extend it is fine (new round bump is correct).
- **If you accidentally pushed to a merged branch:** create a fresh branch from `main` (or from the merge commit), cherry-pick your new commits there, and open a new PR from the new branch.
- **Review round bumps on push within an open PR are intended.** Each push is new code and deserves fresh review; the previous round's pass is stale. Complete the new round before proceeding.

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
