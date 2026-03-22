# Review PR — Deep Code Review with Learnable Criteria

Structured code review that reads the diff against concrete, modifiable criteria. The review criteria live in `.claude/kaizen/review-criteria.md` — a separate file that grows smarter as failure modes are discovered.

The `pr-review-loop.sh` hook enforces that this review happens. This skill defines **how** to review.

**When to use:**
- Automatically triggered by `pr-review-loop.sh` after `gh pr create`
- Can also be invoked manually: `/kaizen-review-pr <pr-url>`
- Wired into `/kaizen-implement` as a mandatory task before merge

## The Review Process

### Phase 1: Gather Context

1. **Read the review criteria:** Load `.claude/kaizen/review-criteria.md` — this is the rubric.
2. **Read the diff:** `gh pr diff <pr-url>` — read every file, not just a summary.
3. **Read linked issues:** Check PR body, branch name, commits for `#N` or `kaizen#N`. If found, `gh issue view` to understand requirements.
4. **Scan recent failure modes:** Check the "Learned Failure Modes" section of the criteria file. These are patterns from past incidents — watch for them specifically in this diff.

### Phase 2: Review Using Subagents

Launch review agents, each focused on one dimension from the criteria file. Each agent reads the diff and returns findings with confidence scores (0-100).

**Execution modes:**
- **Full review** (external/CI, or when invoked manually): Use parallel subagents for each dimension. Thorough but token-expensive.
- **Self-review** (during `/kaizen-implement` task #4): Run as a single agent that checks all dimensions sequentially. Cheaper, still thorough — you're reviewing your own code so context is already loaded.

**Agent assignments (for full review — in self-review, check all sequentially):**

| Agent | Criteria Section | What to check |
|-------|-----------------|---------------|
| DRY reviewer | §1 DRY | Copied blocks, patterns that exist elsewhere in codebase, test setup duplication |
| Testability reviewer | §2-4 Testability + Testing + Harness | Missing tests, tests that skip in CI, mock quality, E2E coverage |
| Tooling reviewer | §5 Tooling + §7 Reuse | Hand-rolled parsers, bash doing TS work, missing library reuse, existing patterns ignored |
| Security reviewer | §6 Security | Shell injection, unquoted variables, secrets, eval |
| Horizon reviewer | Learned Failure Modes | Every FM-N pattern from the criteria file checked against this specific diff |

**Each agent must:**
- Read the full diff (not a summary)
- Read the specific criteria section assigned to it
- For each finding: cite the file, line, and which criterion it violates
- Score confidence 0-100 using this scale:
  - **0-25:** Likely false positive or nitpick
  - **50:** Real issue but minor or unlikely in practice
  - **75:** Verified real issue, will impact functionality or maintainability
  - **100:** Certain issue, confirmed by evidence in the code

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
