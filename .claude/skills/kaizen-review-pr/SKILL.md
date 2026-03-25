---
name: kaizen-review-pr
description: Review PR — Deep Code Review with Learnable Criteria
user_invocable: true
---

# Review PR — Deep Code Review with Learnable Criteria

Structured review driven by data-driven dimensions (`prompts/review-*.md`). Each dimension is an adversarial check — run as a subagent, producing structured DONE/PARTIAL/MISSING findings. Learned failure modes in `.claude/kaizen/review-criteria.md` supplement the dimensions with FM-N patterns from past incidents.

The `pr-review-loop.sh` hook enforces that this review happens. This skill defines **how** to review.

**When to use:**
- Automatically triggered by `pr-review-loop.sh` after `gh pr create`
- Can also be invoked manually: `/kaizen-review-pr <pr-url>`
- Wired into `/kaizen-implement` as a mandatory task before merge

## The Review Process

### Phase 1: Gather Context

1. **Discover dimensions:** `npx tsx src/cli-dimensions.ts list` — these are the review rubric. Also load `.claude/kaizen/review-criteria.md` for supplementary learned failure modes (FM-N patterns).
2. **Read the diff:** `gh pr diff <pr-url>` — read every file, not just a summary.
3. **Read linked issues:** Check PR body, branch name, commits for `#N` or `kaizen#N`. If found, `gh issue view --repo "$ISSUES_REPO"` to understand requirements.
4. **Scan recent failure modes:** Check the "Learned Failure Modes" section of the criteria file. These are patterns from past incidents — watch for them specifically in this diff.

### Phase 2: Review Using Subagent Dimensions

**All review checks are dimensions.** Every dimension is a `prompts/review-*.md` file. All dimensions run — no skipping. Run `npx tsx src/cli-dimensions.ts list` to see what's available.

**Step 2a: Get the briefing.** Discover all applicable dimensions and their data needs:

```bash
npx tsx src/cli-dimensions.ts list
```

This shows every dimension, what data it needs (`diff`, `issue`, `pr`, `codebase`, `tests`), and which dimensions share data needs (natural grouping signal).

**Step 2b: Decide grouping.** You decide how to distribute dimensions across subagents. Use these signals:

- **Data overlap:** Dimensions needing the same data (`[diff, issue]`) are efficient to group — the subagent fetches once.
- **PR size:** Small PR → fewer agents, bundle more. Large PR → more agents, less per agent.
- **Issue risk:** Security-sensitive, auth changes, production-facing → more agents, consider redundancy (give a critical dimension to 2 agents independently).

Example groupings:

| PR context | Agents | Grouping |
|-----------|--------|----------|
| Tiny docs fix (10 lines) | 1 agent | All 7 dimensions in one pass |
| Normal bug fix (80 lines) | 2-3 agents | Agent 1: requirements + scope-fidelity + pr-description (need issue). Agent 2: logic + error-handling + test-quality (need diff). |
| Large feature (400 lines) | 4-5 agents | Smaller groups, 1-2 dimensions each |
| Security-sensitive | 5+ agents | Security dimensions get 2 independent agents for redundancy |

**Step 2c: Spawn subagents.** For each group, launch an Agent tool subagent with:
- The dimension prompt(s) from `prompts/review-*.md`
- The data it needs (pre-fetch `gh pr diff`, `gh issue view`, etc. and pass in the prompt)
- Instructions to output structured JSON findings per dimension

Launch independent subagents **in parallel** (multiple Agent tool calls in one message).

**Step 2d: Validate coverage.** After ALL subagents return, verify every dimension was reviewed. Call `validateReviewCoverage()` from `src/review-battery.ts` or manually check: does every dimension from the briefing have findings in the results?

**If any dimensions are MISSING from results** (subagent failed, timed out, or was forgotten): spawn replacement subagents for the missing dimensions. Do NOT proceed with incomplete coverage.

