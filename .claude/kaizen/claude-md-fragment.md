<!-- BEGIN KAIZEN PLUGIN — managed by /kaizen-setup. Do not edit this section manually. -->

## Kaizen — Continuous Improvement

Kaizen is installed at `{{KAIZEN_ROOT}}`. It provides enforcement hooks, reflection workflows, and dev workflow skills. Configuration in `kaizen.config.json`.

### Kaizen Skills

| Skill | When to Use |
|-------|-------------|
| `/kaizen-reflect` | Post-work reflection — classify impediments, file issues (Level 1→2→3) |
| `/kaizen-gaps` | Strategic analysis — tooling/testing gaps, horizon concentration, unnamed dimensions |
| `/kaizen-deep-dive` | Autonomous deep-dive — find root cause category, create meta-issue, hand off to write-plan |
| `/kaizen-write-plan` | Planning gate — validate problem, gather incidents, form grounded plan, admin approval |
| `/kaizen-implement` | Execution engine — read grounding, worktree, TDD, PR, review loop, merge, cleanup |
| `/kaizen-audit-issues` | Periodic issue taxonomy audit — label coverage, epic health, incidents |

### Dev work skill chain — MUST follow this workflow

**Full workflow docs:** [`{{KAIZEN_ROOT}}/.claude/kaizen/workflow.md`]({{KAIZEN_ROOT}}/.claude/kaizen/workflow.md)

Key triggers — activate the right skill for the user's intent:

- "gap analysis", "analyze gaps", "tooling gaps" → `/kaizen-gaps`
- "make a dent", "hero mode", "deep dive" → `/kaizen-deep-dive` → `/kaizen-write-plan`
- "write plan", "plan #N", "look at issue #N", "evaluate this", "what should we work on", "what's next" → `/kaizen-write-plan`
- "lets do it", "go ahead", "build it", "ship it" → `/kaizen-implement`

### The Zen of Kaizen

Run `/kaizen-zen` to see the full commentary ([`{{KAIZEN_ROOT}}/.claude/kaizen/zen.md`]({{KAIZEN_ROOT}}/.claude/kaizen/zen.md)).

### Kaizen Policies

**Generic policies:** [`{{KAIZEN_ROOT}}/.claude/kaizen/policies.md`]({{KAIZEN_ROOT}}/.claude/kaizen/policies.md) — recursive kaizen, hooks infrastructure, worktree isolation, co-commit tests, smoke tests ship with feature.

**Host-specific policies:** [`.claude/kaizen/policies-local.md`](.claude/kaizen/policies-local.md) — project-specific enforcement rules.

### Verification Discipline

**Read [`{{KAIZEN_ROOT}}/.claude/kaizen/verification.md`]({{KAIZEN_ROOT}}/.claude/kaizen/verification.md)** before writing fixes or tests. Covers: path tracing, invariant statements, runtime artifact verification, smoke tests.

### Kaizen Backlog

Future work tracked as GitHub Issues. Issue taxonomy in [`{{KAIZEN_ROOT}}/docs/issue-taxonomy.md`]({{KAIZEN_ROOT}}/docs/issue-taxonomy.md). Every issue MUST have: `kaizen` + level (`level-1`/`level-2`/`level-3`) + area label.

<!-- END KAIZEN PLUGIN -->
