# PRD: Planning Quality — Closing the Issue→Plan Gap

*March 2026. Informed by 5 rounds of structured exploration and 23 concrete GitHub failure cases.*

---

## Section 1 — Problem Statement

### 1.1 The Asymmetric Quality Problem

The kaizen pipeline has three stages with asymmetric quality:

- **Issues:** Strong. Problems are explored carefully, failure modes are named, motivating incidents are cited.
- **Issue → Plan:** Weak. This is the gap. Plans are formed without grounding, without alternatives, without validated hypotheses.
- **Reviews:** Strong. Adversarial, dimensional, improved by the battery.

The gap is structural: the issue→plan transformation has no retrieval phase and no structured pre-plan formation discipline. The agent reads the issue body once, linearly, and begins planning from its first interpretation.

This produces plans that address what the issue *says to build* rather than what will make the problem *stop happening*. The plan inherits the issue's proposed solution without questioning it. It designs from first principles without checking what already exists. It commits to a single architecture without naming the one it's competing against. It assigns behavior to a location without verifying that location is testable in isolation.

In 7 of 8 analyzed GitHub failures, the issue body contained enough information for a better plan. The failures arose from what agents chose not to look at, not from information gaps in the issues themselves.

**The key insight: information scarcity is not the problem. Non-application is.**

### 1.2 The Nine Failure Categories

Five categories were identified in the initial evidence pass. Four more emerged from extended analysis of 23 total cases.

**Category 1: Goal vs. Work-Item Extraction**

The plan extracts work items from the issue body but not the success criteria. Tests pass. Code ships. The problem persists because "done" was defined as "code written" not "problem solved."

Canonical example: **PR #832 / Issue #666** — The issue asked for the skill chain to stop being implicit. The plan built a TypeScript interface, a YAML frontmatter parser, and 22 unit tests. All green. Zero of the 16 existing SKILL.md files were populated. The issue asked for observable behavioral change; the plan delivered technical infrastructure that the observable behavior depended on but never triggered. Issue was closed. Skill chain remained implicit.

Additional cases: Issue #966 / PR #970 (review-pr skill missing storage step — the skill's purpose was to store findings; the step was absent from its own SKILL.md).

**Category 2: Hypothesis-as-Contract**

The issue body's "proposed fix" or "suggested approach" is treated as a specification rather than a hypothesis to validate before committing to implementation. When the hypothesis is wrong, the full implementation is wasted.

Canonical example: **Issue #724** — A static lint hook was specified as the fix for WSL2 `/proc` path hangs. The implementor built the hook faithfully with 22 tests. The admin reverted it entirely in PR #736 (232 lines deleted). The correct fix — test timeouts and wall-clock budgets that would handle *any* hang — was documented in companion issues #684 and #686 that the issue body itself referenced. The proposed fix addressed one specific trigger; the failure class was broader.

Additional cases: PR #816 / Issue #814 (timing sentinel disabled instead of fixed — issue explicitly stated "fix the underlying slowness rather than increasing the timeout"), PR #708 / Issue #685 (kernel-path lint hook — implementor accepted prescribed mechanism without validating it was the right abstraction level).

**Category 3: Single Design Considered**

Plans produce one design without exploring alternatives. The one design has a failure mode the plan never named, which surfaces only after implementation reveals it.

Canonical example: **PR #970 / Issue #966** — The plan chose "orchestrator posts findings" (orchestrator calls `store-review-batch` after all subagents complete) without surfacing the alternative: "agents post their own findings" (each dimension subagent calls `store-review-finding` directly before returning). The interface ownership question was never asked. The admin asked it during implementation: "maybe the subagents should post the review findings?" That question took 30 seconds. Analyzing the answer — that agent-stores is resilient to session death while orchestrator-batch loses all findings if the session dies after 3 of 5 agents complete — took 10 minutes. Issue #979 documents: "That question would have saved 3 review rounds and a policy violation if asked before implementation started."

Additional cases: Issue #758 (scope-guard deadlock — fix blocked ALL tools including the Bash tool needed to fix settings.json; recovery was impossible from within Claude Code; real user spent 10+ messages in a deadlocked session), Issue #939 / PR #956 (five systems broke when worktree was deleted — each built in isolation with an unstated shared assumption that the working directory is stable and long-lived).

**Category 4: Testability Not Assessed Pre-Implementation**

Code is placed in untestable locations — `main()`, hook entry points, top-level execution blocks — and the testability gap is only discovered after the code is written. The location is correct for the functionality but wrong for the testing strategy.

Canonical example: **PR #894 / Issue #891** — The plan correctly identified the integration work to wire `runFixLoop()` into `auto-dent-run.ts`. The implementation added approximately 70 lines of integration code inline in `main()` with no dependency injection. Issue #896 documents: "70 lines of integration logic... untestable because it lived inline in `main()`." Post-hoc audit (issue #914) found 5 bugs. PR #918 extracted `runReviewWiring()` with dependency injection and fixed all 5.

Additional cases: Batch `jolly-marsupial` (25 PRs shipped with zero review gate firing — unit tests for TypeScript functions existed, but no E2E test verified that Claude Code would invoke the hooks in headless `-p` mode; testability gap was at the full-chain level, not the unit level).

**Category 5: Plan Before Codebase Survey**

Plans design from first principles without surveying what already exists. Custom solutions are built for problems that are already solved by existing tools.

Canonical example: **Issue #957** — Planning issue #940 (auto-dent batch intelligence), the planning agent designed Phase 1 as: post a hand-rolled fenced JSON block to a GitHub issue comment, then parse it back with a custom regex reader. The codebase already had `cli-section-editor.ts write-attachment` / `read-attachment` — named attachments on issues, fully tested, used by every other skill. The issue was self-documenting: it was filed to describe the failure after it was discovered.

