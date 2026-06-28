---
name: cross-pr-dry
description: History-aware DRY/refactor/simplify review for mechanism drift across merged PRs and adjacent codebase paths.
applies_to: reflection
needs: [multiple_prs, git-history, codebase]
high_when:
  - "Recent merged PRs repeatedly touched the same mechanism family"
  - "A shared helper exists but adjacent code still writes a local wrapper or direct shell/comment path"
  - "Multiple telemetry, formatter, parser, or GitHub I/O contracts coexist without an owner"
low_when:
  - "Only one concrete evidence location exists"
  - "The apparent duplication is deliberately separate and documented"
---

Your task: Review cross-PR/codebase DRY drift for {{repo}}.

This review runs in reflection context. It is not a normal PR diff review. Use the deterministic dry-sweep context as evidence, then decide whether the candidates represent actionable duplication/drift or acceptable separation.

## Dry-Sweep Context

{{dry_sweep_context}}

## Review Dimension: Cross-PR DRY

Find mechanism drift that single-PR review misses:

- repeated wrappers around GitHub CLI, subprocesses, comments, parsers, validators, formatters, or telemetry envelopes
- direct comments competing with marker-comment attachments
- local schema or event envelope variants that should share one contract
- cleanup candidates where deletion/unification is better than another additive feature

## Instructions

1. Treat every finding as a candidate unless it has concrete file/line evidence.
2. Prefer existing shared mechanisms over new abstractions.
3. Name the unification target when one exists.
4. Distinguish true drift from acceptable specialized helpers.
5. Do not prescribe a broad rewrite. Recommend the smallest cleanup issue or PR that would reduce future drift.

## Output Format

```json
{
  "dimension": "cross-pr-dry",
  "summary": "<one-line assessment>",
  "findings": [
    {
      "requirement": "<mechanism family or candidate>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<evidence, judgment, suggested unification target, and smallest next cleanup>"
    }
  ]
}
```

Rules for status:
- DONE: No actionable cross-PR DRY drift. Existing separation is justified.
- PARTIAL: Candidate drift exists but should be tracked/advisory until more evidence appears.
- MISSING: Clear duplicated mechanism or competing source of truth exists and should be consolidated.
