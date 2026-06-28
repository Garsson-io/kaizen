<!-- BEGIN KAIZEN PLUGIN — managed by /kaizen-setup. Do not edit this section manually. -->

## Kaizen — Continuous Improvement

Kaizen is installed as an active Claude Code plugin. It provides enforcement hooks, reflection workflows, and dev workflow skills. Configuration lives in `kaizen.config.json`.

### Kaizen Skills

| Skill | When to Use |
|-------|-------------|
| `/kaizen-reflect` | Post-work reflection — classify impediments, file issues (Level 1→2→3) |
| `/kaizen-do` | Goal-driven workflow driver — sets `/goal`, then drives one issue/task through the full kaizen gates |
| `/kaizen-autodent` | inside-harness auto-dent — work one eligible sub-issue at a time through `/kaizen-do` when hooks are unavailable/provider-specific |
| `/kaizen-pick` | Select next kaizen issue — filters claimed, balances epic momentum vs diversity |
| `/kaizen-gaps` | Strategic analysis — tooling/testing gaps, horizon concentration, unnamed dimensions |
| `/kaizen-deep-dive` | Autonomous deep-dive — fix root cause category behind repeated issues |
| `/kaizen-audit-issues` | Periodic issue taxonomy audit — label coverage, epic health, incidents |

### Dev work skill chain — MUST follow this workflow

**Full workflow docs:** use `/kaizen-do` for the goal-driven workflow and `/kaizen-zen` for the operating philosophy. The plugin source of truth is the `Garsson-io/kaizen` repository.

Key triggers — activate the right skill for the user's intent:

- "gap analysis", "analyze gaps", "tooling gaps" → `/kaizen-gaps`
- "make a dent", "hero mode", "deep dive" → `/kaizen-deep-dive`
- "/kaizen-do <issue|task>", "work this ticket to completion" → `/kaizen-do`
- "inside-harness auto-dent", "hook-independent auto-dent", "work this parent issue through sub-issues" → `/kaizen-autodent`
- "what's next", "pick work", "pick a kaizen" → `/kaizen-pick`
- "look at issue #N", "evaluate this" → `/kaizen-evaluate`
- "lets do it", "go ahead", "build it", "ship it" → `/kaizen-implement`

### The Zen of Kaizen

Run `/kaizen-zen` to see the full commentary.

### Kaizen Policies

**Generic policies:** provided by the kaizen plugin — recursive kaizen, hooks infrastructure, worktree isolation, co-commit tests, smoke tests ship with feature.

**Host-specific policies:** [`.agents/kaizen/local/policies-local.md`](.agents/kaizen/local/policies-local.md) — project-specific enforcement rules.

### Verification Discipline

**Read the plugin's verification guidance** before writing fixes or tests. Covers: path tracing, invariant statements, runtime artifact verification, smoke tests.

### Kaizen Backlog

Future work is tracked as GitHub Issues. Every issue MUST have: `kaizen` + level (`level-1`/`level-2`/`level-3`) + area label.

<!-- END KAIZEN PLUGIN -->
