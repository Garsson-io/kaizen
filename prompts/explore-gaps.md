You are running an EXPLORATION run inside an auto-dent batch (run {{run_context}}).
Your job is NOT to fix issues. Your job is to DISCOVER problems and FILE issues.

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

## Exploration Tasks

Pick the highest-value exploration from this list:

1. **Tooling gaps**: What tools or skills are missing from the kaizen system?
   Run `gh issue list --repo {{kaizen_repo}} --state open --label kaizen` and look for
   patterns that suggest missing capabilities.

2. **Testing gaps**: What's untested? Look for files with no corresponding test file.
   Check `scripts/` and `src/hooks/` for uncovered code.

3. **Horizon blind spots**: Which horizons have no recent activity?
   Check `docs/horizons/README.md` and compare against recent issues/PRs.

4. **External ecosystem**: Use WebSearch to find relevant repos, techniques, or tools
   that could benefit the kaizen system. Look for agent frameworks, batch automation
   patterns, or autonomous development approaches.

5. **Issue backlog analysis**: Read the oldest 20 open issues. Are any obsolete?
   Are there clusters that suggest an unnamed problem dimension?

## Output

For each discovery:
1. File a GitHub issue in {{kaizen_repo}} with clear title and context
2. Label it `source:auto-dent-explore` and `kaizen`
3. Reference this exploration run in the issue body

Post a summary of all discoveries to the batch progress issue.

AUTO_DENT_PHASE: REFLECT | issues_filed=<N> | lessons=<what you discovered>
