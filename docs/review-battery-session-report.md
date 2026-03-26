# Review Battery Session Report

Session date: 2026-03-24
Branch: `feat/review-battery` (PR #846)
Linear: ENG-6638

## 1. What We Built

### Architecture

The review battery is a subagent-based adversarial review system. It spawns independent `claude -p` agents that compare a PR (or plan) against its linked GitHub issue and produce structured findings in JSON format.

Core module: `/src/review-battery.ts` (386 lines)

**Data flow:**

```
Issue (gh issue view) + PR diff (gh pr diff)
        |
        v
  Prompt template (prompts/review-*.md)
  with {{variable}} substitution
        |
        v
  claude -p --model sonnet --output-format json
        |
        v
  parseReviewOutput() extracts JSON from markdown fences
        |
        v
  DimensionReview { dimension, verdict, findings[], summary }
        |
        v
  BatteryResult { dimensions[], verdict, missingCount, partialCount, costUsd, durationMs }
```

**Two review dimensions:**

1. `plan-coverage` (`prompts/review-plan-coverage.md`) -- compares a proposed plan against issue requirements before implementation starts. Used by `kaizen-evaluate` Phase 5.5.
2. `requirements` (`prompts/review-requirements.md`) -- compares a merged/open PR against issue acceptance criteria. Used by `kaizen-implement` Step 5b and the auto-dent post-run harness.

**Key types:**

- `FindingStatus`: `'DONE' | 'PARTIAL' | 'MISSING'`
- `ReviewFinding`: `{ requirement, status, detail }`
- `DimensionReview`: `{ dimension, verdict, findings[], summary }`
- `BatteryResult`: aggregated result with overall verdict, counts, cost, duration

**Policy constants (guide agent stop conditions, not code loops):**

- `MAX_FIX_ROUNDS = 3`
- `BUDGET_CAP_USD = 2.0`
- `PASSING_THRESHOLD = { maxMissing: 0 }` (PARTIAL findings are warnings, not blockers)

### The review-fix CLI tool

`/scripts/review-fix.ts` (430 lines) -- standalone CLI that runs the full review-fix cycle:

```
npx tsx scripts/review-fix.ts --pr <url> --issue <num> --repo <owner/repo> [--dry-run] [--resume]
```

Flow: REVIEW -> if pass, done -> if gaps, FIX (spawn fix agent) -> RE-REVIEW -> loop (max 3 rounds or $2 budget).

Features:
- **State persistence** to `.claude/review-fix/pr-<N>.json` after each phase. Supports `--resume` for crash recovery.
- **Merged PR detection**: when a PR is already merged, the fix prompt instructs the agent to create a follow-up branch from main rather than trying to checkout the (likely deleted) PR branch.
- **Prefetching**: issue body, PR body, PR diff, branch name, and merge state are all fetched once upfront rather than by each subagent.
- **Prompts via stdin**: avoids shell argument length limits on large diffs.

### Integration points

**Auto-dent harness** (`scripts/auto-dent-run.ts`, lines 1563-1606): After each run that produces a PR, the harness runs a requirements review. Results are:
- Logged to the run log file
- Posted as a PR comment (best effort)
- Recorded as `review_verdict` and `review_cost_usd` fields on the `RunCompleteEvent` in events.jsonl

The review is **advisory, not blocking**. A failing review does not prevent merge. This is a v1 design decision -- the signal needs more validation before it should block.

**kaizen-evaluate** (Phase 5.5): After plan formulation, agents run the plan-coverage review battery via the Agent tool. MISSING findings must be fixed before presenting the plan to the admin; PARTIAL findings are reviewed for intentional scope reductions.

**kaizen-implement** (Step 5b): After self-review passes, agents run the requirements review battery. MISSING/PARTIAL items are fixed before merging, up to 3 rounds. Budget cap: $2 per battery run.

## 2. Empirical Results

### The 5-PR validation campaign

Five PRs from the jolly-marsupial batch (36 runs, 25 PRs) were selected for validation:

| PR | Issue | Verdict | Findings | Cost | Key gap found |
|----|-------|---------|----------|------|---------------|
| #812 | #811 | PASS | 5 DONE | $0.13 | None -- clean fix of hook timing sentinel glob |
| #816 | #814 | FAIL | varied | $0.10-0.17 | CI sentinel timing issue |
| #803 | #790 | FAIL | varied | $0.10-0.17 | Missing CI lint for state-utils.sh deletion |
| #825 | #726 | PASS | varied | $0.10-0.17 | Clean -- deduplication of batch progress issues |
| #830 | #773 | FAIL | varied | $0.10-0.17 | Worktree-safe MERGE_HEAD detection gaps |

Aggregate numbers from the commit message: **27 total findings, 0 false positives (0% FP rate)**. Review cost: **$0.10-0.17 per PR**.

The state file for PR #812 (`/.claude/review-fix/pr-812.json`) provides the most complete data point. All 5 requirements were evaluated and marked DONE, with specific evidence cited for each (file names, line numbers, cross-references to related issues).

### What kinds of gaps it catches

From the commit messages and review findings, the system detects:

1. **Wrong issue links** -- PR claims to close an issue it doesn't fully address
2. **Silent scope reductions** -- PR defers work without filing follow-up issues or using "Relates to" instead of "Fixes"
3. **Unaddressed acceptance criteria** -- issue has 5 acceptance criteria, PR addresses 3
4. **Overclaiming with `Fixes`** -- using `Fixes #N` when `Relates to #N` would be more accurate (because the underlying problem is not fully resolved)
5. **Infrastructure without adoption** -- building a schema/parser that nothing uses (the "smoke detectors with no batteries" pattern, as seen in PR #832 vs issue #666 where a skill metadata schema was defined but 0/16 SKILL.md files adopted it)

### The zero false positive rate

The 0% false positive rate across 27 findings was achieved *without any tuning*. Two design elements contribute:

1. **Adversarial framing** in the prompt: "Assume the implementing agent did the minimum work to close the issue." This creates the right prior -- the reviewer looks for shortcuts rather than trying to be polite.
2. **Structured output format** with per-finding evidence requirements: "Quote file names and line numbers. 'Looks good' is not a finding." This forces the reviewer to ground each status in specific code evidence, which naturally filters out vague suspicions.

## 3. What We Learned During the Session

### runFixLoop() was YAGNI

The initial design included a programmatic `runFixLoop()` function that would orchestrate the review-fix-re-review cycle in code. This was removed. The insight: **the agent IS the loop**. For interactive skills, the SKILL.md instructions tell the agent to iterate up to MAX_FIX_ROUNDS times. For auto-dent, a single-pass advisory review is the right v1. The fix loop in `scripts/review-fix.ts` exists only for the standalone CLI tool, where there is no enclosing agent to act as the loop.

This came from a `/loop` discussion -- the question was whether the fix iteration should be a code-level loop or an agent-level instruction. The answer: agent-level, because the agent has context the code doesn't (e.g., "this gap is out of scope for this PR" is a judgment call, not a boolean).

### Mustache syntax bug in plan-coverage template

The initial plan-coverage template used `{{#plan_text}}...{{/plan_text}}` conditional blocks. But `loadReviewPrompt()` only does simple `{{var}}` substitution via regex replace, not full mustache parsing. The conditional markers leaked through into the rendered prompt. Fixed in commit `ac59afb`.

### Fix sessions cannot run nested inside another claude session

When the review-fix tool tried to spawn a fix session (via `claude -p`) from within an interactive claude session, it hit ETIMEDOUT errors. The claude CLI doesn't support nested invocations cleanly -- the inner session can't connect to the API server because the outer session holds resources. This means `review-fix.ts` must be run as a standalone CLI tool, not from within an agent session.

### Merged PRs need follow-up branch instructions

When validating against jolly-marsupial batch PRs, many were already merged. Trying to `git checkout <branch>` on a deleted branch fails. The fix prompt was updated to detect merged PRs and instruct the fix agent to create a follow-up branch from main instead.

### Prompts overflow CLI arg limits

Passing the review prompt as a CLI argument (`claude -p "..."`) hit shell argument length limits on large diffs. Switched to passing via stdin: `spawnSync('claude', ['-p', ...], { input: prompt })`.

### Review timeouts on large diffs

The default 120s timeout was insufficient for PRs with large diffs (e.g., PR #832 with its schema definitions). Increased to 180s for the review-fix tool. The auto-dent integration keeps the 120s default since it runs as part of a budget-constrained batch.

## 4. The Methodology Shift

### Empirical validation before merging

Aviad pushed for empirical validation before merging -- not just "the tests pass" but "does it actually catch real gaps on real PRs?" The session followed a dry-run -> triage -> live-run -> iterate cycle:

1. **Build the core module** with unit tests for the parser and formatter
2. **Run a smoke test** against PR #832 (known to have gaps from the jolly-marsupial batch) to verify end-to-end flow
3. **Build the CLI tool** and run `--dry-run` on 5 batch PRs to see the review output without executing fixes
4. **Triage the findings** manually to determine false positive rate
5. **Iterate** on the prompt and tool based on what broke (timeouts, nested sessions, merged PRs, stdin vs args)

### Batch data informed the design

The jolly-marsupial batch (36 runs, 25 PRs, 21 issues filed, 8 issues closed) provided the test corpus. Without this batch running first, there would have been no PRs to validate against. The batch's `state.json` at `/home/aviadr1/projects/kaizen/logs/auto-dent/jolly-marsupial/state.json` lists all 25 PRs and 21 filed issues -- this is the dataset the review battery was validated against.

### The "agent IS the loop" insight

The initial spec called for a programmatic fix loop. The `/loop` discussion revealed that this was wrong for the interactive case: when an agent is running `kaizen-implement`, it already has the full context of the issue, the plan, the code changes, and the review findings. A code-level loop would need to re-establish all that context on each iteration. The agent can just... keep going. The policy constants (`MAX_FIX_ROUNDS`, `BUDGET_CAP_USD`) are stop conditions for the agent, not loop counters for code.

For the standalone CLI (`review-fix.ts`), a code-level loop makes sense because there is no enclosing agent. Each round spawns a fresh `claude -p` session.

### State persistence for resilience

After hitting timeouts and nested-session failures, state persistence was added to `review-fix.ts`. After each phase (review or fix), the state is written to `.claude/review-fix/pr-<N>.json`. The `--resume` flag picks up from the last saved state, so a crash doesn't lose work.

## 5. What This Changes

### For auto-dent

Every PR produced by an auto-dent run now gets an advisory review with structured findings. The findings are:
- Printed to the run log with color-coded status lines
- Posted as a PR comment so humans see gaps before merging
- Recorded in events.jsonl for trend analysis

This means batch operators can now see, at a glance, which auto-dent PRs actually address their linked issues and which just "build infrastructure without using it."

### For interactive skills

Agents using `kaizen-evaluate` now have a plan-coverage gate (Phase 5.5) that catches plan gaps before implementation starts. Agents using `kaizen-implement` have a requirements-coverage gate (Step 5b) that catches implementation gaps before merge. Both have clear stop conditions: fix up to 3 rounds, then escalate to human.

### For the kaizen project

The review battery adds a new quality signal: **does the PR actually solve the stated problem?** This is different from code review (which checks if the code is correct) and CI (which checks if the code works). The review battery checks if the correct, working code addresses the right requirements.

The gap between "tests pass" and "requirements met" is now visible. PR #832 is the canonical example: it added a valid JSON schema parser for SKILL.md frontmatter, all tests passed, code review was clean -- but 0 of 16 SKILL.md files actually used the new schema. The underlying problem (no skill metadata) was not solved.

### Cost model

At $0.10-0.17 per review using `--model sonnet`, the review battery is cheap enough to run on every PR. For auto-dent batches averaging ~$3-4 per run, the review adds 3-5% overhead. The $2 budget cap on fix loops prevents runaway costs.

## 6. Open Questions and Next Steps

### Fix sessions need standalone execution

The ETIMEDOUT issue with nested `claude -p` calls means `review-fix.ts` cannot be called from within an agent session via the Agent tool. For now, the fix loop is only available as a standalone CLI. The interactive skills (kaizen-evaluate, kaizen-implement) use the agent itself as the loop -- the review findings are presented to the agent, which then decides how to fix them.

A possible future path: the Agent tool could support "background" subagent execution that doesn't compete with the parent session for API resources.

### Should review-fix become a skill?

The review-fix CLI tool could be wrapped as a `/kaizen-review-fix` skill. The question is whether this adds value over the existing Step 5b in `kaizen-implement`. The CLI tool is useful for batch operations and one-off retroactive reviews of merged PRs. A skill would make it discoverable inside interactive sessions.

### Review cost in budget calculations

Currently, review cost is tracked in events.jsonl (`review_cost_usd`) but not included in the run's cost budget. If the review battery causes a run to exceed its budget, the excess is invisible. Should the review cost count against the run budget? Or should it be tracked separately as "quality assurance overhead"?

### Should failed reviews block merge in auto-dent?

Currently the review is advisory. A failing review is logged, posted as a comment, and recorded in events -- but the PR still gets merged if it passes CI and code review. Making it blocking would require:
1. Higher confidence in the 0% FP rate (27 findings is a small sample)
2. A mechanism for human override (not all gaps are bugs -- some are intentional scope reductions)
3. Integration with the auto-dent merge flow (currently `queueAutoMerge` doesn't check review results)

The conservative approach: keep advisory for 2-3 more batches, measure FP rate, then decide.

### Expanding review dimensions

Only `requirements` is wired into auto-dent and implement. `plan-coverage` is wired into evaluate but hasn't been exercised in production yet. Future dimensions could include:
- `test-coverage`: does the PR test what the issue asked for, not just what the code does?
- `scope-creep`: does the PR change things the issue didn't ask for?
- `follow-up-hygiene`: does the PR file follow-up issues for deferred work?

## Files

| File | Purpose |
|------|---------|
| `/src/review-battery.ts` | Core module: types, parsing, prompt loading, spawning, battery orchestration, formatting |
| `/src/review-battery.test.ts` | 18 unit tests (parser, formatter, template loading) + 3 replay tests (gated) |
| `/prompts/review-plan-coverage.md` | Plan-coverage review prompt template |
| `/prompts/review-requirements.md` | Requirements-coverage review prompt template |
| `/scripts/review-fix.ts` | Standalone CLI for review-fix cycle with state persistence |
| `/scripts/auto-dent-run.ts` | Auto-dent integration (lines 1563-1606) |
| `/scripts/auto-dent-events.ts` | RunCompleteEvent type with review_verdict and review_cost_usd |
| `/.claude/skills/kaizen-evaluate/SKILL.md` | Phase 5.5: plan-coverage review |
| `/.claude/skills/kaizen-implement/SKILL.md` | Step 5b: requirements-coverage review |
| `/.claude/review-fix/pr-812.json` | Sample state file from validation campaign |

## 7. Decision Framework: Criteria Section vs Independent Dimension

### The Two Review Mechanisms

The review system has two fundamentally different execution paths:

1. **Criteria sections** (in `.claude/kaizen/review-criteria.md`): Loaded into the reviewing agent's context as instructions. The same agent that implemented the code reads and applies them. Cost: zero marginal (already in session). Trust: low (the implementing agent reviews its own work).

2. **Independent dimensions** (in `prompts/review-*.md`): Spawned as separate `claude -p` subagents. Fresh context, no access to the implementing agent's reasoning. Cost: $0.10-0.20 per dimension. Trust: high (adversarial, cannot be gamed).

### Decision Criteria

Use this decision tree to determine where a review check belongs:

```
Is the check about CODE QUALITY (patterns, style, structure)?
  → YES → Criteria section (the implementing agent can self-check)

Is the check about REQUIREMENTS FIDELITY (did the PR solve the right problem)?
  → YES → Independent dimension (needs adversarial framing, issue context)

Does the check need EXTERNAL CONTEXT the code review doesn't have?
  (issue body, acceptance criteria, plan text, PR description narrative)
  → YES → Independent dimension (the context is the input)

Can the implementing agent game the check by writing code that
  technically passes but misses the point?
  → YES → Independent dimension (adversarial separation is the value)

Is the check DETERMINISTIC (regex, AST, grep)?
  → YES → Neither. Build a detector in src/analysis/ instead.
  → Detectors are free, un-gameable, and testable with synthetic scenarios.

Is the check a PATTERN from a past incident (FM-N)?
  → YES → Criteria section (cheap, broad coverage, grows over time)
  → Exception: if the pattern requires issue-level context, make it a dimension.
```

### Cost-Benefit Analysis

| Mechanism | Cost per PR | Trust | Context | Best for |
|-----------|-------------|-------|---------|----------|
| Criteria section | $0 | Low (self-review) | Code diff only | Code quality, patterns, style |
| Independent dimension | $0.10-0.20 | High (adversarial) | Code + issue + plan | Requirements, scope, narrative |
| Deterministic detector | $0 | Highest (code) | AST/regex | Shell injection, stale refs, DRY |

### Budget Guidance and Presets

**Target budget per PR: $0.30-0.50** (3 dimensions at $0.10-0.17 each).

Recommended presets:

| Preset | Dimensions | Cost | When |
|--------|-----------|------|------|
| `quick` | `requirements` only | ~$0.13 | Auto-dent advisory, tiny PRs (<20 lines) |
| `standard` | `requirements` + `pr-description` | ~$0.26 | Normal PRs, interactive kaizen-implement |
| `thorough` | `requirements` + `pr-description` + `plan-coverage` + future dimensions | ~$0.40-0.65 | Large PRs (>300 lines), security-sensitive, multi-issue PRs |

The `plan-coverage` dimension applies at evaluate time (before implementation), not at PR review time. It should not be in the PR review presets but rather triggered by `kaizen-evaluate` Phase 5.5.

Upper bound: **5 dimensions at $0.17 = $0.85**. Beyond 5 dimensions, diminishing returns set in -- the incremental value of a 6th adversarial reviewer is low compared to improving the first 3 prompts.

### Section-by-Section Recommendation for review-criteria.md

| # | Section | Recommendation | Rationale |
|---|---------|---------------|-----------|
| 1 | DRY | **Keep as criteria** | Code-structural check. The implementing agent can grep for duplicates. Partially covered by FM-3 detector. |
| 2 | Testability | **Keep as criteria** | Code-structural check. "Can this function be tested without I/O?" is answerable from the diff alone. |
| 3 | Testing | **Keep as criteria** | Code-structural check. "Does every exported function have a test?" is diff-answerable. |
| 4 | Testing Harness / E2E | **Keep as criteria, add future dimension** | The "does a trigger-to-outcome test exist?" question is partly structural (criteria) and partly requirements-level ("did the issue ask for E2E coverage?"). Today: keep as criteria. Future: a `test-coverage` dimension that cross-references issue requirements against test files would be high-value. |
| 5 | Tooling Fitness | **Keep as criteria** | Code-structural. "Is there a library for this?" requires codebase knowledge the implementing agent already has. |
| 6 | Security | **Keep as criteria, invest in detectors** | Shell injection and unquoted variables are better caught by deterministic detectors (regex on `execSync` calls with template literals, unquoted `$VAR` in .sh files). The criteria section provides LLM judgment for cases detectors miss. Do NOT make this a dimension -- security review needs full diff context that a $0.13 sonnet call may not handle deeply enough. |
| 7 | Reuse & Patterns | **Keep as criteria** | Code-structural. Overlaps heavily with DRY (section 1). Consider merging sections 1 and 7 into a single "DRY & Reuse" section. |
| 8 | Best Practices | **Keep as criteria** | Grab-bag of code quality checks. These are cheap self-review items. |
| FM-1 to FM-12 | Learned Failure Modes | **Keep as criteria** | These are pattern-matching checks against the diff. They grow over time and are free to evaluate. The deterministic subset (FM-8, FM-9, FM-10, FM-11, FM-12) already have detectors in `src/analysis/`. |

### Existing Dimensions: Keep or Restructure?

| Dimension | File | Recommendation |
|-----------|------|---------------|
| `requirements` | `review-requirements.md` | **Keep as dimension**. This is the highest-value adversarial check. It catches "correct code, wrong problem" -- something self-review cannot detect because the implementing agent has already convinced itself the code is right. |
| `plan-coverage` | `review-plan-coverage.md` | **Keep as dimension**. Used at evaluate time, not PR review time. Needs issue context the code review doesn't have. |
| `pr-description` | `review-pr-description.md` | **Keep as dimension**. Narrative quality assessment benefits from fresh eyes. The implementing agent wrote the description and cannot objectively judge whether it tells the story well. |

### Recommended New Dimensions (Future)

| Dimension | Value | Priority |
|-----------|-------|----------|
| `scope-creep` | Does the PR change things the issue didn't ask for? Catches gold-plating and drive-by refactors that expand risk surface. | High -- cheap to build, high signal |
| `test-coverage` | Does the PR test what the issue asked for, not just what the code does? Cross-references issue acceptance criteria against test assertions. | Medium -- high value but needs the implementing agent to have written tests first |
| `follow-up-hygiene` | Does the PR file follow-up issues for deferred work? Catches silent scope reductions. | Low -- partially covered by `requirements` dimension already |

### Summary Decision Rule

**If it can be answered by reading the diff alone, it belongs in criteria. If it requires comparing the diff against an external artifact (issue, plan, PR description), it belongs in a dimension. If it can be answered by a regex, it belongs in a detector.**

The criteria file is the "what good code looks like" rubric. Dimensions are the "did this code solve the right problem?" adversarial checks. Detectors are the "is this pattern present in the diff?" automated scanners. All three work together -- they are not substitutes for each other.
