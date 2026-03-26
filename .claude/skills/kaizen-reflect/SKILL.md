---
name: kaizen-reflect
description: Recursive process improvement — core workflow for continuous improvement across all verticals. Escalation framework (Level 1→2→3), reflection triggers, backlog management. Triggers on "kaizen", "process improvement", "improve processes", "recursive kaizen".
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# Recursive Kaizen — Core Workflow

**Role:** The reflection engine. Fires after work is done and produces actionable improvements. Classifies the right enforcement level and files issues. Also the meta-layer: reflects on whether the kaizen system itself is working.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — run `/kaizen-zen` to print it.

## The Dev Work Skill Chain

Each skill has a distinct responsibility. They complement, not overlap.

| Skill | Role | Owns | Feeds into |
|-------|------|------|------------|
| `/kaizen-pick` | **Selector** — chooses WHICH issue | Issue selection, collision avoidance | `/kaizen-evaluate` |
| `/kaizen-evaluate` | **Scope gate** — decides WHAT to build | Scope decisions, evidence gathering, admin approval | `/kaizen-implement` |
| `/kaizen-prd` | **Cartographer** — maps the problem space | Problem taxonomy, requirements | `/kaizen-evaluate` |
| `/kaizen-implement` | **Execution engine** — turns scope into code | Freshness checks, code, tests, PRs | `/kaizen-reflect` |
| `/kaizen-plan` | **Sequencer** — breaks large work into PRs | Dependency graph, sub-issues | `/kaizen-implement` |
| `/kaizen-reflect` | **Reflection engine** — learns from the work | Level classification, improvement filing, meta-reflection | `/kaizen-pick` (loop) |

**Key boundaries:**
- `/kaizen-evaluate` decides scope. `/kaizen-implement` must not change scope unilaterally — if reality changed, escalate back.
- `/kaizen-prd` maps the problem space with taxonomies. The taxonomy is the durable artifact — solution details rot.
- `/kaizen-reflect` reflects on both the work AND the kaizen system itself. The system must improve itself.

Kaizen is not optional. It is a CORE part of every piece of work. Every case completion, every fix-PR, every incident triggers a kaizen reflection that produces concrete, actionable output.

**Recursive kaizen** means improving how we improve. When a process improvement doesn't work, escalate the enforcement mechanism — don't just write another instruction. *"It's kaizens all the way down."*

## The Kaizen Cycle

```
  WORK ──▶ REFLECT ──▶ IDENTIFY ──▶ CLASSIFY ──▶ IMPLEMENT ──▶ VERIFY
   ▲                                                              │
   └──────────────────────────────────────────────────────────────┘
```

Every step produces output. Nothing is "just thinking."

### 1. REFLECT (triggered automatically)

Reflection happens at these mandatory checkpoints:

| Trigger | What to reflect on | Output |
|---------|-------------------|--------|
| Case completion | Impediments, friction, what slowed you down | Kaizen suggestions in case conclusion |
| Fix-PR | Root cause, why it happened, is the fix level sufficient | Kaizen section in PR description |
| Incident (human time wasted) | What failed, why the process didn't catch it | Immediate escalation assessment |
| Periodic review | Kaizen backlog triage, pattern detection | Priority adjustments |

### 1.5. CONSULT TELEMETRY — data before anecdote (kaizen #670)

**If running inside an auto-dent batch**, consult structured telemetry before identifying impediments. Anecdotal impressions ("this felt slow") are less reliable than measured data ("this run cost 3x the rolling average"). Data first, narratives second.

**How to check:** Look for the environment variable `AUTO_DENT_BATCH_DIR` or the batch state file. The telemetry lives in the batch output directory.

