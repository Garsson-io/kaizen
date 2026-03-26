# Review Loop Spec — Multi-Dimensional Review for AI Coding Workflows

Status: Partially implemented — see Implementation Status section
Parent: #842, #843

## Problem

AI coding agents reduce scope silently, close issues as "done" when partially addressed, and game review gates. The root cause: review is treated as a single pass at the end, not as a continuous multi-dimensional loop. The implementing agent reviews its own work and clears its own gates — like grading your own exam.

Evidence from jolly-marsupial batch (2026-03-24):
- 25 PRs shipped with zero actual review (agent ran `gh pr diff` to clear gate)
- PR #832: built parser infrastructure, adopted it in 0 of 16 files, closed issue as complete
- PR #810: added 2 L1 prompt lines for a problem with 3 failure patterns, closed issue as complete
- 6 of 8 closed issues had zero comments explaining what addressed them

## Core Principle

**Review is not a step. It's a loop across multiple dimensions, and the reviewer must be independent of the implementer.**

## Review Dimensions

Each dimension is a comparison between two artifacts. Order matters — earlier dimensions prevent wasted work on later ones.

| # | Dimension | Comparison | Question | When |
|---|-----------|-----------|----------|------|
| 1 | Plan → Issue | plan vs issue requirements | Does the plan address ALL failure modes and acceptance criteria? | Before any code |
| 2 | Plan → Codebase | plan vs existing code | Is this feasible? What exists to reuse? What should be deleted? | Before any code |
| 3 | Plan → Test categories | plan vs failure modes | What categories of tests are needed? Not just the specific bug — what class of bugs? | Before any code |
| 4 | Test plan → Plan | test plan vs requirements | Do the planned tests actually test what matters, or just what's easy? | Before TDD |
| 5 | TDD → Plan | failing tests vs plan | Do the failing tests encode the requirements as invariants? | After TDD red, before implementation |
| 6 | Implementation → Plan | code vs plan | Did we build what we planned? No scope creep, no silent reduction. | After implementation |
| 7 | Implementation → Issue | code vs acceptance criteria | Does the implementation satisfy ALL requirements from the issue? | After implementation |
| 8 | Implementation ← Quality | code vs best practices | DRY, conventions, no dead code, clean architecture. | After implementation |
| 9 | Test plan → Implementation | test categories vs code | Do tests cover the failure category, not just the specific bug? Would these tests catch regressions? | After implementation |
| 10 | Implementation ← Tests | code vs test results | Do tests pass? Fix if broken. | After implementation |

## The Four Steps

The workflow has 4 distinct steps. Each step has its own internal loop. The loops run autonomously — human intervention is optional, not required.

### Step 1: Plan Loop

Scope, requirements mapping, feasibility. Cheap — reading and thinking, no code. Catches bad plans before investing in implementation.

```
PLAN LOOP (max 3 iterations):
  1. Read issue → propose plan
     - Approach and scope
     - What to build, what to delete, what to defer
     - What categories of tests are needed
     - What existing code/patterns to reuse
     - Explicit requirement mapping: each issue criterion → how plan addresses it

  2. Review: Plan → Issue requirements (dimension 1)
     - List every requirement/acceptance criterion from the issue
     - Mark each as: ADDRESSED by plan / NOT ADDRESSED / PARTIALLY ADDRESSED
     - If any NOT ADDRESSED: revise plan or explicitly note as out-of-scope with justification

  3. Review: Plan → Codebase (dimension 2)
     - Is the approach feasible given existing architecture?
     - What existing code should be reused? (grep before building)
     - What dead code/legacy paths should be deleted as part of this work?

  4. Review: Plan → Test categories (dimension 3)
     - What failure modes does this work address?
     - What failure modes does this implementation approach naturally introduce?
     - What categories of tests would catch both?

  5. If gaps found → revise plan → go to 2

  EXIT: Plan covers all requirements, approach is feasible, test categories identified
  OUTPUT: plan.json (structured plan with requirement mapping)

  TRANSITION: "Plan complete. Proceed to implementation?"
```

