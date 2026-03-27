---
name: kaizen-write-plan
description: Planning gate — takes an issue (from deep-dive or direct) and produces a grounded implementation plan with admin approval. Triggers on "write plan", "plan issue", "plan #N", "evaluate this", "look at issue #N", "should we do this", "plan kaizen", "accept case", "what should we work on", "pick work", "what's next".
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# kaizen-write-plan — Planning Gate

## Quick Reference

**Input artifacts:**
- Path A (from deep-dive): `npx tsx src/cli-structured-data.ts retrieve-deep-dive --issue {N} --repo "$ISSUES_REPO"` (body + metadata + connected issues in one call)
- Path B (admin-specified): `gh issue view {N} --repo "$ISSUES_REPO" --json title,body,labels,comments`

**Output artifact:** grounding attachment on the issue
```bash
npx tsx src/cli-structured-data.ts store-grounding --issue {N} --repo "$ISSUES_REPO" --file grounding.md
```

**Tasks:** Create at start via **TaskCreate** — 6 tasks (see Workflow Tasks table below)

**Tools used in this skill:**
- **TaskCreate** / **TaskUpdate** — progress tracking
- **Agent tool with `subagent_type=Explore`** — for parallel research in Phase 3 (Path B)
- **Agent tool with `subagent_type=general-purpose`** — for plan coverage review (Phase 6)

**Flow:**
```
Detect path → [Path B: phases 0-3] → phase 4 (scope) → phase 5 (form plan) → phase 6 (admin)
```

---

**Role:** The planning gate. Takes a specific issue (from `/kaizen-deep-dive` or from the admin directly) and produces a grounded implementation plan with admin approval before implementation starts. Scope decisions live here — `/kaizen-implement` executes the scope this skill sets.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — *"Specs are hypotheses. Incidents are data."* and *"No promises without mechanisms."*

---

## Two Entry Paths

**State which path you're on immediately at skill start.**

**Path A — After kaizen-deep-dive:** The meta-issue already exists. Deep-dive already deconflicted, explored the codebase, gathered incidents, and identified the root cause. Detection: issue body contains `## Problem — The Pattern` section.
- Skip Phases 0-3 (already done by deep-dive)
- Jump directly to Phase 4

**Path B — Admin-specified ("plan #N"):** Starting from any existing issue.
- Run all Phases 0-6 in sequence

---

## Workflow Tasks

Create these tasks at skill start using **TaskCreate**:

| # | Task | Description |
|---|------|-------------|
| 1 | Collision detection | Check GitHub labels, open PRs, git log for existing work (PATH B ONLY) |
| 2 | Read artifacts | Read issue body + deep-dive artifacts (Path A) or issue body only (Path B) |
| 3 | Problem validation + incidents | Confirm problem exists, gather incidents (PATH B ONLY) |
| 4 | Scope + architecture | Assess implementation scope, architecture fitness, hypotheses |
| 5 | Form grounded plan | 5 steps → write plan → store-grounding |
| 6 | Admin approval | Plan coverage review, present to admin, get GO/NO-GO |

Mark each task **in_progress** before starting it. Mark **completed** when done.

**What comes next:**
- **GO → single PR:** `/kaizen-implement`
- **GO → multi-PR:** `/kaizen-plan` first, then `/kaizen-implement` per sub-issue
- **Needs spec:** `/kaizen-prd` first, then back here
- **NO-GO:** Close with reason

---

## Phase 0: Collision Detection *(PATH B ONLY — skip on Path A)*

Deep-dive already ran this. On Path A, proceed directly to Phase 1.

On Path B, check all four sources before evaluating:

```bash
# Already fixed?
gh issue view {N} --repo "$ISSUES_REPO" --json state
git log --oneline --all --grep="#{N}" | head -5
gh pr list --repo "$HOST_REPO" --state merged --search "#{N}" --json number,title

# Claimed or active?
gh issue view {N} --repo "$ISSUES_REPO" --json labels,state

# Open PRs?
gh pr list --repo "$HOST_REPO" --state open --search "#{N}" --json number,title,headRefName
```

**If already fixed:** Report evidence, stop.
**If collision:** Ask — Take over, Assist, or Pick different work?

**On approval (end of Phase 6):** Label the issue:
```bash
gh issue edit {N} --repo "$ISSUES_REPO" --add-label "status:backlog"
```

---

## Phase 1: Read Artifacts

**Path A — Read deep-dive output (one call):**
```bash
npx tsx src/cli-structured-data.ts retrieve-deep-dive --issue {N} --repo "$ISSUES_REPO"
```
Returns: issue body (Problem/RootCause/ConcreteБugs/CompoundFix/Scope) + metadata attachment + connected symptom issues.

Summarize what deep-dive found: root cause pattern, concrete bugs, proposed compound fix, scope.

**Path B — Read issue body only:**
```bash
gh issue view {N} --repo "$ISSUES_REPO" --json title,body,labels,comments
```

Check for an existing spec: if body has >100 lines or links to `docs/*-spec.md`, skip Phase 3 (incident gathering).

