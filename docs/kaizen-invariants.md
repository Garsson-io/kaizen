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

---

## Additional invariants discovered via hook inventory

The first 8 invariants above were identified from PR-creation incidents. A systematic review of every registered hook surfaces more invariants currently in force — some already at L2, others at L1 only.

### Edit/Write invariants (L2-enforced ✅)

### I9 — No source edits on main branch outside a worktree
**Why**: Main checkout is the canonical workspace; changes there bypass worktree isolation and race with other agents.
**Check point**: PreToolUse on Edit/Write
**Enforcement**: L2 ✅ `kaizen-enforce-worktree-writes.sh` — denies Edit/Write on source paths (src/, package.json, tsconfig.json, docs/, …) when in main checkout on main branch.

### I10 — No source edits in worktree without a kaizen case
**Why**: Every code change should be tied to a case record for traceability.
**Check point**: PreToolUse on Edit/Write (in worktree)
**Enforcement**: L2 ✅ `kaizen-enforce-case-exists.sh` — denies when case backend CLI is configured and no case matches the current worktree.

### Commit/push invariants (L2-enforced ✅)

### I11 — No dirty/uncommitted files at PR creation
**Why**: `gh pr create` with uncommitted work mislabels the PR's contents and orphans the missing commits.
**Check point**: PreToolUse on `gh pr create`
**Enforcement**: L2 ✅ `kaizen-check-dirty-files-ts.sh` — denies `gh pr create` when the worktree is dirty. Advisory on `git push` / `gh pr merge`.

### I12 — No `git rebase` on PR branches
**Why**: Rebase rewrites history, requires force-push, and loses the merge point. Safer path: `git merge origin/main`.
**Check point**: PreToolUse on Bash
**Enforcement**: L2 ✅ `kaizen-block-git-rebase.sh` — denies `git rebase` except `--abort`/`--continue`/`--skip`.

### Gate invariants (L2-enforced ✅)

### I13 — While review is pending (`needs_review`), only review-scoped commands run
**Why**: Prevents the agent from sidestepping the review by doing other work first.
**Check point**: PreToolUse on any tool during review gate
**Enforcement**: L2 ✅ `kaizen-enforce-pr-review-ts.sh` — denies all non-review Bash/Edit/Write; allows `gh pr diff/view/comment`, `git diff`, `grep`, `npm test`, `npx`, Agent.

### I14 — While reflection is pending (`needs_pr_kaizen`), only kaizen-scoped commands run
**Why**: Parallel to I13 — enforces the reflection step before continuation.
**Check point**: PreToolUse on any Bash during reflection gate
**Enforcement**: L2 ✅ `kaizen-enforce-pr-reflect-ts.sh`.

### I15 — Every push to an open PR's branch triggers a review round
**Why**: New code is new risk; a prior round's pass is stale.
**Check point**: PostToolUse on `git push`
**Enforcement**: L2 ✅ `pr-review-loop-ts.sh` — bumps round and re-activates `needs_review`. Auto-passes only tiny pushes (<15 lines) and never past `CUMULATIVE_CAP=100`.

### I16 — Every PR create/merge requires a reflection
**Why**: Each PR is a learning opportunity; skipping reflection lets impediments compound.
**Check point**: PostToolUse on `gh pr create` / `gh pr merge`
**Enforcement**: L2 ✅ `kaizen-reflect-ts.sh` — sets `needs_pr_kaizen`. Cleared by valid `KAIZEN_IMPEDIMENTS` JSON or `KAIZEN_NO_ACTION` declaration via `pr-kaizen-clear-ts.sh`.

### Quality invariants (L1 advisory — candidates for escalation)

### I17 — Source files co-commit with their tests
**Why**: Without co-commit, tests can lag forever. Every changed source file should have a matching test file changed in the same commit OR an explicit `@test-exception: <reason>` annotation.
**Check point**: PreToolUse on `git commit`, `gh pr create`
**Enforcement**: L1 only ⚠️ — `kaizen-pr-quality-checks-ts.sh` warns but does not block. Candidate for escalation to L2.

### I18 — Tests pass before stopping
**Why**: Stopping with failing tests hides regressions.
**Check point**: Stop
**Enforcement**: L1 only ⚠️ — `kaizen-verify-before-stop.sh` reminds. Cannot be automated without spawning heavy subprocesses on Stop (retry loops risk OOM — see hooks-design.md).

### I19 — No secrets/credentials in commits
**Why**: Irrecoverable once pushed.
**Check point**: PreToolUse on `git commit`, `gh pr create`
**Enforcement**: L1 only ⚠️ — `kaizen-pr-quality-checks-ts.sh` has a light heuristic check. Candidate for L2 with a proper secret-scanner.

### I20 — Search for similar issues before creating a new one
**Why**: Duplicate issues fragment attention.
**Check point**: PreToolUse on `gh issue create`
**Enforcement**: L1 advisory ⚠️ — `kaizen-search-before-file.sh` searches and shows results but does not block.

### I21 — Worktree cleanup before stopping (no orphan locks, no uncommitted work)
**Why**: Orphan locks block future sessions; uncommitted work gets lost on worktree removal.
**Check point**: Stop
**Enforcement**: L1 advisory ⚠️ — `kaizen-check-cleanup-on-stop.sh` warns + removes lock.

### Meta invariants (L1 only — candidates for future enforcement)

### I22 — Skill changes require behavioral proof (before/after test)
**Why**: Prompt-level changes can't be verified by unit tests; need a `claude -p` demonstration of the intended behavior difference.
**Enforcement**: L1 policy (`.agents/kaizen/policies.md` §10). Candidate for a L2 hook that inspects `.claude/skills/*/SKILL.md` diffs in PRs.

### I23 — PRs changing hooks/skills must run E2E tests against `kaizen-test-fixture`
**Why**: Hook/skill changes can silently break host-project integration.
**Enforcement**: L1 policy (`.agents/kaizen/policies.md` §11). Candidate for a CI check.

---

## Summary — where the gaps are

### L2-enforced (no gap)
I5, I6, I9, I10, I11, I12, I13, I14, I15, I16 — **10 invariants fully at L2.**

### L1-only policy (gap — agent must remember)
I1, I2, I3, I4, I7, I8, I17, I18, I19, I20, I21, I22, I23 — **13 invariants only at L1.**

### Follow-up issues escalating to L2

| Invariants | Tracking issue | Scope |
|------------|:-:|---|
| I1, I2, I3, I4 | **#1036** | PR preconditions hook on `gh pr create` |
| I7 | **#1032** | `git push` hook for merged-branch detection |
| I8 | **#1035** | implementation precondition: issue has stored test plan |
| I17 (co-commit tests) | — | candidate — file issue to escalate pr-quality-checks warning to block |
| I19 (secrets) | — | candidate — file issue for proper secret-scanner integration |
| I22, I23 (meta) | — | candidates — tooling-fitness PRDs

---

## Hook design principle for kaizen

Every invariant above follows the same escalation pattern:

1. **Start in L1** — write the rule in AGENTS.md or a SKILL file
2. **If agents violate it in practice** — escalate to L2 with a PreToolUse/PostToolUse hook that denies the violating action with a clear recovery message
3. **If the L2 hook can be bypassed by a workaround** — escalate to L3 by changing the data structure so the workaround becomes impossible

Never stop at L1 for an invariant that matters. L1 alone is a suggestion.
