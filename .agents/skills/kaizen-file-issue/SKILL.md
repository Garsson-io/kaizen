---
name: kaizen-file-issue
description: Friction-to-issue capture — takes an observed problem, preserves what sucked with enough detail, and explains what would be awesome instead without turning it into a design doc. Describes the failure mode and desired operator experience, not a prescribed implementation. Triggers on "file issue", "file kaizen", "file incident", "observed a problem", "log incident", "capture issue", "friction", "what would be awesome".
---

<!-- Host config: read .agents/kaizen/skill-config-header.md before running commands -->

# File Issue — Friction-to-Issue Capture

**Role:** The friction capturer. Takes a raw observation ("I just saw X happen") and turns it into a well-formed GitHub issue that preserves what sucked with enough detail for a future implementor to understand it, plus what would be awesome instead. Describes the failure mode and desired operator experience, not a prescribed implementation.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — *"Compound interest is the greatest force in the universe."* Every incident captured is a data point. Data points compound into patterns. Patterns compound into systematic fixes.

**When to use:**
- You just observed a problem and want to preserve it before context evaporates
- During `/kaizen-reflect` when an impediment needs a filed issue
- During any work when you notice something broken or suboptimal
- When a human reports an incident that needs tracking
- When a workflow, CLI, hook, or tool interaction feels bad and the friction itself is the evidence

**When NOT to use:**
- Large initiatives that need problem-space mapping → use `/kaizen-prd`
- Issues that need decomposition into sub-issues → use `/kaizen-plan`
- You already know the solution and it's small → just fix it in the current PR

## The Anti-Pattern This Skill Prevents

Without a friction-capture path, three failure modes dominate:

1. **Solution collapse** — the first idea becomes the spec. "Add a hook that blocks X" gets filed instead of "tests can hang with no circuit breaker." The implementor inherits a prescribed mechanism instead of a problem to solve.
2. **Thin capture** — the issue names the gap but drops the costly session context: commands tried, errors, wrong-shaped tools, and what the operator actually needed.
3. **Filing avoidance** — writing a good issue feels heavyweight, so problems go unfiled and disappear.

This skill prevents all three by enforcing enough structure to preserve the friction without turning the issue into a design doc. The target is concise but complete: what happened, what sucked, what would be awesome instead, and why this is a problem space rather than a one-off.

## The Process

### Step 0: Read host configuration

```bash
KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)
HOST_REPO=$(jq -r '.host.repo' kaizen.config.json)
ISSUES_REPO=$(jq -r '.issues.repo // .host.repo' kaizen.config.json)
ISSUES_LABEL=$(jq -r '.issues.label // ""' kaizen.config.json)
```

### Step 1: Gather the friction

Ask (or extract from context) these things:

1. **What exactly happened?** The specific incident — concrete, with context (when, where, what was being done).
2. **What failure mode does this reveal?** One level of abstraction above the incident. Not "the hook didn't match" but "there's no format contract between hooks."
3. **What sucked?** The friction trail: commands tried, errors, confusing output, wrong-shaped interfaces, retries, missing affordances, or decisions the operator had to reconstruct manually.
4. **What would be awesome instead?** The desired operator experience with enough detail to recognize success: the command you wanted to type, the message you wanted to see, the workflow that should have been obvious.
5. **What's the rough direction?** A vague guess at the fix area (L1/L2/L3, which skill/hook/area). Explicitly flagged as a guess. Not a spec.

### Step 1b: Add workflow/QoL detail when friction is the evidence

For workflow, CLI, hook, review-gate, ergonomics, or quality-of-life issues, the friction trail is not optional. Add these sections when the information exists:

```markdown
## Friction Trail

[The sequence of attempts and what each one cost: commands, errors, misleading output, missing command, wrong-shaped tool, manual bridge, repeated retry.]

## What I Needed To Do/Write

[The command, UI action, status line, or decision path the operator wanted. This can be concrete without prescribing the implementation.]

## What Would Be Awesome Instead

[The target operator experience: what should be obvious, what should be one command, what should fail closed, what should be printed, what should be stored.]
```

Do not collapse these into "add a CLI that..." unless the friction itself proves that a CLI is the right level. Preserve the experience first; implementation details come later.