---

## Phase 2: Problem Validation *(PATH B ONLY)*

Confirm the problem actually exists in current code before scoping anything.

1. Re-state as a falsifiable hypothesis:
   > "We believe [issue title claim] is observable as [specific symptom] in the current codebase."

2. Design and run the minimal test: read the relevant file, grep for the pattern, check current behavior.

3. Report:
   - **Problem confirmed — evidence: [X at file:line]** → proceed
   - **Problem NOT confirmed** → comment on issue, recommend close or update, do not implement

---

## Phase 3: Gather Incidents + Assess Observability *(PATH B ONLY)*

Use **Agent tool with `subagent_type=Explore`** for parallel incident research:
- Git log: commits, PR descriptions mentioning the problem
- Kaizen reflections, hook outputs, issue comments and cross-references

For each incident, record **specific data**:
- When: exact date, commit SHA, or PR number
- Specific failure: exact error message, test output, or observable wrong behavior — not "it broke"
- Who was affected: which agent or human, in which context
- Specific impact: time wasted, work blocked, wrong output produced
- How resolved: specific fix, workaround, or still open

Look for: concrete reproducible failure paths, not abstract patterns. A good incident description lets a future agent reproduce the failure.

**Observability questions:**
- What logs/artifacts exist when this occurs?
- Would you notice without someone reporting it?
- If fixed, how would you prove it?

---

## Phase 4: Scope + Architecture Fitness + Hypotheses

**Default to the full solution.** Only split when pieces are genuinely independent.

**Scope questions:**
- What's the simplest correct implementation of the full solution?
- Is this testable end-to-end? If not, building the test infrastructure is IN SCOPE.
- What's the right build order?
- Are there genuinely independent sub-problems that ship better as separate PRs?

**Splitting rule:** Each piece must independently deliver value, have its own tests, and not require the other pieces to be useful.

**Architecture fitness — MANDATORY:**

| Question | Red flag → Action |
|----------|-------------------|
| What language should this be in? | Bash with complex branching → propose TypeScript |
| What runtime? | tsx when bun is faster → use bun |
| What libraries exist? | None considered → search package.json first |
| Can we test E2E? | No harness exists → **building it is IN SCOPE** |
| What patterns exist to reuse? | None found → search before writing |
| What dead code exists here? | Working around it → identify and remove |

**Make hypotheses explicit:**
```
HYPOTHESIS: [what you think causes the problem — a falsifiable claim]
WHY IT MIGHT BE WRONG: [what would disprove this]
FASTEST TEST: [experiment that takes minutes, not hours]
```

Run the fastest test before Phase 5.

### Scope Reduction Discipline — MANDATORY gate

When proposing to do less than the full solution, provide **at least one**:
1. A mechanistic signal (non-LLM) that fires when deferred work is needed
2. A connection to an active epic where progress naturally surfaces the need
3. A filed follow-up issue with concrete trigger criteria

**Without one of these three, do not reduce scope.**

---

## Phase 5: Form Grounded Plan — MANDATORY

Form the plan through five steps. This takes 10-20 minutes and prevents implementing the wrong thing.

### Step 5.1: Extract Success Criteria

```
GOAL: [what the user/system can't do now]
DONE WHEN: [the specific verifiable outcome that means it's fixed]
```

Verifiable means: an external observer can check it without reading the implementation. Write this before looking at code. Every plan task must connect back to DONE WHEN.

### Step 5.2: Survey Existing Tooling, Docs, Policies, Skills

Before designing a solution, find what already exists to reuse. This is **solution-space** research — what tools, utilities, patterns, and docs are relevant to *fixing* this problem (distinct from deep-dive's problem-space exploration which understood *what's broken*).

Survey the relevant areas for this problem:
- Existing CLI tools in `src/` that solve adjacent problems
- Design docs in `docs/` that describe the domain
- Skill docs in `.claude/skills/` that describe existing workflows
- Policies in `.claude/kaizen/` that apply enforcement rules
- `package.json` for available libraries

For each item found: does it solve the core problem or an adjacent one? State findings in the plan's "Information Retrieved" section.

### Step 5.3: Generate and Reject at Least One Alternative

Identify the highest-risk design choice:

```
OPTION A: [description] — SELECTED
Failure mode if wrong: [one sentence — name a failure mode, not a preference]

OPTION B: [description] — REJECTED
Rejected because: [specific failure mode that disqualifies it]
```

"Cleaner" is not a failure mode. "Loses all state if the session dies" is.

### Step 5.4: Validate the Fix's Assumption

```
HYPOTHESIS: [what the proposed fix assumes about the root cause]
VALIDATION: [what you will run or read to confirm — must take <15 min]
IF WRONG: [what evidence would disqualify this hypothesis]
```

Run the validation before committing to the plan.

### Step 5.5: Map Testability Seams

For each significant behavior, fill in this row:

