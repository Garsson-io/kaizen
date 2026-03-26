---
name: reflection-quality
description: Gaming the kaizen gate — waiving all findings, generic reasons, filing trivial issues instead of fixing. The pattern that makes reflection theater instead of learning.
applies_to: reflection
needs: [reflection_history]
high_when:
  - "Most or all impediments in a reflection are waived or no-action"
  - "Waiver reasons are generic (overengineering, low-frequency, self-correcting)"
  - "Filed impediments are trivial fixes in already-touched files"
low_when:
  - "Reflection produced concrete action items with specific issue references"
  - "Waivers have specific, evidence-based justifications"
---

Your task: Analyze reflection quality for gaming patterns.

This review runs in reflection context — it has access to reflection history, not just a single diff. It catches process-level failure modes that single-PR review cannot see.

## Review Dimension: Reflection Quality

Two failure modes that turn reflection into theater:

**FM-10: Reflection Gaming / Generic Waivers**
Agent satisfies the kaizen gate with minimal effort: all findings waived/no-action, generic reasons like "overengineering"/"low frequency"/"self-correcting", or "filed" without an issue reference. The gate is passed but no learning occurs.

Detection signals:
- `KAIZEN_IMPEDIMENTS` with >50% waived/no-action
- Waiver reasons match the blocklist: "overengineering", "low frequency", "self-correcting", "out of scope"
- Impediment marked "filed" without a `ref` field pointing to an issue

**FM-12: Filing Trivial Issues Instead of Fixing**
Agent identifies a small fix during reflection (gitignore, unused import, config tweak, typo, 1-line change) but files it as a new issue instead of fixing it in the current PR. This creates unnecessary context-reload cost — the issue sits in the backlog, and the next session must re-learn the context to make a trivial change.

Detection signals:
- Filed impediment describes a fix that is < 10 lines and < 10 minutes of work
- Filed impediment targets files already touched in the PR
- Filed impediment uses trivial-fix keywords: "typo", "gitignore", "unused import", "rename", "add comment"

## Instructions

### Step 1: Analyze waiver ratio

From the reflection history:
- Count total impediments
- Count waived/no-action impediments
- Count impediments with generic waiver reasons
- Count "filed" impediments without issue references

If waived+no-action > 50% of total: flag as MISSING (FM-10).

### Step 2: Check waiver quality

For each waived impediment, evaluate the reason:
- **Good waiver**: Specific evidence why the fix would cause more harm than good, or why the finding is a false positive in this specific case
- **Bad waiver**: Generic rationale that could apply to any finding ("overengineering", "low frequency", "self-correcting", "out of scope")

Bad waivers are likely gaming. Flag them.

### Step 3: Check filed vs fixable

For each "filed" impediment:
- Is the described fix < 10 lines? Would it take < 10 minutes?
- Does it target files already modified in the PR?
- Does the description use trivial-fix keywords?

If yes to 2 of 3: flag as FM-12 (should have been fixed in-PR).

### Step 4: Assess learning signal

Does the reflection produce actionable learning?
- Are MISSING findings connected to concrete follow-up actions?
- Do filed issues have specific issue refs (not just "will file issue")?
- Is the root cause identified, or just the symptom described?

## Output Format

```json
{
  "dimension": "reflection-quality",
  "summary": "<one-line summary>",
  "findings": [
    {
      "requirement": "<waiver quality | trivial-filed-as-issue | learning signal>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<specific evidence: which impediment, what the waiver says, why it's gaming>"
    }
  ]
}
```

Rules for status:
- DONE: Waivers are specific and evidence-based. Filed issues are non-trivial. Reflection produces genuine learning.
- PARTIAL: Some waivers are generic, or 1-2 trivial items were filed instead of fixed.
- MISSING: >50% waivers with generic reasons, OR filed-instead-of-fixed for a trivial in-PR change.
