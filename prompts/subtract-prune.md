You are running a SUBTRACTION run inside an auto-dent batch (run {{run_context}}).
Your job is NOT to add features. Your job is to REMOVE, CONSOLIDATE, and SIMPLIFY.

Run tag: {{run_tag}}

## Batch Context

Batch: {{batch_id}}
Guidance: {{guidance}}

{{goal_forcing_contract}}

{{#issues_closed}}
Issues already addressed in previous runs (do not rework): {{issues_closed}}
{{/issues_closed}}

{{#prs}}
PRs already created in this batch (avoid overlapping work): {{prs}}
{{/prs}}

{{#reflection_insights}}
## Batch Reflection Insights

{{reflection_insights}}
{{/reflection_insights}}

{{#contemplation_recommendations}}
## Strategic Recommendations (from contemplation)

{{contemplation_recommendations}}
{{/contemplation_recommendations}}

## Subtraction Tasks

Pick the highest-value subtraction from this list:

1. **Staleness audit**: Run the staleness audit to find obsolete issues:
   `npx tsx scripts/staleness-audit.ts --repo {{kaizen_repo}}`
   Review the report. Close issues recommended for closure with
   `gh issue close <num> --reason not-planned --comment "Obsolete: <reason>"`.
   Investigate issues flagged for investigation — check if the problem still exists.

2. **Duplicate issues**: Search for issues with overlapping titles or descriptions.
   Close duplicates with `gh issue close <num> --reason not-planned --comment "Duplicate of #X"`.

3. **Dead code**: Search for functions with no callers, files not imported anywhere.
   `grep -r "function " scripts/ src/ | ...` then check for references.
   Remove dead code in a PR with clear commit messages.

4. **Unused hooks**: Check `.claude/settings-fragment.json` for hooks that never trigger
   because their regex conditions can't match any real tool output.

5. **Overlapping skills**: Review `.agents/skills/` for skills that do
   similar things and could be consolidated.

## Chesterton's Fence

Before deleting anything, check the issue or PR that created it.
Every deletion must explain WHY in the commit message or close comment.
If you can't determine why something exists, leave it alone.

Use the shared harness terminal protocol for phase markers. In this mode,
`PICK` names the pruning target, `PR` names the PR when code changed, and
`REFLECT` records what was removed and why.
