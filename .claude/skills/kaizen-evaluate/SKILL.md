---
name: kaizen-evaluate
description: Evaluate a kaizen case before implementation — gather incidents, find low-hanging fruit, critique specs, get admin input, record lessons. Triggers on "accept case", "evaluate kaizen", "should we do this", "triage kaizen". ALSO triggers when browsing/selecting work — "look at issue #N", "check this PR", "what should we work on", "pick up kaizen #N", "find low hanging fruit", "which case", "what's next", "prioritize", or any discussion of a specific GitHub issue, PR, or kaizen case that precedes implementation.
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Accept Case — Kaizen Case Evaluation

**Role:** The scope gate. Decides WHAT to build and at what level. Gathers evidence, evaluates scope, gets admin approval. Scope decisions live here — `/kaizen-implement` executes the scope this skill sets, and must not change it unilaterally.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Specs are hypotheses. Incidents are data."* and *"No promises without mechanisms."*

Before diving into implementation of a kaizen issue, run this skill to make sure we're solving the right problem, at the right scope, with the right evidence.

Too many kaizen issues go from "abstract problem" to "big spec" to "never implemented." This skill forces concrete thinking: what actually happened, what's the simplest correct implementation, what does the admin think, and what did we learn for next time. **Default to implementing the full solution.** Only split when the pieces are genuinely independent.

## When to use

- Someone says "let's do kaizen #N"
- A spec exists but no implementation has started
- You're about to plan work and want to validate the direction first
- The admin asks you to evaluate or prioritize a kaizen case

## The process

This is a conversation, not a checklist. The phases overlap. Use judgment about what's needed — a tiny issue might skip straight to low-hanging fruit; a complex one might need deep incident archaeology.

### Phase 0: Collision detection

**Before evaluating, check if someone else is already working on this issue — or if it's already fixed.** This prevents wasted effort.

**Check all four sources — labels alone are not authoritative:**

1. **Already fixed?** Check if the issue was already resolved by a merged PR or commit:
   ```bash
   # Check if issue is closed
   gh issue view {N} --repo "$ISSUES_REPO" --json state
   # Search git log for commits referencing this issue
   git log --oneline --all --grep="#{N}" | head -5
   # Search for PRs that fixed this issue
   gh pr list --repo "$HOST_REPO" --state merged --search "#{N}" --json number,title
   ```
   **If the issue is already closed or a merged PR references it, STOP.** Report to the admin: "Issue #{N} appears to be already fixed by {evidence}. Verify before proceeding."

2. **GitHub labels:** Does the kaizen issue have `status:active`, `status:backlog`, or `status:blocked` labels?
   ```bash
   gh issue view {N} --repo "$ISSUES_REPO" --json labels,state
   ```

3. **Active cases in database:** Is there a case linked to this issue?
   ```bash
   $KAIZEN_CLI case-list --status active,backlog,blocked
   # Then filter by github_issue == {N} in the JSON output
   ```
   If `$KAIZEN_CLI` is not configured (e.g., kaizen self-dogfood repo has no case CLI), skip this check.

4. **Open PRs:** Are there PRs referencing this issue?
   ```bash
   gh pr list --repo "$HOST_REPO" --state open --search "kaizen #{N}" --json number,title,headRefName
   ```

**If collision detected**, present the conflict to the admin:
- "Kaizen #{N} is being worked on by case `{name}` (status: {status})"
- "There's an open PR #{M} that addresses this: {title}"
- Ask: **Take over** (claim the issue, coordinate with the other agent), **Assist** (contribute to the existing case/PR), or **Pick different work** (go back to `/kaizen-pick`)?

**If no collision**, proceed to Phase 1.

