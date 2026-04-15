/**
 * case-system.ts — Case frontend: the single gateway for dev work tracking.
 *
 * Architecture:
 *   Case FE (this file) — interface + orchestration
 *     └── Case BE (pluggable) — GitHub, Linear, or custom
 *           └── issue-backend.ts — issue CRUD
 *           └── structured-data.ts — plan/testplan storage on issues
 *
 * The case system enforces:
 *   - Every dev worktree has a case
 *   - Every case links to an issue
 *   - Every issue has a stored plan before implementation starts (I8)
 *   - Every issue has a stored test plan (I3)
 *
 * Skills and hooks go through this FE, never call the BE directly.
 *
 * Part of kaizen #1055.
 */

import {
  retrievePlan,
  retrieveTestPlan,
  issueTarget,
} from './structured-data.js';
import {
  createIssueBackend,
  type IssueBackendConfig,
  type Issue,
} from './issue-backend.js';

// ── Case types ──────────────────────────────────────────────────────

export interface Case {
  branch: string;
  issueNumber: number;
  repo: string;
  description: string;
  status: 'active' | 'done' | 'abandoned';
}

export interface CreateCaseOpts {
  branch: string;
  issueNumber: number;
  repo: string;
  description: string;
}

export interface PlanGateResult {
  passed: boolean;
  hasPlan: boolean;
  hasTestPlan: boolean;
  issueNumber: number;
  repo: string;
  /** Why the gate failed, if it did. */
  reason?: string;
}

// ── Case Backend interface ──────────────────────────────────────────

/**
 * Backend interface for case storage and plan retrieval.
 * GitHub BE is the default. Linear or others can implement this.
 */
export interface CaseBackend {
  readonly name: string;

  /** Get the issue linked to a case. */
  getIssue(issueNumber: number, repo: string): Issue | null;

  /** Retrieve the implementation plan from the issue. */
  retrievePlan(issueNumber: number, repo: string): string | null;

  /** Retrieve the test plan from the issue. */
  retrieveTestPlan(issueNumber: number, repo: string): string | null;
}

// ── GitHub Backend ──────────────────────────────────────────────────

export class GitHubCaseBackend implements CaseBackend {
  readonly name = 'github';

  getIssue(issueNumber: number, repo: string): Issue | null {
    try {
      const backend = createIssueBackend({ backend: 'github' });
      return backend.view(issueNumber, repo);
    } catch {
      return null;
    }
  }

  retrievePlan(issueNumber: number, repo: string): string | null {
    try {
      return retrievePlan(issueTarget(String(issueNumber), repo));
    } catch {
      return null;
    }
  }

  retrieveTestPlan(issueNumber: number, repo: string): string | null {
    try {
      return retrieveTestPlan(issueTarget(String(issueNumber), repo));
    } catch {
      return null;
    }
  }
}

// ── Case Frontend ───────────────────────────────────────────────────

export class CaseSystem {
  private backend: CaseBackend;

  constructor(backend?: CaseBackend) {
    this.backend = backend ?? new GitHubCaseBackend();
  }

  /**
   * Plan gate — checks whether an issue has a stored plan and test plan.
   * This is the single enforcement point. Hooks and skills call this.
   */
  checkPlanGate(issueNumber: number, repo: string): PlanGateResult {
    const plan = this.backend.retrievePlan(issueNumber, repo);
    const testPlan = this.backend.retrieveTestPlan(issueNumber, repo);

    const hasPlan = plan !== null && plan.length > 0;
    const hasTestPlan = testPlan !== null && testPlan.length > 0;
    const passed = hasPlan && hasTestPlan;

    const missing: string[] = [];
    if (!hasPlan) missing.push('implementation plan');
    if (!hasTestPlan) missing.push('test plan');

    return {
      passed,
      hasPlan,
      hasTestPlan,
      issueNumber,
      repo,
      reason: passed ? undefined : `Issue #${issueNumber} is missing: ${missing.join(', ')}. Run /kaizen-write-plan first.`,
    };
  }

  /** Retrieve raw plan text (for substance checks). */
  retrievePlan(issueNumber: number, repo: string): string | null {
    return this.backend.retrievePlan(issueNumber, repo);
  }

  /** Retrieve raw test plan text (for substance checks). */
  retrieveTestPlan(issueNumber: number, repo: string): string | null {
    return this.backend.retrieveTestPlan(issueNumber, repo);
  }

  /**
   * Get the issue data for a case's linked issue.
   */
  getIssue(issueNumber: number, repo: string): Issue | null {
    return this.backend.getIssue(issueNumber, repo);
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
