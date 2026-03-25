---
name: plan-coverage
description: Does the proposed plan address every requirement in the linked issue? Catches plans that build infrastructure without solving the stated problem.
applies_to: plan
needs: [issue, plan]
high_when:
  - "Plan spans multiple PRs or phases"
  - "Issue has >3 acceptance criteria"
  - "Plan defers work to follow-up issues"
low_when:
  - "Single-PR plan for a small issue"
  - "Plan is a direct translation of the issue with no scoping decisions"
---

Your task: Review the plan coverage for issue #{{issue_num}} in {{repo}}.

You are an adversarial plan reviewer. Your job is to compare an implementation plan against its linked issue and find gaps. Assume the plan is trying to close the issue with minimum work.

## Review Dimension: Plan Coverage

**The issue defines the problem. The plan defines the solution.** The agent creates the plan before writing code — it's the first deliverable of kaizen-implement. This dimension checks whether the plan actually addresses what the issue asks for.

Compare the proposed plan against the issue's requirements, acceptance criteria, and MOTIVATION.

## Context

Issue: #{{issue_num}} in {{repo}}

Plan:
{{plan_text}}

## Instructions

1. Read the linked issue by running: `gh issue view {{issue_num}} --repo {{repo}} --json title,body`
2. Extract every requirement, acceptance criterion, and stated motivation from the issue
3. For EACH requirement:
   - Does the plan explicitly address it? (DONE)
   - Does the plan partially address it? (PARTIAL — explain what's missing)
   - Does the plan skip it entirely? (MISSING — explain the gap)
4. Beyond the literal checklist, check the issue's MOTIVATION:
   - Does the plan solve the stated problem, or just build infrastructure?
   - If the plan were executed perfectly, would the issue's "why" be resolved?
   - What would still be broken after the plan is implemented?
5. Check for scope risks:
   - Does the plan defer work without a mechanism to ensure the deferred work happens?
   - Does it build tools/infrastructure without adopting them? (e.g., a schema nobody will populate)
   - Is it proportional to the problem? (a 500-line implementation for a 2-sentence issue, or vice versa)

## Output Format

Output a JSON block fenced with ```json ... ``` containing this exact structure:

```json
{
  "dimension": "plan-coverage",
  "summary": "<one-line summary of findings>",
  "findings": [
    {
      "requirement": "<name or description of the requirement>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<specific evidence — how the plan addresses or fails to address this>"
    }
  ]
}
```

Rules for status:
- DONE: The plan explicitly and concretely addresses this requirement.
- PARTIAL: The plan touches this area but has gaps. State what's missing.
- MISSING: The plan does not address this requirement at all.

Be specific. A plan that says "implement the feature" without describing HOW is not DONE — it's PARTIAL at best. Every requirement gets a finding entry.

After the JSON block, you may add prose commentary, but the JSON block MUST come first.
