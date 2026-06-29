/**
 * case-system.test.ts — Tests for the Case FE and pluggable backend.
 *
 * Proves:
 *   - Plan gate composition (existence + text carryover)
 *   - Pluggable backend swap works without changing the FE (in-memory stub)
 *   - Full issue-lifecycle facade (create, get, list, update, comment, close, reopen)
 *   - Plan store/retrieve round-trip
 */

import { describe, expect, it } from 'vitest';
import {
  CaseSystem,
  GitHubCaseBackend,
  createCaseSystem,
  type CaseBackend,
  type CreateIssueOpts,
  type UpdateIssueOpts,
  type ListIssuesOpts,
  type Issue,
} from './case-system.js';

// ── In-memory backend (proves pluggability) ────────────────────────

class InMemoryBackend implements CaseBackend {
  readonly name = 'in-memory';
  private issues = new Map<string, Issue>();
  private plans = new Map<string, string>();
  private testplans = new Map<string, string>();
  private comments: Array<{ issue: number; repo: string; body: string }> = [];
  private nextNumber = 1;

  private key(issue: number, repo: string) { return `${repo}:${issue}`; }

  createIssue(opts: CreateIssueOpts) {
    const number = this.nextNumber++;
    const url = `https://example.test/${opts.repo}/issues/${number}`;
    this.issues.set(this.key(number, opts.repo), {
      number, title: opts.title, state: 'open', labels: opts.labels ?? [],
      body: opts.body, url,
    });
    return { number, url };
  }
  getIssue(n: number, repo: string) { return this.issues.get(this.key(n, repo)) ?? null; }
  listIssues(opts: ListIssuesOpts) {
    return [...this.issues.values()].filter(i => {
      if (opts.state && opts.state !== 'all' && i.state !== opts.state) return false;
      if (opts.labels?.length && !opts.labels.every(l => i.labels.includes(l))) return false;
      return true;
    });
  }
  updateIssue(opts: UpdateIssueOpts) {
    const i = this.issues.get(this.key(opts.number, opts.repo));
    if (!i) throw new Error(`no issue ${opts.number}`);
    if (opts.title !== undefined) i.title = opts.title;
    if (opts.body !== undefined) i.body = opts.body;
    if (opts.addLabels?.length) i.labels = [...new Set([...i.labels, ...opts.addLabels])];
    if (opts.removeLabels?.length) i.labels = i.labels.filter(l => !opts.removeLabels!.includes(l));
  }
  addComment(n: number, repo: string, body: string) {
    this.comments.push({ issue: n, repo, body });
  }
  closeIssue(n: number, repo: string) {
    const i = this.issues.get(this.key(n, repo));
    if (i) i.state = 'closed';
  }
  reopenIssue(n: number, repo: string) {
    const i = this.issues.get(this.key(n, repo));
    if (i) i.state = 'open';
  }

  retrievePlan(n: number, repo: string) { return this.plans.get(this.key(n, repo)) ?? null; }
  retrieveTestPlan(n: number, repo: string) { return this.testplans.get(this.key(n, repo)) ?? null; }
  storePlan(n: number, repo: string, text: string) {
    this.plans.set(this.key(n, repo), text);
    return `https://example.test/${repo}/issues/${n}#plan`;
  }
  storeTestPlan(n: number, repo: string, text: string) {
    this.testplans.set(this.key(n, repo), text);
    return `https://example.test/${repo}/issues/${n}#testplan`;
  }

  // Test helpers
  getComments() { return this.comments; }
}

// ── Plan gate ──────────────────────────────────────────────────────