Additional cases: PR #803 / Issue #808 (deletion without tracing dependents — 3054 lines of bash tests silently skipping after hook deletion; `grep -r "kaizen-pr-reflect-clear" .claude/hooks/tests/` before deletion would have found all 6 affected test files), Issue #726 (duplicate tracking issues — harness called `gh issue create` unconditionally without checking for existing tracking issues; `findExistingProgressIssue()` was added in PR #825 after the fact).

**Category 6: Incomplete Deletion Scope**

Deletion is scoped to the target artifact but not to everything that references it. The deleted artifact is gone; the references remain, silently broken — tests that skip, docs pointing at deleted files, plugin.json with dead hook paths.

Canonical example: **PR #803 / Issue #808** — The TS migration plan correctly scoped deletion of bash hooks and their direct tests. It did not check whether any bash test files referenced the deleted hooks via `require_file` guards. Six test files had guards pointing at deleted hooks. When the hooks were gone, the guards silently skipped all 3054 lines of tests. CI reported "all tests pass." The false green persisted until an exploration run weeks later.

Signature: "All tests pass" after deletion. Later discovery of silently skipping tests, stale docs, or CI running against deleted artifacts.

**Category 7: Dual Failure Mode Blindness**

A constraint fix eliminates one failure mode but creates the symmetric opposite. The plan builder optimizes against the observed failure without naming both ends of the design space.

Canonical example: **PR #718 → PR #720** — PR #718 fixed auto-dent's blind-loop problem (agents picking 4 issues in one session reactively) with a "one issue per run" policy. The fix was correct against the observed failure. It prevented intentional bundling that `/kaizen-deep-dive` already handled deliberately. PR #720 was filed immediately after to replace the rule with a PLAN→EXECUTE→STOP pattern that allowed deliberate bundling while preventing reactive scope expansion. Issue #722 was filed to document the pattern and add both-failure-modes analysis to the evaluate/implement skills.

Signature: A behavioral rule fix is followed immediately by a corrective PR that loosens the rule. Admin notes the fix was "too restrictive" or "prevented valid behavior."

**Category 8: Scope Leakage Without Lifecycle**

Implementation ships features beyond what was tracked in any issue. The extras are coherent with the project but have no feedback loop, no replay tests, no improvement path. Retroactive issues are filed to track what shipped.

Canonical example: **PR #846** — The issue asked for an adversarial review battery. PR #846 delivered the core battery plus 4 extra review dimensions, a `/kaizen-dimensions` skill, `docs/artifact-lifecycle.md`, `docs/review-dimensions-research.md`, and 3 extra zen principles. None of the extras had corresponding issues. Issues #861, #862, #863 were filed retroactively to document what had shipped. The 4 unplanned dimensions never had replay tests against motivating PRs.

Signature: Multiple retroactive issues filed after merge. PR diff contains substantially more new files than referenced in any issue.

**Category 9: Recursive Failure — System Fails to Capture Lessons About Itself**

The kaizen reflection and memory system is supposed to capture lessons from admin corrections. When the reflection system itself fails to enforce lesson capture, the same mistakes recur across sessions.

Canonical example: **Issue #781** — The "write real E2E tests" feedback was given across multiple sessions but never saved as a memory or filed as an issue until the admin explicitly asked "can you debug why the lesson on testing is not sticking?" The reflection skill documented the required behavior (save corrections as memory files AND codify them in infrastructure) but the instruction was L1 only — no hook verified that when a correction was given, it was saved.

Signature: Admin says "I told you" or "this is not sticking" — the signal that a correction was given before but not absorbed.

### 1.3 Cost Estimates

Based on the GitHub evidence:

- **Category 1 (Goal vs. Work-Item):** Issue #666 required a full second PR cycle to deliver what the first PR was supposed to deliver. Estimated: 1-2 lost implementation sessions per occurrence.
- **Category 2 (Hypothesis-as-Contract):** PR #708 delivered 232 lines that were deleted in PR #736. Total waste: ~2 PR cycles. Issue #816 resulted in the underlying slowness remaining unfixed with ongoing CI friction.
- **Category 3 (Single Design):** PR #970 went through 17 comments and multiple fix rounds before the interface ownership question was resolved. Estimated: 3-5 review rounds per occurrence.
- **Category 4 (Testability Cutout):** PR #894's 70 untestable lines accumulated 5 bugs, required PR #918 for extraction and fixes. Batch `jolly-marsupial` shipped 25 PRs with zero enforcement — the cost of building the review battery was entirely attributable to this gap.
- **Category 5 (Codebase Survey):** Issue #957's custom storage over existing tools created two competing storage systems. PR #803's silent test skip required an exploration run to discover — latency of weeks before detection.
- **Category 7 (Dual Failure Mode):** PR #718 → PR #720 in immediate sequence within the same batch — 100% implementation waste on a rule that was immediately corrected.

---

## Section 2 — Desired End State

When this initiative is complete, plans will have four properties that the current system cannot guarantee:

**Grounded.** Before any design is committed, the planner has read the CLAUDE.md Key Files table, run at least one grep for existing tools in the problem domain, and documented what was found. Plans that propose new infrastructure cite either a negative search result ("searched for write-attachment pattern: nothing found") or an integration decision ("using cli-section-editor.ts because it already solves named attachment storage"). Plans without documented search results are structurally non-compliant.

