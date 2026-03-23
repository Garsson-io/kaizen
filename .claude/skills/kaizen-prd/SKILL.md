---
name: kaizen-prd
description: Plan a large body of work through iterative discovery, producing a spec document, GitHub issue, and docs-only PR. Leaves enough context for a future implementor. Triggers on "write prd", "plan large work", "write spec", "plan initiative", "architecture spec", "write MRD", "plan epic".
---

# Plan Large Work — Iterative Discovery to Spec

**Role:** The cartographer. Maps the problem space before anyone starts building. Produces the taxonomy and problem structure that outlasts any specific solution. *"Map the territory before you move through it."*

This skill guides you through planning a large initiative — from fuzzy idea to a structured spec document that a future implementor can pick up and execute. The output is a docs-only PR with a GitHub issue as the tracking anchor.

**When to use:** The work is too large to start coding immediately. You need to think through the problem space, make architectural decisions, identify risks, and leave a trail of reasoning for whoever implements it (including your future self).

## First: Feature or Horizon?

Before planning, determine what kind of work this is:

**Feature** — Has phases and a definition of done. "Add case routing," "implement container build caching," "add Telegram channel." Even if it has 5 phases, it ends. Most work is this.

**Horizon** — An infinite game. A dimension of quality you'll endlessly want to improve. "Testing," "security," "observability," "autonomous operations." A horizon gets a taxonomy (what does good look like at each level?), a "you are here" marker, and clarity on the next few steps — but no definition of done, because there isn't one.

**Feature within a horizon** — A concrete piece of work that advances a horizon. "Add mount-security tests" is a feature within the testing horizon. The feature has a definition of done; the horizon doesn't.

This distinction matters because:
- A **feature spec** focuses on requirements, implementation phases, and completion criteria
- A **horizon spec** focuses on the taxonomy (levels/dimensions of what good looks like), current state assessment, and near-term next steps — but deliberately leaves distant levels rough
- A **feature-within-horizon spec** references the horizon taxonomy to show where the feature sits and how it advances the current level

**You won't accumulate many horizons.** A horizon is a fundamental quality dimension — testing, security, observability, developer ergonomics, autonomous operations. If you're creating dozens, you're tracking features, not horizons.

**What you produce:**

**Default: Issue-only PRD** — Most PRDs should live directly in the GitHub issue body. This is simpler, more discoverable, and avoids the overhead of a docs-only PR. The issue IS the spec.

**Exception: File+PR PRD** — Use a `docs/*-spec.md` file + docs-only PR only for large, multi-stakeholder initiatives where:
- Multiple agents will implement different phases
- The spec exceeds ~200 lines and needs its own review cycle
- The spec contains diagrams or tables that benefit from rendered markdown

**Output by type:**
1. **Issue-only (default):** GitHub issue with structured body (the spec lives in the issue)
2. **File+PR (large initiatives):**
   - Spec document: `docs/{name}-spec.md` (feature) or domain-appropriate location (horizon)
   - GitHub issue (tracking anchor, links to spec)
   - Docs-only PR (reviewable, versionable)
3. **Horizon:** The taxonomy lives with the domain it covers (e.g., `.claude/kaizen/horizon.md`), with a symlink from `docs/horizons/{name}.md`. Check `docs/horizons/` for existing horizons before creating a new one.

**Documentation deliverables (noted in the spec, produced during implementation):**

When the spec introduces new operational processes (scripts to run, cleanup policies, lifecycle management), the spec should explicitly call out the documentation deliverables that the implementor must produce:
- **Operational docs** (`docs/{name}.md`): how it works, when to run, what the policy is
- **CLAUDE.md section**: brief policy summary for agent context (5-10 lines, link to full docs)
- **Skill** (if interactive): when the feature has a "run this when X happens" flow

Mark these in Section 7 ("Needs Building") alongside the code deliverables. The implementor (`/kaizen-implement`) will produce them — the spec just ensures they're not forgotten. See `/kaizen-implement` section 4b for the full policy.

**Issue-only PRDs:** When the full PRD lives in a GitHub issue rather than a `docs/*-spec.md` file, the issue body **must** include the following instruction at the top (before the spec content):