describe('CaseSystem.checkPlanGate', () => {
  it('passes when plan + testplan exist', () => {
    const be = new InMemoryBackend();
    const { number } = be.createIssue({ title: 't', body: '', repo: 'r' });
    be.storePlan(number, 'r', '## Plan');
    be.storeTestPlan(number, 'r', '## Test Plan');
    const sys = new CaseSystem(be);
    const r = sys.checkPlanGate(number, 'r');
    expect(r.passed).toBe(true);
    expect(r.hasPlan).toBe(true);
    expect(r.hasTestPlan).toBe(true);
  });

  it('fails when plan missing', () => {
    const be = new InMemoryBackend();
    const { number } = be.createIssue({ title: 't', body: '', repo: 'r' });
    be.storeTestPlan(number, 'r', '## Test Plan');
    const r = new CaseSystem(be).checkPlanGate(number, 'r');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('implementation plan');
  });

  it('carries plan + test plan text in the result (no refetch needed)', () => {
    const be = new InMemoryBackend();
    const { number } = be.createIssue({ title: 't', body: '', repo: 'r' });
    be.storePlan(number, 'r', 'PLAN_TEXT');
    be.storeTestPlan(number, 'r', 'TEST_PLAN_TEXT');
    const r = new CaseSystem(be).checkPlanGate(number, 'r');
    expect(r.planText).toBe('PLAN_TEXT');
    expect(r.testPlanText).toBe('TEST_PLAN_TEXT');
  });

  it('treats empty string as missing', () => {
    const be = new InMemoryBackend();
    const { number } = be.createIssue({ title: 't', body: '', repo: 'r' });
    be.storePlan(number, 'r', '');
    be.storeTestPlan(number, 'r', '');
    expect(new CaseSystem(be).checkPlanGate(number, 'r').passed).toBe(false);
  });

  it('fails when the plan explicitly closes a different issue (#1161)', () => {
    const be = new InMemoryBackend();
    be.createIssue({ title: 'selected', body: '', repo: 'r' });
    be.storePlan(1, 'r', '## Plan\n\nShip the batch in one PR.\n\nCloses #1, #2, and #3');
    be.storeTestPlan(1, 'r', '## Test Plan\n\n- unit');

    const r = new CaseSystem(be).checkPlanGate(1, 'r');

    expect(r.passed).toBe(false);
    expect(r.hasPlan).toBe(true);
    expect(r.hasTestPlan).toBe(true);
    expect(r.reason).toContain('scope-conflicting close target');
    expect(r.reason).toContain('#2');
    expect(r.reason).toContain('#3');
  });

  it('allows closing-keyword targets for the selected issue', () => {
    const be = new InMemoryBackend();
    be.createIssue({ title: 'selected', body: '', repo: 'r' });
    be.storePlan(1, 'r', '## Plan\n\nFixes #1 with a scoped PR.');
    be.storeTestPlan(1, 'r', '## Test Plan\n\n- unit');

    const r = new CaseSystem(be).checkPlanGate(1, 'r');

    expect(r.passed).toBe(true);
  });

  it('allows non-closing context references to parent or sibling issues', () => {
    const be = new InMemoryBackend();
    be.createIssue({ title: 'selected', body: '', repo: 'r' });
    be.storePlan(1, 'r', 'Parent: #1134\n\nCompare behavior observed on #2, but only implement #1.');
    be.storeTestPlan(1, 'r', '## Test Plan\n\n- unit');

    const r = new CaseSystem(be).checkPlanGate(1, 'r');

    expect(r.passed).toBe(true);
  });

  it('allows prose-separated context references after a selected close target', () => {
    const be = new InMemoryBackend();
    be.createIssue({ title: 'selected', body: '', repo: 'r' });
    be.storePlan(1, 'r', 'Fixes #1 by comparing the incident observed on #2.');
    be.storeTestPlan(1, 'r', '## Test Plan\n\n- unit');

    const r = new CaseSystem(be).checkPlanGate(1, 'r');

    expect(r.passed).toBe(true);
  });
});

// ── Plan store / retrieve round-trip ───────────────────────────────

describe('CaseSystem plan storage', () => {
  it('storePlan then retrievePlan round-trips', () => {
    const be = new InMemoryBackend();
    const { number } = be.createIssue({ title: 't', body: '', repo: 'r' });
    const sys = new CaseSystem(be);
    const url = sys.storePlan(number, 'r', '## Plan\n\n1. Do it');
    expect(url).toContain('#plan');
    expect(sys.retrievePlan(number, 'r')).toBe('## Plan\n\n1. Do it');
  });

  it('storeTestPlan then retrieveTestPlan round-trips', () => {
    const be = new InMemoryBackend();
    const { number } = be.createIssue({ title: 't', body: '', repo: 'r' });
    const sys = new CaseSystem(be);
    sys.storeTestPlan(number, 'r', '## Test Plan\n| a | b |');
    expect(sys.retrieveTestPlan(number, 'r')).toBe('## Test Plan\n| a | b |');
  });
});

// ── Issue lifecycle facade ─────────────────────────────────────────

