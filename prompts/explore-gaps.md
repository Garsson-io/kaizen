You are running an EXPLORATION run inside an auto-dent batch (run {{run_context}}).
Your job is NOT to fix issues. Your job is to DISCOVER problems and FILE issues.

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

## External Research Phase

Before running gap analysis, spend 5 minutes researching one external topic using WebSearch.
Rotate through these focus areas based on run number ({{run_num}} mod 6):

| run_num mod 6 | Topic |
|---------------|-------|
| 0 | "Claude Code skills ecosystem" — superpowers, awesome-claude-skills, Agent Skills standard |
| 1 | "Autonomous coding agents" — Devin, SWE-agent, OpenHands, Codex CLI architectures |
| 2 | "LLM observability platforms" — Langfuse, LangSmith, Arize Phoenix |
| 3 | "Experiment frameworks for AI" — autoresearch, DSPy, prompt optimization |
| 4 | "Agent architecture patterns" — hooks vs subagents, skill composition, multi-agent coordination |
| 5 | "Recursive self-improvement" — LessWrong, alignment forum, research papers |

Use WebSearch to find 2-3 relevant repos or articles for your assigned topic.
For each discovery: assess relevance to kaizen. If high-relevance, put it
through the Search-before-file gate below before filing or commenting.

## Exploration Tasks

Pick the highest-value exploration from this list:

1. **Tooling gaps**: What tools or skills are missing from the kaizen system?
   Run `gh issue list --repo {{kaizen_repo}} --state open --label kaizen` and look for
   patterns that suggest missing capabilities.

2. **Testing gaps**: What's untested? Look for files with no corresponding test file.
   Check `scripts/` and `src/hooks/` for uncovered code.

3. **Horizon blind spots**: Which horizons have no recent activity?
   Check `docs/horizons/README.md` and compare against recent issues/PRs.

4. **Issue backlog analysis**: Read the oldest 20 open issues. Are any obsolete?
   Are there clusters that suggest an unnamed problem dimension?

## Output

### Required artifact

Write a durable candidate-task manifest to:

`{{candidate_manifest_path}}`

This file is required even if you also file GitHub issues. It is the scouting
artifact the next exploit/subtract run can consume. Use this JSON shape:

```json
{{candidate_manifest_schema}}
```

Rules:
- Include every promising candidate you discovered, including candidates you did
  not file as issues.
- Use `suggested_mode` to describe how the next run should approach the candidate.
- Fill `dedup` for every candidate. A candidate without `dedup.query`,
  `dedup.matches`, `dedup.decision`, and `dedup.reason` is incomplete scouting.
- If no candidates exist, write `"candidates": []` and explain why in the run
  summary.
- A run that only files issues but writes no manifest is incomplete scouting.

### Search-before-file gate

Before filing any issue, run a targeted duplicate search using
`gh issue list --search` or `gh search issues`. Record the exact query and
relevant matches in the candidate's `dedup` object.

Use exactly one dedup decision per candidate:
- `file_new` - no strong existing match; file a new issue.
- `comment_existing` - a strong match exists; comment on the existing issue
  with the new evidence instead of filing a duplicate.
- `candidate_only` - promising but not worth filing or commenting yet; keep it
  in the manifest for future planning.

At most 2 candidates may use `file_new` in one explore run. Prioritize the two
highest-value genuinely new gaps. Extra discoveries should be `comment_existing`
or `candidate_only`.

For each discovery:
1. Search first and record the `dedup` decision in the manifest.
2. If `decision=file_new`, file a GitHub issue in {{kaizen_repo}} with clear
   title and context, label it `source:auto-dent-explore` and `kaizen`, and
   reference this exploration run in the issue body.
3. If `decision=comment_existing`, add the new evidence to the existing issue
   and do not file a duplicate.

Post a summary of all discoveries to the batch progress issue.

AUTO_DENT_PHASE: REFLECT | issues_filed=<N> | lessons=<what you discovered>
