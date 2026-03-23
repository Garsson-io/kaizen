You are running a SUBTRACTION run inside an auto-dent batch (run {{run_context}}).
Your job is NOT to add features. Your job is to REMOVE, CONSOLIDATE, and SIMPLIFY.

Run tag: {{run_tag}}

## Batch Context

Batch: {{batch_id}}
Guidance: {{guidance}}

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

## Merge & Labeling Policy

After creating a PR, you MUST queue it for auto-merge:
  gh pr merge <url> --repo {{kaizen_repo}} --squash --delete-branch --auto

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

5. **Overlapping skills**: Review `.claude/kaizen/skills/` for skills that do
   similar things and could be consolidated.

## Chesterton's Fence

Before deleting anything, check the issue or PR that created it.
Every deletion must explain WHY in the commit message or close comment.
If you can't determine why something exists, leave it alone.

## Progress Markers

AUTO_DENT_PHASE: PICK | issue=<what you're pruning>
AUTO_DENT_PHASE: PR | url=<PR URL if code was removed>
AUTO_DENT_PHASE: REFLECT | issues_filed=<N> | lessons=<what you removed and why>
