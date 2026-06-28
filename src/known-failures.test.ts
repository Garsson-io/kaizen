import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseKnownFailures,
  loadKnownFailures,
  isKnownFailure,
  unownedFailures,
  findOwnershipProblems,
  knownFailuresPath,
  type KnownFailure,
  type IssueState,
} from './known-failures.js';

const ok = (entries: Partial<KnownFailure>[]) =>
  JSON.stringify({ knownFailures: entries });

describe('parseKnownFailures', () => {
  it('accepts a valid entry and ignores unknown top-level keys', () => {
    const r = parseKnownFailures(
      JSON.stringify({ _doc: 'note', knownFailures: [{ test: 'a::b', issue: 1481, reason: 'tracked' }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.entries).toEqual([{ test: 'a::b', issue: 1481, reason: 'tracked' }]);
  });

  it('accepts an empty registry', () => {
    const r = parseKnownFailures(ok([]));
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it('rejects malformed JSON', () => {
    const r = parseKnownFailures('{ not json');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/invalid JSON/);
  });

  it('rejects a missing knownFailures array', () => {
    const r = parseKnownFailures(JSON.stringify({ items: [] }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/knownFailures/);
  });

  it('rejects a missing/invalid issue', () => {
    expect(parseKnownFailures(ok([{ test: 'a', reason: 'x' }])).ok).toBe(false);
    expect(parseKnownFailures(ok([{ test: 'a', issue: 0, reason: 'x' }])).ok).toBe(false);
    expect(parseKnownFailures(ok([{ test: 'a', issue: 1.5, reason: 'x' }])).ok).toBe(false);
  });

  it('rejects an empty test or reason', () => {
    expect(parseKnownFailures(ok([{ test: '', issue: 1, reason: 'x' }])).ok).toBe(false);
    expect(parseKnownFailures(ok([{ test: 'a', issue: 1, reason: '  ' }])).ok).toBe(false);
  });

  it('reports per-entry errors with their index', () => {
    const r = parseKnownFailures(ok([{ test: 'a', issue: 1, reason: 'ok' }, { test: 'b' }]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('knownFailures[1]'))).toBe(true);
  });
});

describe('isKnownFailure / unownedFailures', () => {
  const entries: KnownFailure[] = [
    { test: 'test_hooks.py::TestPRLifecycle::test_full_lifecycle', issue: 1481, reason: 'tracked' },
    { test: 'flaky_suite.py', issue: 1200, reason: 'whole-file flake' },
  ];

  it('matches an exact nodeid', () => {
    expect(isKnownFailure('x/test_hooks.py::TestPRLifecycle::test_full_lifecycle', entries)?.issue).toBe(1481);
  });

  it('matches any failure in a file-scoped entry', () => {
    expect(isKnownFailure('a/flaky_suite.py::TestX::test_y', entries)?.issue).toBe(1200);
  });

  it('does not match an unrelated failure', () => {
    expect(isKnownFailure('test_other.py::test_z', entries)).toBeUndefined();
  });

  it('returns only the unowned failures', () => {
    const failing = [
      'flaky_suite.py::TestX::test_y',
      'test_other.py::test_z',
      'test_hooks.py::TestPRLifecycle::test_full_lifecycle',
    ];
    expect(unownedFailures(failing, entries)).toEqual(['test_other.py::test_z']);
  });

  it('treats an empty registry as: everything is unowned', () => {
    expect(unownedFailures(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('findOwnershipProblems', () => {
  const entries: KnownFailure[] = [
    { test: 'a', issue: 10, reason: 'r' },
    { test: 'b', issue: 10, reason: 'r' },
    { test: 'c', issue: 20, reason: 'r' },
  ];

  it('flags entries whose owning issue is closed or missing, grouped by issue', () => {
    const states: Record<number, IssueState> = { 10: 'open', 20: 'closed' };
    const problems = findOwnershipProblems(entries, n => states[n] ?? 'missing');
    expect(problems).toEqual([{ issue: 20, state: 'closed', tests: ['c'] }]);
  });

  it('returns no problems when every owning issue is open', () => {
    expect(findOwnershipProblems(entries, () => 'open')).toEqual([]);
  });
});

describe('shipped registry', () => {
  it('parses and validates the checked-in .agents/kaizen/known-failures.json', () => {
    const path = knownFailuresPath();
    const r = parseKnownFailures(readFileSync(path, 'utf8'));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('loadKnownFailures returns the same validated entries', () => {
    expect(loadKnownFailures().ok).toBe(true);
  });
});
