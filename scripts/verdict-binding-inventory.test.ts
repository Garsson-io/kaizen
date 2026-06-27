/**
 * verdict-binding-inventory.test.ts — the #1227 binding lint.
 *
 * #1227's category: kaizen computes quality verdicts correctly, then no
 * mechanism is required to HONOR them at the irreversible action. The fix is a
 * standing INVENTORY: every terminal/finalizing action must mechanically
 * consume the relevant computed verdict, failing closed. A computed verdict with
 * no enforcing consumer at a terminal action is itself a defect.
 *
 * This test is that inventory as code. Each entry pins a terminal action to the
 * source evidence that it consumes its verdict. If a future edit decouples a
 * terminal action from its verdict (the #1212 regression class), the matching
 * assertion fails — turning an L1 "remember to bind it" into an L2 CI gate.
 *
 * When you add a NEW terminal/finalizing action (issue-close scope-match,
 * batch-finalize, gate-clear, post-merge verify — #1165), ADD it here with the
 * evidence it consumes its verdict. Leaving it out is the bug this guards.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

/**
 * Each terminal action and the evidence it is bound to its verdict.
 * `evidence` are substrings that MUST all be present in `file`.
 */
interface BindingEntry {
  action: string;
  verdict: string;
  file: string;
  evidence: string[];
}

const INVENTORY: BindingEntry[] = [
  {
    action: 'auto-dent run.complete outcome stamp',
    verdict: 'review_verdict / process_verdict / lifecycle_health',
    file: 'scripts/auto-dent-run.ts',
    // The outcome emitted on run.complete must route through deriveRunOutcome,
    // not a raw success ternary (#1224).
    evidence: ['deriveRunOutcome(', 'outcome,'],
  },
  {
    action: 'gh pr merge',
    verdict: 'latest review round verdict',
    file: 'src/hooks/enforce-merge-verdict.ts',
    // The merge gate must read a derived verdict and be able to DENY (#1220).
    evidence: ['deriveStoredRoundVerdict', "action: 'deny'", 'isGhPrCommand'],
  },
];

describe('verdict→terminal-action binding inventory (#1227)', () => {
  it.each(INVENTORY)('$action is bound to its verdict ($verdict)', ({ file, evidence }) => {
    const src = read(file);
    for (const needle of evidence) {
      expect(src, `${file} must contain "${needle}" to keep its verdict binding`).toContain(needle);
    }
  });

  it('deriveRunOutcome consumes all three run verdicts (no silent decoupling)', () => {
    const src = read('scripts/auto-dent-outcome.ts');
    expect(src).toContain('reviewVerdict');
    expect(src).toContain('processVerdict');
    expect(src).toContain('lifecycleHealth');
    // A base success must be able to become failure — fail-closed.
    expect(src).toMatch(/return\s+hasRedVerdict\(verdicts\)\s*\?\s*'failure'\s*:\s*'success'/);
  });

  it('the merge-verdict gate is registered in plugin.json (binding is actually wired)', () => {
    const plugin = read('.claude-plugin/plugin.json');
    expect(plugin).toContain('kaizen-enforce-merge-verdict-ts.sh');
  });

  it('the merge-verdict gate has its executable wrapper present', () => {
    // A registration with no wrapper is a dead binding (kaizen-doctor territory).
    const wrapper = read('.claude/hooks/kaizen-enforce-merge-verdict-ts.sh');
    expect(wrapper).toContain('enforce-merge-verdict.ts');
  });
});