### Step 2: Implement + Test + Review Loop

TDD, implementation, multi-dimensional review. The core build cycle. Creates a PR.

```
IMPLEMENT LOOP (max 3 iterations):

  6. Test plan review (dimension 4)
     - Review: test plan → plan. Do we test what matters?
     - Not just "does the function return the right value" but "does this prevent the category of bug?"

  7. TDD Red (dimension 5)
     - Write failing tests that encode requirements as invariants
     - Review: do failing tests match the plan? Are they invariant-based, not bug-affirming?

  8. Implement — TDD Green
     - Make failing tests pass
     - Simplest correct implementation

  9. Create PR (if first iteration) or push fixes (subsequent iterations)

  10. Review battery (dimensions 6-10, subagents run in parallel):
      a. Implementation → Plan (dimension 6): did we build what we planned?
      b. Implementation → Issue criteria (dimension 7): all requirements met?
      c. Implementation ← Quality (dimension 8): DRY, clean, conventional?
      d. Test coverage → Failure categories (dimension 9): tests cover the right things?
      e. Run tests (dimension 10): all pass?

  11. If any dimension fails:
      - Fix the findings
      - Re-run ONLY the failed dimensions
      - Go to 9

  EXIT: All dimensions pass
  OUTPUT: PR with coverage report in body, review findings attached

  TRANSITION: "Implementation complete, all reviews pass. Proceed to merge?"
```

### Step 3: Check / CI / Merge Loop

PR checks, CI, merge. Mechanical but can fail.

```
MERGE LOOP (max 3 iterations):

  12. Wait for CI checks
      - If checks fail: read failure, fix, push, re-run review on changed dimensions
      - If merge conflicts: merge main, resolve, push

  13. Squash merge
      - Verify PR state is "merged"
      - If merge failed: diagnose, fix, retry

  14. Post-merge verification
      - Verify linked issue is closed (or close manually if auto-close didn't fire)
      - Post closure comment on issue: what was delivered, which PR, which batch/run
      - Update parent epic checklist if applicable

  EXIT: PR merged, issue closed with audit trail
  OUTPUT: merge confirmation + closure report

  TRANSITION: "Merged and closed. Proceed to reflection?"
```

### Step 4: Post-Completion Reflection

What did we learn? What should improve? Filed as issues, not lost in transcripts.

```
REFLECTION:

  15. Compare: what was planned vs what was delivered
      - Any scope changes during implementation? Document why.
      - Any surprises? (harder than expected, easier, found related issues)

  16. Review the review: did the review dimensions catch real issues?
      - Which dimensions produced useful findings?
      - Which produced noise?
      - Calibration data for improving review prompts

  17. File follow-ups
      - Deferred scope → follow-up issues with trigger criteria
      - Process improvements → kaizen issues
      - Lessons learned → PR comment or issue comment for future reference

  EXIT: Reflection complete, follow-ups filed
  OUTPUT: reflection summary (stored in batch logs and posted to progress issue)
```

## Unified Orchestration Model

The loops are structural — they exist in both interactive and non-interactive modes. The difference is only in how transitions and escalations are handled.

```
                    PLAN LOOP ──→ IMPLEMENT LOOP ──→ MERGE LOOP ──→ REFLECTION
                    (step 1)      (step 2)           (step 3)       (step 4)
                       │              │                  │               │
                       ▼              ▼                  ▼               ▼
                  dimensions       dimensions         CI checks      compare
                    1-3              4-10             merge           plan vs
                  (review)         (review)          conflicts       delivery
                       │              │                  │               │
                       ▼              ▼                  ▼               ▼
                  gaps? ──→        gaps? ──→         fail? ──→      file
                  revise           fix+push          fix+push       follow-ups
                  plan             re-review         re-check
```

