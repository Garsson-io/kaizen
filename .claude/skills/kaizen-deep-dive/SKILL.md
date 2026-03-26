---
name: kaizen-deep-dive
description: Autonomous deep-dive into a kaizen domain — find the root cause category behind repeated issues, create a meta-issue tying them together, then hand off to /kaizen-implement. Triggers on "make a dent", "hero mode", "deep dive kaizen", "fix the category", "autonomous fix".
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Make a Dent — Root Cause Discovery and Meta-Issue Creation

**Role:** The detective. When a cluster of kaizen issues share a root cause, this skill finds the category, maps the symptoms, and creates a well-structured meta-issue that ties them together. Then hands off to `/kaizen-implement` for execution.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Compound interest is the greatest force in the universe"* and *"An enforcement point is worth a thousand instructions."*

**What this skill produces:** A single GitHub meta-issue with:
- The root cause pattern identified
- Concrete symptom issues linked
- A plan covering bug fixes AND category prevention tests
- Structured data (plan, metadata, connected issues)

**What this skill does NOT do:** Write code, run tests, create PRs, or ship anything. After creating the meta-issue, it invokes `/kaizen-implement` which handles all of that.

**When to use:**
- There's a cluster of related open kaizen issues (3+) with a shared root cause
- Individual fixes would be incremental; fixing the category has compound impact
- The user wants autonomous execution — "make it work, I'm counting on you"
- After `/kaizen-gaps` identifies a high-impact domain worth a deep dive

## The Algorithm

### Phase 0: WIP Deconfliction

Before selecting which domain to attack, map what other agents are doing. Choosing a domain that overlaps with active work wastes effort and creates merge conflicts.

**Gather the WIP landscape:**
```bash
git worktree list
gh pr list --repo "$HOST_REPO" --state open --json number,title,headRefName
```

If `$KAIZEN_CLI` is configured:
```bash
$KAIZEN_CLI case-list --status active,backlog,blocked
```

**Build an occupied/available domain map:**
From worktrees, cases, and PRs, identify which broad domains have active work. Map each piece of WIP to a domain (deployment, hooks, worktree mgmt, testing, skills, CI, cases, etc.).

**Choose your target from AVAILABLE domains only.** The compound impact of a deep-dive is highest when it's orthogonal to all other active work.

**Priority override:** Check for `priority:critical` and `priority:high` issues first:
```bash
gh issue list --repo "$ISSUES_REPO" --state open --label "priority:critical" --json number,title,labels
gh issue list --repo "$ISSUES_REPO" --state open --label "priority:high" --json number,title,labels
```
If critical/high-priority issues exist in an AVAILABLE domain, prefer that domain.

### Phase 1: Map the Territory (Research, no code changes)

Launch **parallel research agents** to build a complete picture of the target domain:

**Agent A — Issue Archaeology:**
```bash
gh issue list --repo "$ISSUES_REPO" --state open --limit 100 --json number,title,labels,body,comments
gh issue list --repo "$ISSUES_REPO" --state closed --limit 50 --json number,title,labels,body,closedAt
```

Classify each issue: is it a **symptom** (one-off bug) or a **root cause** (category-level problem)?

**Agent B — Code Exploration:**
Read the actual code in the target domain. Map the **interaction surface**: which components talk to each other? What format expectations cross boundaries? Where are the untested seams?

### Phase 2: Find the Category

From the research, identify:
1. **The pattern**: What type of bug keeps recurring?
2. **The root cause**: Why do individual fixes not prevent recurrence?
3. **The compound fix**: What changes fix the concrete bugs AND prevent the category?
4. **Category prevention tests**: What interaction/boundary tests would catch the next 10 bugs in this category?

### Phase 3: Create the Meta-Issue

Create a GitHub issue that serves as the implementation spec. This is the primary deliverable of the deep-dive.

**Issue structure:**

