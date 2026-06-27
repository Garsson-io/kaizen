---
name: kaizen-review-pr
description: Review PR — Adversarial dimension review with fix loop
user_invocable: true
---

# Review PR

**Upholds invariants**: I5 (findings stored), I13 (review gate), I15 (push → review round), I27 (no silent deferring), I28 (all applicable dimensions). See [`docs/kaizen-invariants.md`](../../../docs/kaizen-invariants.md).

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
- **Instruct each agent to store its own findings immediately** (see storage instruction below)

**Storage instruction to include in every subagent prompt** (substitute actual PR number, repo, round):
> After outputting your JSON findings blocks, for EACH dimension you reviewed,
> pipe the JSON payload directly to `store-review-finding` via `--stdin`:
>
> ```bash
> npx tsx src/cli-structured-data.ts store-review-finding \
>   --pr <PR_NUMBER> --repo <owner/repo> --round <ROUND> \
>   --dimension <dim> --stdin <<'JSON'
> {"dimension":"<dim>","verdict":"pass|fail","summary":"...","findings":[...]}
> JSON
> ```
>
> **Use heredoc-to-stdin, not `--text`** — shell-quoting `--text` with JSON that
> contains quotes or newlines is fragile (#1039 silently degraded to a
> fail-with-empty-findings sentinel that satisfied the review gate but lost
> every actual finding). Heredoc-to-stdin passes the payload through a pipe —
> no shell quoting, multi-line-safe.
>
> **Do NOT write to `/tmp/finding-<dim>.json` first** — the review gate
> (`enforce-pr-review.ts`) blocks the `Write` tool and most Bash commands
> during active review; `cat > /tmp/...` heredoc redirects are among the
> blocked operations. `npx tsx ... --stdin <<'JSON'` is on the allowed
> path (`npx` + Bash heredoc into the process's stdin). See epic #1059.
>
> The CLI validates the payload strictly: it exits non-zero with an actionable
> error if the JSON doesn't parse, required fields are missing, or `verdict=fail`
> has empty findings. If you see a non-zero exit, FIX the payload and re-run —
> do not ignore it, or the review gate will clear on empty findings.
>
> On success the CLI prints the stored URL plus a one-line summary
> (`N findings (D DONE, P PARTIAL, M MISSING)`). Verify the counts match your
> intent before ending your response.

**Why per-agent storage (not orchestrator batch):** If the orchestrating session is interrupted after some agents complete, already-stored findings survive on the PR. The orchestrator only stores the summary (Phase 5) — per-dimension storage is each agent's own responsibility.

### Step 2c: Coverage gate

After all agents return: verify every dimension has a JSON findings block in the responses AND a marker comment on the PR (`list-review-dims`). Any dimension missing → spawn a replacement agent. **Do not proceed to Phase 3 until all dimensions have findings stored.**

```bash
npx tsx src/cli-structured-data.ts list-review-dims \
  --pr <PR_NUMBER> --repo <owner/repo> --round <ROUND>
```

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

**You do not write the verdict. The verdict is derived.** `store-review-summary` reads the
per-dimension findings you stored this round and composes the authoritative verdict block from
them — any MISSING → FAIL, PARTIAL but no MISSING → PASS (surfaced loudly), else PASS. You cannot
substitute a hand-written "REVIEW PASSED" for the derived block (#1019); a note that asserts the
round passed while the findings derive FAIL is rejected.

Before storing: confirm every requirement from the linked issue is DONE or deferred with a filed
follow-up issue. If any dimension still has MISSING findings, the round is FAIL — fix them
(Phase 4) or escalate; do not narrate a pass.

Store the round summary (required to advance to next round or close the gate):
```bash
npx tsx src/cli-structured-data.ts store-review-summary \
  --pr <PR_NUMBER> --repo <owner/repo> --round <N> --head-sha "$(git rev-parse HEAD)" --wait-ci
```

For a derived PASS or PASS-with-partials verdict, `store-review-summary` now verifies the PR's
current HEAD matches `--head-sha` and that `gh pr checks` is green for that HEAD before it writes
the summary/sentinel (#1070). **Always pass `--wait-ci`** when storing right after a push: CI is
usually still running, and `--wait-ci` makes the command *poll* `gh pr checks` until terminal
instead of treating a still-pending check as a failure (#1221). On a genuine timeout it exits with
the distinct code `75` ("CI still pending — not a review FAIL") so the fix loop retries later rather
than counting an exhausting fix round. Failing or stale-head CI is still a real block (exit 1);
re-run review on the current head after CI passes. Tune the wait with `--ci-timeout-sec N` /
`--ci-poll-sec N`. A review summary on a non-PR (issue) target skips the CI proof entirely (#1222).

Add `--note "<context>"` only for non-verdict commentary (e.g. "rebased onto main, re-ran tests").
Read back the derived verdict with `read-review-summary --pr <N> --repo <repo> --round <N>` — the
header line (`## Review Round N — PASS | PASS — k PARTIAL | FAIL`) is the real verdict.

If the derived verdict is FAIL or PASS — k PARTIAL with blocking gaps: return to Phase 1 with the
updated diff for the next round.

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
