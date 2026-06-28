import { describe, expect, it } from 'vitest';
import {
  classifyObservedTestFailures,
  deriveRunTestHealth,
  extractObservedTestFailureIds,
} from './auto-dent-test-health.js';
import type { KnownFailuresValidation } from '../src/known-failures.js';

const registry = (tests: string[]): KnownFailuresValidation => ({
  ok: true,
  errors: [],
  entries: tests.map((test, i) => ({
    test,
    issue: 1000 + i,
    reason: 'owned by test',
  })),
});

describe('extractObservedTestFailureIds', () => {
  it('extracts shell failure file names from run-all-tests output', () => {
    const ids = extractObservedTestFailureIds(`
FAILED FILES:
  - test-pre-push-wrapper
  - test_hooks.py

owned-failure check (#1518)
`);
    expect(ids).toEqual(['test-pre-push-wrapper', 'test_hooks.py']);
  });

  it('extracts pytest nodeids from verbose pytest output', () => {
    const ids = extractObservedTestFailureIds(`
FAILED .claude/hooks/tests/test_hooks.py::TestHooks::test_rejects_bad_pr - AssertionError
FAILED .claude/hooks/tests/test_hooks.py::TestHooks::test_blocks_unplanned_work - AssertionError
`);
    expect(ids).toEqual([
      '.claude/hooks/tests/test_hooks.py::TestHooks::test_rejects_bad_pr',
      '.claude/hooks/tests/test_hooks.py::TestHooks::test_blocks_unplanned_work',
    ]);
  });
});

describe('deriveRunTestHealth', () => {
  it('returns unknown when the run log contains no observed failed test ids', () => {
    expect(deriveRunTestHealth({ runLog: 'All tests passed.' })).toBe('unknown');
  });

  it('returns pass when every observed failure is owned by the shared registry', () => {
    expect(
      deriveRunTestHealth({
        runLog: 'FAILED FILES:\n  - test-pre-push-wrapper\n',
        load: () => registry(['test-pre-push-wrapper']),
      }),
    ).toBe('pass');
  });

  it('returns unowned-failures when any observed failure lacks an owner', () => {
    expect(
      deriveRunTestHealth({
        runLog: 'FAILED FILES:\n  - test-pre-push-wrapper\n  - test-unowned-hook\n',
        load: () => registry(['test-pre-push-wrapper']),
      }),
    ).toBe('unowned-failures');
  });

  it('fails closed when failures were observed but the registry cannot be loaded', () => {
    expect(
      deriveRunTestHealth({
        runLog: 'FAILED FILES:\n  - test-pre-push-wrapper\n',
        load: () => ({ ok: false, errors: ['invalid JSON'], entries: [] }),
      }),
    ).toBe('unowned-failures');
  });

  it('uses the same substring ownership semantics as known-failures', () => {
    expect(
      classifyObservedTestFailures(
        ['.claude/hooks/tests/test_hooks.py::TestHooks::test_rejects_bad_pr'],
        registry(['test_hooks.py::TestHooks::test_rejects_bad_pr']),
      ),
    ).toBe('pass');
  });
});
