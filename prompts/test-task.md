You are running a synthetic test task for pipeline validation.

Run tag: {{run_tag}}

## Task

1. Create a new branch from HEAD: `test-probe-{{run_tag_slug}}`
2. Create a file `test-probe-{{timestamp}}.md` with this content:
   ```
   # Test Probe
   Run tag: {{run_tag}}
   Timestamp: {{iso_now}}
   ```
3. Commit with message: "test: probe {{run_tag}}"
4. Create a PR: `gh pr create --title "test: probe {{run_tag}}" --body "Synthetic test task for pipeline validation. Run tag: {{run_tag}}" --repo {{host_repo}}`
5. Leave auto-merge to the harness.

Do not ask for confirmation. Complete all steps.

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

When done, follow the shared harness terminal protocol from the goal-forcing contract.
