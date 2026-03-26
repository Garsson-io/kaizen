---
name: kaizen-review-pr
description: Review PR — Adversarial dimension review with fix loop
user_invocable: true
---

# Review PR

## Loop

| Phase | What you do | Done when |
|-------|-------------|-----------|
| **1. Pre-fetch** | Get diff, issue, PR body, briefing | All data in hand |
| **2. Run dimensions** | Spawn subagents (parallel) for all dimensions | Every dimension has findings JSON |
| **3. Classify** | Auto-classify showstoppers; score rest by confidence | MUST-FIX + SHOULD-FIX list assembled |
| **4. Fix** | Fix every MUST-FIX and SHOULD-FIX, commit, push | All items addressed |
| ↩ **Repeat from Phase 1** | Read updated diff, re-run all dimensions | — |
| **DONE** | No MUST-FIX or SHOULD-FIX remain after Phase 3 | Declare: `REVIEW PASSED — N rounds, M findings fixed` |
| **ESCALATE** | Round 3 ends with remaining MUST-FIX | Comment on PR, do not merge |

**Loop rule:** After Phase 4, return to Phase 1 with the updated diff. Max 3 full rounds.

---

## Artifacts

| Artifact | Produced by | Consumed by | Lives where |
|----------|-------------|-------------|-------------|
| Briefing (dim list + groupings) | `briefing --lines N` | Phase 2 grouping decision | in-context |
| Diff | `gh pr diff` | All review subagents | pass verbatim into agent prompts |
| Issue body | `gh issue view --repo "$ISSUES_REPO"` | requirements, scope-fidelity, test-plan, plan-fidelity agents | pass into agent prompts |
| PR body | `gh pr view` | pr-description, plan-fidelity agents | pass into agent prompts |
| Dimension findings (JSON) | Each subagent | Phase 3 classifier | in-context |
| Classified findings list | Phase 3 | Phase 4 fix work | in-context |
| Review verdict | Clean Phase 3 | `pr-review-loop-ts.sh` state gate | hook state file |

---

## Showstoppers (Auto MUST-FIX, confidence 100)

These bypass normal confidence scoring. If any subagent returns one, classify it immediately as MUST-FIX — no deliberation.

| Showstopper | Dimension | Signal |
|-------------|-----------|--------|
| **No implementation plan** | `plan-fidelity` | `plan existence: MISSING` — agent went issue→code without planning |
| **New behavior, no tests** | `test-plan` | `coverage completeness: MISSING` for a PR that adds logic |
| **Security vulnerability** | `security` | Any `MISSING` finding (injection, secrets, eval) |

Fix these before anything else. They are not judgment calls.

---

## Phase 1: Pre-fetch

Run before spawning any agents. Pass collected data directly into agent prompts — agents should not re-fetch.

```bash
# Diff line count (for briefing)
LINES=$(gh pr diff <pr-url> | wc -l)

# Dimension briefing — shows all dimensions, data needs, natural groupings
npx tsx src/cli-dimensions.ts briefing --lines $LINES

# Full diff (pass to all agents)
gh pr diff <pr-url>
# Diff URL (for humans): https://github.com/<owner>/<repo>/pull/<N>.diff

# Linked issue(s) — scan PR body, branch name, recent commits for #N
gh issue view <N> --repo "$ISSUES_REPO" --json title,body

# PR body (includes test plan link if present)
gh pr view <pr-url> --json title,body,url

# Plan text (for plan-dependent dimensions: plan-fidelity, plan-coverage, improvement-lifecycle)
npx tsx src/cli-structured-data.ts retrieve-plan --issue <N> --repo "$ISSUES_REPO"

# Connected issues (for requirements coverage — verify ALL connected issues are addressed)
npx tsx src/cli-structured-data.ts query-connected --issue <N> --repo "$ISSUES_REPO"
```

**After pre-fetch, display the review context before spawning agents:**

```
PR:    <pr-url>
Diff:  https://github.com/<owner>/<repo>/pull/<N>.diff
Issues: #N1 <title> <url>
        #N2 <title> <url>
Plan:  <plan text length or "none — plan dims will emit MISSING">
Connected: #N1 [role] title, #N2 [role] title (from query-connected)

Agents:
- Agent 1: <dimension list> (<needs>)
- Agent 2: <dimension list> (<needs>)
- Agent 3: <dimension list> (<needs>)
- Agent 4: <dimension list> (<needs>)
```

This display makes the review plan visible before subagents launch — easier to spot missing coverage or wrong groupings.

---

## Phase 2: Run All Dimensions

