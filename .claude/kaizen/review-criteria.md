# Code Review Criteria

This file supplements the dimension-based review (`prompts/review-*.md`). It records **learned failure modes** from past incidents — process-level patterns that can't be detected by reading a single diff.

## How This File Is Used

`/kaizen-review-pr` reads this file in Phase 1 alongside the dimension briefing. The failure modes here are pattern-matching hints for the review agents, not structured checks. They augment the dimensions — they don't replace them.

**Note on coverage:** Sections §1–§8 from the original criteria have been promoted to structured dimension files:
- §1 DRY → `prompts/review-dry.md`
- §2–§4 Testability + Testing + Harness → `prompts/review-test-quality.md` + `prompts/review-test-plan.md`
- §5 Tooling Fitness + §7 Reuse → `prompts/review-tooling.md` *(new)*
- §6 Security → `prompts/review-security.md` *(new)*
- §8 Best Practices → absorbed into `prompts/review-error-handling.md` + `prompts/review-tooling.md`

Run `npx tsx src/cli-dimensions.ts list` to see all active dimensions.

---

## Learned Failure Modes

Process-level patterns from past incidents. Reviewers scan for these specifically in Phase 1.

**Dimension coverage:** FM-3 is in `review-dry.md`. FM-5, FM-6, FM-9 are in `review-tooling.md`. FM-7 is in `review-test-plan.md`. FM-8 is in `review-improvement-lifecycle.md`. The FMs below that remain here (FM-1, FM-2, FM-4, FM-10, FM-11, FM-12) are process-level patterns that dimensions can't catch from a single diff.

### FM-1: Tests that pass locally but skip/fail in CI
**Pattern:** Test creates temp git repo without setting `user.name`/`user.email`. Passes locally (global config exists), fails in CI (no global config).
**Source:** PR #434, plugin-lifecycle.test.ts
**Check:** Any `git init` + `git commit` in tests must set local git config.

### FM-2: Tests referencing removed infrastructure
**Pattern:** Test code references old systems (SQLite DB, cli-kaizen) that were replaced. Tests SKIP instead of FAIL, hiding the gap.
**Source:** PR #434, test-enforce-case-exists.sh
**Check:** When refactoring a system, grep for all test references to the old system.

### FM-3: Copy-pasted mock/setup blocks in tests
**Pattern:** Same mock creation code (10+ lines) copy-pasted 3+ times across tests instead of extracted to a shared helper.
**Source:** PR #434, initial test rewrite had 3 identical mock CLI blocks.
**Check:** Any block >5 lines that appears twice in a test file → extract to helper.

### FM-4: Multi-PR fix cycles (the 4-PR pattern)
**Pattern:** Agent ships a feature, then needs 2-4 follow-up PRs to fix bugs that testing would have caught. Each PR triggers reflection, but reflection doesn't prevent the next bug.
**Source:** Issue #400, PRs #273/#275/#277/#280
**Check:** If this PR is a "fix:" for a recent feature, ask: what test would have caught this before the first PR?

### FM-5: Hand-rolled solutions for solved problems
**Pattern:** Agent writes a custom YAML parser, JSON schema validator, or config reader instead of using an existing library.
**Source:** Issue #334 (kaizen self-dogfood)
**Check:** Before writing any parser/validator/formatter, check npm for existing solutions and package.json for already-installed ones.

### FM-6: Complex logic in bash scripts
**Pattern:** Bash script grows beyond thin wrapper into 100+ lines with conditionals, loops, string manipulation, and error handling — all of which would be more testable and maintainable in TypeScript.
**Source:** Multiple incidents — worktree-du.sh, enforce-case-exists.sh history
**Check:** If a .sh file has >50 lines of logic (not comments/boilerplate), it should probably be TS with a thin bash wrapper.

### FM-7: Scope reduction that cuts testability
**Pattern:** Evaluate/implement reduces scope by deferring "test infrastructure" or "E2E harness" — exactly the parts that prevent the 4-PR pattern.
**Source:** Issue #400, multiple PRs shipping without E2E tests
**Check:** If the PR adds a feature but defers its tests, that's a red flag. The test IS the feature.