**On approval (end of Phase 5):** When the admin approves this case for implementation, label the kaizen issue as claimed:
```bash
gh issue edit {N} --repo "$ISSUES_REPO" --add-label "status:backlog"
gh issue comment {N} --repo "$ISSUES_REPO" --body "Claimed for evaluation by accept-case at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

This labeling is defense-in-depth on top of the L3 enforcement in `ipc-cases.ts` (which blocks duplicate case creation for the same kaizen issue). The label makes the claim visible to other agents checking `gh issue list` before they even reach the code-level check.

### Phase 0.5: Check for existing spec

Before doing deep analysis, check if a detailed spec already exists for this issue:

```bash
# Check for linked spec documents
gh issue view {N} --repo "$ISSUES_REPO" --json body --jq '.body' | grep -oE 'docs/[a-z0-9-]+-spec\.md'
# Check issue body length (>100 lines suggests a detailed spec)
gh issue view {N} --repo "$ISSUES_REPO" --json body --jq '.body' | wc -l
```

**If a detailed spec exists (>100 lines or links to a `docs/*-spec.md`):**
- Skip Phases 1-2 (incident gathering and observability assessment) — the spec author already did this work
- Jump to Phase 3 (find low-hanging fruit) with the spec as context
- Phase 4 (critique the spec) and Phase 5 (ask the admin) still apply

This prevents redundant analysis when someone already invested in understanding the problem. The spec is your starting point — verify it's still accurate (Phase 4) rather than re-deriving it.

**If this issue is part of an epic (has a `Parent: #N` reference):** Read the parent epic. Check whether it contains methodology or process patterns that should already be in skills/docs/hooks but aren't. Epics accumulate process insights ("always form hypotheses," "use progressive detail," "escalate on recurrence") that are more valuable than the feature work itself — but they only help future agents if they're in the repo. If you find unapplied methodology, include applying it in this case's scope. (kaizen #381)

### Phase 1: Gather the incidents

Don't work in the abstract. Find what actually happened.

**Search for concrete occurrences:**
- Git log: commits, PR descriptions, review comments that mention the problem
- Hook outputs: kaizen reflections, dirty-file violations, review blocks
- Kaizen issue comments and cross-references
- Agent memory files that reference this pattern

**For each incident, capture:**
- When it happened (date, PR, commit)
- Who was affected (which agent, which human)
- What the observable impact was (time wasted, work blocked, wrong output)
- How it was resolved (workaround, manual fix, abandoned)

**What you're looking for:**
- Frequency — is this weekly or was it twice ever?
- Trend — getting worse, stable, or already improving?
- Clustering — does it always happen in the same context?
- Severity distribution — mostly minor annoyances or occasional major blocks?

If you can't find incidents, that's a signal. Maybe the problem is theoretical, or maybe the observability is missing (which is itself a finding).

### Phase 2: Assess observability

Can you actually tell when this problem happens? If not, that might be the real first fix.

**Questions to answer:**
- What logs/artifacts exist when this occurs?
- Would you notice this problem without someone reporting it?
- If you fixed it, how would you prove it's fixed?
- What data would help the admin decide priority?

If the answer to most of these is "we can't tell," consider whether adding observability is the real low-hanging fruit, not the fix itself.

### Phase 3: Assess the implementation as a whole

**Default to implementing the full deliverable set.** A PR must deliver value, be testable, and be tested — that's the bar. Don't split work into "low-hanging fruit now, rest later" unless the pieces are genuinely independent (different systems, different test suites, different areas of the codebase). "It's complex" is not a reason to split — it's a reason to plan well.

**Assess the implementation by asking:**
- What's the simplest correct implementation of the full solution?
- Is this testable end-to-end? If not, building the test infrastructure is IN SCOPE.
- What's the right order to build the pieces? (Tests first, then implementation, then integration.)
- Are there genuinely independent sub-problems that would ship better as separate PRs?

**When genuine splitting is warranted:** The pieces must each independently deliver value, have their own tests, and not require the other pieces to be useful. "Phase 1: add the config, Phase 2: add the feature that uses it" is NOT a valid split — the config alone delivers no value.

**Issue lifecycle when splitting:** If you split an epic/vague issue into a concrete deliverable, the deliverable is a **sub-issue** — not the main issue. The main issue stays open until its full scope is delivered. The PR should `Fixes #sub-issue`, not `Fixes #main-issue`. This prevents scope reduction from silently closing issues that still have undelivered work.

**Diagnostic tests as an assessment tool:** A failing test that reproduces the reported problem is often the strongest evidence AND the clearest definition of done. If you can express the expected behavior as a test during evaluation, do so — it proves the problem exists, defines when it's fixed, and may reveal the actual bug surface is different than reported (see kaizen #120 where TDD revealed a second bug invisible during code reading).

### Phase 3.5: Form hypotheses — what are you assuming without testing?

Before recommending a solution, make your assumptions explicit. Most kaizen work follows: observe problem → spec solution → implement → hope it works. This misses the scientific method step: **form a hypothesis, design an experiment, test it.**

**For the root cause, state:**
```
HYPOTHESIS: [what you think causes the problem — a falsifiable claim]
WHY IT MIGHT BE WRONG: [what would disprove this]
FASTEST TEST: [experiment that takes minutes, not hours]
```

**For the proposed solution, ask:**
- "What am I assuming about the system that I haven't verified?"
- "If I'm wrong about the root cause, what would I see instead?"
- "Is there a 15-minute experiment that would confirm or falsify this?"

**When the problem has multiple plausible causes**, consider running a quick experiment before committing to implementation. The experiment framework (`npx tsx src/cli-experiment.ts create`) supports structured hypothesis tracking — use it for non-trivial investigations.

**Why this matters:** Kaizen #388 found that agents routinely skip diagnosis and jump to implementation. Hypotheses that are never tested lead to fixes for the wrong problem. A falsified hypothesis is more valuable than an untested assumption — it narrows the search space.

See [experiments/README.md](../../kaizen/experiments/README.md) for experiment patterns (A/B compare, probe-and-observe, toggle-and-measure).

### Phase 3.7: Architecture & Tooling Fitness — MANDATORY assessment

Before accepting work, assess whether you have the right tools to do it well. Bad tooling choices are the root cause of many multi-PR fix cycles — the code works but is untestable, unmaintainable, or fragile.

**For every piece of work, answer these questions:**

| Question | Red flag → Action |
|----------|-------------------|
| What language should this be in? | Bash with complex branching → propose TypeScript with thin bash wrapper |
| What runtime? | tsx when bun is available and faster → use bun |
| What libraries exist for this problem? | None considered → search npm and package.json before hand-rolling |
| Can we test this E2E? | No harness exists → **building the harness is IN SCOPE, not a follow-up** |
| What existing patterns in the codebase should we reuse? | None found → grep before writing |
| What test infrastructure do we need? | Nothing planned → mock helpers, fixtures, shared setup must be scoped |
| What dead code or legacy paths exist in this area? | Working around dead code instead of deleting it → identify and remove dead code as part of the fix |

**The critical rule:** If the E2E test harness doesn't exist, building it is part of this work. Deferring testability is how we get the 4-PR pattern (#400). "Tests later" = no tests. "Harness in a follow-up" = no harness.

**How to apply:** State your tooling assessment in the evaluation output. If the admin approves the work, the tooling choices carry forward to `/kaizen-implement`. If you identify a harness gap, the implement task plan must include building it as a task BEFORE writing the feature code.

### Scope Reduction Discipline — MANDATORY gate

When your evaluation proposes doing less than the full solution — "start with L1, escalate later", "implement the simple version first", "defer the hook to a follow-up" — you are making a promise about future work. **Promises without mechanisms are just scope cuts.**

You may only recommend reduced scope if you also provide **at least one** of:

1. **A mechanistic signal** (non-LLM) that will fire when the deferred work is needed. Examples: a hook that counts `vi.mock` calls and warns above a threshold, a CI check that flags files over N lines, a script that measures duplication. Even noisy signals with false positives are acceptable — they create awareness. The signal doesn't need to be perfect; it needs to exist.

2. **A connection to an existing epic** where progress on that epic naturally surfaces the need. Example: "as we work through the ipc.ts extraction epic (#63), each extraction step will reveal whether the remaining coupling is tolerable." The epic must be open and actively tracked — a stale epic is not a mechanism.

3. **A filed follow-up issue** with concrete trigger criteria. Not "consider L2 later" but a kaizen issue that states: "Implement L2 mock-count warning hook. Trigger: when 3+ test files in a quarter have >5 mocks." The issue must be specific enough that a future agent can evaluate whether the trigger condition has been met.

**If none of these three exist, you must not reduce scope.** Either solve the full problem in the current case, or include building the signal infrastructure as part of the current scope.

**Why this matters:** "Do less now, more later" without a mechanism is just "do less." The "later" never arrives because there's no signal that triggers it. The reduced scope becomes the final scope, and the problem persists silently. This has happened repeatedly in kaizen evaluations — agents propose L1 with "escalate to L2 if needed" but provide no way to detect when L1 has failed.

**This gate applies to:**
- Phase 3 recommendations (low-hanging fruit instead of full solution)
- Phase 5 questions to the admin ("X now, Y later?")
- Any recommendation that defers work to a future case

**Example — wrong:**
> "Start with an L1 prompt addition. If agents still ignore it after 3-5 PRs, escalate to L2."
> *(Who counts the PRs? How do you detect "ignoring"? No mechanism = no escalation.)*

**Example — right:**
> "Start with L1 prompt + L2-warn hook that counts mocks and emits warnings. The warnings create the signal — if we see repeated warnings over the next few cases, that's the trigger to upgrade to L2-block. Filed as kaizen #N with trigger criteria."

### Phase 4: Critique the spec (if one exists)

Read the spec with the incidents in hand. Evaluate:

- **Does the problem statement match the incidents?** Or did the spec drift into abstraction?
- **Are the proposed options proportional?** A 15-minute fix shouldn't have a 300-line spec with comparison matrices.
- **What's missing?** Incidents often reveal aspects the spec didn't consider.
- **What's over-specified?** Options that are clearly wrong shouldn't take up space.
- **Is the most important question buried?** Specs sometimes bury the pivotal decision as an "open question" instead of resolving it first.
- **Is there a simpler framing?** Sometimes the spec is solving the wrong problem at the right scope, or the right problem at the wrong scope.

#### Solution evaluation — is this the right fix? (kaizen #714)

Scope evaluation asks "should we do this?" Solution evaluation asks "is this the right thing to do?" Both are required. Before accepting a spec's proposed solution, answer:

1. **What failure mode does this spec address? Is that the right failure mode?** The spec may describe a symptom while the root cause is elsewhere.
2. **Is the proposed mechanism the simplest one that addresses it? What alternatives exist?** A lint hook, a test, a SKILL.md update, and an architectural change all address "bad code gets committed" — but at very different costs.
3. **Would a simpler fix (one level lower: L3→L2→L1) address the same failure mode?** Don't build L2 enforcement when L1 instructions would suffice. Don't build L3 architecture when L2 hooks would work.
4. **Is this failure mode expected to recur? If not, is prevention worth the overhead?** A one-time incident doesn't necessarily justify a permanent mechanism.
5. **What is the cost of the proposed mechanism?** Maintenance burden, false positives, performance impact, cognitive load on agents. Every mechanism has ongoing cost.

**If any answer raises doubt, surface it before implementing.** Do not ship a correct implementation of the wrong spec. The goal is to catch #685-style mistakes (perfect implementation, wrong solution) before they consume implementation time.

**Red flag:** The spec's solution section reads like a task list ("add hook X, modify file Y, create test Z") instead of describing the desired outcome. That's a sign the solution was the first idea, not the best one.

**If this case is one phase of a larger spec**, also assess the spec's progressive detail:
- Is the current phase detailed enough to implement without guessing?
- Are distant phases over-specified with solution details that will be wrong by the time we get there?
- Does the spec need updating *before* implementation (current phase is unclear) or *after* (current phase is fine, future phases need trimming)?
- If the spec doesn't need updating before implementation, say so — don't block real work on spec maintenance.

The `/kaizen-implement` skill handles PRD updates after each phase. Your job here is to flag if the spec's current state would *block or mislead* implementation, not to preemptively rewrite it.

**Check for documentation deliverables:** If the spec introduces new operational processes (scripts to run, cleanup policies, lifecycle management), verify that the spec explicitly lists documentation as a deliverable in "Needs Building." If it doesn't, flag this: "The spec introduces [process X] but doesn't include documentation/policy docs as a deliverable. The implementor should produce: operational docs (`docs/{name}.md`), CLAUDE.md policy section, and a skill if the process is interactive."

Write the critique into the spec document itself (new section at the end). The critique is part of the artifact — future readers need to see it.

### Phase 5: Ask the admin

Present your findings clearly so the admin can make a decision without reading the spec or the code. Lead with three TLDRs, then offer depth.

**Required structure — always present these first:**

1. **Problem TLDR** (2-3 sentences): What's broken or missing, stated concretely. Not "test coverage is low" but "mount-security.ts validates every container mount but has zero tests — if the validation logic has a bug, containers could access .ssh, .aws, or other sensitive paths."

2. **How it works now TLDR** (2-3 sentences): How the current system handles this today. Help the admin understand whether the existing code is sound (just needs tests/hardening) or is itself the problem (hacky, needs rework). Be honest — "the validation logic is clean but untestable due to global cache state" is more useful than "it works."

3. **What changes TLDR** (2-3 sentences): What you'd actually do, concretely. Not "improve test coverage" but "add a deps interface to mount-security.ts (matching the existing pattern in send-response.ts), write 15-20 unit tests covering blocked patterns, allowlist matching, and read-write policy."

4. **Deep dive pointers** (1 paragraph): Where the admin can read more if they want — which spec sections, which source files, which incidents are most informative. This respects their time: they can stop at the TLDRs or dig in.

**Then ask targeted questions.** Not open-ended "what do you think?" but specific choices that need a human decision.

**Structure your questions as:**
- "I found N incidents over M weeks. The pattern is X. Does this match your experience?"
- "The spec proposes A, but the incidents suggest B would be more impactful. Which direction?"
- "The full solution is Y. Here's the implementation plan: [concrete steps]. Any concerns before I proceed?"
- "This problem overlaps with kaizen #N. Should we merge them or keep separate?"
- "The spec's open question #K is actually the pivotal decision. My lean is Z because [reason]. Agree?"

**Don't ask:**
- Questions you could answer by reading the code
- Questions where all options are equivalent
- "Is this important?" (you should already know from the incidents)

### Phase 5.5: Review plan coverage (automated)

After formulating a plan (from Phase 3-5), run the **plan-coverage review battery** to check for gaps before presenting to the admin or starting implementation.

**How to invoke:** Use the Agent tool with the plan-coverage review prompt:

```
Launch a subagent with the review-plan-coverage prompt from prompts/review-plan-coverage.md.
Pass the plan text and issue number. The subagent compares the plan against the
issue's requirements and returns structured findings (DONE / PARTIAL / MISSING).
```

**Interpret the results:**
- **All DONE:** Plan covers the issue. Proceed to Phase 6.
- **PARTIAL findings:** Gaps exist but may be intentional scope reductions. Review each PARTIAL finding — if the reduction is intentional, document why (per Scope Reduction Discipline). If unintentional, fix the plan.
- **MISSING findings:** The plan skips a requirement entirely. Fix the plan before proceeding. Do not present a plan with MISSING items to the admin without flagging them.

**Fix loop:** If the review finds gaps, update the plan and re-run the review. Maximum 3 rounds (per `MAX_FIX_ROUNDS` in `src/review-battery.ts`). If still failing after 3 rounds, present the findings to the admin alongside the plan — they decide whether the gaps are acceptable.

### Phase 6: Capture lessons for the system

After the admin responds, the conversation you just had contains signal that's currently lost. The admin's reasoning — why they chose X over Y, what they value, what surprised them about the data, where their intuition disagreed with the spec — this is the highest-value information in the entire process, and today it evaporates when the conversation ends.

**Why this matters for recursive kaizen:**

The kaizen cycle is WORK → REFLECT → IDENTIFY → CLASSIFY → IMPLEMENT → VERIFY. But there's a missing loop: the evaluation step itself (this skill) should improve over time. When an admin says "this spec was way too long for the problem" or "you should have checked incident frequency first," that's not just feedback on this case — it's calibration data for how future cases should be evaluated.

**What a lessons system would enable:**
- Agents could read past evaluation sessions before starting new ones, avoiding the same mistakes (e.g., writing a 300-line spec for a 15-minute fix)
- Pattern detection across evaluations: "we keep speccing things that should just be implemented" or "we keep implementing before understanding the problem"
- The admin's judgment becomes durable — not locked in one conversation's context
- Priority calibration: what the admin actually cares about vs. what agents think they care about

**What needs to be captured (not how):**
- The admin's decision and their reasoning
- Where the spec/plan diverged from the admin's view of the problem
- Calibration data: was the problem bigger or smaller than the spec implied?
- Meta-observations about the evaluation process itself

The mechanism for storing and surfacing this doesn't exist yet. That's a separate design problem — and one that should be informed by several rounds of running this skill first, so we have concrete examples of what kind of lessons emerge and how they'd be used. Don't design the system in the abstract; accumulate the data, then design around it.

### Multi-PR Follow-Through Discipline — MANDATORY when splitting work

When evaluation recommends splitting an epic into sub-issues (Phase 3), the split itself is not the risk — **dropping the follow-ups is.** The pattern: first PR ships, follow-up issues rot in the backlog for weeks, the epic delivers 30% of its value and is quietly forgotten.

**Mechanism: file all sub-issues before starting any implementation.**

When you decide to split work into multiple PRs:

1. **File ALL sub-issues on GitHub immediately.** Not "we'll file the rest later" — all of them, now, with clear titles, definitions of done, and dependency links. This is the minimum viable mechanism: they exist in the backlog even if the current session ends unexpectedly.

2. **Link them to the parent epic** with a comment listing all sub-issues and their dependency order. The epic is the dashboard — anyone (human or agent) can see what's done and what remains.

3. **Use session tasks to track the full set.** Create tasks for ALL sub-issues in the current session, not just the first one. Even if you won't complete them all, the task list shows the commitment and makes it visible when you stop early.

4. **After each PR, continue to the next sub-issue.** This is the critical behavior change. When PR 1 merges, do not stop and wait for a new session. Check the task list, pick up the next sub-issue, and keep going. The default is **continue**, not **stop**. Only stop if:
   - The admin explicitly says to stop
   - A blocker emerges that requires human input
   - The session has been running for an unreasonable duration

5. **If you must stop before completing all sub-issues**, update the epic with current progress and explicitly state what remains. The `/kaizen-implement` skill's "On sub-issue closure" section handles the mechanics.

**Why this matters:** Filing sub-issues is necessary but not sufficient. Issues without momentum get deprioritized by `/kaizen-pick` in favor of fresher work. The follow-through happens in the same session because that's when context is hot and the implementation is cheapest. Splitting work into PRs should be a code organization choice, not an invitation to stop working.

**Anti-pattern: "Ship and reflect."** The agent ships PR 1, runs reflection, encounters the post-merge gate, clears it, and considers the work done. The remaining sub-issues are technically in the backlog but have no champion. **The agent that split the work IS the champion** — continue until the epic is delivered or the admin redirects.

## Anti-patterns

- **Skipping Phase 1.** Going straight from "kaizen #N exists" to "let's implement the spec" without checking if the spec matches reality.
- **Spec worship.** A spec is a hypothesis. Incidents are data. When they conflict, trust the data.
- **Analysis paralysis.** If Phase 3 finds an obvious 15-minute fix, just do it. Don't block on completing all 6 phases.
- **Asking the admin obvious questions.** Respect their time. Only escalate decisions that genuinely need human judgment.
- **Recording trivial lessons.** "We should test our code" is not a lesson. "Specs over 100 lines for problems with known solutions lead to spec-rot — implement instead" is.
- **"Do X now, Y later" without a mechanism.** Reducing scope is fine — but only if you provide a signal (mechanistic tool, epic connection, or filed follow-up) that will trigger "later." Without a mechanism, "later" never arrives. See the Scope Reduction Discipline gate.
- **Ship and stop.** Completing one sub-issue of a multi-PR split and stopping. The agent that split the work owns follow-through. See Multi-PR Follow-Through Discipline above.

## Integration with other skills

- After accept-case, use `/kaizen-implement` to bridge spec to code (applies the five-step algorithm: question, delete, simplify, accelerate, automate)
- If the case needs a spec first, use `/kaizen-prd` — but only if Phase 1-3 showed the problem is genuinely complex
- If the case is ready for implementation, use `/kaizen-plan` to break it into PRs
- When splitting into sub-issues, follow the Multi-PR Follow-Through Discipline — file all sub-issues upfront and continue working through them
- Lessons learned feed back into future accept-case evaluations

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Collision detection | Check GitHub labels, case DB, open PRs for existing work on this issue |
| 2 | Gather incidents | Search git log, PRs, review comments for concrete occurrences with dates and impact |
| 3 | Assess scope and architecture | Check implementation fitness, testability, library reuse, E2E harness |
| 4 | Critique spec (if exists) | Validate problem statement against incidents, check proportionality, identify gaps |
| 5 | Ask the admin | Present 3 TLDRs (problem, current state, proposed change), ask targeted questions |
| 6 | Record lessons and decide | Capture admin input, record calibration, output GO/NO-GO with scope |

**What comes next:**
- **GO → single PR:** `/kaizen-implement` — will create case, worktree, and 11 implementation tasks
- **GO → multi-PR:** `/kaizen-plan` first (breaks into sub-issues), then `/kaizen-implement` per sub-issue
- **Needs spec:** `/kaizen-prd` first, then back to evaluate
- **NO-GO:** Close with reason

See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for full workflow.

## Recursive Kaizen

This skill is part of the improvement system. Apply it to itself: after evaluating a case, reflect on whether the evaluation process helped or got in the way. Did Phase 1 (gather incidents) reveal the right things? Did Phase 3 (low-hanging fruit) find something the spec missed? Was Phase 5 (ask the admin) worth the admin's time? These observations, captured in kaizen reflections, are the raw material for improving this skill. See `/kaizen-implement` for the fuller picture of recursive kaizen.