**Hypothesis-driven.** The issue body's proposed fix is treated as a conjecture, not a specification. The plan states the assumption the proposed fix makes, names a condition that would falsify it, and records that the fastest validation was run before committing to implementation. Plans that skip this are visibly missing the Hypothesis and IF WRONG fields.

**Alternatives-aware.** At the highest-risk design choice in the plan, at least two designs are named. One is selected with a statement of its failure mode if wrong. The others are rejected with specific failure modes that disqualify them. "Cleaner" is not a failure mode. "Loses all state if the session dies before the batch write completes" is a failure mode. The alternatives section exists so that when an implementation fails, the audit trail shows whether the relevant alternative was considered and rejected.

**Success-criteria-bound.** The plan begins with DONE WHEN: a specific observable outcome an external observer can verify without reading the implementation. Every task in the plan traces to this criterion. Tasks that cannot be traced are either removed or a new task is added that makes the connection explicit. "Tests pass" is a valid DONE WHEN. "The feature works" is not.

**Autonomously chosen and quickly executed on familiar territory.** The system improves over time. As the category library accumulates entries, planning on known failure categories becomes recognition-fast — seconds to load the prior, not minutes to reason from scratch. Novel territory is explicitly slower, with full exploration required and the gap logged for future category creation.

**Self-improving.** Each plan makes the next plan better. The `store-plan` step persists the plan so it is retrievable at survey time for future issues in the same domain. The category library accumulates incidents and refines recognition confidence. The gap between "principle known in abstract" and "negative exemplar retrievable at planning time" closes progressively as the FSI is populated.

---

## Section 3 — The Three Components

### Component 1: Standard Questions (Phase 4.5)

Four mandatory questions that the agent answers before writing any plan. These questions exist because the first plan written without them will address what the issue says to build, not what will make the problem stop happening.

The questions run between Phase 4 (Critique Spec) and Phase 5 (Ask Admin) in kaizen-evaluate. They run after the spec critique so the plan can incorporate what the critique found. They run before Phase 5 so the admin sees a grounded plan, not a first-interpretation plan.

The four questions, in order:
1. What does "done" look like from the outside? (GOAL + DONE WHEN before reading any code)
2. What already exists in this problem area? (grep commands before designing)
3. What is the plan's core assumption and how would you know it's wrong? (HYPOTHESIS + IF WRONG + VALIDATION triple)
4. Where does the test live and what is the seam? (BEHAVIOR + LIVES IN + TESTED IN + SEAM for each significant behavior)

Each question requires looking at something the agent has not yet looked at. The sequence matters: GOAL before code, survey before design, hypothesis before plan, seam before location.

Time cost: 10-20 minutes per evaluation. Infrastructure cost: zero. This is the minimum viable change.

### Component 2: Codebase Grounding

A mandatory survey step before any design is committed. The survey is not an optional artifact — it is the prerequisite for the alternatives step.

What to read, in order:
1. CLAUDE.md Key Files table (10-minute overview of what exists)
2. grep for existing tools in the problem domain (storage, hooks, review, dimensions)
3. package.json for relevant libraries before hand-rolling
4. grep for existing implementations of similar logic

Decision rule for reuse: does the existing tool solve the core problem, or an adjacent problem? If core: use it. If adjacent: note the integration point. If nothing: state explicitly in the plan's Information Retrieved section.

The survey result must appear in the plan as a code block with actual grep output or an explicit "searched, nothing found" statement. Prose claims about what was or wasn't found are not verifiable. Stored grep output is.

### Component 3: Category Library

An accumulated library of failure patterns, each with a recognition signature, structural tests, and incident references. The library makes known failure categories recognition-fast — an agent with a good category match loads the prior in seconds rather than reasoning from scratch.

The library lives at `.claude/kaizen/categories/`, one YAML file per category. Categories accumulate from incidents via `/kaizen-reflect`: when a failure is filed with an FSI-eligible label, the reflect step maps it to an existing category (incrementing incident count) or flags it for a new category if no existing category fits.

Retrieval is three-pass:
1. Keyword pre-filter: scan `trigger_keywords` for the issue's vocabulary
2. Structural test: for each candidate, answer yes/no questions that confirm the structural match
3. Precursor scan: check for the "fragile shape" in the proposed plan

Categories with confirmed matches load as priors into Phase 4.5 Step 3 (alternatives). Ambiguous matches (match confidence 0.5) are noted but do not constrain — they proceed with full exploration. This prevents category capture: agents under time pressure cannot load wrong priors confidently.

---

## Section 4 — Architecture: Three Tiers

### Tier 1: Phase 4.5 in kaizen-evaluate (Now, 1 PR)

Insert Phase 4.5 between Phase 4 and Phase 5 in kaizen-evaluate SKILL.md. Five sequential grounding steps, each with a time budget. No new infrastructure. No new CLI commands. No new files. Single file change: `.claude/skills/kaizen-evaluate/SKILL.md`.

Addresses: Categories 1 (goal extraction), 2 (hypothesis-as-contract), 3 (single design — surfaces the choice), 4 (testability not assessed).

Risk if deferred: Issues #666 (schema built, zero SKILL.md files populated) and #957 (custom storage over existing tools) are repeatable right now. Every evaluation that runs without Phase 4.5 has the same structural exposure.

### Tier 2: Plan Schema + FSI Bootstrap (Next, 1-2 PRs)

Two additions:

First, enforce the structured plan schema in `store-plan`. The sections `## Success Criteria`, `## Information Retrieved`, `## Design Alternatives Considered`, `## Seam Map`, `## Test Plan` must be present. Warn (not error) on missing sections. This creates an auditable trail: a future reviewer can see whether Phase 4.5 was actually performed, not just whether a plan was stored. Advisory, not blocking.