describe('CaseSystem issue lifecycle', () => {
  it('createIssue returns number + url and stores it', () => {
    const be = new InMemoryBackend();
    const sys = new CaseSystem(be);
    const result = sys.createIssue({ title: 'new bug', body: 'details', repo: 'r', labels: ['kaizen'] });
    expect(result.number).toBe(1);
    expect(result.url).toContain('/r/issues/1');
    const issue = sys.getIssue(1, 'r');
    expect(issue?.title).toBe('new bug');
    expect(issue?.labels).toContain('kaizen');
  });

  it('listIssues filters by state and labels', () => {
    const be = new InMemoryBackend();
    const sys = new CaseSystem(be);
    sys.createIssue({ title: 'open-1', body: '', repo: 'r', labels: ['bug'] });
    sys.createIssue({ title: 'open-2', body: '', repo: 'r', labels: ['feat'] });
    const { number: n3 } = sys.createIssue({ title: 'closed-1', body: '', repo: 'r', labels: ['bug'] });
    sys.closeIssue(n3, 'r');

    expect(sys.listIssues({ repo: 'r', state: 'open' })).toHaveLength(2);
    expect(sys.listIssues({ repo: 'r', state: 'closed' })).toHaveLength(1);
    expect(sys.listIssues({ repo: 'r', state: 'all', labels: ['bug'] })).toHaveLength(2);
  });

  it('updateIssue replaces title and body', () => {
    const be = new InMemoryBackend();
    const sys = new CaseSystem(be);
    const { number } = sys.createIssue({ title: 'old', body: 'old body', repo: 'r' });
    sys.updateIssue({ number, repo: 'r', title: 'new', body: 'new body' });
    const issue = sys.getIssue(number, 'r');
    expect(issue?.title).toBe('new');
    expect(issue?.body).toBe('new body');
  });

  it('updateIssue adds and removes labels', () => {
    const be = new InMemoryBackend();
    const sys = new CaseSystem(be);
    const { number } = sys.createIssue({ title: 't', body: '', repo: 'r', labels: ['a', 'b'] });
    sys.updateIssue({ number, repo: 'r', addLabels: ['c'], removeLabels: ['a'] });
    const issue = sys.getIssue(number, 'r');
    expect(issue?.labels.sort()).toEqual(['b', 'c']);
  });

  it('addComment records a comment (visible via backend)', () => {
    const be = new InMemoryBackend();
    const sys = new CaseSystem(be);
    const { number } = sys.createIssue({ title: 't', body: '', repo: 'r' });
    sys.addComment(number, 'r', 'looks good');
    expect(be.getComments()).toEqual([{ issue: number, repo: 'r', body: 'looks good' }]);
  });

  it('closeIssue then reopenIssue flips state', () => {
    const be = new InMemoryBackend();
    const sys = new CaseSystem(be);
    const { number } = sys.createIssue({ title: 't', body: '', repo: 'r' });
    expect(sys.getIssue(number, 'r')?.state).toBe('open');
    sys.closeIssue(number, 'r');
    expect(sys.getIssue(number, 'r')?.state).toBe('closed');
    sys.reopenIssue(number, 'r');
    expect(sys.getIssue(number, 'r')?.state).toBe('open');
  });

  it('getIssue returns null for unknown', () => {
    const sys = new CaseSystem(new InMemoryBackend());
    expect(sys.getIssue(999, 'r')).toBeNull();
  });
});

// ── Pluggable-backend proof ────────────────────────────────────────

describe('CaseSystem — pluggable backend', () => {
  it('FE works unchanged with an arbitrary CaseBackend impl', () => {
    // InMemoryBackend is literally a different backend from GitHubCaseBackend.
    // If this test runs, the facade's portability claim is real.
    const sys = new CaseSystem(new InMemoryBackend());
    expect(sys.backendName).toBe('in-memory');
    const { number } = sys.createIssue({ title: 't', body: '', repo: 'r' });
    sys.storePlan(number, 'r', '## Plan');
    sys.storeTestPlan(number, 'r', '## Test Plan');
    expect(sys.checkPlanGate(number, 'r').passed).toBe(true);
  });
});

// ── Factory ────────────────────────────────────────────────────────

describe('createCaseSystem', () => {
  it('defaults to GitHub backend', () => {
    expect(createCaseSystem().backendName).toBe('github');
  });
  it('explicitly selects github', () => {
    expect(createCaseSystem('github').backendName).toBe('github');
  });
});

// ── GitHubCaseBackend shape ────────────────────────────────────────

describe('GitHubCaseBackend', () => {
  it('has name "github" and all facade methods', () => {
    const be = new GitHubCaseBackend();
    expect(be.name).toBe('github');
    for (const m of ['createIssue', 'getIssue', 'listIssues', 'updateIssue',
                     'addComment', 'closeIssue', 'reopenIssue',
                     'retrievePlan', 'retrieveTestPlan', 'storePlan', 'storeTestPlan']) {
      expect(typeof (be as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });
});
