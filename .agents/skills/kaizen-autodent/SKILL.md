---
name: kaizen-autodent
description: Inside-harness auto-dent workflow for hook-independent kaizen runs. Use when a parent/umbrella issue or explicit sub-issue list should be driven one eligible sub-issue at a time through /kaizen-do without relying on Claude-only hooks.
triggers:
  - /kaizen-autodent
  - inside-harness auto-dent
  - hook-independent auto-dent
  - run auto-dent inside this session
  - work this parent issue through sub-issues
depends_on:
  - kaizen-do
  - kaizen-write-plan
  - kaizen-review-pr
  - kaizen-write-pr
user_invocable: true
---

# Kaizen Autodent - Inside-Harness Auto-Dent

`/kaizen-autodent <parent/umbrella issue | sub-issue list | task>` packages the inside-harness auto-dent loop for providers and host repos where hooks may be absent, stale, provider-specific, or unavailable.

This skill is hook-independent. Hooks are helpful feedback, not proof. Authoritative proof comes from durable artifacts: GitHub issues and PRs, stored plans/test-plans, case/worktree state, commits, test output, review attachments, CI, merge state, reflection evidence, and the workflow gate ledger.

## First Action: Identify Scope

Read host configuration before GitHub calls:

```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
ISSUES_REPO=$(jq -r '.issues.repo // .host.repo' kaizen.config.json)
ISSUES_LABEL=$(jq -r '.issues.label // ""' kaizen.config.json)
```

Then classify the input:

| Input | Meaning | Next action |
| --- | --- | --- |
| parent/umbrella issue | Multi-issue campaign | Read parent body/comments and extract open sub-issues |
| sub-issue list | Explicit queue | Verify each issue state and collision status |
| single issue | One work item | Hand off directly to `/kaizen-do` |
| task text | No issue yet | File or select a scope-matched issue before implementation |

For every GitHub issue input, fetch identity:

```bash
gh issue view <N> --repo "$ISSUES_REPO" --json number,title,url,state,labels,body
```

## Loop Contract

Work one eligible sub-issue at a time.

1. Select one eligible sub-issue: open, unclaimed or intentionally taken over, not already fixed, and not blocked by dependency order.
2. Run `/kaizen-do <sub-issue>` for that selected issue. Do not inline or fork the per-ticket workflow.
3. Produce one scope-matched PR for that sub-issue.
4. Use `Fixes <sub-issue>` only for the sub-issue the PR fully resolves.
5. Do NOT close the parent epic from a child PR. Use `Parent: #<parent>` or `Refs: #<parent>` for parent linkage.
6. After merge, update the parent issue progress/current-state/next-step if the parent tracks sub-issue progress.
7. Continue to the next eligible sub-issue unless the parent is complete, the queue is exhausted, or the run reaches a documented blocked state.

If several issues share the same small code path and one PR is clearly more efficient, stop and run `/kaizen-plan` or update the parent plan first. Do not reactively bundle issues mid-implementation.

## Durable Artifact Table

Use this table to verify progress. It is a view over the shared workflow contract; it is not a second gate schema.

| Phase | Durable artifact |
| --- | --- |
| issue identity | issue number, title, URL, repo, state, labels, parent/sub-issue relationship |
| stored plan/test-plan | `retrieve-plan` and `retrieve-testplan` output for the selected sub-issue |
| worktree/case | branch, worktree path, case or worktree-scoped `kaizen.issue` binding |
| commits and tests | source/test commits plus command, result, count, and output source |
| related-area DRY/refactor | evidence that competing mechanisms/schemas/drift were reduced, or reason no refactor was warranted |
| meet-reality output | real CLI, hook, prompt, PR, status, or workflow output showing the behavior changed |
| review/requirements/impact | stored review findings, requirements verdict, impact proof, and fix-loop state |
| reflection evidence | durable reflection, issue/comment, or explicit no-action reason |
| PR/CI/merge/cleanup | PR URL, CI state, merge result, branch/worktree cleanup, issue closure |
| hook/provider activation | hook activation evidence when hooks are expected, or schema-valid external substitute evidence when hooks are unavailable |

## Shared Status

Use the shared workflow driver for status. Do not hand-roll another gate checklist.

```bash
npx tsx scripts/kaizen-workflow-driver.ts status --issue <N> --repo "$ISSUES_REPO" --mode manual
```

When the inside-harness loop has evidence the CLI cannot infer, pass it explicitly:

```bash
npx tsx scripts/kaizen-workflow-driver.ts status --issue <N> --repo "$ISSUES_REPO" --mode manual \
  --dry-refactor "done: reused /kaizen-do and workflow gate ledger" \
  --meet-reality "done: status output inspected" \
  --hook-provider-activation "not applicable: hook-independent run; durable external evidence used"
```

The canonical evidence contract is `docs/workflow-gate-ledger.md`. Producers and consumers must use that ledger shape instead of inventing ad hoc booleans, progress rows, or prompt-local lifecycle lists.

## Stop Conditions

The inside-harness loop may stop only at one of these states:

- parent complete: all intended sub-issues are closed or explicitly not applicable.
- no eligible sub-issue: all remaining issues are blocked, claimed, closed, or out of scope; update the parent with the reason.
- current sub-issue blocked: `/kaizen-do` status shows an honest blocked gate and the blocker is recorded durably.
- repair budget exhausted: auto-dent/ledger repair state says no further same-PR evidence repair is useful.

Do not stop merely because a PR exists. The selected sub-issue is incomplete until `/kaizen-do` has driven the applicable gates or recorded an honest blocked/not-applicable state.

## Related Issues Sweep

Before each PR body is finalized, search for closely related issues:

```bash
gh issue list --repo "$ISSUES_REPO" --state open --search "<key terms>" --json number,title,body --limit 15
```

For each result:

- Fully resolved by this PR: include `Fixes <issue>` only if it is scope-matched.
- Parent/umbrella relationship: include `Parent: #<parent>` or `Refs: #<parent>`, never a closing keyword.
- Partially addressed: add `Related: #<issue>` and comment on what remains.

## DRY Rule

This skill exists to coordinate a loop, not to redefine the kaizen lifecycle. Keep lifecycle mechanics delegated to:

- `/kaizen-do` for one-ticket execution.
- `scripts/kaizen-workflow-driver.ts status` for status output.
- `docs/workflow-gate-ledger.md` for the workflow evidence contract.
- `/kaizen-write-pr` for PR descriptions.

If this skill needs a new phase or gate, update the workflow gate ledger first and make the new skill consume it.