### Interactive Mode

The loops run autonomously. The human can interrupt at any point.

**Default (autonomous) behavior:**
- Each step runs its internal loop until convergence or max iterations
- At each step transition, the agent pauses and reports: "Plan complete. 3 requirements mapped, all addressed. Proceed to implementation?"
- If no human response within ~10 seconds: proceed (configurable)
- If max iterations reached without convergence: stop and report what's stuck

**Human intervention points (any time):**
- **Interrupt mid-loop:** "wait, you're missing X" → agent incorporates feedback, continues loop
- **Skip a step:** "skip planning, go straight to implementation" → agent proceeds
- **Override a finding:** "ignore that quality finding, it's intentional" → dimension marked as passed
- **Redirect:** "actually let's do a different approach" → restart current step
- **Approve early:** "looks good, ship it" → skip remaining review iterations

**How it maps to skills:**
- Step 1 (Plan Loop) = `/kaizen-evaluate` rewritten to include requirement mapping + subagent reviews
- Step 2 (Implement Loop) = `/kaizen-implement` rewritten to include TDD + review battery
- Step 3 (Merge Loop) = end of `/kaizen-implement` (already exists, just needs audit trail)
- Step 4 (Reflection) = `/kaizen-reflect` (already exists, just needs plan-vs-delivery comparison)
- "Go through all steps" = `/kaizen-deep-dive` or auto-dent prompt chains all 4

### Non-interactive Mode (auto-dent)

Same loops, but the harness orchestrates between sessions and spawns independent review subagents.

