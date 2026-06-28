Use /kaizen-deep-dive with this guidance: {{guidance}}

Run tag: {{run_tag}}
Include this run tag in any PR descriptions or commit messages you create.

## Batch Context

You are running inside an auto-dent batch loop (run {{run_context}}).
After this run completes, the loop will start another run with fresh context.
Run to completion. Do not ask for confirmation — make autonomous decisions.

{{goal_forcing_contract}}

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

{{#cross_batch_steering}}
## Cross-Batch Steering (from prior batches)

Earlier auto-dent batches recorded structured outcomes on GitHub. Analyzing them
surfaced these steering signals — weigh them when choosing what to work on and how:

{{cross_batch_steering}}

These reflect what worked and what didn't across batches, not just this one.
{{/cross_batch_steering}}

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
- **FINISH:** when your planned lifecycle is complete, let the shared harness terminal protocol govern summary, STOP, and progress-marker evidence.
