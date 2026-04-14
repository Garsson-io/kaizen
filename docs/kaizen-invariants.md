# Kaizen Process Invariants

> **CANONICAL SOURCE OF TRUTH.** This file is the single authoritative list of kaizen process invariants. Other files (AGENTS.md, skill docs, hook source files, review dimensions) reference invariants by their ID (`I1`..`IN`) and must NOT restate the rules. When an invariant changes, update this file only.

Properties that MUST always hold in the kaizen workflow. Each invariant lists its check point and the enforcement layer that mandates it.

**Layer legend:**
- **L1** — Policy in AGENTS.md / SKILL.md (agent must remember)
- **L2** — PreToolUse/PostToolUse hook (blocks on violation)
- **L3** — Mechanistic (cannot be bypassed; built into data structures)

When L1 fails, escalate to L2. When L2 can be bypassed, escalate to L3.

---

## Enforcement matrix — Invariant → Artifact (forward index)

Which artifacts uphold each invariant. Use this to answer "who cares about I7?"

| Invariant | Hook(s) enforcing | Skill(s) upholding | Review dimension(s) | Gap issue |
|-----------|-------------------|--------------------|---------------------|:----:|
| **I1** closes #N adjacent | — | `kaizen-write-pr` (write-time) | `requirements`, `pr-description` | [#1036](https://github.com/Garsson-io/kaizen/issues/1036) |
| **I2** scope-matched closure | — | `kaizen-write-pr`, `kaizen-evaluate` | `requirements`, `scope-fidelity` | [#1036](https://github.com/Garsson-io/kaizen/issues/1036) |
| **I3** issue has stored testplan | — | `kaizen-write-plan`, `kaizen-write-pr` | `plan-coverage`, `plan-fidelity` | [#1036](https://github.com/Garsson-io/kaizen/issues/1036) |
| **I4** PR body has B×L table | — | `kaizen-write-pr` (step 8) | `pr-description`, `test-plan` | [#1036](https://github.com/Garsson-io/kaizen/issues/1036) |
| **I5** review findings stored | `pr-review-loop` | `kaizen-review-pr` | `reflection-quality` | — |
| **I6** gates cleared by mechanism | `stop-gate`, `pr-kaizen-clear`, `post-merge-clear` | `kaizen-reflect` | — | — |
| **I7** no push to merged branch | — | — | — | [#1032](https://github.com/Garsson-io/kaizen/issues/1032) |
| **I8** plan before implementation | — | `kaizen-implement`, `kaizen-write-plan` | `plan-fidelity` | [#1035](https://github.com/Garsson-io/kaizen/issues/1035) |
| **I9** no edits on main outside worktree | `enforce-worktree-writes` | — | — | — |
| **I10** edit requires case | `enforce-case-exists` | — | — | — |
| **I11** no dirty files at PR create | `check-dirty-files` | — | — | — |
| **I12** no git rebase on PR branches | `block-git-rebase` | — | — | — |
| **I13** review gate limits tools | `enforce-pr-review` | `kaizen-review-pr` | — | — |
| **I14** reflect gate limits tools | `enforce-pr-reflect` | `kaizen-reflect` | — | — |
| **I15** push triggers review round | `pr-review-loop` | `kaizen-review-pr` | `multi-pr-spiral` | — |
| **I16** PR create/merge → reflection | `kaizen-reflect-ts` | `kaizen-reflect` | `reflection-quality` | — |
| **I17** co-commit source + tests | `pr-quality-checks` (advisory) | — | `test-quality` | candidate |
| **I18** tests pass before stop | `verify-before-stop` (advisory) | — | `test-plan`, `test-quality` | candidate |
| **I19** no secrets in commits | `pr-quality-checks` (advisory) | — | `security` | candidate |
| **I20** search before issue create | `search-before-file` (advisory) | `kaizen-file-issue` | — | candidate |
| **I21** worktree cleanup on stop | `check-cleanup-on-stop` (advisory) | `kaizen-cleanup` | — | candidate |
| **I22** skill changes need proof | — | — | `skill-changes` | candidate |
| **I23** hook/skill PRs run E2E | — | — | `tooling-fitness` | candidate |
| **I24** post-merge branch+worktree cleanup | `post-merge-clear` (partial) | `kaizen-cleanup`, `kaizen-wip` | — | [#1037](https://github.com/Garsson-io/kaizen/issues/1037) |
| **I25** no dirty files between ops | `check-dirty-files` (partial) | — | — | [#1037](https://github.com/Garsson-io/kaizen/issues/1037) |
| **I26** branch from origin/main | — | `kaizen-evaluate` (collision detect) | — | [#1037](https://github.com/Garsson-io/kaizen/issues/1037) |
| **I27** test plan fully implemented | — | `kaizen-implement`, `kaizen-review-pr` | `plan-coverage`, `test-plan`, `scope-fidelity` | [#1038](https://github.com/Garsson-io/kaizen/issues/1038) |
| **I28** review covers all dimensions | `pr-review-loop` (sentinel, partial) | `kaizen-review-pr` | all | [#1038](https://github.com/Garsson-io/kaizen/issues/1038) |

## Enforcement matrix — Artifact → Invariants (reverse index)

### Hooks

| Hook | Event | Enforces |
|------|:-----:|----------|
| `enforce-pr-review` | PreToolUse (Bash/Edit/Write/Agent) | I13 |
| `enforce-pr-reflect` | PreToolUse (Bash) | I14 |
| `enforce-worktree-writes` | PreToolUse (Edit/Write) | I9 |
| `enforce-case-exists` | PreToolUse (Edit/Write) | I10 |
| `check-dirty-files` | PreToolUse (Bash) | I11, I25 (partial) |
| `block-git-rebase` | PreToolUse (Bash) | I12 |
| `pr-review-loop` | PostToolUse (Bash) | I5, I15, I16 (partial), I28 (partial) |
| `kaizen-reflect` | PostToolUse (Bash) | I16 |
| `pr-kaizen-clear` | PostToolUse (Bash) | I6, I16 (clear path) |
| `post-merge-clear` | PostToolUse (Bash/Skill) | I6, I24 (partial) |
| `stop-gate` | Stop | I6, I13/I14/I16/I24 (Stop-time check) |
| `pr-quality-checks` | PreToolUse (Bash) advisory | I17, I18, I19 (all advisory) |
| `verify-before-stop` | Stop advisory | I18 |
| `check-cleanup-on-stop` | Stop advisory | I21, I24 (partial) |
| `search-before-file` | PreToolUse (Bash) advisory | I20 |
| `capture-worktree-context` | PostToolUse (Bash) | — (infrastructure for I24/cleanup skills) |
| `worktree-setup`, `session-cleanup`, `check-wip` | SessionStart | — (infrastructure) |
| `bump-plugin-version` | PreToolUse (Bash) | — (infrastructure) |

### Skills

| Skill | Invariants it upholds / assumes |
|-------|--------------------------------|
| `/kaizen-write-pr` | I1, I2, I3, I4 (write-time enforcement) |
| `/kaizen-write-plan` | I3 (stores test plan), I8 (plan must exist) |
| `/kaizen-implement` | I3, I8, I10, I15, I17, I18, I27 |
| `/kaizen-review-pr` | I5, I13, I15, I27, I28 |
| `/kaizen-reflect` | I16 |
| `/kaizen-evaluate` | I2, I8, I26 |
| `/kaizen-cleanup` | I21, I24 |
| `/kaizen-wip` | I13, I14, I24 (awareness) |
| `/kaizen-file-issue` | I20 |
| `/kaizen-sections` | I3, I5 (storage primitives) |
| `/kaizen-dimensions` | I28 |
| `/kaizen-pick`, `/kaizen-prd`, `/kaizen-plan` | I2 (scope), I8 (plan-driven) |

### Review dimensions

| Dimension | Checks invariants |
|-----------|-------------------|
| `requirements` | I1, I2, I3, I27 |
| `scope-fidelity` | I2, I27 |
| `plan-coverage` | I2, I3, I8, I27 |
| `plan-fidelity` | I3, I8, I27 |
| `pr-description` | I1, I4, I27 |
| `test-plan` | I18, I27 |
| `test-quality` | I17, I18 |
| `security` | I19 |
| `skill-changes` | I22 |
| `tooling-fitness` | I9, I10, I19 (infrastructure placement) |
| `multi-pr-spiral` | I15, I18, I27 |
| `reflection-quality` | I5, I16 |
| `dry` | I17 (code reuse discipline) |
| `correctness` | I18, I27 (baseline code quality) |
| `improvement-lifecycle` | I5, I15, I16, I27, I28 (meta: kaizen capabilities improvable?) |

## How to add a new invariant

1. Pick the next unused ID (highest existing + 1).
2. Add a section in the invariants list below with: **Why** / **Check point** / **Enforcement**.
3. Add a row to the forward-index matrix above.
4. Add entries to the reverse-index matrices for each hook/skill/dimension that touches it.
5. If an L2 hook is missing, file a follow-up issue and add it to the **Gap issue** column.
6. In `.agents/AGENTS.md`, if the invariant needs to be visible in-context, add a one-line summary (NOT the full text — keep the canonical copy here).
7. For each hook source file that enforces the new invariant, add `@enforces IN` to its top-of-file JSDoc.

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

### Post-merge / branch hygiene invariants

### I24 — After PR merges, delete the branch AND clean up the worktree
**Why**: Merged branches are dead weight that confuse future navigation. Worktrees left around leak disk space, accumulate stale state files, and re-trigger hooks (`check-wip` pings, orphan locks). Dirty worktrees with merged PRs are especially dangerous because they pretend to be live work.

**Check point**: After `gh pr merge` succeeds (or after `gh pr view --json state` returns MERGED)
**Enforcement**:
- L2 ⚠️ partial: `pr-review-loop-ts.sh` sets `needs_post_merge` gate on merge; `kaizen-post-merge-clear-ts.sh` clears it when `/kaizen-reflect` runs. Remote branch auto-deletes via `--delete-branch --auto` on the merge command.
- L1: `kaizen-check-cleanup-on-stop.sh` warns at session stop.
- **MISSING**: no hook forces deletion of the LOCAL branch or the worktree after merge. Candidate for new hook (see #1037 to be filed).

### I25 — Never leave dirty files in a branch/worktree between operations
**Why**: Dirty files accumulate between commands: "I'll commit that later", then "later" never comes. `gh pr create` fires the dirty-files hook only once; between-commit drift isn't caught.

**Check point**: PreToolUse on `git push`, PostToolUse on Edit/Write, Stop
**Enforcement**:
- L2 ✅ partial: `kaizen-check-dirty-files-ts.sh` blocks `gh pr create` on dirty worktrees; warns on `git push` and `gh pr merge`.
- L1: `kaizen-check-cleanup-on-stop.sh` warns at session stop.
- **MISSING**: no hook blocks `git push` when the worktree is dirty (as opposed to warn). Candidate for extension of check-dirty-files to escalate the push warning to a block (behind a confirmation override).

### I26 — All new branches must be created from `origin/main` (fresh fetch)
**Why**: Branching off a stale local main, another feature branch, or a pre-merge worktree produces PRs with duplicated diff (the PR #1031 incident). `git merge-base HEAD origin/main` should be a recent commit on `origin/main`, not an older history point.

**Check point**: PostToolUse on `git checkout -b <name>` (and `git branch <name>`)
**Enforcement**:
- L1: `.agents/AGENTS.md` Branch & PR hygiene section mentions not pushing to merged branches but doesn't say "branch from origin/main".
- **MISSING**: no hook verifies branch parentage. Candidate for new L2 hook that runs `git merge-base HEAD origin/main` and denies if the base is not a recent commit on `origin/main`.

### Scope/test-plan completeness invariants

### I27 — Test-plan behaviors must be fully implemented in the PR (no deferring)
**Why**: Deferred behaviors are a scope-matching failure in disguise. If the scope truly excludes a behavior, the behavior shouldn't be on the test plan. If the behavior is on the plan, it must ship. Exception: a deferred behavior with an explicit tracking issue is acceptable — but then the issue's acceptance criteria must include it.

**Check point**: Review-time (every push triggers a review round — see I15)
**Enforcement**:
- L2 ✅ partial: `prompts/review-plan-coverage.md` checks plan vs issue requirements; `prompts/review-test-plan.md` checks test strategy correctness.
- **MISSING**: no dimension explicitly flags "behavior marked ⏳ deferred with no tracking issue". Candidate for new review dimension or extension of `review-plan-coverage.md`.
- Escape: a deferred behavior may remain IF the PR body names an open tracking issue for it. Review must verify the tracking issue exists and is open.

### I28 — PR review must cover ALL applicable documented dimensions, not just one
**Why**: Reviewing a PR through a single lens (e.g., only correctness) misses orthogonal failure modes (DRY violations, scope creep, test strategy gaps, security issues, etc.). 15 dimensions are documented in `prompts/review-*.md`; each has `applies_to` and `high_when` metadata to guide selection.

**Check point**: During `/kaizen-review-pr` skill invocation
**Enforcement**:
- L2 ✅ partial: `pr-review-loop-ts.sh` sentinel requires structured findings to clear the gate. `/kaizen-review-pr` skill runs the dimension battery via `review-battery.ts`.
- L1: AGENTS.md mentions batching dimensions by shared `needs`.
- **MISSING**: no hook verifies that every applicable dimension produced a finding. An agent could store a finding for `correctness` only and clear the gate. Candidate for a post-review verifier that cross-checks stored findings against `npx tsx src/cli-dimensions.ts briefing` output.

The 15 documented dimensions (see `prompts/review-*.md`):

| Dimension | When it applies |
|-----------|-----------------|
| correctness | every PR |
| dry | every PR with code changes |
| improvement-lifecycle | PRs that claim to improve a workflow |
| multi-pr-spiral | PRs in a multi-PR epic (detect drift across the set) |
| plan-coverage | PR claiming to close an issue — does plan address the issue? |
| plan-fidelity | does PR match stored plan? |
| pr-description | every PR (Story Spine check) |
| reflection-quality | PRs that include reflection output |
| requirements | every PR claiming `Closes #N` |
| scope-fidelity | every PR — creep + reduction |
| security | PRs touching auth/secrets/external I/O |
| skill-changes | PRs modifying `.claude/skills/*/SKILL.md` |
| test-plan | every PR with testable behaviors |
| test-quality | every PR with test changes |
| tooling-fitness | PRs adding/modifying tooling |

---

## Summary — where the gaps are

### L2-enforced (no gap)
I5, I6, I9, I10, I11, I12, I13, I14, I15, I16 — **10 invariants fully at L2.**

### L2-partial (some enforcement, but with gaps)
I24 (post-merge gate sets, but branch/worktree deletion not forced), I25 (dirty-check blocks at PR create but only warns on push), I27 (review dimensions check plan but don't flag ⏳ items without tracking), I28 (review sentinel required but doesn't verify dimension coverage).

### L1-only policy (gap — agent must remember)
I1, I2, I3, I4, I7, I8, I17, I18, I19, I20, I21, I22, I23, I26 — **14 invariants only at L1.**

### Follow-up issues escalating to L2

| Invariants | Tracking issue | Scope |
|------------|:-:|---|
| I1, I2, I3, I4 | **#1036** | PR preconditions hook on `gh pr create` |
| I7 | **#1032** | `git push` hook for merged-branch detection |
| I8 | **#1035** | implementation precondition: issue has stored test plan |
| I24, I25, I26 | **#1037** (to file) | post-merge cleanup + push-dirty block + branch-from-origin-main |
| I27, I28 | **#1038** (to file) | no-deferred-behaviors + all-dimensions-covered review checks |
| I17 (co-commit tests) | — | candidate — file issue to escalate pr-quality-checks warning to block |
| I19 (secrets) | — | candidate — file issue for proper secret-scanner integration |
| I22, I23 (meta) | — | candidates — tooling-fitness PRDs

### I29 — No hand-rolled parsing or regex for structured data. Use schemas (Zod). Prefer YAML, use JSON where needed.

**Why**: Hand-rolled regex parsing is fragile, hard to test, and produces false positives (see Hook Gym smoke runs: 3 gate detection bugs from instructional text matching gate keywords). Zod schemas are self-documenting, composable, and produce actionable error messages on validation failure. YAML is human-readable in terminal output; JSON is used where Claude's protocol requires it (e.g. `hookSpecificOutput` for deny decisions).

**Check point**: Code review — any PR introducing parsing logic
**Enforcement**:
- L1: This invariant in AGENTS.md + review dimensions
- **MISSING**: no automated lint for regex usage on structured data. Candidate for a `review-tooling-fitness` dimension check or a custom ESLint rule.

**Examples**:
- Hook output: YAML `HookOutput` schema (`src/hooks/lib/gate-signal.ts`) validated by Zod, parsed by `parseHookOutput()`
- Review findings: `ReviewFindingData` schema (`src/review-finding-contract.ts`) with `validateReviewFindingPayload()`
- Stream events: `HookResponseEvent` type (`scripts/hook-gym-schema.ts`)

**Anti-patterns**:
- `output.match(/needs_review/)` → use `parseHookOutput(output)?.gate === 'needs_review'`
- `JSON.parse(text)` without schema validation → use `Schema.safeParse(JSON.parse(text))`
- Regex to extract PR URLs from prose → use structured `pr` field in YAML output

---

## Hook design principle for kaizen

Every invariant above follows the same escalation pattern:

1. **Start in L1** — write the rule in AGENTS.md or a SKILL file
2. **If agents violate it in practice** — escalate to L2 with a PreToolUse/PostToolUse hook that denies the violating action with a clear recovery message
3. **If the L2 hook can be bypassed by a workaround** — escalate to L3 by changing the data structure so the workaround becomes impossible

Never stop at L1 for an invariant that matters. L1 alone is a suggestion.
