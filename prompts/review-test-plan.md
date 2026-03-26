---
name: test-plan
description: Is the testing strategy right for this issue? Correct test pyramid levels, invariant identification, SUT selection, category prevention for bug fixes.
applies_to: pr
needs: [diff, issue, tests]
high_when:
  - "PR is a bug fix — test must prevent the category of bug, not just this instance"
  - "PR introduces a new system, service, or integration boundary"
  - "PR modifies test harness, fixtures, or test infrastructure itself"
  - "Issue describes a failure that wasn't caught by existing tests"
low_when:
  - "PR is docs-only or config-only with no testable behavior"
  - "PR only modifies existing tests without changing production code"
---

Your task: Review the test strategy for PR {{pr_url}} (issue #{{issue_num}} in {{repo}}).

You are a test strategy reviewer. Your job is NOT to check if tests are well-written (that's the test-quality dimension). Your job is to check if the PR has the RIGHT tests — the right levels of the test pyramid, the right invariants, the right SUT.

## Review Dimension: Test Plan

The relationship chain: **issue → plan → testing plan → tests**. The issue defines what to solve. The plan defines how to solve it. The testing plan defines how to verify the solution. The tests implement that plan. This dimension checks the testing plan — is the verification strategy correct?

A good test plan is not just a list of what to test. It is a **tiered strategy** that answers four questions:
1. What tier is each test at — and is that the right tier?
2. Do cheaper tests run before expensive ones?
3. When a long-running test fails, does it give enough detail to diagnose without re-running?
4. Is the total test budget (time + money) sustainable for CI?

## Key Concepts

**Test Pyramid Levels:**
- **Unit tests**: Test a single function/class in isolation. Fast, cheap, narrow.
- **Integration tests**: Test boundaries between components (API calls, DB queries, hook → system interaction). Medium cost, catch interface mismatches.
- **E2E tests**: Test the full user-facing flow. Expensive, slow, but catch what nothing else does.

**Invariants**: Properties that must ALWAYS be true, regardless of input. "The parser always returns valid JSON or null" is an invariant. "This specific bug is fixed" is not — it's a regression test. Invariants are more valuable because they prevent categories of bugs.

**SUT (System Under Test)**: What exactly is being tested? If the bug is in the parser but the test only exercises the API endpoint, the SUT is wrong — you're testing the integration when the unit is broken.

**Category prevention**: For bug fixes, the test should prevent not just THIS bug but FUTURE bugs in the same system. If an off-by-one error caused the bug, the test should cover boundary conditions generally, not just the one input that triggered the original failure.

**Tiered test strategy**: Every test should live at the cheapest tier that can catch the failure it targets. The tiers, in order of cost:

| Tier | Name | Guard | Cost | Speed | What it catches |
|------|------|-------|------|-------|-----------------|
| 0 | Unit | always | free | ms | Logic bugs in pure functions, wrong parsing, bad state transitions |
| 1 | Structural | always | free | ms | File existence, schema validity, API contract shape — no subprocess |
| 2 | Smoke E2E | env var (e.g. `CLAUDE_E2E=1`) | ~$0.05/call | ~30s | Does the real system return a valid response shape? |
| 3 | Replay E2E | env var (e.g. `CLAUDE_E2E=replay`) | ~$0.20/call | ~90s | Does the real system return the correct semantic result for a known input? |

**Short before long — the diagnostic ladder**: Tests are a decision tree. Each tier answers a narrower question. Never spend money at a higher tier until cheaper tiers pass:

```
Does the pure logic work?          → Tier 0: fix first, it's free
Does the interface/file exist?     → Tier 1: fix first, it's free
Does the real system respond?      → Tier 2 smoke: $0.05, 30s
Is the semantic output correct?    → Tier 3 replay: $0.20, 90s
```

A Tier 3 failure that could have been caught by Tier 0 wasted $0.20 and 90 seconds. The plan should enforce this ordering explicitly — CI should run Tier 0+1 unconditionally and bail if they fail, before ever touching Tier 2+3.

**Observability for long tests**: Any test that calls an external process (LLM, API, subprocess) MUST:
1. Write the full raw output to a **named** file (not anonymous tmpfile) before parsing it
2. Include the file path in every subsequent assertion message
3. Log cost + duration immediately after the call returns
4. On failure, also print the first 300 chars of raw output directly in the error

This rule exists because "expected 'requirements' but got undefined" is useless when the real issue is the LLM returned an error page. Re-running to diagnose costs money. Pattern:

```typescript
const rawPath = join(resultsDir, `smoke-${dim}-${Date.now()}.txt`);
writeFileSync(rawPath, result.stdout ?? '');
const costUsd = parsed?.total_cost_usd ?? 0;
console.log(`  ${dim} smoke: $${costUsd.toFixed(3)} in ${duration}ms → ${rawPath}`);
// all assertions include the path so failures are self-diagnosing
expect(review, `Schema invalid — raw: ${rawPath}\n${(result.stdout ?? '').slice(0, 300)}`).not.toBeNull();
```

**Named files, not anonymous**: Use content-meaningful names (`smoke-requirements-20260325.txt`) not UUIDs. This lets you find and compare outputs across runs without hunting.

**Budget gate**: E2E tests that call LLMs or external APIs MUST be gated behind an env var (`CLAUDE_E2E`, `E2E`, etc). Never run them in default `npm test`. Estimate cost before running and abort if over a per-test threshold (e.g. `if (result.costUsd > 0.30) throw new Error('cost overrun')`).

**Resumability for long suites**: When a suite has N expensive tests, failure at test K means you re-run everything. To avoid this:
1. Write each test result to disk (`resultsDir/<dim>-<tier>.json`) before moving to the next
2. Run with `--bail` so the suite stops at first failure — fix in order, not all at once
3. Use a results dir with a stable path (`REVIEW_E2E_RESULTS_DIR` env var or `.claude/e2e-results/`) so outputs persist between runs for inspection
4. Consider a `--only-failed` mode: skip tests whose result file shows `pass` from a recent run

**Incremental test plan — the ladder rule**: Don't try to write all tiers at once. Build bottom-up, lazily:
- **Today**: Write Tier 0+1 for everything immediately. They're free — no excuse.
- **Next time you touch a dimension**: Run Tier 2 smoke manually, save the output. That output IS your Tier 3 fixture.
- **Next time a dimension finds something real**: Promote the run to a Tier 3 replay test. The motivating PR is your test case.
- **Never write Tier 3 from scratch**: Always promote from a real Tier 2 run. "I think the output should be X" is not a replay test — a captured real output that you verified is correct IS.

**Checkpoint-resume for fast iteration within a work session**: When iterating on a broken step N in a long pipeline, you should NOT re-run steps 1..N-1 to get back to the failure point. The right design:
1. Every expensive step writes its full output to a named checkpoint file BEFORE attempting to parse or assert on it. If an assertion throws, the checkpoint is already saved.
2. A DEV mode loads the latest checkpoint instead of calling the external process — instant, free, lets you iterate on assertions without burning budget.
3. A SKIP_PASSED mode skips tests whose checkpoint shows `passed=true` — run the suite, only re-run what failed.

Concretely: if a Tier 3 assertion fails, you fix the assertion and run with `CLAUDE_E2E_DEV=1` to iterate against the saved output. Only when the assertion logic is right do you run the real $0.20 Tier 3 call. This collapses a $0.40 debug cycle (2 re-runs) into $0.20 (1 real call + N free iterations).

**Assertion isolation — extract, don't inline**: Write assertion logic as standalone pure functions of the parsed result object. This means:
- You can unit-test the assertion against a fabricated DimensionReview object (Tier 0 — free)
- You can run the assertion against a saved checkpoint (DEV mode — free)
- Only the final validation wire-up needs the real pipeline

Pattern:
```typescript
// Pure assertion — testable in isolation against any DimensionReview
function assertRequirementsHasAdoptionGap(review: DimensionReview, rawPath: string): void {
  const gap = review.findings.find(f => f.status !== 'DONE' && f.detail.includes('kaizen-implement'));
  expect(gap, `Expected adoption gap finding — raw: ${rawPath}\n...`).toBeTruthy();
}

// Tier 0: verify assertion logic without any LLM call
it('assertRequirementsHasAdoptionGap detects gap in known-bad review', () => {
  const fakeReview = { findings: [{ requirement: 'R', status: 'MISSING', detail: 'kaizen-implement did not adopt' }], ... };
  assertRequirementsHasAdoptionGap(fakeReview, 'synthetic');
});

// Tier 3: wire to real pipeline
it('requirements replay against PR #832', () => {
  const { review, rawPath } = runDimensionCall('requirements', 'replay');
  assertRequirementsHasAdoptionGap(review!, rawPath);
});
```

**Minimal reproduction shortcut**: When a prompt file is broken, you want to iterate on it without running the full test harness. The prompt file IS the SUT. Render it manually and pipe to claude:
```bash
# 1. Render the prompt to see what claude receives
npx tsx -e "
  import { loadReviewPrompt } from './src/review-battery.js';
  process.stdout.write(loadReviewPrompt('requirements', { pr_url: '...', issue_num: '1', repo: 'org/repo', ... }));
" > /tmp/rendered-prompt.txt

# 2. Iterate on the prompt with direct claude calls (no test harness overhead)
cat /tmp/rendered-prompt.txt | claude -p --output-format json --dangerously-skip-permissions
```
This loop is seconds per iteration. Only when the prompt looks right do you run the full test.

**Tactical vs strategic E2E — cadence by scope, not calendar**:
- **Tactical** (before merging a change to dimension X): `CLAUDE_E2E=1 vitest run -- -t "X smoke"` — one dimension, ~$0.05, ~30s
- **Strategic** (before a release, or after touching multiple dimensions): all dimensions Tier 2, ~$0.55, ~6min
- **Deep** (after a major prompt rewrite, or when a replay fails and you want to verify fixes): specific Tier 3 replays — do not run all Tier 3 at once unless you have verified all Tier 2 passes first

## Instructions

1. Read the linked issue by running: `gh issue view {{issue_num}} --repo {{repo}} --json title,body`
2. Read the PR diff by running: `gh pr diff {{pr_url}}`
3. Classify the work type: new feature, bug fix, refactor, integration, infrastructure
4. For the work type, evaluate the testing strategy:

### For Bug Fixes:
- **Invariant identified?** What property was violated? Is the test asserting that property, or just asserting the specific input/output from the bug report?
- **SUT correct?** Is the test testing the component where the bug lives, or a wrapper around it?
- **Category prevention?** Does the test prevent similar bugs (boundary conditions, null handling, type coercion) or only this exact bug?
- **Regression test exists?** Is there a test that would have caught the original bug if it had existed before the fix?

### For New Features:
- **Test pyramid level appropriate?** Does the feature need E2E testing (user-facing flow), or are unit tests sufficient (pure logic)?
- **Integration boundaries tested?** If the feature crosses component boundaries, are those boundaries tested?
- **Invariants stated?** Do the tests express what should ALWAYS be true about this feature, or just what it does with specific inputs?
- **Edge cases planned?** Empty input, null, maximum values, concurrent access — are the relevant edge cases for this feature identified?
- **Tiered strategy present?** Is there a clear plan for which tier each test lives at, and why?
- **Short-before-long enforced?** Do cheaper tests come first, so expensive tests only run when cheap tests pass?
- **Observability for long tests?** Do E2E/integration tests capture raw output for diagnosis, not just assertion results?
- **Budget sustainable?** Is total E2E cost estimated and gated?

### For Refactors:
- **Behavior preserved?** Tests should pass BEFORE and AFTER the refactor with zero changes to test code. If tests were modified, why?
- **No test-only validation?** If new tests were added during a "pure refactor," that's suspicious — what behavior are they testing that wasn't tested before?

### For Infrastructure/Harness Changes:
- **Meta-testing?** Changes to test harness should be tested — who tests the tests?
- **Existing tests still valid?** Do existing tests still test what they claim to after the infrastructure change?

5. Check the test-to-issue chain:
   - Can you trace from each test back to a requirement in the issue?
   - Can you trace from each requirement in the issue to at least one test?
   - Are there requirements with no test coverage?

6. Check the tiered strategy specifically:
   - Is there a tier-0/tier-1 test that would catch the same failure as a more expensive test? If so, flag the expensive test as over-engineered or the cheap test as missing.
   - Do any long-running tests lack observability (raw output capture, named file, path in failure message, cost + duration logged)?
   - Are E2E tests gated by env var?
   - Is there a comment or doc explaining estimated cost per E2E tier?
   - Is the incremental ladder clear — what is added now vs. deferred, and under what conditions?
   - For deferred tests, is the condition specific enough to be actionable? ("add when motivating PR found" is good; "add later" is not)
   - Are long E2E suites resumable — do they write results to disk so a partial run can be continued?
   - Is there a distinction between tactical (per-dimension, before merge) and strategic (all dimensions, before release) E2E runs?

7. Check scaffolding quality:
   - Are temp files in named directories (not anonymous tmpfile UUIDs)?
   - Is cleanup in `finally` blocks or `afterEach` (not at test end — failures skip cleanup)?
   - Are E2E tests independent — each one creates its own temp dir, no shared state between tests?
   - Is the mock level correct — mocking at the SUT interface, not below it?

8. Check fast-iteration design (most commonly missing):
   - **Checkpoint-resume**: Does every expensive call save output to a named file BEFORE parsing? If an assertion fails mid-test, is the raw output already on disk?
   - **DEV mode**: Is there a flag (e.g., `CLAUDE_E2E_DEV=1`) to load the latest checkpoint instead of re-calling the external process? This is what enables free assertion iteration.
   - **SKIP_PASSED**: Can tests be skipped if a recent pass result exists? This is what enables resuming a partially-passed suite without re-running successful tests.
   - **Assertion isolation**: Are assertions written as pure functions of the parsed result, so they can be unit-tested in Tier 0 without any subprocess? Can you verify assertion logic is correct before spending money on a real call?
   - **Minimal reproduction**: Is there a documented shortcut to reproduce a single prompt failure without running the full test harness?
   - **Expected iteration cost**: For a typical debugging session (fix a broken Tier 3), what is the expected cost with vs without these patterns? If the answer is "same either way," the patterns are missing.

## Output Format

```json
{
  "dimension": "test-plan",
  "summary": "<one-line assessment of testing strategy>",
  "findings": [
    {
      "requirement": "<test strategy criterion>",
      "status": "DONE | PARTIAL | MISSING",
      "detail": "<specific evidence — which tests, which invariants, which gaps>"
    }
  ]
}
```

Rules for status:
- DONE: The testing strategy is appropriate for the work type. Right pyramid level, invariants identified, SUT correct, observability present for long tests.
- PARTIAL: Tests exist but strategy has gaps. Name the gap: wrong pyramid level, missing invariant, testing wrapper instead of core, only regression not category prevention, E2E tests without raw output capture, missing budget gate.
- MISSING: No tests for new behavior, or tests exist but don't verify the right thing, or expensive tests run without cheaper ones first.

Be calibrated: a 10-line config change doesn't need E2E tests. But a system with external process calls (LLM, API, subprocess) that has no E2E smoke test is a real gap — and a smoke test without observability is a PARTIAL, not a DONE.

After the JSON block, you may add prose commentary.
