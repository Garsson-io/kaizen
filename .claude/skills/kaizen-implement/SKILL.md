---
name: kaizen-implement
description: Execution engine — takes scope set by /kaizen-write-plan and turns it into working code. Triggers on "implement spec", "implement prd", "start implementation", "pick up spec", "execute spec". ALSO triggers on greenlight phrases after discussing concrete work — "lets do it", "go ahead", "build it", "start on this", "do it", "make it happen", "go for it", "ship it", "yes do it". Always uses EnterWorktree for isolation. Always calls ExitWorktree on completion.
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Implement Spec — Execution Engine

## Quick Reference

**Input artifact:** grounding attachment from `/kaizen-write-plan`
```bash
npx tsx src/cli-structured-data.ts retrieve-grounding --issue {N} --repo "$ISSUES_REPO"
```

**Output artifacts:**
- Plan attachment (brief execution note): `store-plan --issue {N}`
- PR with `Fixes $ISSUES_REPO#N` in body
- Merged code

**Tasks:** Create at start via **TaskCreate** — 11 tasks (see Workflow Task Plan below)

**Tools used in this skill:**
- **TaskCreate** / **TaskUpdate** — progress tracking at every step
- **EnterWorktree** — create isolated worktree (NOT claude-wt)
- **ExitWorktree** — ALWAYS called at end, even on failure
- **Agent tool with `subagent_type=general-purpose`** — review battery subagents in parallel
- Review-PR loop: max 3 rounds. Each round: fix findings → commit → push → re-run review

