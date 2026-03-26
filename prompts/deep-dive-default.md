Use /kaizen-deep-dive with this guidance: {{guidance}}

Run tag: {{run_tag}}
Include this run tag in any PR descriptions or commit messages you create.

## Batch Context

You are running inside an auto-dent batch loop (run {{run_context}}).
After this run completes, the loop will start another run with fresh context.
Run to completion. Do not ask for confirmation — make autonomous decisions.

{{#issues_closed}}
Issues already addressed in previous runs (do not rework): {{issues_closed}}
{{/issues_closed}}

{{#prs}}
PRs already created in this batch (avoid overlapping work): {{prs}}
{{/prs}}

{{#reflection_insights}}
## Batch Reflection Insights

Prior mid-batch reflection produced these insights. Use them to guide your work:

{{reflection_insights}}

Factor these insights into your issue selection and approach.
{{/reflection_insights}}

{{#contemplation_recommendations}}
## Strategic Recommendations (from contemplation)

A prior contemplation run assessed this batch strategically and recommends:

{{contemplation_recommendations}}

Weight these recommendations when choosing what to work on.
{{/contemplation_recommendations}}

{{#plan_assignment}}
## Assigned Work

The batch planner has pre-selected this issue for you:

{{plan_assignment}}

Start with this issue. If you complete it and have capacity, proceed to
the next item from the guidance. If the assigned issue is blocked or
already resolved, skip it and pick from the backlog as usual.
{{/plan_assignment}}

## Merge & Labeling Policy

After creating a PR, you MUST:

1. Queue it for auto-merge:
     gh pr merge <url> --repo {{host_repo}} --squash --delete-branch --auto
   Do NOT leave PRs open for manual review — this is an unattended batch.
   The harness will also attempt auto-merge as a safety net, but do it yourself first.

2. Explicitly close every issue this PR fixes:
     gh issue close <num> --repo {{host_repo}}
   Do this immediately after queueing auto-merge — do NOT rely on "Closes #N"
   keywords in the PR body, because GitHub only auto-closes issues that way
   when the PR targets the repository's default branch. Explicit close always works.

## Bridging Abstract Work to Concrete Steps

If your assigned item has `item_type: "decompose"`, or if leaf issues matching
the guidance are exhausted, bridge abstract work (epics, PRDs, horizons) to
concrete next steps before stopping:

1. **Scan epics**: `gh issue list --repo {{host_repo}} --label epic --state open`
2. **Scan PRDs**: `gh issue list --repo {{host_repo}} --label prd --state open`
3. **Read horizon docs**: Check `docs/horizons/*.md` for maturity axes with defined next levels
4. **Find undecomposed items**: Epics/PRDs with no concrete child issues filed
5. **Decompose the highest-value one**: Read the epic body or PRD doc, file 1-3
   concrete implementation issues, then implement the most actionable one

Emit the DECOMPOSE phase marker when breaking down an epic:
  AUTO_DENT_PHASE: DECOMPOSE | epic=#NNN | issues_created=#X,#Y,#Z

This is higher-value than stopping — advancing an epic by one concrete step
moves the strategic layer forward.

## Scope: plan first, then execute

**Before picking up any work, decide your scope for this run.** Look at the available issues and ask: are any of them the same root cause, same file, or naturally bundled? If yes, plan to handle them together in one PR or a small set of PRs — decide that now, upfront.

Once you start executing, **do not expand scope**. Finishing a PR is not a trigger to pick more work. The harness will restart with fresh context and updated state for the next run. Casually grabbing additional issues after completing your planned work is the failure mode — it creates a blind loop where each completion just pulls in more scope with no deliberate decision.

The right pattern:
- **PLAN:** assess available issues, decide what this run covers (one issue, or a deliberate bundle), state it explicitly
- **EXECUTE:** implement exactly what you planned
- **STOP:** when your plan is done, stop — the harness restarts

If all issues are genuinely exhausted (backlog empty, all remaining issues claimed or blocked, AND no epics/PRDs can be decomposed), include this marker in your final response:

AUTO_DENT_PHASE: STOP | reason=<reason>

For example: "AUTO_DENT_PHASE: STOP | reason=backlog exhausted — no more open issues matching 'hooks reliability'"
Only emit STOP when work is truly gone, not at the end of a normal run.

When done, summarize what was accomplished. List all PRs created, issues filed,
and issues closed with full URLs.

## Progress Markers

Throughout your work, emit structured progress markers so the harness can show
what you're doing. Place each marker on its own line. Format:

AUTO_DENT_PHASE: <PHASE> | key=value | key=value ...

Phases and their expected keys:

| Phase | When | Keys |
|-------|------|------|
| PICK | After selecting an issue | issue=<#NNN or URL>, title=<short title> |
| EVALUATE | After scoping the work | verdict=<proceed/skip/defer>, reason=<why> |
| IMPLEMENT | Starting implementation | case=<case-id>, branch=<branch-name> |
| TEST | After running tests | result=<pass/fail>, count=<number of tests> |
| PR | After creating a PR | url=<PR URL> |
| MERGE | After queuing auto-merge | url=<PR URL>, status=<queued/merged> |
| DECOMPOSE | After breaking down an epic/PRD | epic=<#NNN>, issues_created=<#X,#Y,#Z> |
| REFLECT | After reflection | issues_filed=<N>, issues_closed=<#A,#B,...>, lessons=<short summary> |

Example:
  AUTO_DENT_PHASE: PICK | issue=#472 | title=improve hook test DRY
  AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=clear spec, medium complexity
  AUTO_DENT_PHASE: IMPLEMENT | case=260323-1200-k472 | branch=case/260323-1200-k472
  AUTO_DENT_PHASE: TEST | result=pass | count=15
  AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/500
  AUTO_DENT_PHASE: MERGE | url=https://github.com/Garsson-io/kaizen/pull/500 | status=queued
  AUTO_DENT_PHASE: REFLECT | issues_filed=1 | lessons=shared helpers reduce test boilerplate

Emit these naturally as you complete each phase. Missing keys are fine — emit what you have.
