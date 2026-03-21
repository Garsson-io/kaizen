# Dev Work Skill Chain

When the conversation involves **selecting, evaluating, or starting dev work**, activate the right skills in sequence. Do NOT jump straight to writing code.

## Host Configuration

All skills read `kaizen.config.json` from the host project root:
```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
KAIZEN_CLI=$(jq -r '.host.caseCli // ""' kaizen.config.json)
```

## Flow

```
User asks "where are the gaps", "analyze gaps", "what should we invest in"
  -> /kaizen-gaps  (strategic: tooling/testing gaps, horizon concentration, unnamed dimensions)
    -> produces: low-hanging fruit, feature PRD candidates, meta/horizon PRD candidates

User asks "make a dent", "hero mode", "fix the category", "deep dive", "autonomous fix"
  -> /kaizen-deep-dive  (autonomous: find root cause category, fix bugs, add interaction tests, ship PR)

User asks "what's next", "pick work", "pick a kaizen", "what should we work on"
  -> /kaizen-pick  (filter claimed issues, score by momentum/diversity, present options)

User discusses a specific issue, PR, case, or spec
  -> /kaizen-evaluate  (collision check, evaluate, find low-hanging fruit, get admin input)

User greenlights: "lets do it", "go ahead", "build it", "do it", "yes", etc.
  -> /kaizen-implement  (five-step algorithm, create worktree, then execute)

Work is large enough to need multiple PRs
  -> /kaizen-plan  (break into sequenced PRs with dependency graph)

Work is done
  -> /kaizen-reflect  (reflect on impediments, suggest improvements)
```

## Key Triggers to Recognize

- **Strategic gap analysis:** "gap analysis", "analyze gaps", "tooling gaps" -> `/kaizen-gaps`
- **Autonomous deep-dive:** "make a dent", "hero mode", "deep dive" -> `/kaizen-deep-dive`
- **Selecting work from backlog:** "pick a kaizen", "what's next", "find work" -> `/kaizen-pick`
- **Evaluating specific work:** "look at issue #N", "evaluate this" -> `/kaizen-evaluate`
- **Greenlighting work:** "lets do it", "go ahead", "build it", "ship it" -> `/kaizen-implement`
- **All dev work should be in an isolated worktree.** If the host has a case CLI (`$KAIZEN_CLI`), use it. Otherwise, create a plain git worktree.

## Issue Routing (Three-Way)

When reflecting (`/kaizen-reflect`), classify each impediment:

1. **Meta-kaizen** — about kaizen's own hooks/skills/policies -> file in `$KAIZEN_REPO`
2. **Host-kaizen** — about this specific host project -> file in `$HOST_REPO` with `kaizen` label
3. **Generalized pattern** — reusable lesson any project benefits from -> file in `$KAIZEN_REPO` with `type:pattern` label