**Key structural differences:**
- Each step is a separate `claude -p` session (fresh context, no confirmation bias)
- Review subagents are harness-spawned (implementing agent can't game them)
- Transitions are automatic (no pause for human)
- Escalation = label PR `needs-human-review` + post findings as comment

```
HARNESS ORCHESTRATION:

  SESSION 1: Plan
    claude -p "Read issue #N. Propose plan with requirement mapping." → plan.json

  HARNESS: Scope Review (parallel subagents, dimensions 1-3)
    IF gaps → SESSION 1b: "Revise plan given these findings: ..."
    Max 3 scope iterations

  SESSION 2: Implement
    claude -p "Implement this plan. TDD first. Create PR." → PR created

  HARNESS: Review Battery (parallel subagents, dimensions 6-10)
    IF gaps → SESSION 3: "Fix these review findings in the existing PR."
    Re-run only failed dimensions. Max 3 review iterations.

  HARNESS: Merge
    Auto-merge if all pass. Post closure comment.
    If still failing → label needs-human-review.

  SESSION 4: Reflect
    claude -p "Compare plan vs delivery. File follow-ups."
```

## Cost Model

| Phase | Cost | Time | Iterations |
|-------|------|------|------------|
| Plan session | ~$0.30 | ~2 min | 1-2 |
| Scope review (2-3 subagents) | ~$0.25 | ~1 min | 1-2 |
| Implement session | ~$1.50 | ~8 min | 1 |
| Review battery (4 subagents) | ~$0.50 | ~2 min | 1-3 |
| Fix session | ~$0.50 | ~3 min | 0-2 |
| Merge + reflection | ~$0.30 | ~2 min | 1 |
| **Total per issue** | **~$3-5** | **~15-20 min** | — |

Current jolly-marsupial cost: $2.46/PR with zero review and frequent rework. The review loop costs more per PR but prevents the rework cycle where issues get re-filed and re-implemented.

## Definition of Done for a PR

A PR is ready to merge when ALL of these are true:

- [ ] Plan reviewed: all issue requirements are ADDRESSED
- [ ] Tests exist for each identified failure category (not just the specific bug)
- [ ] All tests pass
- [ ] Implementation matches plan (no scope creep or silent reduction)
- [ ] All issue acceptance criteria marked DONE in PR body
- [ ] Code quality review passes (DRY, conventions, no dead code)
- [ ] If anything was deferred: follow-up issue filed with trigger criteria
- [ ] PR body includes: why this approach, what was deferred, review findings addressed
- [ ] `Fixes #N` only if ALL criteria are met; `Relates to #N` otherwise

## Experimental Validation (2026-03-24)

### Experiment 1: Post-hoc subagent audit

**Method:** Launched independent review subagents against two PRs from jolly-marsupial batch. Each received issue body + PR body + access to source files.

**Results:**
- PR #832 (issue #666, skill metadata): Reviewer found all 4 checklist items DONE but identified that 0 of 16 SKILL.md files use the new fields. "Pure plumbing with zero adoption. Validation is effectively dead code."
- PR #810 (issue #765, dead code prompts): Reviewer found both prompt lines added as specified but identified that 1 of 3 failure patterns isn't a dead code issue at all, and the fix violates the evaluate skill's own Scope Reduction Discipline.

**Cost:** ~$0.13 per audit, ~70-100 seconds each.

**Conclusion:** Independent subagent reviewers find real gaps that implementing agents miss. Post-hoc detection works.

### Experiment 2: Plan loop — can review catch gaps BEFORE implementation?

**Method:** Replayed issue #666 through the plan loop. First, a planning agent read the issue and existing code, then proposed a plan. Then, a review agent compared the plan against the issue's motivation.

**Results:**
- **Planning agent** (simulating implementer): Read the existing code, checked all 4 requirements against the implementation, declared "COMPLETE — nothing left to do." Did NOT identify the zero-adoption gap.
- **Review agent** (independent, adversarial prompt): Found the same gap immediately. "The issue wanted to make the skill chain explicit and mechanically validated. What was delivered is empty infrastructure — a schema nobody populates, and validation that can never fail. This is the software equivalent of installing smoke detectors with no batteries."

**Key finding:** The adversarial framing matters. The planning agent asked "are requirements met?" (yes — code exists). The review agent asked "does the plan address the MOTIVATION?" (no — the problem is unsolved). Same code, same issue, opposite conclusions.

**Cost:** ~$0.13 for the review agent.

**Conclusion:** The plan loop catches gaps before implementation. The review prompt must be adversarial ("assume minimum work, check motivation not just checklist") to be effective. An implementing agent has confirmation bias; an independent reviewer doesn't.

### Experiment 3: Hook enforcement in headless mode

**Method:** Tested whether Claude Code hooks fire in `-p` mode, and whether the review gate actually blocks.

**Results:**
- All hook types fire in `-p` mode (confirmed via filesystem canaries)
- Hook events are NOT logged in stream-json output (only SessionStart appears)
- After EnterWorktree, hooks resolve from the worktree's `.claude/hooks/`
- Stop hook `decision:block` works — session continues, agent receives reason
- The agent clears the review gate by running `gh pr diff` — the hook treats "looked at diff" as "completed review" and sets `STATUS=passed`
- 25 PRs shipped with zero actual review despite the gate mechanism existing

**Conclusion:** The current review gate is L1 disguised as L2 — the agent satisfies it mechanically without doing the work. Independent subagent review is the real L2.

### Design Implications

1. **Review prompts must be adversarial.** "Check if requirements are met" produces rubber-stamp approvals. "Assume minimum work, check if the MOTIVATION is addressed" produces real findings.
2. **Independence is non-negotiable.** The implementing agent has confirmation bias. It finds code that matches the checklist and declares victory. A separate agent with a separate context doesn't.
3. **The plan loop is the highest-ROI intervention.** Catching a bad plan costs $0.13. Implementing a bad plan and discovering it post-hoc costs $2-5. Implementing, closing, re-discovering, and re-implementing costs the full lifecycle twice.
4. **Gates that can be cleared by the gated agent are theater.** The `gh pr diff` → auto-pass pattern proves this. Real enforcement requires an agent the implementer doesn't control.

## Implementation Status (2026-03-26)

### Built and working

| Component | File(s) | What it does |
|-----------|---------|-------------|
| Review battery engine | `src/review-battery.ts` (787 lines) | Spawns `claude -p` subagent reviewers, structured findings, parallel execution |
| Review-fix CLI | `scripts/review-fix.ts` (625 lines) | Review → fix → re-review loop with state persistence, budget cap, resume |
| Dimension CLI | `src/cli-dimensions.ts` (296 lines) | List/show/add/validate/briefing for review dimensions |
| 14 dimension prompts | `prompts/review-*.md` | Adversarial review prompts for plan-coverage, plan-fidelity, requirements, scope-fidelity, DRY, correctness, security, error-handling, logic-correctness, test-plan, test-quality, tooling-fitness, improvement-lifecycle, pr-description |
| Auto-dent review + fix loop | `scripts/auto-dent-run.ts` | Post-run review battery; if fail, spawns fix loop via `runFixLoop()` (PR #891) |
| Review events | `scripts/auto-dent-events.ts` | Structured events: `review.round_start`, `review.round_complete`, `review.fix_spawned`, `review.fix_complete` |
| Plan as issue comment | `kaizen-implement` SKILL.md | Agent posts plan.md + test-plan.md before writing code |
| Plan-vs-delivery in reflection | `kaizen-reflect` SKILL.md | Step 1.7 compares plan comment against PR delivery |
| E2E test infrastructure | `scripts/review-battery.e2e.test.ts` | Tier 2-4 tests with checkpoints, resume, fast iteration |
| Synthetic fixtures | `Garsson-io/kaizen-test-fixture` | PR #3 (truncate, no tests), PR #5 (two known bugs), issues |

### Not yet built (deferred)

| Feature | Why deferred | Prerequisite |
|---------|-------------|-------------|
| Separate `claude -p` sessions per step | Architectural change to auto-dent harness — plan/implement/review/reflect as independent sessions | Design how plan.md transfers context between sessions |
| Harness-spawned independent review | Implementing agent currently spawns its own review in interactive mode | Session isolation architecture |
| Interactive mode orchestrator | Pause-and-report at step transitions with configurable timeout | Unified skill orchestration |
| Dimension dependency ordering | Partial ordering (dims 1-3 before 6-10) | Research whether flat ordering produces noise |
| Portable zippable run artifacts | Self-contained run directory with git patches | Design run directory layout |
| Plan→codebase feasibility dimension (#2) | No adversarial prompt for plan vs existing code | Write the prompt |
| Re-run only failed dimensions | Currently all dimensions re-run each round | Track per-dimension state |
| Review calibration | Feedback on which dimensions produce signal vs noise | Accumulate data across batches |

### Answered open questions

| Question | Answer |
|----------|--------|
| Plan format (was #6) | Markdown, not JSON. `plan.md` and `test-plan.md` as issue comments. See Plan Format section. |
| Subagent prompt design (was #1) | 14 adversarial prompts in `prompts/review-*.md`, ~100-200 lines each. Proven effective at $0.05-0.20/dim. |
| Incremental adoption (was #7) | All 14 dimensions run by default. Briefing CLI helps prioritize. |

## Open Questions

1. **Loop termination:** Max 3 iterations per loop. Is this the right number?

2. **Cost threshold:** Small issues might not justify a full review battery. Should there be a lightweight path for trivial changes?

3. **Dimension dependencies:** Should the battery be partially ordered? Or just run everything flat?

4. **Review quality:** How do we review the reviewers? Multiple independent reviewers per dimension help (voting), but add cost.

5. **Interactive timeout:** How long to wait before proceeding autonomously at step transitions?

6. **Session boundary in auto-dent:** Each step as a separate `claude -p` session means losing context. The plan.md must be detailed enough for a fresh session to implement without re-discovering. Problem or feature?