Second, build `src/cli-experience.ts` with `add-entry` and `query` subcommands, bootstrap `.claude/kaizen/categories/` with the 10 initial categories from the failure taxonomy, and wire Phase 0.7 into kaizen-evaluate: query by issue keywords before plan formation begins. Wire `add-entry` into `/kaizen-reflect` as a mandatory step when filing issues with FSI-eligible labels.

Dependency on Tier 1: Phase 4.5 (Tier 1) produces the plan sections that Tier 2 validates. Without Tier 1, the sections won't exist. Without Tier 2, they won't be auditable.

### Tier 3: Category Library + Recognition Algorithm + Plan Battery (Later, 2-3 PRs)

Full category library with 10 YAML files under `.claude/kaizen/categories/`, each with recognition signature, structural test, failure topology, and incident links.

Recognition algorithm: three-pass (keyword pre-filter, structural test, precursor signals), under 60 seconds, outputs confirmed categories with confidence scores. Only matches with confidence >= 0.8 load as priors. Ambiguous matches (0.5) proceed with full exploration.

Plan battery: 7 dimensions enforced after `store-plan`. Blocking only on goal-traceability, hypothesis-validation, codebase-survey, and design-alternatives when the plan touches irreversible decisions. Non-blocking dimensions generate PARTIAL findings with warnings.

Dependency on Tier 2: The plan battery's codebase-survey dimension is only meaningful if the FSI provides context about what to search for. Without FSI data, the dimension degenerates to "did the plan say it searched?" — which is what Phase 4.5 Step 2 already checks without a battery. Build categories from incidents, not from theory.

### Dependency Graph

```
Tier 1 (Phase 4.5)
  |
  |-- produces plan sections (Success Criteria, Information Retrieved, etc.)
  |-- creates grounding discipline before design
  |
  v
Tier 2 (Plan Schema + FSI Bootstrap)
  |
  |-- validates that Tier 1 steps were performed (schema warnings)
  |-- accumulates incident data (FSI entries with trigger keywords)
  |-- surfaces category priors at planning time (Phase 0.7)
  |
  v
Tier 3 (Category Library + Recognition)
  |
  |-- calibrates recognition from Tier 2's incident data
  |-- plan battery uses FSI context for codebase-survey dimension
  |-- confidence scoring requires real incident history
```

Tier 1 without Tier 2: Plans are grounded but not auditable. Compliance is observable only by reading each plan manually.

Tier 2 without Tier 1: Audit trail exists but plans aren't being formed correctly — the sections will be missing.

Tier 3 without Tier 2: Category library has no calibrated incident data. Recognition produces high noise. Categories are theoretically derived, not empirically validated.

---

## Section 5 — The Category Library Design

### Format

Markdown files, one per category, flat directory at `.claude/kaizen/categories/`. YAML frontmatter with structured fields, markdown body for human-readable description and incident narrative.

### Schema

```yaml
---
id: goal-vs-work-item
name: "Goal vs. Work-Item Extraction"
description: "Plan extracts work items from issue but not the success criterion."
anti_pattern_shape: "task list that covers all spec requirements but not the observable failure condition"
preferred_shape: "DONE WHEN criterion derived from issue goal, all tasks trace to it"
trigger_keywords:
  - "implement"
  - "add feature"
  - "close issue"
structural_tests:
  - "Does the issue body contain a sentence describing what a user cannot do now?"
  - "Does the plan contain a DONE WHEN criterion derived from that sentence?"
  - "Do all plan tasks connect to the DONE WHEN criterion?"
incident_refs: [666, 966]
confidence: 0.85
confirmed_recurrences: 4
fragile_designs:
  - "Plan that checks all acceptance criteria without defining observable goal"
  - "Test suite that verifies code correctness without verifying goal fulfillment"
resilient_designs:
  - "DONE WHEN written before reading any code, all tasks traceable to it"
  - "Requirements review battery run post-merge to verify goal fulfillment"
---
```

### Lifecycle

**When to add a new category:** Two triggers: (1) `/kaizen-reflect` identifies a failure that maps to no existing category AND the `match_confidence` for the nearest category is < 0.5, AND at least 2-3 incidents match the new pattern. (2) Admin explicitly requests a new category based on a pattern they recognize.

Do not add categories from theory. Add from incidents. The category is not ready until at least 2 concrete incident refs are available.

**When to edit:** Two triggers: (1) False negative — an incident occurred that the category should have caught, but the `trigger_keywords` were absent from the issue vocabulary. Action: add the missing keyword to `trigger_keywords`. (2) False positive — the category fired on an issue where the pattern didn't apply. Action: tighten the `structural_tests` to add a discriminating yes/no question.

**When to archive:** When the failure mode is no longer relevant to the current codebase. The standard is: if the category has had zero confirmed recurrences in 6 months AND the `anti_pattern_shape` describes a pattern that no longer occurs in the architecture. Archive to `.claude/kaizen/categories/archive/` rather than delete — the incident history remains accessible.

**Consolidation at 30-50+ entries:** When the library reaches 30-50 entries, domain partitioning becomes necessary. Partition by domain prefix: `storage/`, `testing/`, `enforcement/`, `hooks/`, `planning/`. Within each domain, consolidate categories with overlapping `trigger_keywords` into a single category with richer `structural_tests`. The goal is: no two categories should fire simultaneously on the same issue without one being a clear superset.

### Retrieval: Three-Pass Algorithm

