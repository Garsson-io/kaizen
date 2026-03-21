<!-- BEGIN KAIZEN PLUGIN — managed by /kaizen-setup. Do not edit this section manually. -->

## Kaizen — Continuous Improvement

Kaizen is installed as a plugin at `.kaizen/`. It provides enforcement hooks, reflection workflows, and dev workflow skills. Configuration in `kaizen.config.json`.

### Kaizen Skills

| Skill | When to Use |
|-------|-------------|
| `/kaizen-reflect` | Post-work reflection — classify impediments, file issues (Level 1→2→3) |
| `/kaizen-pick` | Select next kaizen issue — filters claimed, balances epic momentum vs diversity |
| `/kaizen-gaps` | Strategic analysis — tooling/testing gaps, horizon concentration, unnamed dimensions |
| `/kaizen-deep-dive` | Autonomous deep-dive — fix root cause category behind repeated issues |
| `/kaizen-audit-issues` | Periodic issue taxonomy audit — label coverage, epic health, incidents |

### Dev work skill chain — MUST follow this workflow

**Full workflow docs:** [`.kaizen/.claude/kaizen/workflow.md`](.kaizen/.claude/kaizen/workflow.md)

Key triggers — activate the right skill for the user's intent:

- "gap analysis", "analyze gaps", "tooling gaps" → `/kaizen-gaps`
- "make a dent", "hero mode", "deep dive" → `/kaizen-deep-dive`
- "what's next", "pick work", "pick a kaizen" → `/kaizen-pick`
- "look at issue #N", "evaluate this" → `/kaizen-evaluate`
- "lets do it", "go ahead", "build it", "ship it" → `/kaizen-implement`

### The Zen of Kaizen

Run `/kaizen-zen` to see the full commentary ([`.kaizen/.claude/kaizen/zen.md`](.kaizen/.claude/kaizen/zen.md)).

### Kaizen Policies

**Generic policies:** [`.kaizen/.claude/kaizen/policies.md`](.kaizen/.claude/kaizen/policies.md) — recursive kaizen, hooks infrastructure, worktree isolation, co-commit tests, smoke tests ship with feature.

**Host-specific policies:** [`.claude/kaizen/policies-local.md`](.claude/kaizen/policies-local.md) — project-specific enforcement rules.

### Verification Discipline

**Read [`.kaizen/.claude/kaizen/verification.md`](.kaizen/.claude/kaizen/verification.md)** before writing fixes or tests. Covers: path tracing, invariant statements, runtime artifact verification, smoke tests.

### Kaizen Backlog

Future work tracked as GitHub Issues. Issue taxonomy in [`.kaizen/docs/issue-taxonomy.md`](.kaizen/docs/issue-taxonomy.md). Every issue MUST have: `kaizen` + level (`level-1`/`level-2`/`level-3`) + area label.

<!-- END KAIZEN PLUGIN -->