This is the gate: **you cannot move to Phase 3 until all dimensions have findings.**

**Each subagent must:**
- Read the full diff (not a summary)
- Read the dimension prompt assigned to it
- For each finding: cite the file, line, and which dimension it relates to
- Output structured JSON per the dimension's output format

### Phase 3: Filter and Classify

Collect all findings from subagents. Filter:
- **Drop** findings with confidence < 75
- **Classify** remaining as:
  - **MUST-FIX** (confidence ≥ 90): Blocks merge. Bugs, security issues, DRY violations with 3+ copies, missing tests for new execution paths.
  - **SHOULD-FIX** (confidence 75-89): Fix before merge. Minor DRY, testability improvements, pattern inconsistencies.

### Phase 4: Fix Loop

If MUST-FIX or SHOULD-FIX items exist:

1. **Fix each finding** — edit the code, add tests, extract helpers
2. **Commit and push** — one commit per logical fix, or batch related fixes
3. **Re-review from Phase 1** — read the new diff, re-run the criteria
4. **Repeat** until no findings remain or max rounds reached (3 rounds)

If issues remain after 3 rounds, escalate (see below).

### Phase 5: Verdict

When no MUST-FIX or SHOULD-FIX items remain:

```
REVIEW PASSED — N rounds, M findings fixed
```

## Requirements Verification

Before declaring the review passed, also check:

- **Linked issue requirements:** List every requirement from the linked issue. Mark each as DONE, PARTIAL, or MISSING.
- **If MISSING:** Implement now, or explicitly note "deferred to follow-up: [reason]"
- **Documentation:** If hooks/CI/workflows/policies changed, update the relevant docs (CLAUDE.md, skills, README). See criteria §8.

## What This Review Does NOT Check

- Build/typecheck — CI handles this
- Formatting/linting — CI handles this
- Pre-existing issues on lines not modified in this PR
- Stylistic preferences not in the criteria file

## Escalation

After 3 review rounds with remaining MUST-FIX issues:

1. Comment on the PR:
   ```
   gh pr comment <url> --body "@aviadr1 Code review hit 3 rounds. Remaining MUST-FIX issues: [list]. Need human eyes."
   ```
2. Do NOT merge until escalation is resolved.

## Updating the Criteria

When this review (or a kaizen reflection) discovers a new failure pattern:

1. Add it to `.claude/kaizen/review-criteria.md` under "Learned Failure Modes"
2. Use the format: `### FM-N: title` / `Pattern:` / `Source:` / `Check:`
3. Commit the criteria update as part of the current PR or as a follow-up
4. The next review automatically picks up the new pattern

This is how the review system learns. Every incident that slips through becomes a check that prevents the next one.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Gather context + briefing | Discover dimensions (`npx tsx src/cli-dimensions.ts list`), read full diff, read linked issues, read plan from issue comments, load learned failure modes from `review-criteria.md` |
| 2 | Review (subagent dimensions) | Decide grouping using priority signals + data overlap + PR size. Spawn subagents for ALL dimensions. Validate coverage — all dimensions must have findings (`validateReviewCoverage()`). |
| 3 | Filter and classify findings | Drop confidence < 75. MUST-FIX ≥ 90 (blocks merge). SHOULD-FIX 75-89 (fix before merge). |
| 4 | Fix loop (max 3 rounds) | Fix each finding, commit+push, re-review from task #1. Repeat until clean or 3 rounds. If still unclean at round 3: escalate to human. |

**Hooks enforcing review:**
- `pr-review-loop-ts.sh` — state machine tracking review rounds
- `enforce-pr-review-ts.sh` → `enforce-pr-review.ts` — blocks non-review commands, edits, and subagents during review
- `kaizen-stop-gate.sh` → `stop-gate.ts` — unified stop gate (blocks stop with any pending gate)

**What comes next:** After review is clean → merge (squash). After merge → `/kaizen-reflect` is mandatory (stop hook blocks without it). See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for full workflow.
