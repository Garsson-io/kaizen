/**
 * verdict-binding-invariant.test.ts — categorical guard for #1227.
 *
 * The #1227 category: kaizen computes quality verdicts correctly, but a verdict
 * is decorative unless a MECHANISM is required to honour it at the irreversible
 * action. At every point-of-no-return the system must ask "did the verdict
 * pass?", not "does an artifact exist?", and fail closed.
 *
 * This is the compound-interest piece of the deep-dive: rather than only fixing
 * the three known holes, this test pins an INVENTORY of (terminal action →
 * verdict it consumes → enforcing consumer) and asserts each binding is wired.
 * A computed verdict with no enforcing consumer at a terminal action is itself
 * a defect — if a future change removes a binding (e.g. reverts the merge gate,
 * re-bakes CI side-effects into storage, or decouples run-outcome from the
 * verdicts), this test goes red.
 *
 * The canonical human-readable inventory lives in
 * docs/verdict-binding-inventory.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMergeVerdict } from './hooks/enforce-merge-verdict.js';
import { deriveRunOutcome } from '../scripts/auto-dent-run.js';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('#1227 — terminal actions are BOUND to verdicts (binding inventory)', () => {
  // ── 1. Merge → latest review verdict (#1220) ──────────────────────
  describe('merge → review verdict (#1220)', () => {
    it('the merge-verdict gate is registered as a PreToolUse Bash hook', () => {
      const plugin = read('.claude-plugin/plugin.json');
      expect(plugin).toContain('kaizen-enforce-merge-verdict-ts.sh');
    });

    it('the gate BLOCKS a merge whose latest review round derived FAIL', () => {
      const r = checkMergeVerdict('gh pr merge 903 --repo org/repo --squash --auto', {
        reader: () => ({ round: 4, verdict: 'FAIL' }),
        env: {},
      });
      expect(r.action).toBe('deny');
    });

    it('the gate ALLOWS a merge whose latest review round derived PASS', () => {
      const r = checkMergeVerdict('gh pr merge 903 --repo org/repo --squash', {
        reader: () => ({ round: 4, verdict: 'PASS' }),
        env: {},
      });
      expect(r.action).toBe('allow');
    });
  });

  // ── 2. Run-success stamp → run verdicts (#1224) ───────────────────
  describe('auto-dent run-success → recorded verdicts (#1224)', () => {
    it('a review FAIL can never roll up to success', () => {
      expect(deriveRunOutcome({ stopRequested: false, exitCode: 0, artifactCount: 1, reviewVerdict: 'fail' }))
        .toBe('failure');
    });

    it('process-incomplete can never roll up to success', () => {
      expect(deriveRunOutcome({ stopRequested: false, exitCode: 0, artifactCount: 1, processVerdict: 'process-incomplete' }))
        .toBe('failure');
    });

    it('a clean run with artifacts still rolls up to success (no over-blocking)', () => {
      expect(deriveRunOutcome({ stopRequested: false, exitCode: 0, artifactCount: 1, reviewVerdict: 'pass' }))
        .toBe('success');
    });
  });

  // ── 3. PASS review summary → CI proof (#1221 / #1222 / #1225) ──────
  describe('PASS review summary → CI proof, with side-effect-free storage (#1222/#1225)', () => {
    it('storage layer (structured-data.ts) does NOT shell out — no spawnSync / gh CI calls', () => {
      const src = read('src/structured-data.ts');
      expect(src).not.toMatch(/spawnSync/);
      expect(src).not.toMatch(/headRefOid/);
      expect(src).not.toMatch(/pr['"\s,]+checks/);
    });

    it('the CI proof is enforced at the CLI boundary on BOTH PASS-storing handlers', () => {
      const cli = read('src/cli-structured-data.ts');
      // both store-review-summary and store-review-batch must call the gate
      const calls = cli.match(/enforceCiProofForPass\(/g) ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('the CI proof distinguishes ci_pending (wait, exit 75) from a real FAIL (exit 1) — #1221', () => {
      const src = read('src/review-ci-proof.ts');
      expect(src).toContain('EXIT_CI_PENDING');
      expect(src).toContain('waitForCiProof');
    });
  });

  // ── 4. I29 — structured meta read through the shared accessor ──────
  it('summary verdict is read via the shared meta accessor, not a hand-rolled regex (I29)', () => {
    const src = read('src/structured-data.ts');
    expect(src).toContain('extractMetaComment');
    // the old greedy anchored regex must be gone
    expect(src).not.toMatch(/summary\.match\(\/\^<!-- meta/);
  });
});