### FM-8: Stale references after rename/migration
**Pattern:** A file, function, or skill is renamed/extracted but consumers still reference the old name. Tests SKIP on the missing dependency instead of failing, masking the breakage.
**Source:** PR #416 (24 stale nanoclaw references), issue #413 (post-merge-clear checked wrong skill name), PR #406 (54 orphaned tests)
**Check:** After any rename: `grep -r` for the old name across the entire repo. Any test SKIP that says "not found" for a removed dependency is a stale reference, not a valid skip.
**Detector:** `src/analysis/diff-checks.ts:detectStaleReferences()` — deterministic, testable via synthetic scenarios.

### FM-9: Environment/worktree assumptions in hooks
**Pattern:** Shell hooks use `git status`/`git diff` without `-C` flag (checks CWD, not target repo), hardcode absolute paths, or create test git repos without `user.name`/`user.email` (fails in CI).
**Source:** Issue #232 (CWD vs target), issue #219 (hardcoded path), PR #434 (git init in CI)
**Check:** In shell hooks: every `git status`/`git diff` must have `-C "$TARGET"`. In tests: every `git init` must be followed by user config. No hardcoded `/home/*/` paths.
**Detector:** `src/analysis/diff-checks.ts:detectEnvAssumptions()` — checks added lines for these patterns.

### FM-10: Reflection gaming / generic waivers
**Pattern:** Agent satisfies kaizen gate with minimal effort: all findings waived/no-action, generic reasons like "overengineering"/"low frequency"/"self-correcting", or "filed" without issue reference.
**Source:** Issue #388 (15+ incidents), issue #280 ("low frequency" waiver), issue #258 ("overengineering" rationalization)
**Check:** KAIZEN_IMPEDIMENTS with >50% waived/no-action, blocklist matches on waiver reasons, "filed" without ref field.
**Detector:** `src/analysis/reflection-checks.ts:detectReflectionGaming()` — pure function, testable with synthetic impediment lists.

### FM-11: Multi-PR fix cycles (ship-then-fix spiral)
**Pattern:** 3+ PRs merged within 2 hours touching the same files, referencing the same issue, or all titled "fix:". Indicates iterating in production instead of validating before merge.
**Source:** PRs #418-421 (4 fix PRs in 21 minutes for plugin.json), issue #400 (4 PRs for progress reporting)
**Check:** Before creating a "fix:" PR, check recent merged PRs. If 2+ already exist for the same area, stop and ask: "what test would have caught this before the first PR?"
**Detector:** `src/analysis/pr-pattern-checks.ts:detectMultiPRCycles()` — analyzes PR metadata for temporal/file clustering.

### FM-12: Filing trivial impediments instead of fixing in-PR
**Pattern:** Agent identifies a small fix during reflection (gitignore, unused import, config tweak, typo) but files it as a new issue instead of fixing it in the current PR. This creates unnecessary context-reload cost — the issue sits in the backlog, and the next session must re-learn the context to make a 1-line change.
**Source:** This PR (#449) — filed #450 for a 1-line gitignore fix that was then fixed in the same PR anyway.
**Check:** For each "filed" impediment, ask: is this < 10 min and < 30 lines? Is it in files already touched? If yes, fix it now with `disposition: "fixed-in-pr"`.
**Detector:** `src/analysis/reflection-checks.ts:detectFiledWhenFixable()` — flags "filed" impediments whose description matches trivial-fix keywords.

---

## Detector Integration

The `src/analysis/` module provides deterministic detectors for FM-8 through FM-12. The code enum uses short names (`FM1:DRY_VIOLATION` etc.) while the docs use sequential FM-N numbering. Both reference the same taxonomy from epic #441. These complement the LLM-based review:

- **Runtime:** `kaizen-pr-quality-checks-ts.sh` runs code quality checks at PR create time (FM-3/DRY)
- **Synthetic testing:** `npx vitest run src/analysis/` validates detectors against known-bad and known-good scenarios
- **Gap analysis:** `/kaizen-gaps` Phase 2.7 runs detectors against real PRs and reports detection coverage

When a new failure mode is discovered, add it here AND add a synthetic scenario to `src/analysis/run-scenarios.test.ts`. The scenario proves the detector works; the criteria entry tells the LLM reviewer what to look for.
