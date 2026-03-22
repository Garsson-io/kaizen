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

AUTO_DENT_STOP: <reason>

For example: "AUTO_DENT_STOP: backlog exhausted — no more open issues matching 'hooks reliability'"
This will gracefully stop the batch loop. Only use this when you've genuinely
run out of work — not when a single run is complete.

When done, summarize what was accomplished. List all PRs created, issues filed,
and issues closed with full URLs.
