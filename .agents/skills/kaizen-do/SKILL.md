---
name: kaizen-do
description: One-command kaizen workflow driver. Use for "/kaizen-do <issue|task>" to set a literal /goal forcing function, then drive the full kaizen workflow through its gates until lifecycle completion.
triggers:
  - /kaizen-do
  - kaizen do
  - do kaizen
  - work this ticket to completion
depends_on:
  - kaizen-write-plan
  - kaizen-implement
  - kaizen-review-pr
  - kaizen-write-pr
user_invocable: true
---

# Kaizen Do — Goal-Driven Workflow Driver

`/kaizen-do <issue|task>` packages the existing kaizen workflow under the missing forcing function: a literal `/goal`.

Kaizen already has useful gates. This driver makes `/goal` keep pressure on the session until those gates are respected, instead of relying on the operator or agent to remember every step.

## First Action: Set `/goal`

Before doing any other work, set a literal goal directive:

```text
/goal Complete the full kaizen workflow for <ticket number, title, URL or task>. The goal is not complete until the applicable kaizen gates are respected or honestly deferred through existing gate mechanisms: ticket identity -> plan/test-plan gate -> worktree/case gate -> implementation with tests -> related-area DRY/refactor pass -> meet reality -> review/requirements/impact gates -> reflection gate -> PR/CI/merge/cleanup.
```

If the input is a GitHub issue, first fetch and name the ticket identity:

```bash
gh issue view <N> --repo "$ISSUES_REPO" --json number,title,url,state,labels
```

The `/goal` text must mention the ticket number, title, and URL. For non-issue tasks, name the task plainly and state the observable completion condition.

## Short Workflow

Use the active `/goal` to drive the workflow through this list:

1. **Ticket identity** — confirm issue number, title, URL, state, labels, and scope.
2. **Plan/test-plan gate** — retrieve or create a substantive stored plan and test plan with `/kaizen-write-plan`.
3. **Worktree/case gate** — create or enter a fresh case worktree from `origin/main`; bind the issue with `cli-issue-binding.ts`.
4. **Implementation with tests** — write RED tests first when behavior changes, implement, and keep source/tests co-committed.
5. **Related-area DRY/refactor pass** — sweep the area touched by the ticket for competing mechanisms, schemas, duplicated lifecycle text, drift, dead code, and avoidable surface area. Consolidate or delete what is in scope.
6. **Meet reality** — try the PR/workflow in the way a user or harness would experience it; observe outputs and side effects. Record whether the ticket goal changed in reality, not just whether tests passed.
7. **Review/requirements/impact gates** — run `/kaizen-review-pr`, fix findings, prove requirements coverage and impact.
8. **Reflection gate** — complete kaizen reflection through the existing hook mechanism.
9. **PR/CI/merge/cleanup** — write the PR with `/kaizen-write-pr`, wait for checks, merge when green, then clean the branch/worktree and verify issue closure.

The goal is incomplete while any applicable gate is pending. If a gate does not apply, say why in the status output or PR body. If work must stop early, use the existing honest deferral/gate mechanism rather than declaring the `/goal` complete.

## Status Calls

Use the reusable status CLI whenever you need to know what remains:

```bash
npx tsx scripts/kaizen-workflow-driver.ts status --issue <N> --repo "$ISSUES_REPO" --mode manual
```

When a skill, `/goal`, or auto-dent has evidence the CLI cannot infer from git/GitHub state, pass it through the same command:

```bash
npx tsx scripts/kaizen-workflow-driver.ts status --issue <N> --repo "$ISSUES_REPO" --mode manual \
  --dry-refactor "done: shared workflow driver reused" \
  --meet-reality "done: status output inspected"
```

Use this for progress updates, `/goal` status checks, auto-dent prompts, and review evidence. Do not hand-roll a second checklist in the skill or PR body.

## Refactor/DRY Rule

The related-area refactor pass is required, not optional cleanup. The question is:

> Did this work reduce competing mechanisms, schemas, and drift in the area it touched?

If yes, show the consolidation or deletion. If no, record the evidence for why the existing mechanisms were already unified and why additional refactor would be out of scope.

## Meet Reality Rule

Before declaring the goal complete, exercise the changed workflow and observe concrete outputs or side effects:

- CLI output, rendered prompt, hook response, status report, PR body, issue comment, artifact, or external state.
- For headless/auto-dent work, inspect the rendered prompt and lifecycle/status evidence the harness will see.
- For skill changes, include structural proof and live provider smoke when available; if the provider is unavailable, document the exact blocker and deterministic fallback proof.

Tests and reviews are necessary but not sufficient. The `/goal` completes only when reality matches the ticket's intended outcome.
