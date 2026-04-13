# Kaizen Process Invariants

Properties that MUST always hold in the kaizen workflow. Each invariant lists its check point and the enforcement layer that mandates it.

**Layer legend:**
- **L1** — Policy in AGENTS.md / SKILL.md (agent must remember)
- **L2** — PreToolUse/PostToolUse hook (blocks on violation)
- **L3** — Mechanistic (cannot be bypassed; built into data structures)

When L1 fails, escalate to L2. When L2 can be bypassed, escalate to L3.

---

## The kaizen process (canonical order)

```
1. FILE ISSUE       →  scope-matched; acceptance criteria explicit
2. WRITE PLAN       →  /kaizen-write-plan — stores plan with "## Test Plan" section
3. IMPLEMENT        →  /kaizen-implement — edits in worktree; uses plan
4. CREATE PR        →  gh pr create — body has Closes #<N> + behaviors×levels
5. REVIEW           →  /kaizen-review-pr — retrieves test plan; stores findings
6. REFLECT          →  /kaizen-reflect — KAIZEN_IMPEDIMENTS clears gates
7. MERGE            →  GitHub closes #N automatically
```

---

## Invariants

### I1 — Every PR has `Closes #<N>` with `#N` adjacent to the closing keyword

**Why**: Orphan PRs lose the issue/scope traceability. GitHub's parser requires `#N` immediately after `close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved`; any other pattern (e.g. `Closes subtask of #N`) is parser-ambiguous.

**Check point**: PR body at `gh pr create` time
**Enforcement**:
- L1: `.agents/AGENTS.md` Mandatory Practice, `.agents/skills/kaizen-write-pr/SKILL.md` "Issue linkage" section
- L2: **MISSING** — needs PreToolUse hook on `gh pr create` (see #1036 below)

### I2 — The closed `#N` is scope-matched (not an epic, no open sub-issues)

**Why**: Closing an epic auto-closes it on merge even if sub-PRs are outstanding. Real incident: #1029 used `Closes #1028` (epic) → GitHub closed the epic prematurely → admin had to reopen.

**Check point**: PR body at `gh pr create` time
**Enforcement**:
- L1: `.agents/AGENTS.md`, `.agents/skills/kaizen-write-pr/SKILL.md`
- Review-time: `prompts/review-requirements.md` check #7 (flags during dimension review)
- L2: **MISSING** — hook should call `gh issue view <N> --json labels` and deny if labels include `epic` or if `gh issue list --search "parent issue:<N>"` is non-empty

### I3 — The closed `#N` has a stored test plan (`retrieve-testplan` ≠ null)

**Why**: Without a stored test plan, reviewers have nothing to check the PR against. Agents can claim any test coverage. The test plan is the first-class contract for what "done" means.

**Check point**: PR body at `gh pr create` time
**Enforcement**:
- L1: `.agents/AGENTS.md` Mandatory Practice
- L3 (partial): `retrieveTestPlan` with 3-step fallback — dedicated attachment, plan attachment section, issue body section
- L2: **MISSING** — hook should call `npx tsx src/cli-structured-data.ts retrieve-testplan --issue <N> --repo <R>` and deny if empty

### I4 — PR body includes behaviors × levels table

**Why**: The reviewer retrieves it from the issue. The PR author must surface it in the body so reviewers can scan coverage at a glance.

**Check point**: PR body at `gh pr create` time
**Enforcement**:
- L1: `.agents/AGENTS.md`, `.agents/skills/kaizen-write-pr/SKILL.md` step 8
- L2: **MISSING** — hook should grep PR body for a behaviors×levels section and the 5-level taxonomy words

### I5 — Review round has structured findings stored

**Why**: Gate clearing requires proof of review work, not just comments. A `.reviewed-rN` sentinel is written only by `store-review-summary` (structured data). A comment alone does not clear the review gate.

**Check point**: After `gh pr diff` within a review
**Enforcement**:
- L2 ✅: `src/hooks/pr-review-loop.ts` `checkReviewSentinel` — won't transition state to `passed` without the sentinel

### I6 — Gates cleared by mechanism, never by `rm` of state files

**Why**: State files encode pending work. Removing them bypasses the requirement. Escape hatch exists (`KAIZEN_UNFINISHED`) but is auditable.

**Check point**: Stop
**Enforcement**:
- L2 ✅: `src/hooks/stop-gate.ts` reads all pending gates; only clears on explicit `KAIZEN_UNFINISHED` or per-gate clear mechanisms
- L1: `memory/feedback_post_merge_gate.md`

### I7 — No pushes to branches whose most recent PR is merged

**Why**: Commits pushed to a merged branch get orphaned; the review loop's state file points at the wrong (merged) PR. Always create a new branch for follow-up work.

**Check point**: `git push`
**Enforcement**:
- L1: `.agents/AGENTS.md` Branch & PR hygiene section (PR #1033)
- L2: **MISSING** — tracked in #1032

### I8 — Implementation begins only after plan is stored

**Why**: Retroactive plans rationalize whatever was built. The plan must drive implementation choices, not document them after the fact.

**Check point**: First implementation `git commit` on a worktree
**Enforcement**:
- L1: `.agents/AGENTS.md` (needs to be added)
- L2: **MISSING** — tracked in #1035

---

## Summary — where the gaps are

| Invariant | L1 | L2 | L3 | Gap |
|-----------|:---:|:---:|:---:|-----|
| I1 — Closes #N adjacent | ✅ | — | — | hook issue #1036 |
| I2 — Scope-matched (no epic) | ✅ | — | — | hook issue #1036 |
| I3 — Issue has test plan | ✅ | — | partial | hook issue #1036 |
| I4 — PR body has B×L table | ✅ | — | — | hook issue #1036 |
| I5 — Review findings stored | — | ✅ | — | complete |
| I6 — Gates cleared via mechanism | ✅ | ✅ | — | complete |
| I7 — No push to merged branch | ✅ | — | — | hook issue #1032 |
| I8 — Plan before implementation | — | — | — | tracked in #1035 (needs both L1 and L2) |

**Five of eight invariants need L2 hooks** to move from "the agent must remember" to "the system blocks the violation." Three follow-up issues track the missing hooks: #1032, #1035, #1036 (filed alongside this doc).

---

## Hook design principle for kaizen

Every invariant above follows the same escalation pattern:

1. **Start in L1** — write the rule in AGENTS.md or a SKILL file
2. **If agents violate it in practice** — escalate to L2 with a PreToolUse/PostToolUse hook that denies the violating action with a clear recovery message
3. **If the L2 hook can be bypassed by a workaround** — escalate to L3 by changing the data structure so the workaround becomes impossible

Never stop at L1 for an invariant that matters. L1 alone is a suggestion.