**Pass 1: Keyword Pre-Filter (< 5 seconds)**
Scan all category files for `trigger_keywords` overlap with the issue's title and body vocabulary. Return all categories with at least one keyword match. This is intentionally broad — it's a pre-filter, not a match.

**Pass 2: Structural Tests (< 30 seconds per candidate)**
For each candidate from Pass 1, present the `structural_tests` as yes/no questions. The agent answers each based on the issue. Score: number of YES / total tests.
- Score >= 0.8: confirmed match, `match_confidence: 1.0`
- Score 0.5-0.79: ambiguous, `match_confidence: 0.5`
- Score < 0.5: not a match, exclude

**Pass 3: Precursor Scan (< 15 seconds per confirmed match)**
For confirmed matches, scan the proposed plan (if available) or the issue's proposed fix for the `anti_pattern_shape`. If found: "anti-pattern present in proposed design — load preferred shape as alternative."

**Output:** For each confirmed match: category name, `anti_pattern_shape`, `preferred_shape`, incident refs, `match_confidence`. For ambiguous matches: category name, `match_confidence: 0.5`, flag: `proceed-with-full-exploration`.

**Domain Partitioning for Scale:** At 30+ entries, retrieve only from the relevant domain partition. Determine domain from issue labels or body vocabulary: storage-related issues → `storage/` partition; hook-related → `hooks/` partition. This keeps Pass 1 from returning noise as the library grows.

### Proportionality

Familiar category (match_confidence >= 0.8): The agent loads the prior and proceeds. Phase 4.5 Step 3 (alternatives) names the `anti_pattern_shape` as the rejected option with the `preferred_shape` as the selected option. Total overhead: under 60 seconds to run retrieval, near-zero to form the alternatives section.

Novel territory (match_confidence < 0.5, or no match): Full exploration. Phase 4.5 takes its full 10-20 minutes. The absence of a category match is logged after the evaluation completes: `was_category_retrieved_at_design_time: false`. This log becomes the data source for future category creation.

### Starter Set: 10 Initial Categories

Seeded from the 9 failure categories in Section 1.2 plus one high-frequency pattern from the extended evidence:

