# Dev Work Skill Chain

When the conversation involves **selecting, evaluating, or starting dev work**, activate the right skills in sequence. Do NOT jump straight to writing code.

## Host Configuration

All skills read `kaizen.config.json` from the host project root. See [skill-config-header.md](skill-config-header.md) for full details.
```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
ISSUES_REPO=$(jq -r '.issues.repo // .host.repo' kaizen.config.json)
KAIZEN_CLI=$(jq -r '.host.caseCli // ""' kaizen.config.json)
```

## Flow

```
User asks "where are the gaps", "analyze gaps", "what should we invest in"
  -> /kaizen-gaps  (strategic: tooling/testing gaps, horizon concentration, unnamed dimensions)
    -> produces: low-hanging fruit, feature PRD candidates, meta/horizon PRD candidates

User asks "make a dent", "hero mode", "fix the category", "deep dive", "autonomous fix"
  -> /kaizen-deep-dive  (autonomous: find root cause category, create meta-issue)
    -> hands off to /kaizen-write-plan #N

User discusses a specific issue, PR, case, or spec
  -> /kaizen-write-plan #N  (validate problem, gather incidents if needed, form grounded plan, admin approval)

User greenlights: "lets do it", "go ahead", "build it", "do it", "yes", etc.
  -> /kaizen-implement #N  (read grounding, enter worktree, TDD, PR, review loop, merge, cleanup)

Work is large enough to need multiple PRs
  -> /kaizen-plan  (break into sequenced PRs with dependency graph)

Work is done
  -> /kaizen-reflect  (reflect on impediments, suggest improvements)
```

## Task Tracking

Every skill creates tasks at start using TaskCreate. This gives the user progress visibility and prevents forgotten steps (review, reflection, cleanup). See [workflow-tasks.md](workflow-tasks.md) for the canonical task list for each skill, hook firing points, and the full dev workflow sequence diagram.

## Entry Point Decision Tree

```
Want autonomous category fix?               → /kaizen-deep-dive → /kaizen-write-plan #N
Have a specific issue number?               → /kaizen-write-plan #N
Plan approved by admin?                     → /kaizen-implement #N
Large work planned with sub-issues?         → /kaizen-implement for sub-issue #1
Need to define the problem first?           → /kaizen-prd → /kaizen-write-plan
Want strategic backlog analysis?            → /kaizen-gaps
Want to audit issue hygiene?                → /kaizen-audit-issues
```

## Key Triggers to Recognize

- **Strategic gap analysis:** "gap analysis", "analyze gaps", "tooling gaps" → `/kaizen-gaps`
- **Autonomous deep-dive:** "make a dent", "hero mode", "deep dive" → `/kaizen-deep-dive`
- **Planning specific work:** "write plan", "plan #N", "look at issue #N", "evaluate this", "should we do this", "what should we work on", "what's next" → `/kaizen-write-plan`
- **Greenlighting work:** "lets do it", "go ahead", "build it", "ship it" → `/kaizen-implement`
- **All dev work should be in an isolated worktree.** Use `EnterWorktree` (not `claude-wt`) to enter it.

## Issue Routing (Three-Way)

When reflecting (`/kaizen-reflect`), classify each impediment:

1. **Meta-kaizen** — about kaizen's own hooks/skills/policies -> file in `$KAIZEN_REPO`
2. **Host-kaizen** — about this specific host project -> file in `$HOST_REPO` with `kaizen` label
3. **Generalized pattern** — reusable lesson any project benefits from -> file in `$KAIZEN_REPO` with `type:pattern` label