```bash
# Find the current batch's events file
BATCH_DIR="${AUTO_DENT_BATCH_DIR:-}"
if [ -z "$BATCH_DIR" ]; then
  # Fallback: look for events.jsonl in recent batch dirs
  BATCH_DIR=$(ls -td /tmp/auto-dent-*/batch-* 2>/dev/null | head -1)
fi

if [ -n "$BATCH_DIR" ] && [ -f "$BATCH_DIR/events.jsonl" ]; then
  # Read the current run's events
  cat "$BATCH_DIR/events.jsonl" | tail -20

  # Generate batch summary for comparison baselines
  npx tsx scripts/batch-summary.ts "$BATCH_DIR" --json 2>/dev/null | head -50
fi
```

**What to look for in telemetry:**

| Signal | Question to ask | Implication |
|--------|----------------|-------------|
| `cost_usd` >> rolling average | Was the scope too large or did the agent loop? | Scope discipline or stuck-detection needed |
| `duration_ms` >> average | What took extra time — research, debugging, hooks? | Identify time sinks |
| `outcome: empty_success` | Why did the run produce nothing? | Issue selection or evaluation failure |
| `failure_class: hook_rejection` | Which hook blocked and why? | Hook may be too strict, or agent didn't prepare |
| `lifecycle_violations > 0` | What lifecycle steps were skipped? | Workflow discipline gap |
| `tool_calls` >> average | Was the agent stuck in a loop? | Need circuit breakers or better prompts |
| Mode underperformance | Does this cognitive mode consistently cost more per PR? | Adjust mode weights |

**Surface data-driven observations** alongside conversation-based impressions. If the data contradicts your impression, trust the data.

