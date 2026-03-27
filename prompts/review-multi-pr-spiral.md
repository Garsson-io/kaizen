---
name: multi-pr-spiral
description: Ship-then-fix spirals — 3+ PRs hitting the same area in a short window. The pattern that indicates iterating in production instead of validating before merge.
applies_to: reflection
needs: [multiple_prs, git_history]
high_when:
  - "Multiple fix PRs merged within 2 hours touching the same files"
  - "PRs referencing the same issue with titles all starting with fix:"
  - "Branch history shows rapid hotfix cycles in the same area"
low_when:
  - "Only one or two PRs in the area"
  - "PRs are planned incremental steps, not reactive fixes"
---

Your task: Analyze the PR history for ship-then-fix spirals.

This review runs in reflection context — it has access to multiple PRs and git history, not just a single diff. It catches the meta-pattern that single-PR review cannot see.

## Review Dimension: Multi-PR Spiral

Two failure modes that indicate iterating in production instead of validating before merge:

**FM-4: The 4-PR Pattern**
Agent ships a feature, then needs 2-4 follow-up PRs to fix bugs that testing would have caught. Each PR triggers reflection, but reflection doesn't prevent the next bug. The feature "worked" initially but had hidden defects discovered through production use.

**FM-11: Temporal Clustering**
3+ PRs merged within 2 hours touching the same files, referencing the same issue, or all titled "fix:". Indicates a fire-drill response rather than a planned fix.

## Instructions

### Step 1: Identify PR clusters

From the PR history, find any cluster where:
- 3+ PRs touch the same file(s)
- PRs reference the same issue number
- PRs are titled "fix:" and target the same area
- PRs were merged within a 2-hour window

For each cluster found: list the PRs, the files they touch, the issue they reference, and the time span.

### Step 2: Classify each cluster

For each cluster, determine:
- **Is this a spiral?** Did a feature PR create bugs that required hotfix PRs? Or were these planned incremental steps?
- **What test would have caught the initial bug?** State the specific assertion or test case that, if it existed, would have caught the bug before the first fix PR.
- **Did the reflection after each fix PR produce any learning?** Check if the impediments from the feature PR's reflection mentioned the root cause.

### Step 3: Root cause analysis

For the most significant spiral found:
- What was the original feature?
- What type of defect was introduced (logic error, missing edge case, incorrect assumption)?
- Was there a test gap that allowed the defect to ship?
- What would need to change in the development process to prevent recurrence?

## Output Format

```yaml
{
  "dimension": "multi-pr-spiral",
  "summary": "<one-line summary: N spirals found | no spiral pattern detected>",
  "findings": [
    {
      "requirement": "<PR cluster or pattern name>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<the spiral pattern, the PRs involved, the root cause, what test would have caught it>"
    }
  ]
}
```

Rules for status:
- DONE: No spiral detected. PRs in the same area are planned incremental steps.
- PARTIAL: A spiral pattern exists but the damage was limited (2 fix PRs, not 3+).
- MISSING: Full spiral detected — feature PR followed by 3+ fix PRs, or temporal clustering of 3+ fix PRs within 2 hours.

Every MISSING finding must name the specific test or validation that would have caught the original bug before the first fix PR was needed.
