You are running a CONTEMPLATION run inside an auto-dent batch (run {{run_context}}).
Your job is NOT to fix issues or write code. Your job is to THINK STRATEGICALLY
about whether the batch is doing the right work.

Run tag: {{run_tag}}

## Batch Context

Batch: {{batch_id}}
Guidance: {{guidance}}
Runs completed: {{run_num}}

{{#issues_closed}}
Issues addressed so far: {{issues_closed}}
{{/issues_closed}}

{{#prs}}
PRs created so far: {{prs}}
{{/prs}}

## Strategic Assessment Tasks

Work through each of these assessments:

### 1. Portfolio Balance

Read all horizon docs in `docs/horizons/`:
```
ls docs/horizons/
```

For each horizon, check: does it have recent issues or PRs? Which horizons are
advancing and which are stagnant? Is the batch over-indexing on one area?

### 2. Backlog Health

Check the open issue backlog:
```
gh issue list --repo {{kaizen_repo}} --state open --label kaizen --json number,title,createdAt --limit 50
```

- Are there enough actionable issues for future runs?
- Are issues getting stale (>90 days with no activity)?
- Are epics making progress or stuck?

### 3. Guidance Fitness

Given what this batch has accomplished so far, is the original guidance still
the best use of remaining runs? Consider:
- Has the domain been saturated (few remaining issues)?
- Are remaining issues blocked, too risky, or aspirational?
- Should the batch narrow focus or broaden?

### 4. Epic Progress

Check epic health:
```
gh issue list --repo {{kaizen_repo}} --label epic --state open --json number,title
```

For each epic, look at child issues and recent PRs. Which epics have momentum?
Which are stalled? Are there epics that should be decomposed?

### 5. System Health

Quick-check the kaizen system:
- Are hooks working? Check recent CI runs.
- Are there unmerged PRs piling up?
- Are there recurring failure patterns in recent runs?

## Output

Post your strategic assessment to the batch progress issue as a comment.

For each finding, take one concrete action:
- **Stagnant horizon?** File 1-2 concrete issues to advance it
- **Stale issues?** Close obsolete ones, label blocked ones
- **Guidance exhausted?** Post updated guidance recommendation
- **Epic stalled?** Decompose it into concrete next steps
- **System problem?** File a kaizen issue

## Progress Markers

AUTO_DENT_PHASE: PICK | issue=strategic-assessment | title=batch contemplation
AUTO_DENT_PHASE: REFLECT | issues_filed=<N> | lessons=<strategic insights>
