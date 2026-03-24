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
For each discovery: assess relevance to kaizen. If high-relevance, file an issue
with labels `source:ecosystem-research` and `kaizen`.

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

For each discovery:
1. File a GitHub issue in {{kaizen_repo}} with clear title and context
2. Label it `source:auto-dent-explore` and `kaizen`
3. Reference this exploration run in the issue body

Post a summary of all discoveries to the batch progress issue.

AUTO_DENT_PHASE: REFLECT | issues_filed=<N> | lessons=<what you discovered>
