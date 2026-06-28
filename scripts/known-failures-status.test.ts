import { describe, it, expect } from 'vitest';
import { runClassify } from './known-failures-status.js';
import type { KnownFailure } from '../src/known-failures.js';

// runValidate reads the on-disk registry (empty in this repo), so we assert the
// classifier boundary here and rely on src/known-failures.test.ts for the
// ownership/issue-state logic (findOwnershipProblems).

describe('runClassify (CLI boundary)', () => {
  const entries: KnownFailure[] = [
    { test: 'flaky_suite.py', issue: 1200, reason: 'tracked flake' },
  ];

  it('exits 0 when there are no failures', () => {
    expect(runClassify([], entries)).toBe(0);
  });

  it('exits 0 when every failure is owned', () => {
    expect(runClassify(['flaky_suite.py::TestX::test_y'], entries)).toBe(0);
  });

  it('exits 1 when any failure is unowned', () => {
    expect(runClassify(['flaky_suite.py::test_y', 'new_breakage.py::test_z'], entries)).toBe(1);
  });

  it('treats an empty registry as: every failure is unowned', () => {
    expect(runClassify(['anything.py::test_a'], [])).toBe(1);
  });
});
