---
name: kaizen-deep-dive
description: Autonomous deep-dive into a kaizen domain — find the root cause category behind repeated issues, create a meta-issue tying them together, then hand off to /kaizen-write-plan. Triggers on "make a dent", "hero mode", "deep dive kaizen", "fix the category", "autonomous fix".
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Make a Dent — Root Cause Discovery and Meta-Issue Creation

## Quick Reference

**Input:** Kaizen issue backlog (no specific issue needed — this skill finds what to work on)

**Output artifacts:** GitHub meta-issue (body = diagnosis) + metadata attachment
```bash
npx tsx src/cli-section-editor.ts write-attachment --issue {N} --repo "$ISSUES_REPO" --name metadata --file metadata.yaml
```
The meta-issue body IS the diagnosis artifact. No separate plan attachment — `/kaizen-write-plan` handles planning.

**Tasks:** Create at start via **TaskCreate** — 6 tasks (see Workflow Tasks table below)

**Tools used in this skill:**
- **TaskCreate** / **TaskUpdate** — progress tracking
- **Agent tool with `subagent_type=general-purpose`** (in parallel) — Phase 1: issue archaeology + code exploration
- Phases 0-4 are research only; no code changes, no PRs

**Flow:**
```
Phase 0: deconflict → Phase 1: map territory (parallel agents) → Phase 2: find category
→ Phase 3: create meta-issue → Phase 4: validate → Phase 5: hand off to /kaizen-write-plan
```

---

**Role:** The detective. When a cluster of kaizen issues share a root cause, this skill finds the category, maps the symptoms, and creates a well-structured meta-issue that ties them together. Then hands off to `/kaizen-write-plan` for planning and approval.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Compound interest is the greatest force in the universe"* and *"An enforcement point is worth a thousand instructions."*

**What this skill produces:** A single GitHub meta-issue with:
- The root cause pattern identified
- Concrete symptom issues linked
- A plan covering bug fixes AND category prevention tests
- Metadata attachment (structured data for `/kaizen-write-plan` to read)

**What this skill does NOT do:** Write code, run tests, create PRs, ship anything, or produce the implementation plan. After creating the meta-issue, it invokes `/kaizen-write-plan` which handles planning, grounding, and admin approval before implementation.

**When to use:**
- There's a cluster of related open kaizen issues (3+) with a shared root cause
- Individual fixes would be incremental; fixing the category has compound impact
- The user wants autonomous execution — "make it work, I'm counting on you"
- After `/kaizen-gaps` identifies a high-impact domain worth a deep dive

---

## Phase 0: WIP Deconfliction

Before selecting which domain to attack, map what other agents are doing.

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

**Choose your target from AVAILABLE domains only.**

**Priority override:** Check for `priority:critical` and `priority:high` issues first:
```bash
gh issue list --repo "$ISSUES_REPO" --state open --label "priority:critical" --json number,title,labels
gh issue list --repo "$ISSUES_REPO" --state open --label "priority:high" --json number,title,labels
```
If critical/high-priority issues exist in an AVAILABLE domain, prefer that domain.

---

## Phase 1: Map the Territory *(Research only — no code changes)*

Launch **two parallel agents using the Agent tool** to build a complete picture:

**Agent A — Issue Archaeology** (`subagent_type=general-purpose`):
```bash
gh issue list --repo "$ISSUES_REPO" --state open --limit 100 --json number,title,labels,body,comments
gh issue list --repo "$ISSUES_REPO" --state closed --limit 50 --json number,title,labels,body,closedAt
```
Classify each issue: is it a **symptom** (one-off bug) or a **root cause** (category-level problem)?

**Agent B — Code Exploration** (`subagent_type=Explore`):
Read the actual code in the target domain. Map the **interaction surface**: which components talk to each other? What format expectations cross boundaries? Where are the untested seams?

---

## Phase 2: Find the Category

From the research, identify:
1. **The pattern**: What type of bug keeps recurring?
2. **The root cause**: Why do individual fixes not prevent recurrence?
3. **The compound fix**: What changes fix the concrete bugs AND prevent the category?
4. **Category prevention tests**: What interaction/boundary tests would catch the next 10 bugs in this category?

---

## Phase 3: Create the Meta-Issue

Create a GitHub issue that serves as the diagnosis artifact for `/kaizen-write-plan`. The issue body IS the primary deliverable — no separate plan attachment needed here.

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

**Store metadata attachment** (read by `/kaizen-write-plan` Phase 1):
```bash
npx tsx src/cli-section-editor.ts write-attachment --issue {N} --repo "$ISSUES_REPO" --name metadata --file metadata.yaml
```

---

## Phase 4: Validate Plan Against User Request *(MANDATORY)*

**Before handing off**, cross-check the plan against what the user actually asked for.

For each item the user mentioned:
1. Is it in the plan as a **primary** work item (not a follow-up)?
2. If the user said "create X" or "build X", does the plan include building it?
3. Are all user-requested items in the issue's checklist?

**If any user request is missing from the plan**: add it before proceeding.

---

## Phase 5: Hand Off to `/kaizen-write-plan`

Invoke `/kaizen-write-plan` with the meta-issue number. It takes Path A (from deep-dive) and handles:
- Reading the meta-issue body + metadata artifact this skill produced
- Skipping incident gathering (already done here in Phase 1)
- Forming the grounded implementation plan (5-step process)
- Getting admin approval
- Handing off to `/kaizen-implement`

The deep-dive's job is done once the meta-issue exists and `/kaizen-write-plan` is invoked.

---

## Key Principles

1. **Research, don't implement.** This skill's value is finding the category and writing a good issue. The planning comes from `/kaizen-write-plan`.

2. **One PR, not five.** The bugs share a root cause — they belong together. The meta-issue makes this explicit.

3. **Prevention tests are requirements, not afterthoughts.** The meta-issue must specify what interaction/boundary tests to write.

4. **Be complementary, not competitive.** Check what other agents are working on (Phase 0) and pick an orthogonal domain.

5. **Validate against the user's ask.** The plan must cover everything the user asked for before handing off.

---

## Workflow Tasks

Create these tasks at skill start using **TaskCreate**:

| # | Task | Description |
|---|------|-------------|
| 1 | WIP deconfliction | Map worktrees, cases, PRs. Build occupied/available domain map. Choose target from available. |
| 2 | Map territory (parallel agents) | Agent A: issue archaeology. Agent B: code exploration. Run in parallel via Agent tool. |
| 3 | Find the category | Identify pattern, root cause, compound fix, prevention tests. |
| 4 | Create meta-issue | Write the issue body (diagnosis artifact). Store metadata attachment. |
| 5 | Validate against user request | Cross-check plan covers everything the user asked for. |
| 6 | Hand off to /kaizen-write-plan | Invoke /kaizen-write-plan with the meta-issue number (Path A). |

Mark each task **in_progress** before starting. Mark **completed** when done.

---

## Relationship to Other Skills

```
/kaizen-gaps          --> Identifies high-impact domains worth a deep dive.
                         Output: prioritized domain list.

/kaizen-deep-dive     --> THIS SKILL. Finds the root cause category,
  (this skill)            creates a meta-issue tying symptoms together.
                         Output: GitHub meta-issue body + metadata attachment.

/kaizen-write-plan    --> Takes the meta-issue (Path A), forms grounded plan,
                         gets admin approval.
                         Output: grounding attachment on issue.

/kaizen-implement     --> Execution engine. Reads grounding. Executes scope.
                         Output: merged PR, closed issues.
```