```
BEHAVIOR: [what it does]
LIVES IN: [file.ts, functionName()]
TESTED IN: [tests/test_file.ts or tests/test_file.sh]
SEAM: [the injection point that isolates this for testing]
LADDER RUNG: [the lowest rung from docs/test-ladder-spec.md that actually exercises this boundary]
```

**Choose the rung that matches the boundary, not the cheapest rung available.** See `docs/test-ladder-spec.md` for the full ladder. Key guidance:

- If the seam involves a real subprocess, OS interaction, hook chain, or agent-tool boundary — that's L5+ territory. Unit tests (L1-L2) run inside the same process and cannot observe cross-process behavior.
- `SessionSimulator` costs **$0 and runs in <1s**. It is NOT a behavioral LLM test. It simulates hook chains and tool use without calling the API. Never defer a `SessionSimulator`-testable behavior to a "future E2E issue."
- **Circular deferral anti-pattern**: "We'll add E2E tests in the issue that tracks E2E gaps" is circular when the symptom under fix IS the E2E gap. If this issue is partly about insufficient test coverage at level L, the fix must include tests at level L, not defer them to the gap issue.

If you cannot name the seam, the behavior is not testable in isolation — design the seam before writing the implementation.

### Cross-Check Gate (MANDATORY before writing the test plan)

**Scan every seam map row. For each row where `LADDER RUNG ≥ L5`:**

1. The test plan MUST include a test at that rung or higher for that behavior.
2. A test plan rung that is lower than the seam's `LADDER RUNG` is a contradiction — fix the test plan, not the seam map.
3. If you find yourself writing "deferred to #N" for an L5+ seam: check whether #N is the same issue (or a symptom of the same issue) you are currently solving. If yes, the deferral is circular — the test belongs here.

Write the cross-check result explicitly before starting the test plan section:

```
CROSS-CHECK:
- [behavior]: seam at [rung], test plan at [rung] — OK / CONTRADICTION
- [behavior]: seam at [rung], test plan at [rung] — OK / CONTRADICTION
```

If any row shows CONTRADICTION, fix the test plan rung before proceeding.

### Write and Store the Plan

With all five steps complete, write the grounding document:

```markdown
## Success Criteria
GOAL: [from step 5.1]
DONE WHEN: [from step 5.1]

## Information Retrieved
- [source]: [what you found] — [how it changes or confirms the plan]

## Design Alternatives
### Option A: [description] — SELECTED
Failure mode if wrong: ...

### Option B: [description] — REJECTED
Rejected because: ...

## Tasks
[Ordered, concrete, traceable to DONE WHEN]

## Test Plan
[Per-task: what invariant is tested, which test file, rung from test-ladder-spec.md]

## Seam Map
[Per-behavior: file, test file, seam, LADDER RUNG]
```

Store immediately:
```bash
npx tsx src/cli-structured-data.ts store-grounding --issue {N} --repo "$ISSUES_REPO" --file grounding.md
```

---

## Phase 6: Plan Coverage Review + Ask Admin

### Automated coverage review

Launch **Agent tool with `subagent_type=general-purpose`** using `prompts/review-plan-coverage.md`. Pass the plan text and issue number. Returns DONE / PARTIAL / MISSING findings.

- **All DONE:** Proceed to admin.
- **PARTIAL:** Intentional scope reduction (document why per Scope Reduction Discipline) or unintentional gap (fix the plan).
- **MISSING:** Fix the plan before presenting. Do not show a plan with MISSING items without flagging them.

Fix loop: max 3 rounds. If still failing after 3, present findings alongside plan — admin decides.

### Present to admin

Required structure:

1. **Problem TLDR** (2-3 sentences): What's broken or missing, concretely.
2. **How it works now TLDR** (2-3 sentences): Current system behavior.
3. **What changes TLDR** (2-3 sentences): What you'd actually do.
4. **Deep dive pointers** (1 paragraph): Where to read more.

**Then ask targeted questions:**
- "I found N incidents over M weeks. Pattern is X. Does this match your experience?"
- "The full solution is Y. Implementation plan: [steps]. Any concerns before I proceed?"
- "The pivotal decision is Z. My lean is [reason]. Agree?"

**Don't ask** questions you could answer by reading the code, or "is this important?"

---

## Anti-patterns

- **Skipping Phase 2.** Implementing solutions to problems that may no longer exist.
- **Spec worship.** A spec is a hypothesis. Incidents are data. When they conflict, trust the data.
- **Analysis paralysis.** If Phase 4 finds an obvious 15-minute fix, just do it.
- **"Do X now, Y later" without a mechanism.** No signal = no escalation = scope cut.

---

## Integration with Other Skills

```
/kaizen-deep-dive   → Finds the category, creates meta-issue spec → calls /kaizen-write-plan (Path A)
/kaizen-write-plan  → THIS SKILL. Planning gate, grounding, admin approval.
/kaizen-implement   → Execution engine. Reads grounding. Executes scope set here.
/kaizen-plan        → Breaks large work into sequenced PRs (call from here when needed)
/kaizen-prd         → Problem mapping when problem is genuinely complex (call from here)
/kaizen-reflect     → Post-implementation reflection
```