**If not in a batch context** (interactive session), skip this step — there is no structured telemetry yet (see #671).

### 1.7. PLAN-VS-DELIVERY CHECK — did we build what we said we would? (kaizen #891)

**If the linked issue has an implementation plan comment** (posted by kaizen-implement step 0b), compare what was planned against what was actually delivered in the PR.

```bash
# Find the plan comment on the issue
gh issue view {N} --repo "$ISSUES_REPO" --json comments --jq '.comments[] | select(.body | contains("## Implementation Plan")) | .body' | head -80
```

**Check each planned item:**
- **Scope**: Did the PR deliver everything in "In this PR"? Was anything silently dropped?
- **Deferred items**: Were deferred items actually filed as follow-up issues?
- **Requirement mapping**: Does each mapped criterion have corresponding code in the PR?
- **Testing strategy**: Were the planned test pyramid levels and invariants actually implemented?

**If scope changed during implementation**, document why — this is expected and valuable data. The question isn't "did we follow the plan exactly" but "did we consciously decide to deviate, or did scope silently shrink?"

**If no plan exists**, note that as an impediment — plans are mandatory per kaizen-implement.

### 2. IDENTIFY impediments — patterns first, then details (kaizen #241, #351)

**Lead with categories, not symptoms.** The most common reflection failure mode is dispositioning each impediment individually and never noticing they share a root cause. Reverse the order: name the patterns first, then drill into individual items.

**Step 2a — List all impediments.** Be specific. Not "we should test more" but "the roeto-session.js stealth plugin import was never tested in the container — need a pre-merge check that runs imports."

**Step 2b — Name the categories BEFORE dispositioning individuals.** Ask: **do these impediments share a root cause category?**

- Group any that share a common pattern (e.g., "format mismatch", "missing test category", "stale cache")
- If 2+ impediments share a root cause, **name the category** and file a single kaizen issue for the category — not separate issues for each symptom
- The category issue is more valuable than the individual symptoms because it enables compound fixes (see `/kaizen-deep-dive`)

**Example:** Three impediments — "hook X didn't match format Y", "hook Z expected format W", "test used wrong format" — all share root cause "no format contract between hooks." File one issue for the format contract, not three for the individual mismatches.

**Step 2c — For each category, ask: is this a new pattern or a recurrence?**
- **New pattern** → file and monitor at appropriate level
- **Recurrence** → the current enforcement level failed. **Must escalate** at least one level (L1→L2, L2→L3). An impediment that recurs at the same level is proof the level is insufficient.

### 2.4. MULTI-PR QUALITY CHECK — are you iterating on the same feature? (kaizen #400)

Before dispositioning individual impediments, check whether this session is part of a multi-PR fix cycle on the same feature:

```bash
# Check recent PRs touching the same files or referencing the same issue
git log --oneline --all --since="3 days ago" --grep="Fixes.*#${ISSUE}" | head -5
gh pr list --repo "$HOST_REPO" --state all --search "#${ISSUE}" --json number,title,state,mergedAt | head -10
```

**If this is the 2nd+ PR for the same feature/case, ask:**
1. "What should I have tested before the FIRST PR that would have caught this?"
2. "Is there a missing pre-flight check, test, or validation that would prevent the cycle?"
3. "Am I fixing symptoms, or is there a root cause I have not addressed?"

The answer to question 1 is the **missing pre-flight discipline** — file it as a kaizen issue targeting the pre-PR workflow (evaluation, testing, or review), not just the feature itself.

**Signals of the multi-PR pattern:**
| Signal | Meaning |
|--------|--------|
| 2+ PRs on same branch/case in quick succession | Iterating on a broken feature |
| Same file modified in 3+ consecutive PRs | Core design issue, not polish |
| PR titles starting with "fix:" referencing the same kaizen issue | Still broken |

**The goal:** Multi-PR cycles are expensive — each PR requires review, CI, merge, and reflection overhead. A single well-tested PR is worth more than three iterative ones. This check makes the pattern visible so the reflection can produce a prevention mechanism, not just note the symptoms.

### 2.5. AMPLIFY POSITIVE FINDINGS (kaizen #349)

Positive findings are equally valuable signal — they validate practices that future agents should follow. After listing impediments, **explicitly review what went well:**

- **What techniques saved time or caught bugs?** (e.g., "TDD caught a real bug in RED phase", "hypothesis framing produced a better PRD")
- **What was surprising or non-obvious?** Non-obvious successes are the most valuable — they're validated practices that wouldn't be discovered by reading docs alone.
- **Is this positive pattern documented where a future agent would find it?** If not, add it to a memory file, CLAUDE.md section, or skill prompt. The goal is not just to avoid repeating mistakes — **it's to repeat successes.**

Positive findings use `type: "positive"` in KAIZEN_IMPEDIMENTS:
```json
{"finding": "TDD caught Buffer vs string mock mismatch in RED phase", "type": "positive", "disposition": "amplified", "target": "memory/practices_tdd_validation.md"}
{"finding": "Testability-first approach saved 5x iteration time", "type": "positive", "disposition": "amplified", "target": ".claude/kaizen/practices.md"}
{"finding": "Foundation-first approach validated", "type": "positive", "disposition": "no-action", "reason": "Already documented in practices.md"}
```

**Disposition for positive findings:**
- `"amplified"` — the pattern was non-obvious and has been documented for future agents (with `target` field pointing to where)
- `"no-action"` — the pattern is already documented or is self-evident

**The asymmetry to fix:** Impediments get filed, analyzed, and escalated. Positive findings must get the same treatment — documented, aggregated, and surfaced. A practice that worked in 5 sessions but is never written down will be independently rediscovered (or not) in session 6.

### 3. CLASSIFY the level

## The Three Levels

### Level 1: Instructions

**What:** Text in CLAUDE.md, SKILL.md, workflow docs, PR descriptions.
**Enforcement:** None — relies on agent/human reading and following.
**When sufficient:** First occurrence, judgment-required situations, direction-setting.
**When to escalate:** Same type of failure happens again.

**Mechanisms:**
- `CLAUDE.md` (harness and vertical repos)
- `SKILL.md` files (skill documentation)
- `workflows/` docs (vertical-specific procedures)
- `groups/global/CLAUDE.md` (agent behavior instructions)

### Level 2: Hooks & Automated Checks

**What:** Code that runs automatically and can BLOCK actions.
**Enforcement:** Deterministic — blocks commit, merge, tool call, or agent completion.
**When sufficient:** Automatable checks, moderate failure cost.
**When to escalate:** Check is bypassed, or failure still happens despite the check.

**Mechanisms:**
- **Claude Code hooks** (`.claude/settings.json`):
  - `PreToolUse` — block dangerous commands, protect files
  - `PostToolUse` — auto-format, validate after edits
  - `Stop` — verify tests/checks before agent finishes
  - `UserPromptSubmit` — validate prompts
- **Git hooks** (`.husky/`) — pre-commit checks
- **CI pipeline** (`.github/workflows/`) — PR merge gates
- **CLI diagnostic tools** (`tools/`) — investigation aids

### Level 2.5: MCP Tools & Skills

**What:** Structured tools the agent calls via MCP protocol. Code that runs when invoked.
**Enforcement:** Semi-automatic — agent must call the tool, but the tool enforces the pattern correctly when called. Can be the ONLY way to perform an action (forcing correct behavior).
**When sufficient:** Complex operations that need guardrails but still require agent judgment on WHEN to act.

**Mechanisms:**
- **MCP tools** (`container/agent-runner/src/ipc-mcp-stdio.ts`) — `create_case`, `send_message`, `case_mark_done`
- **Skills** (`.claude/skills/`) — reusable capability packages with their own docs
- **Agent-browser** — structured web automation tool

**Key distinction from hooks:** Hooks fire automatically on events. MCP tools require agent initiative but enforce correctness when used. Example: `create_case` tool ensures proper case ID, workspace creation, DB insert, and user notification — the agent just decides WHEN to create a case.

### Level 3: Mechanistic / Architectural

**What:** System design makes the wrong thing impossible or the right thing automatic.
**Enforcement:** Structural — built into the code path, can't be bypassed. No agent decision-making.
**When sufficient:** High-cost failures, anything that wastes human time, repeat failures.

**Mechanisms:**
- **Harness code** (`src/`) — IPC handlers, message processing, container runner
- **Container architecture** — read-only mounts, credential proxy, isolation
- **Automated handlers** — cookie auto-handler, timeout progress messages
- **Data validation** — schema enforcement at parse time
- **Message middleware** — pattern detection in incoming messages (e.g., auto-detect cookie JSON)

## Escalation Rules

```
Is this the first occurrence?
  YES → Level 1 (instructions)
  NO  → Has this type of failure happened before?
          YES → Level 2 (hooks/checks) minimum
          NO  → Level 1, but note it for escalation if it recurs

Does this failure waste human time?
  YES → Level 3 (mechanistic) — humans should never wait on agent mistakes

Could an agent bypass this fix by ignoring instructions?
  YES → Must be Level 2+ (enforcement, not just guidelines)

Does the operation need agent judgment on WHEN but not HOW?
  YES → Level 2.5 (MCP tool) — agent decides when, tool enforces correctness

Is the check fully automatable (no judgment needed)?
  YES → Level 2 (hooks) or Level 3 (mechanistic) — why rely on agent memory?
```

## Issue-Filing Discipline — describe the failure mode, not the solution (kaizen #713)

Before writing the solution section of any issue, answer these four questions:

1. **What is the failure mode?** Not the specific trigger — the *class* of failure. Example: "tests can hang with no circuit breaker" not "test wrote to `/proc`."
2. **How often is this expected to recur, and what is the real cost?** If it happened once and cost 5 minutes, the issue may not be worth the filing overhead.
3. **What is the simplest fix at the right level?** (L1/L2/L3) — consider all three before committing to one.
4. **Is the solution section describing an outcome, or a specific implementation?** If it prescribes a specific mechanism (e.g., "add a hook that blocks X"), flag it. The issue should describe the *problem and desired outcome*. Leave the mechanism to the implementor.

**Why this matters:** Issues filed in solution mode ("add a hook that blocks X") collapse the solution space. A future implementor reads the spec as a contract and builds exactly what it says — even if the spec is wrong. The filer is in "what would have prevented this?" mode rather than "what failure mode are we addressing?" mode. The first answer is usually too narrow. (See #685 → #712 as a concrete example of this pattern.)

**Red flag:** If your issue title starts with "Add hook that..." or "Create script to..." — you're describing the solution, not the problem. Rewrite the title to name the failure mode.

## Kaizen Backlog

All improvements that are too large for the current PR go to the `$ISSUES_REPO` issue tracker (see [skill-config-header.md](../../kaizen/skill-config-header.md) for routing).

See [`docs/issue-taxonomy.md`](../../../docs/issue-taxonomy.md) for the full labeling taxonomy, epic lifecycle policy, and incident recording format.

Issue format:
- **Title:** `[L{level}] Brief description`
- **Required labels:** `kaizen` + level (`level-1`/`level-2`/`level-3`) + area (`area/hooks`, `area/skills`, `area/cases`, `area/deploy`, `area/testing`, `area/container`, `area/worktree`) + horizon (recommended)
- **Body:**
  - What failed (incident description / failure mode class)
  - Why it failed (root cause)
  - Current level of fix (if any)
  - Desired outcome and target level (not a specific mechanism — see discipline check above)
  - Verification: how to confirm the fix works

**Fast path:** Use `/kaizen-file-issue` for quick incident-to-issue capture. It enforces the discipline checks above (failure mode framing, duplicate search, level classification) in a streamlined 2-minute flow.

**Before filing a new issue:** Search for existing issues first (`gh issue list --repo "$ISSUES_REPO" --search "<keywords>"`). If a match exists, add an incident comment instead of filing a duplicate. Incidents compound evidence; duplicates fragment it.

## PR Kaizen Section

Every fix-PR MUST include a kaizen section:

```markdown
## Kaizen
- **Root cause:** [what actually caused this]
- **Fix level:** L[1/2/3] — [instructions/hook/mechanistic]
- **Repeat failure?** [yes/no — if yes, what was the previous fix and why wasn't it enough?]
- **Escalation needed?** [yes/no — should this be a higher level?]
- **Backlog issue:** [link to kaizen issue if filed, or "N/A — implemented in this PR"]
```

## Recursive Kaizen

Improving how we improve:

- **Level 1 kaizen:** Improving the work itself (fixing bugs, adding features)
- **Level 2 kaizen:** Improving HOW we work (better processes, hooks, checks)
- **Level 3 kaizen:** Improving how we improve (the kaizen system itself, reflection triggers, escalation criteria)

When the kaizen system itself fails (e.g., reflections happen but don't produce action, or improvements are identified but never implemented), that's a signal to apply kaizen to kaizen — recursive improvement.

**Kaizen horizon taxonomy:** See [horizon.md](../../kaizen/horizon.md) for the L0–L8 taxonomy of autonomous kaizen. Current state: L3–L4, with L5 just beginning.

### Meta-reflection — concrete-to-abstract ladder (MANDATORY)

Every kaizen reflection must include meta-reflection on the kaizen system itself. This is what makes the recursion real, not just aspirational.

**Answer these in order. Each builds on the previous:**

1. **What specific friction did you encounter?** Name the exact moment, not the category. Example: "gap analysis recommended #107 as low-hanging fruit but it was already fixed in PR #210."
1b. **What near-misses occurred?** A near-miss is when you almost took a wrong action but something stopped you — a user correction, a test failure, a second look, or a gut check. Name the moment and what prevented the mistake. Near-misses reveal the same process gaps as actual incidents; they just didn't cause damage *this time*. If nothing stopped the mistake and it went through, that's friction (step 1), not a near-miss.
2. **Is there a generalized version of this friction?** Extract the principle — does this apply beyond this session? Example: "any system that recommends action from cached state is vulnerable to cache-code drift."
3. **What should change in the kaizen system?** Which skill, hook, or process should be different? Example: "gap-analysis should verify recommendations against git log before declaring low-hanging fruit."
4. **What should change in how kaizen improves itself?** Is the reflection mechanism catching this type of friction? Example: "meta-findings are filed individually but never aggregated — the same friction recurs across sessions without anyone connecting the dots."
5. **What mechanism would make this automatic?** Don't just identify — propose the enforcement level (L1/L2/L3). Example: "L2.5 — a meta-finding aggregation step in gap-analysis that scans recent KAIZEN_IMPEDIMENTS for patterns."

Starting concrete and zooming out produces actionable output. Starting abstract produces abstract output. If any step surfaces an improvement, **file a kaizen issue about the skill or process itself.** The kaizen system is just code and prompts — it should improve as aggressively as the codebase does.

**Additional cross-checks (after the ladder):**
- **Were all accept-case preventions dispositioned?** If `/kaizen-evaluate` identified preventions or root causes, list each one and its status: implemented in this PR, filed as issue #N, or not addressed. If any are "not addressed," file them now — a prevention identified but not tracked is a prevention lost.
- **What prompt change would have made this session better?** Look at your mistakes, wrong turns, and suboptimal outputs. For each one, name the specific skill, the current wording gap, and the proposed improvement. The goal is self-improving prompts — every session should make the next one better.
- **Were positive findings amplified?** Review any `type: "positive"` findings from step 2.5. For each non-obvious success, verify it was documented (`disposition: "amplified"` with a `target`). A validated practice that isn't written down will be independently rediscovered — or lost.
- **PRD knowledge flow check (kaizen #381):** Is the parent PRD/epic's methodology reflected in the repo? Specifically: (1) Does the parent epic propose skill/hook/doc changes that haven't been applied? (2) Does it contain process insights that only exist in the GitHub issue body? (3) If gaps exist, file sub-issues with the specific changes needed — not "update skills" but the exact prompt text or doc section. Knowledge in issues is ephemeral; knowledge in skills/docs/hooks is durable. This check catches knowledge gaps that the PRD Knowledge Flow Checklist and the implement-spec methodology cross-check both missed.
- **Admin teaching embedding (kaizen #457):** Did the admin correct your behavior or teach a new principle during this session? Every admin correction is signal about what kaizen L1 instructions are missing. For each correction: (1) Save as feedback memory for the current agent. (2) Identify where in kaizen infrastructure this should be codified — use the routing table below. (3) Make the change in this PR if small (<10 lines), or file an issue with the exact change needed.

  **Admin teaching routing table:**
  | Teaching type | Where to embed | Example |
  |---------------|----------------|----------|
  | Workflow discipline | SKILL.md (the relevant skill) | "Always check for existing work before starting" → add to evaluate skill |
  | Philosophical principle | `.claude/kaizen/zen.md` | "Specs are hypotheses" → add as a zen principle |
  | Quality standard | `.claude/kaizen/review-criteria.md` | "Never ship without E2E test" → add review criterion |
  | Recurring enforcement need | File L2 hook issue | "Agents keep forgetting X" → propose a hook |
  | Operational practice | `.claude/kaizen/policies.md` or `verification.md` | "Always timeout subprocesses" → add to verification |

  **The recursive principle:** "Admin had to prompt me" = kaizen failed to teach the agent automatically. The fix is not memory (helps one agent) — it is infrastructure (helps all agents). Memory is a bandaid; skill/hook/doc changes are the cure.

**Actionability rule:** Every meta-reflection finding MUST have a disposition — either a filed issue (with `ref: "#NNN"`) or fixed in this PR. An observation without a disposition is decoration, not kaizen. If something is truly not friction, reclassify as `type: "positive"` with `disposition: "no-action"`. Include meta-reflection findings in your `KAIZEN_IMPEDIMENTS` declaration with `"type": "meta"`:

```json
{"finding": "accept-case was heavyweight for spec'd issues", "type": "meta", "disposition": "filed", "ref": "#161"}
{"finding": "foundation-first approach validated", "type": "positive", "disposition": "no-action", "reason": "Already natural pattern"}
```

Positive findings (`type: "positive"`) use `disposition: "amplified"` when the pattern is non-obvious and worth documenting for future agents (see step 2.5 above). Use `disposition: "no-action"` only when the pattern is already documented or self-evident.

### No-waiver policy (kaizen #198)

**"Waived" is not a valid disposition.** The agent doing the waiving is the same agent evaluating the waiver — adding guardrails doesn't fix motivated reasoning. A checkbox doesn't prevent rationalization.

Instead, every impediment gets one of three dispositions:
- `"fixed-in-pr"` — addressed in this PR **(preferred for small fixes)**
- `"filed"` — real friction, filed as an issue (with `ref: "#NNN"`)
- `"incident"` — recorded as an incident on an existing issue (with `ref: "#NNN"`)

If something is not actually friction, it's a positive finding:
- `{"type": "positive", "disposition": "no-action", "reason": "why this is not friction"}`

**The `pr-kaizen-clear.sh` hook enforces this at L2.** Any `disposition: "waived"` is rejected with guidance to file or reclassify.

### Fix-first disposition policy (kaizen #441)

**Before filing an impediment as a new issue, ask: "Can I fix this in under 10 minutes without changing the PR's scope?"** If yes, fix it now and use `disposition: "fixed-in-pr"`. Filing takes 2 minutes but creates a context-reload cost later. Fixing takes 5-10 minutes while you already have full context. The issue you file today becomes the multi-PR fix cycle you pay for tomorrow.

**Fix in this PR when:**
- The fix is < 10 minutes and < 30 lines of changes
- The impediment is in files you're already touching
- It's a config/infrastructure fix (gitignore, tsconfig, package.json)
- Not fixing it would be ironic (e.g., DRY violation in a DRY detector)

**File instead when:**
- The fix touches code unrelated to this PR (increases scope and review burden)
- It requires architectural decisions or user input
- It would add > 30% to the PR's diff size
- It needs its own test suite to verify

**The compound benefit:** Each impediment fixed in-PR is one fewer issue in the backlog, one fewer context switch, one fewer PR in the fix cycle. Over 10 reflections, fixing 2 trivial impediments per session instead of filing them saves 20 future context-loads.

> A mechanism you can't reach is a mechanism you don't have.
> Existence is not availability. Availability is not accessibility.

### Post-cycle ultrathink — escalating structural questions (kaizen #260)

After completing the meta-reflection ladder above, spend one more cycle asking questions that surface **structural** insights the default reflection misses. These questions escalate from session-specific to system-wide:

1. **What category does this session's work belong to?** Not the area label — the *type of improvement*. Was this a symptom fix, a category fix, a prevention mechanism, or a detection mechanism? (Ref: Zen §"The right level matters more than the right fix")
2. **If this exact type of work recurs in 3 months, what should be different?** The answer reveals missing infrastructure, not missing instructions.
3. **What assumption did this session validate or invalidate?** Every implementation tests a hypothesis about the system. Name it explicitly.
4. **What's the smallest mechanism that would have prevented this session from being necessary?** If the answer is "nothing — this was genuinely new work," that's fine. If the answer is a hook, test, or contract, file it.

These questions are intentionally abstract. They produce value when they surface something the concrete ladder missed. If they produce nothing beyond what steps 1-5 already found, say so — don't manufacture insight.

## Current Enforcement Inventory

See [`hook-catalog.md`](../../kaizen/docs/hook-catalog.md) for the complete hook inventory with event types, enforcement levels, and gate patterns.

**Non-hook enforcement:**

| Mechanism | Level | Location | What it enforces |
|-----------|-------|----------|-----------------|
| CLAUDE.md policies | 1 | Both repos | Direction, guidelines, decision frameworks |
| Global agent CLAUDE.md | 1 | `groups/global/CLAUDE.md` | Response timing, close-the-loop, formatting |
| Prettier pre-commit | 2 | `.husky/pre-commit` | Code formatting |
| Pre-commit main-checkout block | 2 | `.husky/pre-commit` | Blocks commits from main checkout |
| Pre-push main-checkout block | 2 | `.husky/pre-push` | Blocks pushes from main checkout (defense-in-depth) |
| CI: typecheck + unit tests | 2 | `.github/workflows/ci.yml` (ci job) | Typecheck, format, contract check, unit tests |
| CI: PR policy | 2 | `.github/workflows/ci.yml` (pr-policy job) | Test coverage for changed source files, verification section in PR body |
| CI: E2E tests | 2 | `.github/workflows/ci.yml` (e2e job) | Container build + Tier 1 (MCP tool registration) + Tier 2 (IPC round-trip with stub API). BuildKit + GHA cache, path-filtered |
| Branch protection | 2 | GitHub repo settings | `strict: true`, requires ci + pr-policy + e2e status checks to pass |
| Collision detection | 3 | `src/ipc-cases.ts` | Blocks duplicate case creation for same kaizen issue |
| Case-GitHub issue sync | 3 | `src/case-backend-github.ts` | Auto-syncs status:active/done labels, closes issues on completion |
| IPC requestId sanitization | 3 | `src/ipc-sanitize.ts` | Prevents path traversal in IPC handlers |
| Git LFS | 3 | `.gitattributes` | Binary files tracked correctly |
| Container read-only mounts | 3 | `container-runner.ts` | Work agents can't modify tools |
| Mount security allowlist | 3 | `mount-security.ts` | Validates container mount paths against allowlist |
| Credential proxy | 3 | `credential-proxy.ts` | Secrets never exposed to containers |
| Mechanistic error notifications | 3 | `src/index.ts` | Users always informed of failures (no silent errors) |
| Immediate ack | 3 | `src/index.ts` | Users always know message was received |

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Reflect on work | Review what happened: impediments, friction, near-misses, what slowed down, what went well |
| 1.5 | Consult telemetry | If in auto-dent batch: read events.jsonl, compare cost/duration/outcome against baselines. Data before anecdote. |
| 2 | Identify impediments — patterns first | 2a: List all impediments. 2b: Name categories before dispositioning. 2c: New pattern or recurrence? Recurrence must escalate. |
| 2.4 | Multi-PR quality check | Is this the 2nd+ PR for the same feature? What pre-flight discipline was missing? See signals table. |
| 2.5 | Amplify positive findings | What techniques worked? What was surprising? Document non-obvious successes for future agents. Disposition: amplified or no-action. |
| 3 | Classify enforcement level | L1 (instructions), L2 (hooks), L2.5 (MCP tools), L3 (mechanistic). Apply escalation rules. |
| 4 | File issues / incidents | Search for duplicates first. Disposition: fixed-in-pr, filed, incident, or positive/amplified. No waivers. |
| 5 | Meta-reflection | 5-question ladder: specific friction → generalized → kaizen system change → self-improvement → mechanism. Post-cycle ultrathink. |

**What comes next:** Cleanup (worktree + branch deletion). If sub-issues remain from `/kaizen-plan`, loop back to `/kaizen-implement` for next sub-issue. See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for full workflow.

## Pending Escalations

These are currently Level 1 (instructions) but should be higher:

| Issue | Current | Target | Kaizen Issue |
|-------|---------|--------|-------------|
| Cookie expired, human response ignored | L1 (CLAUDE.md) | L3 (auto-detect cookie JSON, save, test) | TODO: file |
| Agent silent during long processing | L1 (CLAUDE.md "send early reply") | L3 (harness timeout sends progress) | TODO: file |