**Disciplines — non-negotiable:**
- **ONE PR at a time.** Called with a single issue/sub-issue number.
- **No dirty files.** Every changed file must be committed before ExitWorktree.
- **No abandoned worktrees or branches.** ExitWorktree is always called.
- **EnterWorktree only** (not claude-wt — that's an interactive shell alias).

**Flow:**
```
retrieve-grounding → EnterWorktree → store-plan (brief note) → TDD RED → TDD GREEN
→ [push → review-pr → fix loop (max 3 rounds)] → CI → merge → ExitWorktree → reflect
```

---

**Role:** The execution engine. Takes scope set by `/kaizen-write-plan` and turns it into working code. Does NOT decide scope — if re-examination reveals the scope should change, escalate to the admin or loop back to `/kaizen-write-plan`.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Specs are hypotheses. Incidents are data."* and *"The most dangerous requirement is the one nobody re-examined."*

**When to use:**
- `/kaizen-write-plan` produced a grounding and admin approved
- A spec exists (from `/kaizen-prd`) and implementation is starting
- You're picking up a spec that was written days/weeks ago
- You've finished one sub-issue and are moving to the next

**The key insight:** Specs rot. The codebase has changed. Understanding has deepened. Things that seemed important when the spec was written may be irrelevant now. Things the spec didn't anticipate may be obvious now. The spec's value is the *problem taxonomy and direction*, not the specific solutions it proposed.

## Case Gate — MANDATORY before writing any code

Before touching any source code, verify a case exists. The `enforce-case-exists.sh` hook (Level 2) will block edits in worktrees without a case, but you should create the case proactively rather than being blocked.

**Checklist:**
1. **Issue still open?** Before entering a worktree or creating a case, verify the issue isn't already fixed:
   ```bash
   gh issue view {N} --repo "$ISSUES_REPO" --json state
   git log --oneline --all --grep="#{N}" | head -5
   ```
   If closed or a commit references it, STOP — report to admin before proceeding.
2. **Case exists in DB** for the current branch (skip if `$KAIZEN_CLI` is not configured):
   ```bash
   $KAIZEN_CLI case-by-branch "$(git rev-parse --abbrev-ref HEAD)"
   ```
3. **Case has `github_issue` linked** (when working on a kaizen issue)
4. **Case status is `ACTIVE`**

If any check fails and `$KAIZEN_CLI` is configured, create the case via the CLI before proceeding:
```bash
$KAIZEN_CLI case-create --description "your description" --type dev --github-issue N
```
The CLI **auto-detects your current worktree** — if you're already in one, it adopts it instead of creating a duplicate. No need for `--worktree-path`/`--branch-name` flags. Use `--new-worktree` to force creation of a fresh worktree instead.

Works without `dist/` (uses tsx directly from source — no build step needed).

**When `$KAIZEN_CLI` is not available** (e.g., kaizen self-dogfood repo): Skip case DB checks. The worktree and branch name serve as the case identifier. The `enforce-case-exists.sh` hook will still fire — it checks for worktree isolation, not the case DB.

For kaizen issues, always pass `--github-issue` to link the case to the existing issue. Container agents should use `case_create` MCP tool instead.

**Naming convention for kaizen work:** `YYMMDD-HHMM-kNN-kebab-description` (e.g., `260318-2107-k21-fix-newline-prefix`). The `kNN` segment embeds the kaizen issue number, making it visible in worktree names, branch names, and `git worktree list` output — even if the DB step is somehow skipped.

## Workflow Task Plan — Create at Session Start (MANDATORY)

**Step 0:** Read the grounding from `/kaizen-write-plan` — this is the canonical plan:
```bash
npx tsx src/cli-structured-data.ts retrieve-grounding --issue {N} --repo "$ISSUES_REPO"
```

Then discover review dimensions:
```bash
npx tsx src/cli-dimensions.ts list
```
Read the `high_when` signals for each dimension against your issue to identify which matter most.

Then use **EnterWorktree** to enter an isolated worktree. Then post a brief execution note and store it:

```bash
npx tsx src/cli-structured-data.ts store-plan --issue {N} --repo "$ISSUES_REPO" --file plan.md
```

The plan note content:
```
## Execution Note

Grounding confirmed from issue #{N} (retrieved via retrieve-grounding).
Starting execution per grounding task list and test plan.

High-priority review dimensions: [list from cli-dimensions.ts list based on high_when signals]
```

The `plan` slot is kept populated (review-battery reads it via `retrievePlan()`). The canonical plan lives in the `grounding` slot. See `docs/artifact-lifecycle.md`.

**Create ALL of these tasks using TaskCreate:**

| # | Task | Description |
|---|------|-------------|
| 1 | Read grounding + enter worktree | retrieve-grounding → check review dims → EnterWorktree → store-plan (brief note) |
| 2 | Write failing tests (TDD RED) | Express invariants from grounding's test plan. Must fail before implementing. |
| 3 | Implement (TDD GREEN) | Make tests pass with simplest correct change. Full suite green. |
| 4 | Push + create PR | Stage, commit, push, gh pr create with `Fixes $ISSUES_REPO#N`. |
| 5 | Review battery (round 1) | `/kaizen-review-pr` — spawn subagents via Agent tool for all dimensions. Store findings via `store-review-finding`. |
| 6 | Review fix loop | Fix MUST-FIX + SHOULD-FIX. Commit + push. Re-run review. Max 3 rounds total. |
| 7 | Requirements coverage review | Agent tool with `prompts/review-requirements.md`. Fix MISSING/PARTIAL. Max 3 rounds. |
| 8 | Related Issues Sweep | Search for open issues this work fully/partially fixes. Update PR body. |
| 9 | Wait for CI + merge (squash) | `gh pr checks`. Fix failures. Squash merge. Verify merged. |
| 10 | Kaizen reflection | Launch kaizen-bg subagent via Agent tool. Wait for KAIZEN_IMPEDIMENTS to clear gate. |
| 11 | Cleanup | ExitWorktree (remove). Verify branch deleted. Verify issue closed. |

Mark each task **in_progress** via **TaskUpdate** before starting. Mark **completed** when done.

**Review fix loop (task 6):** Max 3 rounds. Each round:
1. Fix all MUST-FIX (≥80 confidence) and SHOULD-FIX (75-79) findings
2. Commit + push
3. Re-run `/kaizen-review-pr`
4. If still findings and rounds < 3: repeat
5. If round 3 and still unclean: escalate via `gh pr comment` — do not merge

**Adapt the list:** Docs-only PRs skip TDD (#2-3). Delete tasks explicitly with a reason — never silently skip.

**Hooks that fire during implementation:** See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for the full hook map.

## Re-examine the Spec

Before touching code, re-examine the spec against current reality. *"Specs are hypotheses. Incidents are data."*

### Question the requirements

Every requirement in the spec was added by someone smart at some point. That doesn't make it right *now*.

**For each section of the spec, ask:**
- Is this still true? Has the codebase changed since this was written?
- Is this still needed? Has the problem been partially solved by other work?
- Who added this requirement? (Check git blame on the spec.) Are they still the right person to validate it?
- What happens if we just... don't do this part?
- **Is there dead code related to this issue?** Removing dead code simplifies the fix and prevents it from causing future confusion. Deletion is a feature, not a risk.

**Concrete actions:**
- Re-read the spec's problem statement. Do the incidents it cites still reproduce?
- Check git log since the spec was merged. Did any PR already address part of it?
- Check if any "Needs Building" items from the spec now exist.
- Check if any "Open Questions" from the spec have been answered by subsequent work.

*"The most dangerous requirement is the one everyone assumes is true but nobody has re-examined."* A spec written when we were at L5 on the test ladder might propose L6 infrastructure that's already been built. A spec that assumed `processGroupMessages` was untestable might not know about a recent DI refactor.

### Check freshness, not scope

This step is about **accuracy** — is the spec still true? — not about **scope** — can we do less? Scope was decided in `/kaizen-write-plan`.

If re-examination reveals something significant has changed (e.g., half the spec was already built by another PR, or a key assumption is wrong), **don't unilaterally skip it**. Flag it to the admin: "The spec assumed X but Y is now true — should we adjust scope?" That's a write-plan decision, not an implementation decision.

**Solution fitness check (kaizen #714):** If during re-examination you realize the spec's proposed solution may address the wrong failure mode or use an unnecessarily complex mechanism, halt and surface the concern before implementing. A correct implementation of the wrong spec wastes more time than pausing to validate. See `/kaizen-write-plan` Phase 4 "Scope + Architecture" for the 5-question check.

**The spec was written to be complete. Implementation should match the problem.** Not everything in the spec needs to be built right now — but what you do build should be built well. *"Avoiding overengineering is not a license to underengineer."*

### Surface the encoded hypothesis (kaizen #348)

Every spec encodes a hypothesis about the root cause, even if it does not say so explicitly. Before implementing, make that hypothesis visible:

```
SPEC HYPOTHESIS: This spec assumes [X causes Y].
IF WRONG: [what would be true instead, and what consequence that has for the implementation]
VALIDATION: [has any experiment, incident, or code reading confirmed this?]
```

**Why this matters:** When the hypothesis is implicit, you cannot tell whether you are fixing the right thing. You implement the spec, ship the PR, and only discover the root cause was different when the problem recurs. Making the hypothesis explicit lets you check it before committing hours of work.

**If the hypothesis has NOT been validated:**
- Is there a 15-minute experiment that would confirm or falsify it? Run it first.
- Does the code tell a different story than the spec? Trust the code.
- Are there incidents that contradict the hypothesis? Trust the incidents.

**If the hypothesis IS validated:** State the evidence and proceed. This is not busywork — it is a 2-minute checkpoint that prevents multi-day rework.

## Work Classification — BEFORE writing code (kaizen #257)

Before diving into implementation, classify what TYPE of work this is. Different types have different risk profiles:

| Type | Description | Key risk | Mitigation |
|------|-------------|----------|------------|
| **New feature** | Adding capability that doesn't exist | Scope creep, over-engineering | Smallest viable step, ship early |
| **Bug fix** | Correcting incorrect behavior | Fixing symptoms not root cause | Path-trace the full chain first |
| **Refactor** | Restructuring without behavior change | Behavior accidentally changes | Tests must pass before AND after |
| **Split/Extract** | Moving code to a new location | Callers silently break | Grep all callers, update every one |
| **Integration** | Connecting existing components | Interface mismatch at boundary | Test the boundary, not just each side |

**Why this matters:** A "split/extract" that's treated like a "new feature" will miss caller updates. A "refactor" without the "tests pass before AND after" discipline may silently change behavior. Name the type, apply its discipline.

## Kaizen Issue Lifecycle Tracking

When implementing work linked to a kaizen issue, maintain the issue's status throughout the lifecycle. This prevents other agents from picking the same work and provides visibility into progress.

### On case creation

When creating a dev case for a kaizen issue, **always pass the kaizen issue number as `githubIssue`** in the case creation request. Do NOT let the system auto-create a new issue — the kaizen issue already exists and should be reused.

The L3 enforcement in `ipc-cases.ts` will:
- Auto-sync `status:active` label to the kaizen issue via `case-backend-github.ts`
- Block creation if another active case already references this issue (collision detection)

### On PR creation

After creating a PR, link it to the kaizen issue and ensure auto-closure on merge:
```bash
# Add has-pr label
gh issue edit {N} --repo "$ISSUES_REPO" --add-label "status:has-pr"
# Add PR link as comment
gh issue comment {N} --repo "$ISSUES_REPO" --body "PR: {pr_url}"
```

**CRITICAL: The PR description body MUST include `Fixes $ISSUES_REPO#{N}`** (with the full `owner/repo` prefix). This tells GitHub to auto-close the kaizen issue when the PR merges. Without this, issues stay open after PRs merge and epic progress tracking breaks. When `$ISSUES_REPO == $HOST_REPO` (same repo), `Fixes #{N}` also works.

### On case completion

The L3 enforcement in `case-backend-github.ts` handles this automatically:
- Syncs `status:done` label to the kaizen issue
- Closes the issue if the case is marked done

You don't need to manually update labels on completion — the code does it.

### On sub-issue closure — update the parent epic

When a sub-issue is closed (either by PR merge or case completion), **update the parent epic issue body**:

1. **Check off the completed item** in the Progress checklist (`- [x] #N`)
2. **Update "Current State"** with what was actually built (1-2 sentences)
3. **Update "Next Step"** with the recommended next sub-issue and why

```bash
# Find the parent epic — look for task list references to this issue
gh issue list --repo "$ISSUES_REPO" --state open --label "kaizen" --search "#{N}" --json number,title
# Then edit the epic body with updated progress
gh issue edit {EPIC} --repo "$ISSUES_REPO" --body "$(cat <<'BODY'
... updated body with checked items, current state, next step ...
BODY
)"
```

This keeps the epic as a living dashboard for any agent or admin picking up the next sub-issue.

## Reuse Check — BEFORE writing utility code

Before writing any code that parses, transforms, validates, or wraps a format/protocol/API, stop and check what already exists. See [verification.md § Pre-Implementation Check](../../kaizen/verification.md) for the full discipline.

**Quick check:**
1. `grep` package.json for relevant libraries (yaml, zod, ajv, marked, etc.)
2. `grep -r` the codebase for similar patterns
3. If a library exists: use it. If codebase has a pattern: follow it.

**This is not optional.** Hand-rolling solved problems creates fragile code, wastes time, and the self-review rationalization ("keeping deps minimal") is a known anti-pattern (kaizen #334).

## Hypothesis Formation — BEFORE fixing bugs

When the work involves fixing a bug or investigating a system behavior, form an explicit hypothesis before writing code. See [experiments/README.md](../../kaizen/experiments/README.md) for the full methodology.

**Before implementing a fix, state:**
```
HYPOTHESIS: [what you think is happening and why]
FALSIFICATION: [what evidence would prove this wrong]
EXPERIMENT: [fastest way to test — minutes, not hours]
```

**Why:** Jumping from "I see a bug" to "here's my fix" skips the diagnostic step. You may fix a symptom while the root cause persists, or fix the wrong thing entirely. A hypothesis forces you to think about what you're assuming.

**When to use the experiment CLI:**
- For bugs with unclear root causes: create a formal experiment (`npx tsx src/cli-experiment.ts create`)
- For A/B comparisons of approaches: use the a-b-compare pattern
- For quick diagnostics: state the hypothesis inline (in a commit message or PR body) — not everything needs formal tracking

**When to skip:** One-line fixes where the root cause is obvious from the stack trace. State "root cause is obvious: [reason]" in the PR.

## Testability Pre-Flight — BEFORE writing code

Before adding logic to an existing file, assess the testability cost. *"Avoiding overengineering is not a license to underengineer."*

**For each file you're about to modify, ask:**
- How many imports does this file have? (Check the import block at the top.)
- If I add branching logic here, how many modules would I need to mock to test it?
- If the answer is >3 mocks, **extract the new logic into a separate, testable function or file first** — then call it from the existing file.

**This is not about scope reduction** — it's about doing the work in a way that's testable from the start, not discovering testability problems after the code and tests are written.

**The signal to watch for:** You're about to add an if-branch to a 500+ line file with 10+ imports. Stop. Extract first, then add.

## TDD — Write Failing Tests First (MANDATORY)

After re-examining the spec and before writing any production code, write failing tests that express the target invariants. This is not just about test coverage — **tests-first is a diagnostic tool** that reveals bugs and misunderstandings that code reading alone misses.

*Incident that motivated this: kaizen #120 — TDD revealed a second bug (null `github_issue_url`) that pure code reading missed. The failing test was the diagnostic that found the real bug surface.*

### The RED-GREEN-REFACTOR cycle

**RED — Write failing tests first:**
1. State the invariants explicitly (per CLAUDE.md's Invariant Statement requirement)
2. Write test file(s) expressing the target behavior — what SHOULD be true after the fix
3. Run the tests. **They must fail.** If they pass, either:
   - The problem is already fixed (re-examine — is this work still needed?)
   - Your tests aren't testing the right thing (fix the tests)
4. Confirm they fail **for the expected reason** — not for an import error, mock issue, or unrelated crash

**GREEN — Write minimal production code:**
5. Make the failing tests pass with the simplest correct change
6. Run the full test suite — no regressions

**REFACTOR — Clean up:**
7. Improve code structure if needed, keeping tests green

### Why this ordering matters

- **Tests written after code** verify what you built — they confirm your implementation, not your understanding
- **Tests written before code** verify what should be true — they catch gaps in your mental model
- **Unexpectedly passing tests** reveal that the problem is different than you thought (kaizen #120: the host-side handler already worked, the bug was elsewhere)
- **Unexpectedly failing tests** reveal bugs you hadn't noticed (kaizen #120: `github_issue_url` was null — a second bug invisible during code reading)

### When to skip (rare)

TDD may not apply when:
- The change is purely docs/config with no testable behavior
- You're writing a spec or PRD (no production code)
- The change is a one-line fix where the existing test suite already covers the invariant (state why in the PR)

When you skip TDD, say so in the PR body and explain why.

## The Implementation Loop

After writing failing tests, you have both a refined understanding AND a concrete definition of done. Now execute:

### 1. State what you're building

One paragraph. What's the concrete deliverable? Not "implement the test ladder spec" but "add mount-security unit tests covering symlink traversal and blocked pattern matching, bringing X3 from None to L2."

### 2. Check the progressive detail principle

The spec should have detailed solutions for the current level and rough outlines for the next level. If you're about to implement something the spec left as a rough outline, that's a signal: you need to refine the spec for this level before coding. Add detail to the spec (as a new commit in the implementation PR or a separate docs PR) and then implement against the refined spec.

If you're about to implement something the spec left as an open question, **stop**. That's a signal the spec needs another round of `/kaizen-prd` or `/kaizen-write-plan` for this specific area. Don't design and implement in the same breath — that's how you get solutions that weren't examined.

### 3. Find the low-hanging fruit

What's the smallest change that:
- Moves a capability up at least one ladder rung?
- Is testable (you can prove it works)?
- Is independently valuable (doesn't depend on future PRs to be useful)?

This is your first PR. Ship it. Get feedback. Then repeat.

### 4. After each phase, update the PRD

When you complete a phase (or a meaningful chunk of a phase), **update the spec document before moving on**. This is not optional — a stale spec is actively harmful because it creates false confidence about what's planned vs what's real.

**The update follows the progressive detail principle:**

1. **Move completed work to "Already Solved"** (Section 7 or equivalent). Record what was actually built, not what the spec predicted. Include learnings — e.g., "DI refactor was simpler than expected because the module had few callers" or "blocked pattern matching had a subtle bug the spec didn't anticipate."

2. **Refine the next phase with real detail.** Now that you've done Phase N, you know things the spec author didn't. Phase N+1's rough outline should become concrete: specific files, specific test counts, specific DI interfaces. This is the detail level that Phase N had before you started it.

3. **Be selective about touching future phases.** A spec has two kinds of content: *problem taxonomy* (what the levels/categories/capabilities are, what each proves, what each misses) and *solution detail* (specific files to change, test counts, implementation strategies). Problem taxonomy is the Kardashev scale — it ages well and must never be trimmed. For solution detail in future phases: **most of the time, leave it alone.** It was written thoughtfully and will be re-examined when that phase begins. The main action is **adding** implementation hints when the current phase produced genuine insight relevant to a future phase — e.g., "the DI pattern in mount-security.ts was simpler than expected; index.ts may benefit from the same approach." As the spec matures through multiple phases, future steps will already be well-specified and rarely need changes. Trim future solution detail if it's actively misleading (contradicts what you just learned) or if the spec is genuinely too prescriptive about implementation for distant phases — but never as a routine cleanup step. The judgment call is: "Is this detail constraining future implementors more than it's helping them?"

4. **Update the gap analysis.** Capabilities that climbed a rung should be updated in the inventory. New gaps discovered during implementation should be added.

**The rhythm:** implement → update spec → implement next → update spec. The spec evolves as a living document, getting more detailed at the frontier and more abstract in the distance. Git history preserves the original detail for anyone who wants it.

**Anti-pattern: "I'll update the spec later."** You won't. The learnings are freshest right after implementation. The update is part of the phase, not an afterthought.

### 4b. Documentation and policy deliverables

When your implementation introduces **new operational processes** — scripts operators must run, policies for when to clean up resources, new lifecycle management, new scheduled tasks — you must produce documentation alongside the code. Code without docs creates tribal knowledge that agents and humans can't discover.

**Ask yourself:** "If someone encounters this system for the first time in 3 months, what do they need to know to operate it?" If the answer is more than "read the code," write docs.

**What to produce:**

1. **Operational documentation** (`docs/{feature-name}.md`): How it works, when to run it, what the policy is. Written for operators (both human and agent). This document captures **what we built and why** — not the implementation plan (that's in the PRD/issue), but the lasting description of the system as it exists now, plus the vision for where it's going.
2. **CLAUDE.md section**: Brief policy summary that agents see in every conversation. Link to the full docs. Keep it to 5-10 lines — CLAUDE.md is expensive context.
3. **Skill (if interactive)**: When the feature has a "run this when X happens" flow, create a skill that guides the user through it (e.g., `/docker-gc` for cleanup workflows).

**Issue-only PRDs → repo docs:** When the PRD lives only in a GitHub issue (not a `docs/*-spec.md` file), the knowledge about what was built and the future vision must still land in the repo. GitHub issues are ephemeral — they get closed, buried, and disconnected from the code. The repo docs (`docs/{feature}.md`) are the lasting record. After implementation, the repo doc should contain:
- **What we built** — the system as it exists now, with concrete details
- **Operating policy** — when to run what, what the thresholds are
- **Future vision** — deferred work, next steps, where this is heading
- **Design decisions** — why we chose X over Y (from the PRD discussion)

This is not duplicating the issue — it's transforming planning artifacts into lasting system documentation.

**When to skip:** Pure library code, internal refactors, bug fixes, test additions — these don't need operational docs. The test is: does this change introduce a new **operational process** that someone needs to know about?

**Anti-pattern: "The code is self-documenting."** Shell scripts with `--help` flags are not documentation. They tell you what flags exist, not when to run the command, what the policy is, or what happens if you don't.

### 4b-ext. Methodology cross-check — does the parent epic's knowledge live in the repo? (kaizen #381)

After completing documentation deliverables, check whether the parent PRD or epic contains **process insights or methodology** that should be in the repo but aren't. This is the safety net for knowledge that the PRD author didn't capture via the Knowledge Flow Checklist.

**Ask:**
- Does the parent epic/PRD propose skill prompt changes? Are they applied?
- Does it contain process patterns ("always do X before Y") that should be in a SKILL.md?
- Does it reference methodology (hypothesis formation, progressive detail, escalation rules) that future agents need but can only find by reading the GitHub issue?

**If gaps exist:**
- Small gaps (< 10 lines of prompt changes): apply them in this PR alongside the code
- Large gaps (new skills, major doc rewrites): file a sub-issue with the specific change

**Example:** Epic #334 proposed "hypothesis-driven experimentation" as methodology. Sub-issues #348, #376, #377, #380 designed specific skill prompt changes. But after implementing the code, none of the skill prompts were updated. This cross-check would have caught that: "Epic #334 proposes adding hypothesis formation to /kaizen-write-plan Phase 4 — is it there? No. Apply it now."

### 4c. Adjacent discovery check — what did this work reveal?

After implementation but before moving on, pause and ask:

- **What did I learn about the system that the spec didn't know?** New coupling, unexpected behavior, fragile assumptions — these are findings, not noise.
- **What almost went wrong?** Near-misses (caught by tests, review, or luck) are as valuable as actual incidents. If a test caught a bug you introduced, that's a near-miss — the test worked, but you almost shipped a bug.
- **What tools/patterns did I reach for that didn't exist?** Missing tools are a signal. If you needed a YAML parser and almost hand-rolled one, that's a gap worth noting.
- **What hypothesis did I hold that turned out wrong?** Falsified assumptions are data. Record them — they prevent the next agent from making the same assumption.

**If you discover something:** File it. Don't save it for the kaizen reflection — by then it may be lost in the noise of session wrap-up. The reflection task (created at session start per H6) is the right place to accumulate these throughout the session.

### 5. Re-enter the loop

After updating the spec, the landscape has changed:
- New information may have emerged — does it change the plan?
- The next step may be different than you expected — re-apply the five steps
- The refined Phase N+1 section is now your implementation target

**Don't treat the spec as a checklist to grind through.** Treat it as a map that gets more detailed as you explore the territory.

## Dogfooding — verify by experiencing the problem path (kaizen #212)

After implementation, **reproduce the original problem and verify it's actually fixed.** This is not the same as running tests — tests verify invariants, dogfooding verifies the user experience.

**Checklist:**
1. **Identify the original trigger.** What action caused the problem? (e.g., "run `/kaizen-gaps` when issue #107 is already fixed")
2. **Reproduce the trigger.** Actually do the thing that used to fail. Don't simulate — experience it.
3. **Verify the new behavior.** Does it produce the expected output? Is the error gone? Is the UX what you intended?
4. **Record the result.** Include the dogfooding output in the PR description — it's evidence, not just a claim.

**When to skip:** Pure library refactors with no user-facing behavior change, or when the trigger requires infrastructure you don't have (e.g., testing container behavior without a running container). State why in the PR.

## Relationship to Other Skills

```
/kaizen-prd          → Defines the problem space and taxonomy. Progressive detail.
                       Output: spec document, kaizen issue.

/kaizen-write-plan   → Planning gate. Reads grounding from write-plan, gets admin approval.
                       Output: grounding attachment (canonical plan).

/kaizen-implement     → THIS SKILL. Reads grounding, executes TDD loop, ships PR.
  (this skill)         Does not decide scope — escalate changes to /kaizen-write-plan.
                       Output: working code, merged PR, closed issues.

/kaizen-plan          → Breaks a large implementation into sequenced PRs.
                       Use BEFORE this skill when the work needs multiple PRs.
                       Output: dependency graph, sub-issues.

/kaizen-reflect      → Reflection after implementation. Impediments, incidents, improvements.
                       Output: structured KAIZEN_IMPEDIMENTS, new issues.
```

The flow is: `kaizen-deep-dive → kaizen-write-plan → kaizen-implement → kaizen-review-pr → kaizen-reflect`. `kaizen-implement` may loop back to `kaizen-write-plan` when re-examination reveals the scope should change — but never changes scope unilaterally.

## Dual Failure Mode Check — MANDATORY for behavioral constraints (kaizen #722)

When implementing a behavioral constraint (prompt change, stop condition, scope rule, enforcement rule), you must name both failure modes before shipping:

1. **If this rule is absent — what goes wrong?** (the original bug that motivated the rule)
2. **If this rule is present — what valid behavior does it prevent?** (the over-correction risk)

**If you can't answer both, the constraint isn't fully specified.** Going from one failure mode to the other without naming both is a predictable pattern — the agent focuses on eliminating the original problem and doesn't ask "what valid behavior does this rule prevent?"

**Example — PR #718 (the incident that motivated this):** Fixed auto-dent's blind-loop problem with "one issue per run." The constraint was too restrictive — it prevented intentional bundling that `/kaizen-deep-dive` already handles deliberately. Required a second PR (#720) to correct it. Naming both failure modes upfront would have caught the over-correction.

**How to apply:**
- State both failure modes explicitly in the PR description
- If the constraint is a prompt/SKILL.md change, include an "Exceptions" or "When this rule does NOT apply" section
- If you can't identify the over-correction risk, ask: "What is the most sophisticated valid use case this rule would block?"

This check applies to: SKILL.md prompt additions, hook rules, scope constraints, stop conditions, enforcement policies. It does NOT apply to: bug fixes, feature code, test additions, documentation.

## Anti-patterns

- **Spec-as-checklist.** Grinding through every spec section in order, implementing what it says regardless of whether the world has changed. The spec is a map, not a contract.
- **Implementing open questions.** If the spec says "open question: how should X work?" and you answer it *while coding*, you skipped the thinking phase. Refine the spec first.
- **Skipping re-examination.** Jumping straight to coding without questioning whether the requirements are still valid. This is how you implement solutions to problems that no longer exist. *"The most dangerous requirement is the one nobody re-examined."*
- **Gold-plating.** Adding capabilities the spec mentions as "future work" because you're already in the code. Future work is future work. Ship the current step.
- **Ignoring new information.** Something you discovered during implementation contradicts the spec. Instead of updating the spec and adjusting, you forge ahead with the original plan. *"Specs are hypotheses. Incidents are data."*
- **Over-correcting constraints.** Shipping a behavioral rule that fixes the original bug but blocks valid behavior. Name both failure modes (absent vs present) before shipping — see Dual Failure Mode Check above.
- **Big-bang implementation.** "I'll implement the whole spec in one PR." No. Find the smallest valuable step. Ship it. Loop.

## Recursive Kaizen — Improving the Improvement Process

*"It's kaizens all the way down."* — Zen of Kaizen

This skill is part of the improvement system: `kaizen-deep-dive → kaizen-write-plan → kaizen-implement → kaizen-reflect`. That system itself should improve over time. See the [Zen of Kaizen](../../kaizen/zen.md) for the full philosophy.

The kaizen reflection that fires on `case_mark_done` already captures impediments. If those reflections include "the spec was over-specified for this problem" or "I implemented unnecessary code because I didn't re-examine the spec," that's process feedback, not just work feedback. These reflections, accumulated over many cases, are the raw material for improving the skills themselves.

**Apply these skills to these skills.** When you use `/kaizen-implement`, ask: did the re-examination surface the right things? Did accept-case catch the right issues? When you notice something, mention it in the kaizen reflection. That's how the improvement process improves itself.
