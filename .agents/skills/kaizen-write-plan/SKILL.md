---
name: kaizen-write-plan
description: Planning gate — takes an issue (from deep-dive or direct) and produces a grounded implementation plan with admin approval. Replaces kaizen-evaluate and kaizen-pick. Triggers on "write plan", "plan issue", "plan #N", "evaluate this", "look at issue #N", "should we do this", "plan kaizen", "accept case", "what should we work on", "pick work", "what's next".
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Write Plan — Planning Gate

**Role:** The planning gate. Takes a specific issue (from `/kaizen-deep-dive` or from the admin directly) and produces a grounded implementation plan, then gets admin approval before implementation starts. Scope decisions live here — `/kaizen-implement` executes the scope this skill sets and must not change it unilaterally.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — *"Specs are hypotheses. Incidents are data."* and *"No promises without mechanisms."*

## Two entry paths

**Path A — After deep-dive:** `/kaizen-deep-dive` already mapped the territory, gathered incidents, found the root cause, and created a meta-issue as the spec. Skip Phases 1-2. Jump to Phase 0 (collision check), then directly to Phase 3 (scope) and Phase 4.5 (plan formation).

**Path B — Guided (admin specifies issue #N):** Admin says "plan #N" or "look at issue #N". Run all phases in sequence.

State which path you're on at the start.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Collision detection | Check GitHub labels, open PRs, worktrees for existing work on this issue |
| 2 | Problem validation | Confirm the problem exists in current code (skip if from deep-dive) |
| 3 | Gather incidents + scope | Find concrete occurrences, assess implementation scope and architecture (skip Phase 1-2 if from deep-dive) |
| 4 | Phase 4.5: Form grounded plan | 5 grounding steps → write and store plan |
| 5 | Ask the admin | Present 3 TLDRs, ask targeted questions, get approval |
| 6 | Plan coverage review | Automated review of plan vs issue requirements |

**What comes next:**
- **GO → single PR:** `/kaizen-implement`
- **GO → multi-PR:** `/kaizen-plan` first, then `/kaizen-implement` per sub-issue
- **Needs spec:** `/kaizen-prd` first, then back here
- **NO-GO:** Close with reason

---

## Phase 0: Collision detection

**Before evaluating, check if this is already done or claimed.**

```bash
# Already fixed?
gh issue view {N} --repo "$ISSUES_REPO" --json state
git log --oneline --all --grep="#{N}" | head -5
gh pr list --repo "$HOST_REPO" --state merged --search "#{N}" --json number,title

# Claimed?
gh issue view {N} --repo "$ISSUES_REPO" --json labels,state

# Open PRs?
gh pr list --repo "$HOST_REPO" --state open --search "#{N}" --json number,title,headRefName
```

**If already fixed:** Report the evidence, stop. Do not implement.

**If collision detected (someone else working on it):** Ask — Take over, Assist, or Pick different work?

**If no collision, proceed.**

**On approval (end of Phase 5):** Label the issue and store evaluation findings:
```bash
gh issue edit {N} --repo "$ISSUES_REPO" --add-label "status:backlog"
npx tsx src/cli-section-editor.ts write-attachment --issue {N} --repo "$ISSUES_REPO" --name evaluation --file eval.md
```

---

## Phase 0.5: Check for existing spec

```bash
gh issue view {N} --repo "$ISSUES_REPO" --json body --jq '.body' | grep -oE 'docs/[a-z0-9-]+-spec\.md'
gh issue view {N} --repo "$ISSUES_REPO" --json body --jq '.body' | wc -l
```

**If a detailed spec exists (>100 lines or links to a `docs/*-spec.md`):** Skip Phases 1-2 (already done). Jump to Phase 3 with the spec as context.

**If this issue is part of an epic:** Read the parent epic for methodology patterns that should be in skills/docs/hooks but aren't. Include applying them in scope.

---

## Phase 0.7: Problem Validation *(skip if from deep-dive)*

Confirm the claimed problem actually exists in current code before scoping anything.

1. Re-state the claim as a falsifiable hypothesis:
   > "We believe [issue title claim] is observable as [specific symptom] in the current codebase."

2. Design and run the minimal test — grep for the pattern, read the relevant file, reproduce the behavior.

3. Report:
   - **"Problem confirmed — evidence: [X at file:line]"** → proceed
   - **"Problem NOT confirmed"** → comment on issue, do not implement, recommend close or update

---

## Phase 1: Gather incidents *(skip if from deep-dive)*

Find what actually happened — concrete occurrences, not abstractions.

- Git log: commits, PR descriptions, review comments mentioning the problem
- Kaizen reflections, hook outputs, issue comments and cross-references

For each incident: when, who affected, observable impact, how resolved.

Look for: frequency, trend, clustering, severity distribution.

---

## Phase 2: Assess observability *(skip if from deep-dive)*

- What logs/artifacts exist when this occurs?
- Would you notice without someone reporting it?
- If fixed, how would you prove it?

If "we can't tell" is the answer to most questions, adding observability may be the real first fix.

---

## Phase 3: Assess implementation scope

**Default to the full solution.** Only split when pieces are genuinely independent.

- What's the simplest correct implementation of the full solution?
- Is this testable end-to-end? If not, building the test infrastructure is IN SCOPE.
- What's the right build order? (Tests first, then implementation, then integration.)
- Are there genuinely independent sub-problems that ship better as separate PRs?

**Splitting rule:** Each piece must independently deliver value, have its own tests, and not require the other pieces to be useful.

**Issue lifecycle when splitting:** Use sub-issues. The PR fixes the sub-issue, not the parent epic.

---

## Phase 3.5: Form hypotheses

Make assumptions explicit before committing to implementation.

```
HYPOTHESIS: [what you think causes the problem — a falsifiable claim]
WHY IT MIGHT BE WRONG: [what would disprove this]
FASTEST TEST: [experiment that takes minutes, not hours]
```

Run the fastest test before writing the plan. A falsified hypothesis is more valuable than an untested assumption.

---

## Phase 3.7: Architecture & Tooling Fitness — MANDATORY

| Question | Red flag → Action |
|----------|-------------------|
| What language should this be in? | Bash with complex branching → propose TypeScript |
| What runtime? | tsx when bun is faster → use bun |
| What libraries exist? | None considered → search npm + package.json first |
| Can we test E2E? | No harness exists → **building it is IN SCOPE** |
| What patterns exist in the codebase to reuse? | None found → grep before writing |
| What dead code exists in this area? | Working around it → identify and remove |

---

## Scope Reduction Discipline — MANDATORY gate

When proposing to do less than the full solution, you must provide **at least one**:

1. **A mechanistic signal** (non-LLM) that fires when deferred work is needed
2. **A connection to an active epic** where progress naturally surfaces the need
3. **A filed follow-up issue** with concrete trigger criteria

**Without one of these three, do not reduce scope.**

---

## Phase 4: Critique the spec (if one exists)

- Does the problem statement match the incidents?
- Are the proposed options proportional to the problem?
- What's missing? What's over-specified?
- Is the most important question buried as an "open question"?

**Solution evaluation — 5 questions (kaizen #714):**
1. What failure mode does this spec address? Is that the right one?
2. Is the proposed mechanism the simplest that addresses it? What alternatives exist?
3. Would a simpler fix (L3→L2→L1) address the same failure mode?
4. Is this failure mode expected to recur? Is prevention worth the overhead?
5. What is the cost of the proposed mechanism?

If any answer raises doubt, surface it before implementing.

---

## Phase 4.5: Plan Formation — MANDATORY

Before writing any plan, form it through five grounding steps. The grounding takes 10-20 minutes and prevents the 30-minute implementation of the wrong thing.

### Step 1: Extract the success criteria

Read the issue body. Find the observable failure — not the proposed fix, the original pain:

```
GOAL: [what the user/system can't do now]
DONE WHEN: [the specific verifiable outcome that means it's fixed]
```

Verifiable means: an external observer can check it without reading the implementation. Write this before looking at any code. Every plan step must connect back to DONE WHEN.

### Step 2: Survey what already exists

Read CLAUDE.md's Key Files table. Then grep:

```bash
# Storage/attachment problems:
grep -r "cli-section-editor\|write-attachment\|store-plan\|store-metadata" src/ --include="*.ts" -l

# Hook problems:
cat docs/hooks-design.md

# Review/dimension problems:
npx tsx src/cli-dimensions.ts list && ls prompts/
```

For each tool found: does it solve the core problem or an adjacent one? State findings in the plan's "Information Retrieved" section. This is how plans avoid re-inventing `cli-section-editor.ts`.

### Step 3: Generate and reject at least one alternative

Identify the highest-risk design choice — the one that determines where state lives or who owns an interface contract:

```
OPTION A: [description] — SELECTED
Failure mode if wrong: [one sentence — must name a failure mode, not a preference]

OPTION B: [description] — REJECTED
Rejected because: [specific failure mode that disqualifies it]
```

"Cleaner" is not a failure mode. "Loses all state if the session dies before the batch write completes" is.

### Step 4: Validate the proposed fix's assumption

```
HYPOTHESIS: [what the proposed fix assumes about the root cause]
VALIDATION: [what you will run or read to confirm — must take <15 min]
IF WRONG: [what evidence would disqualify this hypothesis]
```

Run the validation before committing to the plan. Do not skip for "obvious" fixes.

### Step 5: Map the testability seams

For each significant behavior:

```
BEHAVIOR: [what it does]
LIVES IN: [file.ts, functionName()]
TESTED IN: [tests/test_file.ts or tests/test_file.sh]
SEAM: [the injection point that isolates this for testing]
```

If you cannot name the seam, the behavior is not testable in isolation. Red flags requiring extraction first: target has >5 imports, is a CLI entry point, or testing requires mocking >3 modules.

### Write the plan

With all five steps complete:

```markdown
## Success Criteria
GOAL: [from step 1]
DONE WHEN: [from step 1]

## Information Retrieved
- [source]: [what you found] — [how it changes or confirms the plan]

## Design Alternatives Considered
### Option A: [description] — SELECTED
Failure mode if wrong: ...

### Option B: [description] — REJECTED
Rejected because: ...

## Tasks
[Ordered, concrete, traceable to DONE WHEN]

## Seam Map
[Per-behavior: file, test file, seam]

## Test Plan
[Per-task: what invariant is tested, which test file, unit/integration/E2E]
```

Store immediately:

```bash
npx tsx src/cli-structured-data.ts store-grounding --issue {N} --repo "$ISSUES_REPO" --file plan.md
```

**Time budget:** Simple (single file, no new abstractions): 10-12 min. Complex (new module, state decision, multi-component): 15-20 min. Longer than 20 min = you're designing, not surveying. Go back to step 2.

---

## Phase 5: Ask the admin

**Required structure:**

1. **Problem TLDR** (2-3 sentences): What's broken or missing, concretely.
2. **How it works now TLDR** (2-3 sentences): Current system behavior — sound but untested, or hacky and needs rework?
3. **What changes TLDR** (2-3 sentences): What you'd actually do, concretely.
4. **Deep dive pointers** (1 paragraph): Where to read more — spec sections, source files, most informative incidents.

**Then ask targeted questions:**
- "I found N incidents over M weeks. Pattern is X. Does this match your experience?"
- "The full solution is Y. Implementation plan: [steps]. Any concerns before I proceed?"
- "The spec's open question #K is the pivotal decision. My lean is Z because [reason]. Agree?"

**Don't ask** questions you could answer by reading the code, or "is this important?"

---

## Phase 5.5: Plan coverage review (automated)

After formulating the plan, run the plan-coverage review battery before presenting to admin:

```
Launch a subagent with prompts/review-plan-coverage.md.
Pass the plan text and issue number. Returns DONE / PARTIAL / MISSING findings.
```

- **All DONE:** Proceed to admin.
- **PARTIAL:** Review each — intentional scope reduction (document why per Scope Reduction Discipline) or unintentional gap (fix the plan).
- **MISSING:** Fix the plan before presenting. Do not show a plan with MISSING items without flagging them.

Fix loop max: 3 rounds. If still failing after 3, present findings alongside plan — admin decides.

---

## Phase 6: Capture lessons

After the admin responds, capture:
- The admin's decision and reasoning
- Where the plan diverged from the admin's view
- Calibration: was the problem bigger or smaller than implied?
- Meta-observations about the evaluation process itself

The mechanism for storing and surfacing this doesn't exist yet — accumulate raw notes until the pattern is clear enough to design around.

---

## Multi-PR Follow-Through Discipline — MANDATORY when splitting

When splitting into sub-issues:

1. **File ALL sub-issues on GitHub immediately** — not "later"
2. **Link them to the parent epic** with dependency order
3. **Create tasks for ALL sub-issues** at session start
4. **After each PR, continue to the next sub-issue** — default is CONTINUE, not STOP
5. **If you must stop early**, update the epic with current progress and what remains

The agent that split the work IS the champion — continue until the epic is delivered or the admin redirects.

---

## Anti-patterns

- **Skipping Phase 0.7.** Implementing solutions to problems that may no longer exist.
- **Spec worship.** A spec is a hypothesis. Incidents are data. When they conflict, trust the data.
- **Analysis paralysis.** If Phase 3 finds an obvious 15-minute fix, just do it.
- **"Do X now, Y later" without a mechanism.** No signal = no escalation = scope cut.
- **Ship and stop.** Completing one sub-issue of a multi-PR split and stopping.

---

## Integration with other skills

```
/kaizen-deep-dive   → Finds the category, creates meta-issue spec → calls /kaizen-write-plan
/kaizen-write-plan  → THIS SKILL. Planning gate, grounding, admin approval.
/kaizen-implement   → Execution engine. Takes scope set here.
/kaizen-plan        → Breaks large work into sequenced PRs (call from here when needed)
/kaizen-prd         → Problem mapping when problem is genuinely complex (call from here)
/kaizen-reflect     → Post-implementation reflection
```