> **Implementing Agent: Read This First**
> Your first action is to commit this PRD to `docs/prd-{name}.md` in a standalone PR before writing any implementation code. Copy the spec body from this issue into that file. GitHub issues get closed and buried — the spec must live in the repo where future agents can read it. Only after that file is committed should you proceed with implementation.

GitHub issues are ephemeral — they get closed, buried, and forgotten. The spec must live in the repo. The repo file is not the plan (that's the issue) — it's the lasting record that survives issue closure. This applies even for small-to-medium PRDs: the overhead of one extra file is negligible compared to the cost of losing the reasoning when the issue closes.

Additionally, the issue body should note: "Implementation must produce `docs/{feature}.md` capturing what was built, operating policy, design decisions, and future vision."

## Phase 1: Understand the Initiative

Ask the user to describe what they want to build. Then ask yourself (and them) these questions to build context:

### Problem Space
- **What problem are we solving?** Get specific — not "better security" but "Customer A's MRI scan must never leak to Customer B's agent context."
- **Who experiences the problem?** End users, operators, developers, the system itself?
- **What happens today?** How does the current system handle (or fail to handle) this?
- **What's the cost of not solving it?** Business risk, user trust, operational burden?

### Solution Space
- **What does "good" look like?** Describe the desired end state, not the implementation.
- **What are the constraints?** Budget, timeline, compatibility, regulatory, team skills?
- **What's explicitly out of scope?** Name things that are adjacent but NOT part of this work.

### Threat/Risk Models (if applicable)
- **What can go wrong?** Data leakage, privilege escalation, state corruption, race conditions.
- **What are the isolation boundaries?** What should NOT be able to see/touch what?
- **What are the trust boundaries?** Who/what is trusted vs untrusted?

Don't try to answer everything in one pass. This is iterative — ask, listen, probe, clarify.

## Phase 2: Iterative Discovery

This is the core of the skill. You and the user go back and forth to build shared understanding. The pattern:

```
YOU: Present your understanding + specific questions
USER: Answers, corrects, adds context
YOU: Incorporate, identify new questions or contradictions
USER: Clarifies
... repeat until the model is stable ...
```

### How to drive discovery

1. **State your understanding explicitly.** Don't assume — write it out so the user can correct it. Use tables and diagrams to make structure visible.

2. **Ask pointed questions, not open-ended ones.** Not "what about security?" but "Should the router have access to customer files, or only case summaries?"

3. **Present options with tradeoffs.** When there's a design choice, lay out 2-3 options with pros/cons and state your lean. Let the user decide.

4. **Track what's decided vs what's open.** Maintain a running mental model of:
   - Decided: things you've agreed on
   - Open: things that need more thinking
   - Deferred: things explicitly punted to future work

5. **Challenge the user's assumptions constructively.** If something seems over-engineered or under-specified, say so. "The product thinking has merit, but the engineering needs figuring out" is a valid thing to say.

6. **Separate product thinking from engineering.** Product = what and why. Engineering = how. Get the product right first, then figure out the engineering. But flag early if the engineering looks infeasible for the product vision.

### Signs you're ready to move on
- The user stops adding new concepts
- Open questions are about implementation details, not fundamentals
- You can describe the system to someone who wasn't in the conversation and they'd understand it
- The user says "yes, write it" or equivalent

## Phase 3: Write the Spec Document

Create ONE document (not three). At this stage the MRD, PRD, and architecture are tightly coupled — splitting them adds cross-referencing overhead without clarity.

### File location and naming

```
docs/{kebab-case-initiative-name}-spec.md
```

Example: `docs/case-isolation-spec.md`, `docs/crm-integration-spec.md`

### Document structure

```markdown
# {Initiative Name} — Specification

## 1. Problem Statement

What problem we're solving, who experiences it, what happens today, and why it matters.
Include concrete examples (the "MRI scan" example, not abstract descriptions).

### Threat / Risk Model (if applicable)
- Enumerate specific threats with concrete scenarios
- For each: what's at risk, likelihood, impact, current mitigation (if any)

## 2. Desired End State

What "good" looks like. Describe the system as if it's already built.
- What can users do that they couldn't before?
- What guarantees does the system provide?
- What is explicitly NOT in scope?

## 3. Roles & Boundaries

Who/what are the actors in the system? What can each do, what can't they?
Use a table:

| Role | Can do | Cannot do | Data access | Tools |
|------|--------|-----------|-------------|-------|
| ... | ... | ... | ... | ... |

## 4. Architecture & Isolation Model

How the system enforces the boundaries from section 3.
- Layer diagram (what enforces what)
- Per-layer: what it enforces, what it doesn't, residual risks
- State management: what persists where, what survives restarts

## 5. Interaction Models

Walk through key user scenarios end-to-end:
- Happy path (everything works)
- Edge cases (concurrent users, agent recycling, identity merge)
- Error cases (what happens when X fails?)

Use numbered step-by-step flows, not prose.

## 6. State Management

For each stateful component:
- What state it holds
- Where it's stored (memory, disk, DB, external service)
- What survives container restart / agent recycle
- What's lost and how it's recovered

## 7. What Exists vs What Needs Building

Two tables:

### Already Solved
| Capability | Current implementation | Status |
|------------|----------------------|--------|

### Needs Building
| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|

## 8. Open Questions & Known Risks

Things that need more thinking before or during implementation.
For each: state the question, list options, note your lean if you have one.

## 9. Implementation Sequencing (Optional)

If you have a sense of build order, sketch it. What depends on what?
What can be built in parallel? What's the MVP vs the full vision?
```

### Writing guidelines

- **Be concrete, not abstract.** "Customer A's MRI scan" > "sensitive data." Show the scenario.
- **Show your reasoning.** Don't just state decisions — explain WHY. The implementor needs to know the reasoning to make good judgment calls when they hit edge cases you didn't anticipate.
- **Tables over prose.** When comparing options, listing capabilities, or mapping relationships — use tables. They're scannable and precise.
- **Diagrams in ASCII.** Keep them in the markdown. No external tools needed.
- **Name residual risks.** No design is perfect. Calling out what's NOT solved builds trust and prevents false confidence.
- **Link decisions to their rationale.** When you chose option A over B, say why. When you deferred something, say why it's safe to defer.

### Progressive detail — the most important writing principle

**Detail the problem space fully. Detail solutions only at the current level.**

A spec should define the problem taxonomy with high resolution — what the levels are, what capabilities each level requires, where we are today. Think Kardashev scale (energy), SAE levels (autonomous driving), or CMMI (process maturity). The taxonomy itself is the most valuable artifact. It gives shared vocabulary and direction.

But solution detail should be *progressive*: dense for the level we're at or about to reach, sketched for the next level, and deliberately left open beyond that.

**Example of what this looks like:**

If a system is at Level 3 of a 10-level taxonomy:
- **Level 3 (current):** Full problem analysis. Concrete solution design. Implementation-ready detail.
- **Level 4 (next):** Problem defined. Rough solution outline. Key open questions identified.
- **Level 5-7 (horizon):** Problem described. Solution left as "we will need X capability." No design.
- **Level 8-10 (vision):** One sentence each. The impossible ideal we climb toward.

**Why this matters:**
- Premature specification is the root of all evil. Designing a Level 10 solution while at Level 3 produces speculative architecture that constrains future thinking without providing current value.
- The problem taxonomy ages well. The Kardashev scale was defined in 1964 and is still useful. The specific engineering designs from 1964 are not.
- Progressive detail naturally creates open questions — "what does Level 6 look like in practice?" — which is exactly what a spec should leave for future work.
- When you reach Level 4, you refine its section with full detail and sketch Level 5. The spec evolves as understanding deepens.

**Anti-pattern: "Coverage Dashboard."** If you're at L1 (instructions in a doc), don't design the CI-integrated dashboard that auto-generates coverage matrices. Instead: define the *need* ("we need a way to see where we are"), note the *current state* ("today it's a manual Markdown table"), and leave the solution as an open question for when you're actually at the level where a dashboard makes sense.

**The test:** For every solution paragraph, ask: "Are we at the level where this solution is the next step?" If no, replace the solution with a problem statement and an open question.

## Phase 4: Create the Epic Issue and Sub-Issues

Every PRD produces an **epic issue** — the tracking anchor for the initiative. The epic links to the spec and has two kinds of sub-issues: **practical** (concrete next steps) and **aspirational** (vague provocations that challenge the reader to make them concrete).

### The Epic Issue

**For issue-only PRDs (default):** The issue body IS the spec — use the full document structure from Phase 3. The issue is both the tracking anchor and the single source of truth.

**For file+PR PRDs (large initiatives):** The issue is the epic anchor. Keep it short — the spec document has the details.

```bash
gh issue create --repo "$ISSUES_REPO" --title "Epic: {Initiative Name}" --label "epic,{domain}" --body "$(cat <<'EOF'
## Summary

{2-3 sentences: what this initiative is and why it matters}

## Spec

{For file+PR: See [`docs/{name}-spec.md`](link-to-file-in-PR)}
{For issue-only: the spec body goes here}

## Sub-issues

Tracked as sub-issues linked to this epic.
- **Practical:** concrete next steps with clear acceptance criteria
- **Aspirational:** intentionally vague — challenge the reader to make them concrete

## Status

- [ ] Spec reviewed and approved
- [ ] Implementation planning (break into sub-issues)
- [ ] Implementation
- [ ] Verification
EOF
)"
```

### Practical Sub-Issues (3-5)

These are the concrete next steps someone could pick up and implement. Each should have:
- A clear deliverable
- Acceptance criteria
- A link back to the epic (`**Parent:** #NNN`)

Derive these from the spec's "Needs Building" section and implementation phases. Focus on the first 1-2 phases — don't plan the whole thing.

```markdown
**Parent:** #{epic}

{What to build, concretely.}

**Acceptance:** {What "done" looks like — testable, reviewable.}
```

### Aspirational Sub-Issues (2-4)

These are intentionally vague. They name a direction without prescribing the path. Their purpose is to **provoke the reader into thinking**, not to be implemented as-is.

Good aspirational issues:
- Ask open questions, not closed ones
- Present possibilities as bullet lists, not requirements
- End with a challenge: "Make this concrete: propose one thing and file a real issue for it"
- Don't pretend to know the answer

```markdown
**Parent:** #{epic}

{Description of an interesting direction or open question.}

{Bullet list of possibilities — not requirements, just provocations.}

This issue is intentionally vague. The first step is to make it concrete:
pick one sub-question above, propose a practical approach, and file a real
issue for it.
```

**Label aspirational issues with `aspirational`.** Create the label if it doesn't exist:
```bash
gh label create aspirational --repo {repo} \
  --description "Intentionally vague — challenge the reader to make it concrete" \
  --color "d4c5f9" 2>/dev/null || true
```

### Why both kinds?

Practical issues give the initiative momentum — there's always something to pick up. Aspirational issues prevent tunnel vision — they keep the larger possibilities visible without over-specifying them. The natural flow: someone reads an aspirational issue, gets inspired, files a practical issue, and implements it. The aspirational issue stays open as a gathering point for more ideas.

**Anti-pattern: all practical.** An epic with only concrete tasks is a project plan, not a vision. It closes when the tasks are done, even if the interesting questions remain unexplored.

**Anti-pattern: all aspirational.** An epic with only vague issues is a brainstorm, not a plan. Nothing gets built because nothing is concrete enough to start.

## Phase 5: Create the Docs-Only PR (file+PR PRDs only)

**Skip this phase for issue-only PRDs** — the epic and sub-issues from Phase 4 are the complete deliverable.

For file+PR PRDs, the PR contains ONLY the spec document. No code changes.

```bash
# Create branch
git checkout -b docs/{initiative-name}-spec

# Add spec
git add docs/{name}-spec.md

# Commit
git commit -m "docs: add {initiative name} specification

Covers problem statement, architecture, isolation model,
interaction flows, and open questions.

References: #{issue-number}"

# Push and create PR
git push -u origin docs/{initiative-name}-spec

gh pr create --repo {repo} \
  --title "docs: {initiative name} specification" \
  --body "$(cat <<'EOF'
## Summary

Adds the specification document for {initiative name}.

This is a **docs-only PR** — no code changes. The spec covers:
- Problem statement and threat model
- Architecture and isolation design
- Interaction models and state management
- What exists vs what needs building
- Open questions and known risks

Closes #{issue-number}

## Review guidance

- Does the problem statement capture the real risks?
- Are the isolation boundaries sufficient?
- Are there missing interaction scenarios?
- Are the open questions the right ones?

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## PRD Lifecycle — Living Documents

A PRD is not done when the PR merges. It evolves as implementation proceeds. The `/kaizen-implement` skill owns the update cycle, but the principles are defined here because they follow from how the PRD was written.

### The progressive refinement pattern

After each implementation phase completes, the PRD should be updated:

1. **Completed work → "Already Solved."** Move it out of "Needs Building" with a note about what was actually built and what was learned.
2. **Next phase → full detail.** Refine the next phase's rough outline into concrete implementation detail, informed by what you just learned.
3. **Be selective about touching future phases.** A spec contains two kinds of content: *problem taxonomy* (what the levels/categories/capabilities are, what each proves, what each misses — the "Kardashev scale") and *solution detail* (specific files, test counts, implementation strategies). Problem taxonomy ages well and must never be trimmed. For solution detail in future phases: **most of the time, leave it alone.** The main action is selectively **adding** implementation hints when the current phase produced genuine insight — not routine trimming. As the spec matures through multiple phases, future steps will already be well-specified and rarely need changes. Trim future solution detail if it's actively misleading (contradicts what you just learned) or if the spec is genuinely too prescriptive about implementation for distant phases — but never as routine cleanup. The judgment call is: "Is this detail constraining future implementors more than it's helping them?"
4. **Gap analysis → update.** Reflect current reality.

**Why replace rather than keep both:** Two plans (vague + detailed) diverge immediately. The detailed version for distant phases creates false confidence — it looks decided but isn't. Replace in place; git history preserves the original for anyone who needs it.

**Why not rewrite before starting:** If the current phase is already well-specified enough to implement, rewriting the PRD first just delays real work. Update *after* the phase, when you have real learnings to incorporate.

### When to trigger a PRD rewrite vs update

- **Update (common):** Completed a phase, need to refine the next one. Done inline as part of `/kaizen-implement`.
- **Rewrite (rare):** Implementation revealed the problem taxonomy itself was wrong — not just the solutions, but the framing. This means re-running `/kaizen-prd` for the affected sections. Signal: you keep discovering capabilities or failure modes the spec doesn't have categories for.

## Anti-Patterns

Things this skill is NOT for:

- **Small features.** If you can describe it in a paragraph, just do it. No spec needed.
- **Bug fixes.** The bug IS the spec. Fix it, write tests, move on.
- **Implementation planning for an approved spec.** That's task breakdown, not discovery. Use `/kaizen-plan` to break a spec into PRs and issues.
- **Ongoing documentation.** This produces a point-in-time spec. It will evolve during implementation via subsequent PRs.
- **Designing solutions for distant levels.** If you define a 10-level taxonomy and you're at level 3, don't design the level 8 solution. Define what level 8 *requires* (the problem), not how to build it (the solution). Leave it as an open question.

## Tips for the Implementor (Meta)

When you're the future agent picking up a spec created by this skill:

0. **Commit the spec to `docs/prd-{name}.md` first.** Before writing a single line of implementation code, copy the spec from the GitHub issue body into a repo file and open a standalone PR for it. The issue will be closed when you're done — the spec must outlive it. This is not optional.

1. **Read the whole spec before starting.** Don't jump to "Needs Building" — the reasoning in earlier sections will save you from wrong turns.
2. **Check the Open Questions section.** Some may have been resolved since the spec was written. Some may block your work until answered.
3. **The spec is a starting point, not a contract.** Implementation will reveal things the spec didn't anticipate. Update the spec as you go (new PRs, not edits to the original).
4. **Respect the "Why" sections.** If you're tempted to take a shortcut that contradicts the stated reasoning, stop and think. The reasoning exists because someone thought hard about it. If you still disagree, raise it — don't silently diverge.

## Write for Deletion

A spec will be subjected to the five-step algorithm when implementation begins (`/kaizen-implement`): question requirements, delete, simplify, accelerate, automate. Write your spec expecting this. Specifically:

- **Make sections independently evaluable.** Each section should be deletable without breaking the rest. If someone applies step 2 (delete) and removes the "Coverage Dashboard" section, the remaining spec should still make sense.
- **Separate the problem taxonomy from proposed solutions.** The taxonomy (what the levels are, what capabilities each level requires) ages well and is hard to delete. The proposed solutions age poorly and should be easy to delete. Keep them in distinct sections.
- **Mark confidence levels.** "This is the problem" vs "this is one way to solve it" vs "this is a guess." The implementor needs to know which parts to trust and which to re-examine.
- **Don't bury decisions in prose.** Make them findable, so step 1 (question requirements) can be done efficiently. Tables and explicit "Decision: X because Y" callouts are better than decisions embedded in paragraphs.

The best spec is one where an implementor can read it, delete 40% of it, and still have a clear direction. If deleting any section makes the spec incoherent, the spec is too tightly coupled.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Understand initiative | Ask about problem space, solution space, constraints, threat models |
| 2 | Iterative discovery | State understanding, ask pointed questions, repeat until model stable |
| 3 | Write spec document | 9-section spec in `docs/{name}-spec.md` or issue body |
| 4 | Create epic + sub-issues | Epic anchor with 3-5 practical + 2-4 aspirational sub-issues; include "Implementing Agent: Read This First" block for issue-only PRDs |
| 5 | Create docs-only PR | Branch + spec file + commit + PR (skip for issue-only PRDs) |

**For implementors picking up an issue-only PRD:**

| # | Task | Description |
|---|------|-------------|
| 0 | Commit spec to repo | Copy PRD from issue body → `docs/prd-{name}.md`, open standalone PR, merge before any implementation work |
| 1 | Read full spec | Understand reasoning before touching code |
| 2 | Implement | Work through the spec phases |

## What Comes Next

After the spec is merged and reviewed:
- Use **`/kaizen-evaluate`** to evaluate whether to proceed, gather incidents, and find low-hanging fruit.
- Use **`/kaizen-implement`** to bridge spec to code — re-examine against current reality, apply the five-step algorithm, and execute incrementally.
- Use **`/kaizen-plan`** when implementation is too big for one PR — break into independent, sequenced PRs with dependency graph and sub-issues.

See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for full workflow.

### Knowledge Flow Checklist — MANDATORY before finalizing (kaizen #381)

A PRD that doesn't flow into the repo is decoration. Before marking the PRD complete, answer:

1. **What artifacts does this PRD propose changing?** Check all that apply:
   - [ ] Skills (`SKILL.md` prompt changes, new skill creation)
   - [ ] Hooks (new enforcement, hook modifications)
   - [ ] Docs (`docs/*.md`, operational documentation)
   - [ ] CLAUDE.md (policy sections, key files table)
   - [ ] Policies (`policies.md`, `review-criteria.md`)
   - [ ] Philosophy (`zen.md`, `horizon.md`)

2. **For each checked item:** Either apply the change in this PR, or file a sub-issue with the specific change described (not "update skills" but "add hypothesis-formation step to `/kaizen-evaluate` Phase 3.5").

3. **Process insights test:** Does this PRD contain methodology or process insights (not just feature specs)? Examples: "always form hypotheses before fixing," "use progressive detail," "escalate L1->L2 on recurrence." If yes, these insights must land in the skill/doc/hook that future agents will read — not just in the issue body. File sub-issues or apply directly.

**Why this matters:** Epic #334 (autoresearch) contained detailed methodology across 5 sub-issues. None of it was applied to skill files. Agents starting fresh never saw any of it — they read the skills as-is and repeated the same mistakes. Knowledge in GitHub issues is ephemeral; knowledge in skills/docs/hooks is durable.

**Anti-pattern: "The implementor will handle it."** They won't — implementation focuses on code, not on updating skill prompts. If the PRD proposes a skill change, the sub-issue should exist before the PRD is finalized. The `/kaizen-implement` skill has a methodology cross-check (Phase 4b) as a safety net, but the primary responsibility is here.

### Recursive Kaizen

These skills are the improvement system. The improvement system should improve itself. After using `/kaizen-prd`, reflect: did the spec help implementation or constrain it? Was the progressive detail at the right granularity? Did the problem taxonomy age well? Capture these observations in kaizen reflections — they're the raw material for improving how we write specs. See `/kaizen-implement` for the fuller picture.