### Step 2: Search for duplicates

**Before filing, always search.** Duplicates fragment evidence; incidents compound it.

```bash
# Search for similar issues in the issues repo (HOST_REPO for host projects, KAIZEN_REPO for self-dogfood)
gh issue list --repo "$ISSUES_REPO" --state open --search "<keywords from the incident>" --json number,title,labels --limit 10

# Also search closed issues — the problem may have been "fixed" before
gh issue list --repo "$ISSUES_REPO" --state closed --search "<keywords>" --json number,title,labels --limit 5
```

**If a match exists — explicit decision required (kaizen #959):**

| Similarity | Action |
|---|---|
| Same root cause, same problem space | Add an incident comment to the existing issue. Do NOT file a new issue. |
| Related but distinct failure mode | File new issue AND cross-reference: "Related: #N — same problem space, different failure mode" |
| Superficially similar but different cause | File new issue with explicit note: "Differs from #N because [specific distinction]" |

**Do not proceed to file without making this decision explicit.** The choice between "same issue" and "new issue" is the most important quality gate in the filing workflow.

Add an incident comment to the existing issue using this format:

```markdown
## Incident — [date]

**What happened:** [specific incident]
**Context:** [what was being done when it happened]
**Severity:** [how much time/effort was wasted]
```

Then stop — the issue already exists.

### Step 3: Determine the target repo

Use the three-way routing from `/kaizen-reflect`:

| Type | Target repo | Labels |
|------|------------|--------|
| **Meta-kaizen** — improving kaizen itself | `$KAIZEN_REPO` | `kaizen` |
| **Host-kaizen** — improving the host project | `$HOST_REPO` | `kaizen` |
| **Generalized pattern** — reusable lesson | `$KAIZEN_REPO` | `kaizen`, `type:pattern` |

### Step 4: Classify severity and level

**Level** (enforcement escalation):
- `L1` — Instructions/docs fix (CLAUDE.md, SKILL.md, policies)
- `L2` — Hook or automated check needed
- `L3` — Must be built into architecture (can't be bypassed)

**Area labels** (pick one): `area/hooks`, `area/skills`, `area/cases`, `area/deploy`, `area/testing`, `area/container`, `area/worktree`, `area/observability`, `area/auto-dent`


### Step 4b: Validate minimum labels

Before filing, verify the issue will have **at minimum** these labels:
- `kaizen` (always required)
- One `area/*` label (e.g. `area/hooks`, `area/skills`, `area/testing`)

If a level was determined, also include the `level-N` label. Issues filed without labels are invisible to `/kaizen-pick`, `/kaizen-audit-issues`, and filtered views — #757 sat unlabeled for 24+ hours as an installation blocker because it had no labels.

**Hard rule:** Never pass an empty `--label` argument to `gh issue create`. If you cannot determine the area, default to the most likely area based on the incident description, or ask the user.

### Step 5: File the issue

```bash
gh issue create --repo "$TARGET_REPO" \
  --title "[L${LEVEL}] ${BRIEF_TITLE}" \
  --label "kaizen,level-${LEVEL},${AREA_LABEL}" \
  --body "$(cat <<'EOF'
## Incident

${INCIDENT_DESCRIPTION}

## Problem space

${FAILURE_MODE_DESCRIPTION}

## Friction Trail

${FRICTION_TRAIL_IF_RELEVANT}

## What I Needed To Do/Write

${WANTED_OPERATOR_ACTION_IF_RELEVANT}

## What Would Be Awesome Instead

${DESIRED_OPERATOR_EXPERIENCE_IF_RELEVANT}

## Directional guess

${ROUGH_DIRECTION} — details TBD by implementor.

## Refs

${ANY_RELATED_ISSUES_OR_PRS}
EOF
)"
```

### Step 6: Report the result

Print the issue URL and a one-line summary. If this was triggered from `/kaizen-reflect`, return the issue number for inclusion in `KAIZEN_IMPEDIMENTS`.

## What This Skill Explicitly Avoids

- **Specifying the implementation** — "add a hook that..." is too prescriptive. Describe the failure mode.
- **Decomposing into sub-issues** — that's the implementor's job via `/kaizen-plan`.
- **Writing a design doc** — capture what sucks and what would be awesome with enough detail; do not design the whole subsystem.
- **Becoming a PRD** — if the problem needs mapping, use `/kaizen-prd` instead.
- **Prescribing a mechanism** — name both failure modes the constraint should prevent, not just the one you observed (#722).

## Structured Issue Bodies

Use `##` section headers in the issue body (Problem, Evidence, Acceptance Criteria, etc.). These are readable by `/kaizen-sections` tools — agents can later read or update individual sections without rewriting the entire body: `npx tsx src/cli-section-editor.ts read-section --issue {N} --repo "$ISSUES_REPO" --name "Acceptance Criteria"`

## Issue Body Quality Checklist

Before filing, verify the issue body passes these checks:

- [ ] **Incident paragraph** describes what happened, not what to build
- [ ] **Problem space paragraph** names the failure mode class, not a specific fix
- [ ] **Friction Trail is present for workflow/QoL/tooling issues** — exact attempts, failures, confusing output, or wrong-shaped tools are preserved
- [ ] **What I Needed To Do/Write is present for workflow/QoL/tooling issues** — the desired command/action/status is concrete enough to recognize
- [ ] **What Would Be Awesome Instead is present for workflow/QoL/tooling issues** — the desired operator experience is detailed enough to guide a future implementor
- [ ] **Directional guess** is explicitly flagged as a guess, not a spec
- [ ] **Title** starts with `[L1]`, `[L2]`, or `[L3]`
- [ ] **No solution collapse** — the body doesn't prescribe "add hook X" or "change prompt Y"
- [ ] **Duplicate search was done** — confirmed no existing issue covers this
- [ ] **Labels present** — issue has at least `kaizen` + one `area/*` label. Never file without labels.

## Example Output

> **Title:** `[L2] Tests can hang indefinitely on platform-specific OS paths`
>
> ## Incident
>
> Run 73 test hung indefinitely. Traced to `mkdirSync('/proc/invalid/path')` which hangs on WSL2 instead of throwing.
>
> ## Problem space
>
> Tests that invoke real OS operations on platform-specific paths can hang with no circuit breaker. This is a class of failure, not a one-off — any test touching `/proc`, `/sys`, or other kernel interfaces on non-Linux or WSL platforms risks the same hang.
>
> ## Directional guess
>
> Timeout enforcement (L2) — probably vitest testTimeout + per-run wall-clock budget. Details TBD by implementor.
>
> ## Refs
>
> Batch run 73 log, #684 (vitest timeout), #686 (wall-clock budget)

## Workflow/QoL Example Output

> **Title:** `[L2] Review gate has no ergonomic focused-round storage command`
>
> ## Incident
>
> While preparing PR #1735, the Review verdict gate needed an authoritative stored review round after a small follow-up push. The available tools did not provide a clean "run selected dimensions, inspect, store round, rerun gate" path.
>
> ## Problem space
>
> Review execution and review storage are split across separate APIs. The correct path exists internally, but the operator has to bridge it manually during a blocked PR.
>
> ## Friction Trail
>
> I tried `npx tsx -e 'import { reviewBattery } ... await reviewBattery(...)'`; it failed because inline tsx used CJS output and rejected top-level await. Wrapping it in an async function then failed on module resolution for `./src/review-battery.js`. The supported `scripts/review-fix.ts --dry-run` command was also the wrong shape: it ran the full fix-loop-oriented review path, timed out several dimensions, and did not store the `review/rN/<dimension>` attachments consumed by CI.
>
> ## What I Needed To Do/Write
>
> I needed one supported command to run selected dimensions for PR #1735 and issue #1732, write a durable JSON result, then a safe store command that writes the authoritative review round only if no dimension has MISSING findings or provider failures.
>
> ## What Would Be Awesome Instead
>
> The tool should print per-dimension progress, write a reusable artifact, refuse to mark a failing round as passing, store through the existing structured-data review contract, and offer a copy-paste command to rerun the Review verdict gate.
>
> ## Directional guess
>
> L2 tooling ergonomics — likely a small TypeScript CLI over `reviewBattery()` and `storeReviewBatch()`. Details TBD by implementor.