Every `prompts/review-*.md` file is a dimension. All dimensions run every round. No skipping.

### Step 2a: Decide grouping

Use the briefing's natural groupings (dimensions sharing the same data needs). Scale agent count to PR size:

| PR size | Agents | Rule |
|---------|--------|------|
| ≤ 50 lines | 1–2 | One agent can handle all dimensions |
| 50–300 lines | 3–4 | Group by shared data needs |
| > 300 lines | 4–5 | 2–3 dimensions per agent |
| Security-sensitive | +1 | Give `security` + `correctness` to an additional independent agent |

Data needs determine grouping efficiency — dimensions with identical `needs` share one fetch:
- `[diff]` only: correctness, dry, security, tooling-fitness
- `[diff, issue]`: requirements, scope-fidelity
- `[diff, pr, issue]`: pr-description
- `[diff, tests]` / `[diff, tests, issue]`: test-quality, test-plan
- `[diff, issue, plan, pr]`: improvement-lifecycle, plan-fidelity

### Step 2b: Spawn agents (in parallel)

Send **one message with all Agent tool calls** (parallel launch). For each group:
- Include the full text of each assigned `prompts/review-*.md` verbatim
- Include pre-fetched diff, issue body, PR body directly in the prompt
- Instruct the agent to output one JSON findings block per dimension

### Step 2c: Coverage gate

After all agents return: verify every dimension has a JSON findings block. Any dimension missing → spawn a replacement agent for it. **Do not proceed to Phase 3 until all dimensions have findings.**

---

## Phase 3: Classify

1. **Auto-classify showstoppers first** (see above). These are MUST-FIX at confidence 100 regardless of anything else.
2. Drop all other findings with confidence < 60.
3. Classify remaining:
   - **MUST-FIX** (confidence ≥ 90): blocks merge — bugs, security issues, missing tests for new logic, DRY violations with 3+ copies
   - **SHOULD-FIX** (confidence 60–89): fix before merge — minor DRY, testability gaps, pattern inconsistencies

**Present findings as a table before fixing:**

| # | Finding | Status | Dimension |
|---|---------|--------|-----------|
| 1 | Short title of finding | MUST-FIX / SHOULD-FIX | dimension-name |

Then provide detail for each finding below the table.

If the list is empty after this: → **Phase 5 (Verdict)**.

---

## Phase 4: Fix

Fix MUST-FIX first, then SHOULD-FIX:

1. Edit code, add tests, extract helpers — address the root cause, not just the symptom
2. Commit + push (one commit per logical fix, or batch tightly related fixes)
3. Update the PR body using `/kaizen-sections` — add or replace the "Validation" section with current test results, don't rewrite the entire body:
   ```bash
   npx tsx src/cli-section-editor.ts replace-section --pr <N> --repo <repo> --name "Validation" --text "- [x] 545 tests pass..."
   ```
4. Return to Phase 1 with the updated diff

---

## Phase 5: Verdict

```
REVIEW PASSED — N rounds, M findings fixed
```

Before declaring: confirm every requirement from the linked issue is DONE or deferred with a filed follow-up issue.

---

## Escalation

After round 3 with remaining MUST-FIX items:

```bash
gh pr comment <url> --body "@aviadr1 Review hit 3 rounds. Remaining issues: [list]. Need human eyes."
```

Do NOT merge.

---

## What This Review Does NOT Check

- Build / typecheck — CI handles this
- Formatting / linting — CI handles this
- Pre-existing issues on unmodified lines
- Stylistic preferences not in any dimension

---

## Adding or Promoting Dimensions

When a failure pattern recurs enough to need a permanent check:

```bash
# Scaffold the new dimension
npx tsx src/cli-dimensions.ts add <name> --description "..." --applies-to pr|plan|both

# Validate all dimensions still pass
npx tsx src/cli-dimensions.ts validate
```

Write the adversarial prompt in `prompts/review-<name>.md`. The next review runs it automatically.

All dimensions live in `prompts/review-*.md`. Diff-detectable patterns use `applies_to: pr`. Cross-PR/reflection patterns (multi-pr-spiral, reflection-quality) use `applies_to: reflection` and are auto-skipped in single-PR review. Use `npx tsx src/cli-dimensions.ts list` to see all active dimensions and their scope.

---

## Enforcement Hooks

- `pr-review-loop-ts.sh` — tracks rounds, enforces max-3 rule
- `enforce-pr-review.ts` — blocks non-review tool calls during active review
- `stop-gate.ts` — blocks stopping until review verdict is recorded
