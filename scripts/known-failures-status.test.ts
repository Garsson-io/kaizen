import { describe, it, expect } from 'vitest';
import { runClassify, runValidate, parseIssueState, ghIssueState } from './known-failures-status.js';
import type { KnownFailure, KnownFailuresValidation } from '../src/known-failures.js';
import type { GhResult } from '../src/lib/gh-exec.js';

const gh = (status: number, stdout = '', stderr = ''): GhResult => ({ status, stdout, stderr });

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

describe('parseIssueState', () => {
  it('maps gh state to open/closed/missing', () => {
    expect(parseIssueState(gh(0, '{"state":"OPEN"}'))).toBe('open');
    expect(parseIssueState(gh(0, '{"state":"CLOSED"}'))).toBe('closed');
    expect(parseIssueState(gh(1, '', 'not found'))).toBe('missing'); // non-zero exit
    expect(parseIssueState(gh(0, 'not json'))).toBe('missing');       // malformed
    expect(parseIssueState(gh(0, '{}'))).toBe('missing');             // no state field
  });
});

describe('ghIssueState (injected runner)', () => {
  it('queries gh and parses the result', () => {
    const calls: string[][] = [];
    const stateOf = ghIssueState('owner/repo', (args) => { calls.push(args); return gh(0, '{"state":"open"}'); });
    expect(stateOf(42)).toBe('open');
    expect(calls[0]).toEqual(['issue', 'view', '42', '--json', 'state', '--repo', 'owner/repo']);
  });
});

describe('runValidate (closed-issue gate)', () => {
  const load = (entries: KnownFailure[]): (() => KnownFailuresValidation) =>
    () => ({ ok: true, errors: [], entries });

  it('passes an empty registry', () => {
    expect(runValidate('r', () => 'open', load([]))).toBe(0);
  });

  it('passes when every owning issue is open', () => {
    expect(runValidate('r', () => 'open', load([{ test: 'a.py::x', issue: 1, reason: 'r' }]))).toBe(0);
  });

  it('FAILS when an owning issue is closed', () => {
    expect(runValidate('r', () => 'closed', load([{ test: 'a.py::x', issue: 1, reason: 'r' }]))).toBe(1);
  });

  it('FAILS when an owning issue is missing', () => {
    expect(runValidate('r', () => 'missing', load([{ test: 'a.py::x', issue: 1, reason: 'r' }]))).toBe(1);
  });

  it('FAILS on an invalid registry', () => {
    const badLoad = (): KnownFailuresValidation => ({ ok: false, errors: ['bad'], entries: [] });
    expect(runValidate('r', () => 'open', badLoad)).toBe(1);
  });
});
