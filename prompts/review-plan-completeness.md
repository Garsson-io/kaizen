---
name: plan-completeness
description: Test-plan behaviors marked deferred must have open tracking issues; high deferral rates are scope-match warnings.
applies_to: pr
needs: [issue, plan, pr-body]
high_when:
  - "PR body or test plan contains ⏳ deferred behavior markers"
  - "PR claims partial test-plan coverage"
  - "PR changes review gates, hook-gym validation, or false-pass prevention"
low_when:
  - "The retrieved test plan has no behavior table and no deferred markers"
  - "Docs-only PR with no linked test plan behaviors"
---

Your task: Review test-plan behavior completeness for PR {{pr_url}} (issue #{{issue_num}} in {{repo}}).

You are enforcing kaizen invariant I27: if a behavior is in the test plan, it must either be implemented in this PR or have an explicit open tracking issue. A silent `⏳` deferral is a scope-match failure.

## Review Dimension: Plan Completeness

This dimension checks deferred behavior hygiene, not general test quality.

## Required Commands

1. Retrieve the linked issue's test plan:

   `npx tsx src/cli-structured-data.ts retrieve-testplan --issue {{issue_num}} --repo {{repo}}`

2. Read the PR body:

   `gh pr view {{pr_url}} --json body --jq .body`

3. For every behavior row or bullet marked `⏳`, extract tracking issue references like `#123` or `Garsson-io/kaizen#123`.

4. Verify each tracking issue exists and is open:

   `gh issue view <number> --repo {{repo}} --json state,title`

## Classification Rules

- `MISSING`: A `⏳` behavior has no tracking issue.
- `MISSING`: A `⏳` behavior references only closed or missing tracking issues.
- `DONE`: A `⏳` behavior references at least one open tracking issue.
- `DONE`: No behaviors are marked `⏳`.
- `PARTIAL`: More than 30% of behavior rows are marked `⏳`. This is a warning, not a failure by itself, because the PR may still have open tracking issues for each deferral.

If the test plan cannot be retrieved, return `MISSING` for "test plan is retrievable"; do not infer from the PR body alone.

## Output Format

Output a JSON block fenced with ```json ... ``` containing this exact structure:

```json
{
  "dimension": "plan-completeness",
  "summary": "<one-line assessment of deferred behavior completeness>",
  "findings": [
    {
      "requirement": "<specific behavior or completeness criterion>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<specific evidence: behavior text, tracking issue number, issue state, or deferral rate>"
    }
  ]
}
```

Rules for status:
- DONE: The criterion is fully met.
- PARTIAL: The criterion is warning-worthy but not merge-blocking by itself.
- MISSING: The criterion is not met and blocks review pass.

Every deferred behavior must produce a finding. Do not summarize several untracked deferrals into one vague finding.
