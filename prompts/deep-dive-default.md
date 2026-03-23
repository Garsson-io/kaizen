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

## Merge & Labeling Policy

After creating a PR, you MUST queue it for auto-merge:
  gh pr merge <url> --repo {{host_repo}} --squash --delete-branch --auto
Do NOT leave PRs open for manual review — this is an unattended batch.
The harness will also attempt auto-merge as a safety net, but do it yourself first.

## Stopping the Loop

If you determine there is no more meaningful work to do matching the guidance
(backlog exhausted, all relevant issues claimed, or remaining issues are
blocked/too risky), include this exact marker in your final response:

AUTO_DENT_PHASE: STOP | reason=<reason>

For example: "AUTO_DENT_PHASE: STOP | reason=backlog exhausted — no more open issues matching 'hooks reliability'"
This will gracefully stop the batch loop. Only use this when you've genuinely
run out of work — not when a single run is complete.

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
| REFLECT | After reflection | issues_filed=<N>, lessons=<short summary> |

Example:
  AUTO_DENT_PHASE: PICK | issue=#472 | title=improve hook test DRY
  AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=clear spec, medium complexity
  AUTO_DENT_PHASE: IMPLEMENT | case=260323-1200-k472 | branch=case/260323-1200-k472
  AUTO_DENT_PHASE: TEST | result=pass | count=15
  AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/500
  AUTO_DENT_PHASE: MERGE | url=https://github.com/Garsson-io/kaizen/pull/500 | status=queued
  AUTO_DENT_PHASE: REFLECT | issues_filed=1 | lessons=shared helpers reduce test boilerplate

Emit these naturally as you complete each phase. Missing keys are fine — emit what you have.
