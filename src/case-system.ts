/**
 * case-system.ts — Case frontend: the single gateway for dev-work tracking.
 *
 * Skills and hooks go through this FE, never call the BE directly. Swapping
 * in a LinearCaseBackend (or any impl of CaseBackend) works without changing
 * the FE, the hook, or the skills.
 *
 *   Case FE (this file)            ← single gateway
 *     └── CaseBackend interface    ← pluggable
 *           └── GitHubCaseBackend  ← default (uses issue-backend.ts + structured-data.ts)
 *           └── (future) LinearCaseBackend, CustomCaseBackend, ...
 *
 * Responsibilities:
 *   Plan gate (I3/I8):       checkPlanGate, retrievePlan, retrieveTestPlan,
 *                            storePlan, storeTestPlan
 *   Issue lifecycle:         getIssue, listIssues, createIssue, updateIssue,
 *                            addComment, closeIssue, reopenIssue
 *
 * Part of kaizen #1055.
 */

import {
  retrievePlan as sdRetrievePlan,
  retrieveTestPlan as sdRetrieveTestPlan,
  storePlan as sdStorePlan,
  storeTestPlan as sdStoreTestPlan,
  issueTarget,
} from './structured-data.js';
import {
  createIssueBackend,
  type Issue,
} from './issue-backend.js';

// ── Types ───────────────────────────────────────────────────────────

export type { Issue };

export interface PlanGateResult {
  passed: boolean;
  hasPlan: boolean;
  hasTestPlan: boolean;
  problems: Array<'plan' | 'testplan' | 'scope-conflict'>;
  issueNumber: number;
  repo: string;
  /** The actual plan text (if present), for substance checks without refetch. */
  planText?: string | null;
  /** The actual test plan text (if present). */
  testPlanText?: string | null;
  /** Why the gate failed, if it did. */
  reason?: string;
}

const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)\b/i;
const ISSUE_REF_RE = /(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)\b/g;
const CLOSE_TARGET_LIST_SEPARATOR_RE = /^[\s,]*(?:and|or)?[\s,]*$/i;

function extractClosingIssueTargets(text: string): number[] {
  const targets = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const closingMatch = line.match(CLOSING_KEYWORD_RE);
    if (!closingMatch || closingMatch.index === undefined) continue;
    const firstIssue = Number.parseInt(closingMatch[1], 10);
    if (Number.isInteger(firstIssue)) targets.add(firstIssue);

    let cursor = closingMatch.index + closingMatch[0].length;
    ISSUE_REF_RE.lastIndex = cursor;
    let match: RegExpExecArray | null;
    while ((match = ISSUE_REF_RE.exec(line)) !== null) {
      const separator = line.slice(cursor, match.index);
      if (!CLOSE_TARGET_LIST_SEPARATOR_RE.test(separator)) break;
      const issueNumber = Number.parseInt(match[1], 10);
      if (Number.isInteger(issueNumber)) targets.add(issueNumber);
      cursor = match.index + match[0].length;
    }
  }
  return [...targets].sort((a, b) => a - b);
}

export interface CreateIssueOpts {
  title: string;
  body: string;
  labels?: string[];
  repo: string;
}

export interface UpdateIssueOpts {
  number: number;
  repo: string;
  title?: string;
  body?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

export interface ListIssuesOpts {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  search?: string;
  limit?: number;
  repo: string;
}

// ── CaseBackend interface ──────────────────────────────────────────

/**
 * Backend interface. A backend is everything a host-project tracker must
 * provide for kaizen to run. Every method must be implementable against
 * any reasonable issue tracker (GitHub, Linear, JIRA, custom).
 */
export interface CaseBackend {
  readonly name: string;

  // Issue lifecycle
  createIssue(opts: CreateIssueOpts): { number: number; url: string };
  getIssue(issueNumber: number, repo: string): Issue | null;
  listIssues(opts: ListIssuesOpts): Issue[];
  updateIssue(opts: UpdateIssueOpts): void;
  addComment(issueNumber: number, repo: string, body: string): void;
  closeIssue(issueNumber: number, repo: string): void;
  reopenIssue(issueNumber: number, repo: string): void;

  // Plan attachments (kaizen-specific structured data on issues)
  retrievePlan(issueNumber: number, repo: string): string | null;
  retrieveTestPlan(issueNumber: number, repo: string): string | null;
  storePlan(issueNumber: number, repo: string, planText: string): string;
  storeTestPlan(issueNumber: number, repo: string, testPlanText: string): string;
}

// ── GitHub Backend ──────────────────────────────────────────────────

export class GitHubCaseBackend implements CaseBackend {
  readonly name = 'github';

  private ib() { return createIssueBackend({ backend: 'github' }); }
  private target(issueNumber: number, repo: string) {
    return issueTarget(String(issueNumber), repo);
  }

  // ── Issue lifecycle ──

  createIssue(opts: CreateIssueOpts): { number: number; url: string } {
    return this.ib().create({ title: opts.title, body: opts.body, labels: opts.labels, repo: opts.repo });
  }

  getIssue(issueNumber: number, repo: string): Issue | null {
    try { return this.ib().view(issueNumber, repo); } catch { return null; }
  }

  listIssues(opts: ListIssuesOpts): Issue[] {
    try { return this.ib().list(opts); } catch { return []; }
  }

