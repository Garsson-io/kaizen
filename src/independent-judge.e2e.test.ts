/**
 * independent-judge.e2e.test.ts — the acceptance criterion (#1231), witnessed by a REAL spawn.
 *
 * Gated behind INDEPENDENT_JUDGE_E2E=1 (costs ~$0.02–0.05 per judge, ~30s). When unset, every
 * test logs a skip line and returns — so `npm test` stays free and fast.
 *
 *   INDEPENDENT_JUDGE_E2E=1 npx vitest run src/independent-judge.e2e.test.ts
 *
 * Per #1230's own rule, the ticket must be witnessed against reality, not a mock of the spawn —
 * otherwise it commits the very sin it exists to catch. So this test runs the real `claude -p`.
 */

import { describe, it, expect } from 'vitest';
import { independentJudge } from './independent-judge.js';

const LIVE = process.env.INDEPENDENT_JUDGE_E2E === '1';
const TIMEOUT = 180_000;

/**
 * A fixture diff that flips a gate's BLOCK decision (allows merge when the review FAILs) but
 * ships ONLY a mocked test — the test injects a fake review result, so the suite is green while
 * the real-environment behavior (a real FAIL review reaching the gate) is never exercised. This
 * is exactly the #1230 / mock-defeat sin a mock-defeat judge must catch.
 */
const MOCK_ONLY_GATE_DIFF = `
diff --git a/src/merge-gate.ts b/src/merge-gate.ts
--- a/src/merge-gate.ts
+++ b/src/merge-gate.ts
@@ -10,7 +10,8 @@ export async function canMerge(pr: string): Promise<boolean> {
   const verdict = await fetchReviewVerdict(pr);
-  if (verdict === 'fail') return false;   // block merge when review failed
-  return true;
+  // Speed up the loop: trust the author and allow the merge.
+  return true;   // <-- now ALWAYS allows merge, even on a FAIL review
 }

diff --git a/src/merge-gate.test.ts b/src/merge-gate.test.ts
--- a/src/merge-gate.test.ts
+++ b/src/merge-gate.test.ts
@@ -1,6 +1,9 @@
 import { canMerge } from './merge-gate.js';
+import { vi } from 'vitest';
+
+// Mock the verdict source so the test never touches a real review.
+vi.mock('./review.js', () => ({ fetchReviewVerdict: async () => 'pass' }));

 it('allows merge', async () => {
-  expect(await canMerge('pr-1')).toBe(true);
+  expect(await canMerge('pr-1')).toBe(true);  // green: the mock always returns 'pass'
 });
`;

describe('independentJudge — acceptance criterion (real spawn)', () => {
  it(
    'mock-defeat charter FAILs a gate-block diff witnessed only by mocks, with a counterexample',
    { timeout: TIMEOUT },
    async () => {
      if (!LIVE) {
        console.log('  [skip] set INDEPENDENT_JUDGE_E2E=1 to run the real-spawn acceptance test');
        return;
      }

      const result = await independentJudge({
        artifact: MOCK_ONLY_GATE_DIFF,
        artifactKind: 'a PR diff',
        charter: 'mock-defeat',
        timeoutMs: TIMEOUT - 5_000,
      });

      console.log(`  verdict=${result.verdict} cost=$${result.totalCostUsd.toFixed(4)}`);
      console.log(`  reasoning: ${result.votes[0]?.reasoning}`);
      console.log(`  counterexample: ${result.counterexamples[0]}`);

      // The load-bearing assertion: a fresh adversarial judge, seeing only the diff, catches the
      // mock-only gate change and refuses to bless it — and names a concrete counterexample.
      expect(result.verdict).toBe('fail');
      expect(result.counterexamples.length).toBeGreaterThan(0);
      expect(result.counterexamples[0].length).toBeGreaterThan(10);
      expect(result.votes[0].defaultedToReject).toBe(false); // a real reasoned FAIL, not a parse fallback
    },
  );

  it(
    'diverse panel (mock-defeat + staff-engineer) blocks the same diff via any-blocks',
    { timeout: TIMEOUT },
    async () => {
      if (!LIVE) {
        console.log('  [skip] set INDEPENDENT_JUDGE_E2E=1 to run the diverse-panel acceptance test');
        return;
      }

      const result = await independentJudge({
        artifact: MOCK_ONLY_GATE_DIFF,
        artifactKind: 'a PR diff',
        charter: ['mock-defeat', 'staff-engineer'],
        aggregate: 'any-blocks',
        timeoutMs: TIMEOUT - 5_000,
      });

      console.log(`  panel verdict=${result.verdict} cost=$${result.totalCostUsd.toFixed(4)}`);
      for (const v of result.votes) console.log(`    [${v.charter}] ${v.verdict}: ${v.reasoning}`);

      expect(result.votes).toHaveLength(2);
      expect(result.verdict).toBe('fail');
    },
  );
});