1. `goal-vs-work-item` — Category 1 above (incidents: #666, #966)
2. `hypothesis-as-contract` — Category 2 above (incidents: #724, #814, #685)
3. `single-design` — Category 3 above (incidents: #966/#970, #758)
4. `testability-cutout` — Category 4 above (incidents: #894, batch jolly-marsupial)
5. `plan-before-survey` — Category 5 above (incidents: #957, #803)
6. `incomplete-deletion-scope` — Category 6 above (incidents: #803, TS migration series)
7. `dual-failure-mode-blindness` — Category 7 above (incidents: #718→#720, #722)
8. `scope-leakage-without-lifecycle` — Category 8 above (incidents: #846)
9. `recursive-failure` — Category 9 above (incidents: #781)
10. `session-boundary-state` — The accumulate-then-flush shape: state accumulated in memory during a session, flushed at session end; resilient alternative is write-through per finding. Incidents: review findings loss in PR #966 pipeline, OOM stop-hook pattern.

---

## Section 6 — The Standard Questions (Phase 4.5)

The following is the complete Phase 4.5 as it would appear in kaizen-evaluate SKILL.md. This is the concrete Tier 1 deliverable, copy-pasteable into the skill file.

**Insertion point:** After the existing Phase 4 (Critique the Spec) and before Phase 5 (Ask the Admin). The full phase ordering becomes: Phase 3 (Assess Implementation) → Phase 3.5 (Hypotheses) → Phase 3.7 (Architecture Fitness) → Scope Reduction Discipline → Phase 4 (Critique Spec) → **Phase 4.5 (Plan Formation)** → Phase 5 (Ask Admin) → Phase 5.5 (Plan Coverage Review) → Phase 6 (Capture Lessons).

---

### Phase 4.5: Plan Formation

Before writing any plan, form it through five grounding steps. These steps exist because the first plan you write without grounding will address what the issue *says* to build, not what will make the problem *stop happening*. The grounding takes 10-20 minutes. It prevents the 30-minute implementation of the wrong thing.

**Extract the success criteria first.** Read the issue body. Find the observable failure that motivated the issue — not the proposed fix, the original pain. Write it in two lines:

```
GOAL: [what the user/system can't do now]
DONE WHEN: [the specific verifiable outcome that means it's fixed]
```

Verifiable means: an external observer can check it without reading the implementation. Write this before you look at any code. Every plan step you add must connect back to DONE WHEN. Steps that don't are building infrastructure, not solving the problem.

**Survey what already exists.** Before designing a solution, read CLAUDE.md's Key Files table. Then grep for existing tools in your problem domain:

```bash
# Storage/attachment problems:
grep -r "cli-section-editor\|write-attachment\|store-plan\|store-metadata" src/ --include="*.ts" -l

# Hook problems:
cat docs/hooks-design.md

# Review/dimension problems:
npx tsx src/cli-dimensions.ts list && ls prompts/
```

For each existing tool you find: does it solve the core problem, or an adjacent one? If it solves the core problem, use it. If it solves an adjacent problem, note the integration point. State what you found (or that nothing was found) in the plan's "Information Retrieved" section. Skipping this step is how plans design custom storage over `cli-section-editor.ts`, which already exists and is tested.

**Generate and reject at least one alternative.** Identify the highest-risk design choice in your plan — the choice that determines where state lives or who owns an inter-component contract. Write two options and reject all but one:

```
OPTION A: [description] — SELECTED
Failure mode if wrong: [one sentence]

OPTION B: [description] — REJECTED
Rejected because: [specific failure mode that disqualifies it]
```

The rejection rationale must name a failure mode, not a preference. "Cleaner" is not a failure mode. "Loses all state if the session dies before the batch write completes" is a failure mode. If there is no irreversible choice in your plan, two options with one-sentence rationale is sufficient. If the plan touches state ownership or interface contracts, three options with named failure modes.

**Validate the proposed fix's assumption.** The issue body's "proposed fix" is the issue author's best guess. Before planning to implement it, state what it assumes and run the fastest test to confirm or falsify:

```
HYPOTHESIS: [what the proposed fix assumes about the root cause]
VALIDATION: [what you will run or read to confirm — must take <15 min]
IF WRONG: [what evidence would disqualify this hypothesis]
```

Run the validation before committing to the plan. For a code behavior issue: reproduce the failure and confirm it matches the description. For a configuration or regex issue: check the proposed value against a concrete case. For an architecture issue: read the affected file and confirm the structure matches what the issue describes. Do not skip this for "obvious" fixes — three of kaizen's most expensive multi-PR cycles came from planning implementations of plausible but wrong hypotheses.

**Map the testability seams before placing any code.** For each significant behavior in the plan, state:

```
BEHAVIOR: [what it does]
LIVES IN: [file.ts, functionName()]
TESTED IN: [tests/test_file.ts or tests/test_file.sh]
SEAM: [the injection point that isolates this for testing]
```

If you cannot name the seam, the behavior is not testable in isolation. Add an extraction task before the implementation task. Red flags requiring extraction: the target location has more than 5 imports, the location is a CLI entry point or script's global scope, or testing it would require mocking more than 3 modules. Extract first, implement second — this is never the optional step.

**Write the plan.** With all five steps complete, write the plan using this structure:

```markdown
## Success Criteria
GOAL: [from step 1]
DONE WHEN: [from step 1]

## Information Retrieved
- [source]: [what you found] — [how it changes or confirms the plan]
- (or: "No relevant existing tools found for [domain]")

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

Store the plan immediately after writing it:

```bash
npx tsx src/cli-structured-data.ts store-plan --issue {N} --repo "$ISSUES_REPO" --file plan.md
```

Then proceed to Phase 5 (Ask the Admin). The plan coverage review (Phase 5.5) runs after the admin approves direction. The plan formed here is the input to that review.

**Time budget:** Simple issue (single file, no new abstractions): 10-12 minutes total. Complex issue (new module, state decision, multi-component wiring): 15-20 minutes. If this phase is taking longer than 20 minutes, you are either designing rather than surveying (go back to step 2 and find what already exists) or the issue requires `/kaizen-prd` before evaluation.

---

## Section 7 — What Exists vs What Needs Building

### What Already Exists

- **kaizen-evaluate phases 0-5**: collision detection, incident gathering, observability assessment, architecture fitness, scope reduction discipline, spec critique. All functional.
- **Plan-coverage review (Phase 5.5)**: runs after plan formation, checks requirements completeness. Functional.
- **kaizen-implement plan template**: structured markdown with approach, testing strategy, scope. Functional but missing the Phase 4.5-required sections.
- **`store-plan` in cli-structured-data.ts**: persists plans on issues. Functional, no schema validation yet.
- **kaizen-reflect**: files incidents, three-way routing to kaizen/host/pattern repos. Functional.
- **Memory files**: MEMORY.md with incident lessons. Functional but not queryable at planning time.
- **GitHub issue archive**: 23+ documented failure cases available. Not indexed for retrieval.
- **docs/hooks-design.md**: hook patterns and anti-patterns. Available for survey step.
- **cli-dimensions.ts**: lists review dimensions. Available for survey step.

### What Does Not Exist

- **Phase 4.5**: the five grounding steps in kaizen-evaluate SKILL.md. The gap this PRD addresses.
- **Plan schema sections in kaizen-implement**: `## Information Retrieved` and `## Design Alternatives Considered` are not in the current plan template.
- **Schema validation in `store-plan`**: no warning when required sections are absent.
- **`src/cli-experience.ts`**: the CLI for FSI query and incident add. Does not exist.
- **`.claude/kaizen/categories/` directory**: category library directory and initial 10 YAML files. Does not exist.
- **Phase 0.7 in kaizen-evaluate**: the pre-plan FSI retrieval step. Does not exist.
- **Recognition algorithm**: the three-pass structural test confirmation. Does not exist.
- **Mandatory category mapping in kaizen-reflect**: the reflect-to-FSI pipeline. Does not exist.

### Critical Gap: Phase 6 Implementation

kaizen-evaluate Phase 6 (Capture Lessons for the System) exists in the SKILL.md. It documents exactly what a lessons system would enable and what needs to be captured. It explicitly states: "The mechanism for storing and surfacing this doesn't exist yet." Phase 6 is documented intent without implementation.

The FSI bootstrap (Tier 2) is the implementation of Phase 6. The category library is the storage mechanism Phase 6 describes as missing. Building Tier 2 closes a documented gap that has been acknowledged in the skill for the entire lifetime of the feature.

---

## Section 8 — Known Risks (from Pre-Mortem)

The pre-mortem evaluated all three systems operating simultaneously in September 2026. Three failure modes are most likely.

### Risk 1: False Confidence from Well-Formed but Ungrounded Plans

**The failure:** The battery evaluates plan text. Text can be correct-looking without being grounded. A plan that claims "no existing tool found" passes the codebase-survey dimension if the battery cannot call grep. The plan is structurally well-formed but factually wrong.

Concrete illustration: Issue #957's failure (custom storage built over existing tools) could survive the battery if the plan's codebase-survey section stated "no existing tool found" — a false statement, but one the battery has no mechanism to verify from text alone.

**Mitigation:** The codebase-survey step in Phase 4.5 requires actual grep output stored in the Information Retrieved section as a code block, not a prose claim. A reviewer (human or hook) can check whether the grep was run and whether the conclusion matches the output. This is partial executable verification rather than text assertion.

For Tier 3's battery: the codebase-survey dimension checks for the presence of grep output (a code block in Information Retrieved), not the claim of a search. This is a stronger signal than checking for a prose statement.

### Risk 2: Retrieval Without Integration

**The failure:** FSI entry retrieved. Context injected into the plan. Plan proceeds with the anti-pattern anyway. The plan's Information Retrieved section cites the FSI entry by title. The design alternatives section doesn't mention the retrieved anti-pattern shape. The retrieval was auditable; the integration was hollow.

**Mitigation:** If the plan's frontmatter lists `fsi_entries_consulted`, the design alternatives section must name the retrieved entry's `anti_pattern_shape` explicitly — not in a summary section, but in the design alternatives analysis. "I considered the accumulate-then-flush anti-pattern and rejected it because the session can die after 30 minutes" is forced acknowledgment that cannot be satisfied by copying the FSI entry title. Citing by shape name is a stronger signal than citing by description.

This is still L1 enforcement. If post-Tier-2 observation shows plans consistently cite FSI entries but proceed with the anti-pattern, the forced-acknowledgment requirement should be elevated from advisory to blocking.

### Risk 3: Category Capture in Novel Territory

**The failure:** The recognition algorithm makes it structurally easier to match than to not-match. Pass 1 returns candidates for anything that shares vocabulary. Pass 2 requires the agent to actively decide the structural test doesn't apply. Agents under pressure take the match. A novel failure mode — a race condition in a new worktree-parallel system — gets classified as `session-boundary-state` because it involves state and sessions. The preferred shape (write-through) is applied. It doesn't help. The race condition was about read ordering, not write timing.

**Mitigation:** Pass 2 (structural test) inverts the burden. YES is a positive answer; ambiguous requires 30 seconds to answer, which is itself evidence of low match quality. Add explicit `match_confidence` to output: 1.0 (clear YES), 0.5 (ambiguous), 0.0 (NO). Only matches with confidence >= 0.8 load as priors. Ambiguous matches are logged as candidates but the agent proceeds with full exploration. Novel-territory path is the default; confirmed-match is the exception.

### Observability Signals (First 3 Months)

- **Plan section compliance rate:** Track fraction of stored plans containing `## Information Retrieved` and `## Design Alternatives Considered`. Target: 100% within 4 evaluations of Tier 1 shipping. If below 80% after 6 evaluations, Phase 4.5 instructions are being skipped.
- **Plan-before-survey incidents:** Count GitHub issues filed with "custom storage built over existing tool" descriptions. Baseline: 2 incidents in 6 months (issues #957 and adjacent). Target: 0 in 8 weeks after Tier 1.
- **Goal-extraction failures:** Count post-merge issues where "implementation was correct but didn't solve the goal." Baseline: 1 confirmed incident (#666). Target: 0 in 8 weeks.
- **FSI retrieval usage (after Tier 2):** Track whether Information Retrieved sections in plans cite FSI entries when relevant. Spot-check 3 plans per month: verify cited entries match what `cli-experience.ts query` returns for that issue's keywords.
- **Admin override rate:** If the battery blocks more than 20% of the time (when built), the system is miscalibrated. Above 20% means overhead is too high, not that agents are being sloppy.

---

## Section 9 — Implementation Sequencing

### Issue 1 — Phase 4.5 in kaizen-evaluate (Ship First)

**Title:** `feat(kaizen-evaluate): add Phase 4.5 Plan Formation — four mandatory grounding steps before any plan is written`

**Scope:** Single file change: `.claude/skills/kaizen-evaluate/SKILL.md`. Insert the complete Phase 4.5 block (Section 6 above) between Phase 4 (Critique the Spec) and Phase 5 (Ask the Admin). Also update the Workflow Tasks table: add row between Task 4 (Critique spec) and Task 5 (Ask admin): `4.5 | Plan Formation | Four grounding steps: success criteria, codebase survey, alternatives, hypothesis validation, testability seams`.

**Acceptance criteria:**
- The five steps appear in SKILL.md between Phase 4 and Phase 5 with imperative voice matching adjacent phases
- Each step has an explicit time budget
- The plan output template (Success Criteria / Information Retrieved / Design Alternatives Considered / Tasks / Seam Map / Test Plan) appears as the final sub-step
- `store-plan` command appears at the end of Phase 4.5
- Workflow Tasks table has the 4.5 row

**Success signal:** Plans produced after this change contain `GOAL:` and `DONE WHEN:` lines, an `Information Retrieved` section with grep evidence or explicit "nothing found" statements, and an `OPTION A / OPTION B` pair at the highest-risk design choice.

**Dependencies:** None. This is the MVC.

### Issue 2 — Plan Schema Enforcement in kaizen-implement

**Title:** `feat(kaizen-implement): enforce plan schema sections — Information Retrieved and Design Alternatives Considered required`

**Scope:** Two changes:
1. `.claude/skills/kaizen-implement/SKILL.md` — In Step 0b (Plan Formation), update the plan template to add two required sections: `## Information Retrieved` and `## Design Alternatives Considered`.
2. `src/cli-structured-data.ts` or `src/plan-store.ts` — Add soft schema validation to `store-plan`: warn (exit 0, print warning) when the plan text is missing `## Information Retrieved` or `## Design Alternatives Considered`. Warning format: `[plan-schema] Missing section: "Information Retrieved" — plans should document what was surveyed before designing`. Advisory, not blocking.

**Acceptance criteria:**
- `store-plan` warns (does not error) when `## Information Retrieved` is absent
- `store-plan` warns when `## Design Alternatives Considered` is absent
- `store-plan` exits 0 in both cases
- kaizen-implement's plan template has both sections
- `npm test` covers the warning path

**Dependencies:** Issue 1 (Phase 4.5 produces these sections; Issue 2 validates they were produced).

### Issue 3 — Failure Signature Index (FSI) Bootstrap

**Title:** `feat(kaizen-experience): bootstrap FSI store with 10 categories from documented incidents — Phase 0.7 retrieval in kaizen-evaluate`

**Scope:** Three parts:
1. Create `.claude/kaizen/categories/` directory with 10 YAML files from Section 5's starter set.
2. Build `src/cli-experience.ts` with `query --keywords "..." --limit 3` (keyword scan against `trigger_keywords`, returns top-N matches as plain text) and `add-incident --category <id> --issue <N>` (increments incident_refs).
3. Insert Phase 0.7 in kaizen-evaluate SKILL.md between Phase 0.5 and Phase 1: "Run `npx tsx src/cli-experience.ts query --keywords <3-5 keywords from issue title/body>`. If entries returned, note anti_pattern_shape for each before Phase 4.5 Step 3. If no entries, proceed."

**Acceptance criteria:**
- `.claude/kaizen/categories/` exists with 10 YAML files matching Section 5 schema
- `npx tsx src/cli-experience.ts query --keywords "state session hook"` returns at least 2 matching entries
- Phase 0.7 appears in kaizen-evaluate SKILL.md
- `npm test` covers query command: keyword match, no-match, limit behavior

**Dependencies:** Issues 1+2. Ship after Issue 1 has run for at least 4 real evaluations to validate that Phase 4.5's survey step catches plan-before-survey failures independently before adding FSI retrieval speed.

### Issue 4 — Category Recognition Algorithm

**Title:** `feat(kaizen-experience): add two-pass category recognition — keyword scan plus structural test confirmation`

**Scope:** Extend `src/cli-experience.ts` with a `recognize` subcommand: Pass 1 (keyword scan, existing from Issue 3), Pass 2 (structural tests as yes/no questions, `match_confidence` output: 1.0 / 0.5 / 0.0). Only return categories with confidence >= 0.8 as confirmed matches. Ambiguous matches (0.5) returned with `low-confidence — proceed with full exploration` flag. Update Phase 0.7 in kaizen-evaluate to call `recognize` instead of `query`.

**Acceptance criteria:**
- `recognize --issue-text "..."` returns confirmed matches only when structural tests are clearly YES
- Ambiguous inputs produce `match_confidence: 0.5` with the full-exploration flag
- `npm test` covers: clear match, ambiguous match, clear non-match, confidence update path

**Dependencies:** Issue 3 with at least 8-10 real incident entries logged across at least 3 different categories. Do not build recognition before the incident data exists to calibrate it.

### Issue 5 — kaizen-reflect Mandatory Category Mapping Step

**Title:** `feat(kaizen-reflect): add mandatory incident-to-category mapping step`

**Scope:** After filing an issue in kaizen-reflect, add a step: "Run `npx tsx src/cli-experience.ts query --keywords <issue keywords>`. If a category matches, run `add-incident --category <id> --issue <N>`. If no category matches, log: `was_category_retrieved_at_design_time: false` — this issue may warrant a new category if 2 more incidents match the same pattern."

**Acceptance criteria:**
- kaizen-reflect SKILL.md has the category mapping step
- `add-incident` CLI command works and increments `incident_refs` in the correct category file
- `npm test` covers the reflect-to-FSI path: match found, no match found

**Dependencies:** Issue 3 (FSI must exist before reflect can map to it).

---

## Knowledge Flow Checklist

Per kaizen-prd requirements — which files change and what new files are created:

**SKILL.md files that change:**
- `.claude/skills/kaizen-evaluate/SKILL.md` — Phase 4.5 inserted (Issue 1), Phase 0.7 inserted (Issue 3), Phase 0.7 updated to `recognize` (Issue 4)
- `.claude/skills/kaizen-implement/SKILL.md` — Plan template sections updated (Issue 2)
- `.claude/skills/kaizen-reflect/SKILL.md` — Category mapping step added (Issue 5)

**Docs that need updating:**
- `.claude/kaizen/workflow.md` — Add Phase 4.5 to the workflow task table description
- `docs/artifact-lifecycle.md` — Add FSI entries and category YAML to the artifact chain

**New files created:**
- `.claude/kaizen/categories/` — Directory with 10 YAML category files (Issue 3)
- `src/cli-experience.ts` — FSI query and add-incident CLI (Issue 3, extended in Issue 4)

**Existing infrastructure reused (not built):**
- `src/cli-structured-data.ts` — `store-plan` extended with schema validation (Issue 2)
- `src/cli-dimensions.ts` — Referenced in Phase 4.5 survey step, no changes
- `docs/hooks-design.md` — Referenced in Phase 4.5 survey step, no changes

---

*The bet: Phase 4.5 is the MVC because it addresses the most common failure modes at zero infrastructure cost. The FSI bootstrap makes the category library empirically grounded rather than theoretically derived. Build in that order. Test against real evaluations. Update when evidence contradicts the model.*