```markdown
## Problem — The Pattern

[What type of bug keeps recurring, with concrete issue references]

## Root Cause

[Why individual fixes don't prevent recurrence]

## Concrete Bugs (Symptoms)

- [ ] #N — description
- [ ] #N — description
- [ ] #N — description

## Compound Fix

### Bug Fixes
[For each symptom: what to change and why]

### Category Prevention Tests
[Interaction tests at the boundary that catch the next N bugs in this category.
These are the compound interest — fixing 3 bugs is good, adding tests that
catch the next 10 is better.]

Examples:
- For gate/clear pairs: verify format compatibility across the boundary
- For allowlist hooks: verify every command needed for the workflow is allowed
- For state management: verify clearing one gate doesn't affect another

## Scope

- In this PR: [concrete list of all fixes + prevention tests]
- Deferred: [anything out of scope, with follow-up issue numbers]
```

**Store structured data on the issue:**
```bash
npx tsx src/cli-section-editor.ts write-attachment --issue {N} --repo "$ISSUES_REPO" --name plan --file plan.md
npx tsx src/cli-section-editor.ts write-attachment --issue {N} --repo "$ISSUES_REPO" --name metadata --file metadata.yaml
```

### Phase 4: Validate Plan Against User Request (MANDATORY)

**Before handing off**, cross-check the plan against what the user actually asked for. This catches the "filed issue instead of building it" failure mode.

For each item the user mentioned:
1. Is it in the plan as a **primary** work item (not a follow-up)?
2. If the user said "create X" or "build X", does the plan include building it?
3. Are all user-requested items in the issue's checklist?

**If any user request is missing from the plan**: add it before proceeding.

### Phase 5: Hand Off to `/kaizen-implement`

Invoke `/kaizen-implement` with the meta-issue number. It handles everything from here:
- Case creation with issue linking
- Plan storage (auto-loaded by `reviewBattery()`)
- TDD (failing tests first, including the category prevention tests)
- Implementation
- Review battery + fix loop
- PR creation with Story Spine narrative
- CI, merge, reflection, cleanup

The deep-dive's job is done once the meta-issue exists and `/kaizen-implement` is invoked.

## Key Principles

1. **Research, don't implement.** This skill's value is finding the category and writing a good issue. The code comes from `/kaizen-implement`.

2. **One PR, not five.** The bugs share a root cause — they belong together. The meta-issue makes this explicit so `/kaizen-implement` bundles them.

3. **Prevention tests are requirements, not afterthoughts.** The meta-issue must specify what interaction/boundary tests to write. This is what turns 3 bug fixes into compound interest.

4. **Be complementary, not competitive.** Check what other agents are working on (Phase 0) and pick an orthogonal domain.

5. **Validate against the user's ask.** The plan must cover everything the user asked for. Filing an issue is not the same as doing the work — but the deep-dive's job IS to file the issue, then hand off to the skill that does the work.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | WIP deconfliction | Map worktrees, cases, PRs. Build occupied/available domain map. Choose target from available. |
| 2 | Map territory (parallel agents) | Agent A: issue archaeology. Agent B: code exploration. |
| 3 | Find the category | Identify pattern, root cause, compound fix, prevention tests. |
| 4 | Create meta-issue | Write the issue with structured data. Store plan + metadata. |
| 5 | Validate against user request | Cross-check plan covers everything the user asked for. |
| 6 | Hand off to /kaizen-implement | Invoke implementation skill with the meta-issue number. |

## Relationship to Other Skills

```
/kaizen-gaps          --> Identifies high-impact domains worth a deep dive.
                         Output: prioritized domain list.

/kaizen-deep-dive     --> THIS SKILL. Finds the root cause category,
  (this skill)            creates a meta-issue tying symptoms together.
                         Output: well-structured GitHub meta-issue.

/kaizen-implement     --> Takes the meta-issue and builds it.
                         Case, plan, TDD, code, review, ship.
                         Output: merged PR, closed issues.
```
