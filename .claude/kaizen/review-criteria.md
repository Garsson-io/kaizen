# Code Review Criteria

This file is the **modifiable review prompt** consumed by `/kaizen-review-pr`. It defines what the reviewer checks for. When new failure modes are discovered, add them here — the review gets smarter without touching any skill.

## How This File Is Used

The review skill reads this file and applies each section against the PR diff. Findings are scored by confidence (0-100) and only high-confidence issues (≥75) are reported. The reviewer should cite specific lines and link to code.

---

## 1. DRY

- No duplicated logic across files — extract shared helpers
- No duplicated logic within a file — unify branches with a variable or loop
- No copy-pasted test setup — use shared fixtures (`makeDeps`, `setup_mock_*`)
- Shell wrappers / thin delegators share a common launcher pattern
- If 3+ lines appear twice, it's a DRY violation

**How to check:** For each new function or block, grep the codebase for similar patterns. If one exists, the PR should reuse or extend it — not duplicate it.

## 2. Testability

- All I/O is injectable via a `Deps` interface — no raw `execSync`, `fs.*`, `process.kill` in business logic
- Functions that read data don't also format/print it (separate data from presentation)
- No function reads the same resource twice when it could be passed as a parameter
- `process.exit()` only in CLI entrypoints, never in testable functions
- New branching logic in a 500+ line file with 10+ imports → extract first, then add

**How to check:** Can each new function be tested with zero filesystem, zero network, zero subprocess calls? If not, the I/O boundary needs to be pushed outward.

## 3. Testing

- Every exported pure function has at least one test
- Edge cases covered: empty input, error paths, boundary values
- Mocks match real interface (mock `exec` returns what real git returns)
- Tests don't accidentally use real I/O (missing mock injection falls through to real `execSync`)
- Tests must pass in CI, not just locally — check for environment assumptions (git config, PATH, temp dirs)

**How to check:** Run the tests. Check if any SKIP in CI. Check if any test creates resources without cleanup.

## 4. Testing Harness / E2E Coverage

- New execution paths (hook, script, CLI, IPC handler) have trigger-to-outcome tests
- "Tests later" = no tests — smoke tests ship WITH the feature (Policy #18)
- Reuse and extend existing test harnesses rather than building from scratch
- Test helpers are DRY (`makeDeps` with spread overrides, not copy-pasted per test)
- No filesystem setup needed for unit tests (inject, don't mkdir)
- Integration tests that need filesystem use `mkdtemp` + cleanup

**How to check:** Does a trigger-to-outcome test exist that exercises the real deployment path? Not just unit tests of internal functions, but the actual hook/script/CLI being invoked the way Claude Code invokes it.

## 5. Tooling Fitness

- No hand-rolled parsers for solved formats (YAML, JSON schema, TOML, INI, markdown frontmatter) — use libraries
- No bash scripts with complex branching logic — use TypeScript
- Shell scripts should be thin wrappers that delegate to TS (`tsx-exec.sh` pattern)
- Use bun over tsx when available (faster startup)
- Check `package.json` for existing libraries before adding new ones or hand-rolling

**How to check:** Is there a library in the ecosystem that does this? Is there already one in package.json? If yes to either, the PR should use it.

## 6. Security

- No shell injection via interpolated user/git data (branch names, paths, PR titles)
- Validate or reject unsafe characters before interpolating into shell commands
- No secrets in committed files
- No `eval` or unquoted variable expansion in bash

**How to check:** Find every place user-controlled data enters a shell command. Is it quoted? Is it sanitized?

## 7. Reuse & Patterns

- Shared types exported from a single module (not redefined per file)
- Common patterns (project root resolution, tsx exec, config reading) live in shared libs
- Follows existing codebase patterns — check how similar features are implemented
- When adding to test-helpers.sh or hook libs, check if the pattern already exists

**How to check:** Before writing a helper, grep for it. Before defining a type, check if it's already exported. Before creating a pattern, see if the codebase already has one.

## 8. Best Practices

- No unused imports or variables
- No broken string escapes / quote splicing hacks
- Worktree-safe: works when `node_modules` is in main checkout, not worktree
- Error messages are actionable (tell the user what to do, not just what failed)
- Comments explain WHY, not WHAT — code should be self-documenting for the WHAT

---

## Learned Failure Modes

This section grows over time. Each entry is a pattern discovered through kaizen reflections or incidents. Reviewers should watch for these specifically.

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
