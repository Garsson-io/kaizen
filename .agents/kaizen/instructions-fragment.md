<!-- BEGIN KAIZEN PLUGIN — managed by /kaizen-setup. Do not edit this section manually. -->

## Kaizen — Continuous Improvement

Kaizen is installed as a Claude Code plugin and provides enforcement hooks, reflection workflows, and dev workflow skills. Project configuration is in `kaizen.config.json`. Everything below is reachable via skill names — you don't need to know where kaizen's source lives on disk.

### Kaizen Skills

| Skill | When to Use |
|-------|-------------|
| `/kaizen-reflect` | Post-work reflection — classify impediments, file issues (Level 1→2→3) |
| `/kaizen-pick` | Select next kaizen issue — filters claimed, balances epic momentum vs diversity |
| `/kaizen-gaps` | Strategic analysis — tooling/testing gaps, horizon concentration, unnamed dimensions |
| `/kaizen-deep-dive` | Autonomous deep-dive — fix root cause category behind repeated issues |
| `/kaizen-audit-issues` | Periodic issue taxonomy audit — label coverage, epic health, incidents |
| `/kaizen-zen` | Print the Zen of Kaizen — the philosophical principles |
| `/kaizen-write-plan` | Plan an issue before implementation (produces grounded plan + admin approval) |
| `/kaizen-implement` | Execute a plan — spec to working code |
| `/kaizen-review-pr` | Self-review checklist for your own PRs |
| `/kaizen-write-pr` | Compose a PR description using the Story Spine narrative |
| `/kaizen-sections` | Read/write structured sections in PR + issue bodies |

### Dev work skill chain — MUST follow this workflow

Full workflow documentation: [workflow.md](https://github.com/Garsson-io/kaizen/blob/main/.agents/kaizen/workflow.md).

Key triggers — activate the right skill for the user's intent:

- "gap analysis", "analyze gaps", "tooling gaps" → `/kaizen-gaps`
- "make a dent", "hero mode", "deep dive" → `/kaizen-deep-dive`
- "what's next", "pick work", "pick a kaizen" → `/kaizen-pick`
- "look at issue #N", "evaluate this" → `/kaizen-evaluate`
- "lets do it", "go ahead", "build it", "ship it" → `/kaizen-implement`

### The Zen of Kaizen

Run `/kaizen-zen` to see the full commentary. Source: [zen.md](https://github.com/Garsson-io/kaizen/blob/main/.agents/kaizen/zen.md).

### Kaizen Policies

Generic policies (recursive kaizen, hooks infrastructure, worktree isolation, co-commit tests, smoke tests ship with feature): [policies.md](https://github.com/Garsson-io/kaizen/blob/main/.agents/kaizen/policies.md).

Host-specific policies: [.agents/kaizen/local/policies-local.md](.agents/kaizen/local/policies-local.md) — add your project's own enforcement rules here.

### Verification Discipline

Read [verification.md](https://github.com/Garsson-io/kaizen/blob/main/.agents/kaizen/verification.md) before writing fixes or tests. Covers: path tracing, invariant statements, runtime artifact verification, smoke tests.

### Kaizen Backlog

Future work tracked as GitHub Issues. Issue taxonomy: [docs/issue-taxonomy.md](https://github.com/Garsson-io/kaizen/blob/main/docs/issue-taxonomy.md). Every issue MUST have: `kaizen` + level (`level-1`/`level-2`/`level-3`) + area label.

<!-- END KAIZEN PLUGIN -->