  updateIssue(opts: UpdateIssueOpts): void {
    this.ib().edit({
      number: opts.number,
      repo: opts.repo,
      title: opts.title,
      body: opts.body,
      addLabels: opts.addLabels,
      removeLabels: opts.removeLabels,
    } as Parameters<ReturnType<GitHubCaseBackend['ib']>['edit']>[0]);
  }

  addComment(issueNumber: number, repo: string, body: string): void {
    this.ib().comment({ number: issueNumber, body, repo });
  }

  closeIssue(issueNumber: number, repo: string): void {
    this.ib().close(issueNumber, repo);
  }

  reopenIssue(issueNumber: number, repo: string): void {
    this.ib().reopen(issueNumber, repo);
  }

  // ── Plan attachments ──

  retrievePlan(issueNumber: number, repo: string): string | null {
    try { return sdRetrievePlan(this.target(issueNumber, repo)); } catch { return null; }
  }

  retrieveTestPlan(issueNumber: number, repo: string): string | null {
    try { return sdRetrieveTestPlan(this.target(issueNumber, repo)); } catch { return null; }
  }

  storePlan(issueNumber: number, repo: string, planText: string): string {
    return sdStorePlan(this.target(issueNumber, repo), planText);
  }

  storeTestPlan(issueNumber: number, repo: string, testPlanText: string): string {
    return sdStoreTestPlan(this.target(issueNumber, repo), testPlanText);
  }
}

// ── Case Frontend ───────────────────────────────────────────────────
//
// Every method here is a thin facade over the backend. The FE exists so
// hooks and skills have ONE gateway — swapping the backend requires no
// changes outside this file.

export class CaseSystem {
  private backend: CaseBackend;

  constructor(backend?: CaseBackend) {
    this.backend = backend ?? new GitHubCaseBackend();
  }

  /** Expose backend name — callers may want to check for capabilities. */
  get backendName(): string { return this.backend.name; }

  // ── Plan gate ──

  /**
   * Plan gate — is an issue ready for implementation?
   * Single enforcement point used by hooks and skills.
   * Returns plan/testPlan text in the result to avoid double-fetching.
   */
  checkPlanGate(issueNumber: number, repo: string): PlanGateResult {
    const planText = this.backend.retrievePlan(issueNumber, repo);
    const testPlanText = this.backend.retrieveTestPlan(issueNumber, repo);

    const hasPlan = !!planText && planText.length > 0;
    const hasTestPlan = !!testPlanText && testPlanText.length > 0;
    const scopeConflicts = hasPlan
      ? extractClosingIssueTargets(planText).filter(target => target !== issueNumber)
      : [];
    const passed = hasPlan && hasTestPlan && scopeConflicts.length === 0;

    const missing: string[] = [];
    if (!hasPlan) missing.push('implementation plan');
    if (!hasTestPlan) missing.push('test plan');
    if (scopeConflicts.length > 0) missing.push('scope-conflicting close target');
    const problems: PlanGateResult['problems'] = [];
    if (!hasPlan) problems.push('plan');
    if (!hasTestPlan) problems.push('testplan');
    if (scopeConflicts.length > 0) problems.push('scope-conflict');

    const conflictReason = scopeConflicts.length > 0
      ? `Issue #${issueNumber} plan has scope-conflicting close target(s): ${scopeConflicts.map(n => `#${n}`).join(', ')}. Store a corrected one-issue plan before implementation.`
      : undefined;

    return {
      passed,
      hasPlan,
      hasTestPlan,
      problems,
      issueNumber,
      repo,
      planText: planText ?? null,
      testPlanText: testPlanText ?? null,
      reason: passed
        ? undefined
        : conflictReason ?? `Issue #${issueNumber} is missing: ${missing.join(', ')}. Run /kaizen-write-plan first.`,
    };
  }

  // ── Plan attachments ──

  retrievePlan(issueNumber: number, repo: string): string | null {
    return this.backend.retrievePlan(issueNumber, repo);
  }

  retrieveTestPlan(issueNumber: number, repo: string): string | null {
    return this.backend.retrieveTestPlan(issueNumber, repo);
  }

  storePlan(issueNumber: number, repo: string, planText: string): string {
    return this.backend.storePlan(issueNumber, repo, planText);
  }

  storeTestPlan(issueNumber: number, repo: string, testPlanText: string): string {
    return this.backend.storeTestPlan(issueNumber, repo, testPlanText);
  }

  // ── Issue lifecycle ──

  createIssue(opts: CreateIssueOpts): { number: number; url: string } {
    return this.backend.createIssue(opts);
  }

  getIssue(issueNumber: number, repo: string): Issue | null {
    return this.backend.getIssue(issueNumber, repo);
  }

  listIssues(opts: ListIssuesOpts): Issue[] {
    return this.backend.listIssues(opts);
  }

  updateIssue(opts: UpdateIssueOpts): void {
    this.backend.updateIssue(opts);
  }

  addComment(issueNumber: number, repo: string, body: string): void {
    this.backend.addComment(issueNumber, repo, body);
  }

  closeIssue(issueNumber: number, repo: string): void {
    this.backend.closeIssue(issueNumber, repo);
  }

  reopenIssue(issueNumber: number, repo: string): void {
    this.backend.reopenIssue(issueNumber, repo);
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export function createCaseSystem(backendName?: string): CaseSystem {
  switch (backendName) {
    case 'github':
    default:
      return new CaseSystem(new GitHubCaseBackend());
  }
}
