/**
 * enforce-plan-stored.ts — PreToolUse gate: blocks `gh pr create` without stored plan + test plan.
 *
 * @enforces I3  — Closed issue has a stored test plan (`retrieve-testplan` != null).
 * @enforces I8  — Implementation begins only after plan is stored on the issue.
 *                 Canonical: docs/kaizen-invariants.md.
 *
 * Three gates:
 *   1. **Existence**: Plan and test plan must exist as attachments on the linked issue.
 *      Uses retrievePlan/retrieveTestPlan from structured-data.ts (handles all fallbacks).
 *   2. **Substance**: Plan must have real structure (headings, items, length).
 *   3. **Freshness**: Plan comment `created_at` must predate the branch's first commit.
 *      Prevents the implementing agent from self-authoring a plan in the same session.
 *      GitHub sets `created_at` — agents cannot backdate it.
 *      Updates during implementation are fine (`created_at` is immutable; only `updated_at` changes).
 *
 * Exceptions:
 *   - Docs-only PRs (no source files in diff) — skip all checks
 *   - KAIZEN_SKIP_PLAN_CHECK=1 env var (escape hatch with accountability)
 *
 * Part of kaizen #1055.
 */

import { execSync } from 'node:child_process';
import { readHookInput, traceNullInput } from './hook-io.js';
import { isGhPrCommand, stripHeredocBody, extractRepoFlag } from './parse-command.js';
import { retrievePlan as sdRetrievePlan, retrieveTestPlan as sdRetrieveTestPlan, issueTarget } from '../structured-data.js';
import { readAttachment } from '../section-editor.js';
import { gh } from '../lib/gh-exec.js';

// ── Types ───────────────────────────────────────────────────────────

export interface PlanCheckResult {
  allowed: boolean;
  reason?: string;
  missing?: string[];
}

export interface PlanCheckDeps {
  retrievePlan: (issue: string, repo: string) => string | null;
  retrieveTestPlan: (issue: string, repo: string) => string | null;
  getPlanCommentCreatedAt: (issue: string, repo: string) => string | null;
  getFirstBranchCommitTime: () => string | null;
  getChangedFiles: () => string[];
  getCurrentBranch: () => string;
  detectRepo: () => string;
}

// ── Defaults — reuse structured-data + section-editor ───────────────

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

const DEFAULT_DEPS: PlanCheckDeps = {
  retrievePlan: (issue, repo) => {
    try { return sdRetrievePlan(issueTarget(issue, repo)); } catch { return null; }
  },
  retrieveTestPlan: (issue, repo) => {
    try { return sdRetrieveTestPlan(issueTarget(issue, repo)); } catch { return null; }
  },
  getPlanCommentCreatedAt: (issue, repo) => {
    try {
      const attachment = readAttachment({ kind: 'issue', number: issue, repo }, 'plan');
      if (!attachment?.commentId) return null;
      return gh(['api', `repos/${repo}/issues/comments/${attachment.commentId}`, '--jq', '.created_at']);
    } catch { return null; }
  },
  getFirstBranchCommitTime: () => exec('git log main..HEAD --reverse --format=%aI 2>/dev/null | head -1') || null,
  getChangedFiles: () => {
    const r = exec('git diff --name-only main...HEAD 2>/dev/null');
    return r ? r.split('\n').filter(Boolean) : [];
  },
  getCurrentBranch: () => exec('git rev-parse --abbrev-ref HEAD 2>/dev/null'),
  detectRepo: () => exec('git remote get-url origin 2>/dev/null').replace(/.*github\.com[:/]/, '').replace(/\.git$/, ''),
};

// ── Issue extraction ────────────────────────────────────────────────

export function extractIssueNumber(fullCommand: string): string | null {
  const match = fullCommand.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? match[1] : null;
}

export function extractIssueFromBranch(branch: string): string | null {
  const match = branch.match(/(?:^k|\/|issue-)(\d+)/);
  return match ? match[1] : null;
}

// ── Docs-only detection ─────────────────────────────────────────────

const SOURCE_EXTENSIONS = /\.(ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|rb|sh)$/;

export function isDocsOnly(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(f => !SOURCE_EXTENSIONS.test(f));
}

// ── Substance checks ────────────────────────────────────────────────

export function checkPlanSubstance(planText: string): string[] {
  const failures: string[] = [];
  if (planText.length < 200) {
    failures.push(`Plan is too short (${planText.length} chars, need 200+)`);
  }
  const headings = planText.match(/^#{1,4}\s+.+/gm) ?? [];
  if (headings.length < 2) {
    failures.push(`Plan needs structured headings (${headings.length} found, need 2+)`);
  }
  const listItems = planText.match(/^[\s]*[-*\d]+[.)]\s+.+/gm) ?? [];
  const headingItems = planText.match(/^#{3,4}\s+\S+/gm) ?? [];
  if (listItems.length + headingItems.length < 3) {
    failures.push(`Plan has too few steps/items (${listItems.length + headingItems.length}, need 3+)`);
  }
  return failures;
}

export function checkTestPlanSubstance(testPlanText: string): string[] {
  const failures: string[] = [];
  if (!/(?:## (?:Test Plan|Seam Map|Behaviors)|# Test Plan)/i.test(testPlanText)) {
    failures.push('Missing test plan section header');
  }
  const tableRows = testPlanText.match(/^\|.*\|.*\|/gm) ?? [];
  const behaviorHeadings = testPlanText.match(/^###\s+(?:L\d+|B\d+|\d+)\b/gm) ?? [];
  if (tableRows.length < 3 && behaviorHeadings.length < 2) {
    failures.push('Test plan needs either a behaviors table (3+ rows) or behavior headings (### L1, ### L2, ...)');
  }
  if (!/\b(Unit|Integration|System|E2E|Agentic|Workflow)\b/i.test(testPlanText)) {
    failures.push('Test plan must specify test levels (Unit/Integration/System/E2E)');
  }
  return failures;
}

// ── Core check ──────────────────────────────────────────────────────

export function checkPlanBeforePr(
  fullCommand: string,
  deps: PlanCheckDeps = DEFAULT_DEPS,
): PlanCheckResult {
  const cmdLine = stripHeredocBody(fullCommand);
  if (!isGhPrCommand(cmdLine, 'create')) return { allowed: true };
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') return { allowed: true };

  const repo = extractRepoFlag(cmdLine) || deps.detectRepo();
  if (!repo) return { allowed: true }; // fail-open

  const changedFiles = deps.getChangedFiles();
  if (isDocsOnly(changedFiles)) return { allowed: true };

  const issueNum = extractIssueNumber(fullCommand) ?? extractIssueFromBranch(deps.getCurrentBranch());
  if (!issueNum) {
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: Cannot verify plan — no issue number found.

PR must link an issue with \`Closes #N\` in the body.
This hook enforces I3 (stored test plan) and I8 (plan before implementation).
Without an issue number, there's nowhere to look for the plan.`,
    };
  }

  const missing: string[] = [];
  const plan = deps.retrievePlan(issueNum, repo);
  if (!plan) missing.push('plan');
  const testPlan = deps.retrieveTestPlan(issueNum, repo);
  if (!testPlan) missing.push('testplan');

  if (plan) {
    const issues = checkPlanSubstance(plan);
    if (issues.length > 0) missing.push('plan-substance');
  }
  if (testPlan) {
    const issues = checkTestPlanSubstance(testPlan);
    if (issues.length > 0) missing.push('testplan-substance');
  }

  if (missing.length > 0) {
    const parts: string[] = [];
    if (missing.includes('plan') || missing.includes('testplan')) {
      parts.push('Run /kaizen-write-plan first (in a separate session), then retry.');
    }
    if (missing.includes('plan-substance')) {
      parts.push(`Plan substance issues:\n${checkPlanSubstance(plan!).map(i => `  - ${i}`).join('\n')}`);
    }
    if (missing.includes('testplan-substance')) {
      parts.push(`Test plan substance issues:\n${checkTestPlanSubstance(testPlan!).map(i => `  - ${i}`).join('\n')}`);
    }
    return {
      allowed: false,
      missing,
      reason: `BLOCKED: PR creation requires stored plan and test plan (I3, I8).

Missing/failing: ${missing.join(', ')}
Issue: #${issueNum} (${repo})

${parts.join('\n\n')}

Why: Plans must come from an independent planning session, not be self-authored
during implementation. This prevents self-referential review cycles (#1054).`,
    };
  }

  // Gate 3: Freshness — plan must predate implementation
  const planCreatedAt = deps.getPlanCommentCreatedAt(issueNum, repo);
  const firstCommitTime = deps.getFirstBranchCommitTime();
  if (planCreatedAt && firstCommitTime) {
    if (new Date(planCreatedAt) >= new Date(firstCommitTime)) {
      return {
        allowed: false,
        missing: ['freshness'],
        reason: `BLOCKED: Plan was stored AFTER implementation started (I8 — independent planning).

Plan stored at:         ${planCreatedAt}
First commit on branch: ${firstCommitTime}

The plan must come from a prior /kaizen-write-plan session, not be self-authored
during implementation.

To fix: run /kaizen-write-plan in a NEW session, then return here and retry.

Why: Self-authored plans make review self-referential (#1054, #1055).`,
      };
    }
  }

  return { allowed: true };
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput('enforce-plan-stored'); process.exit(0); }

  const command = input.tool_input?.command ?? '';
  const result = checkPlanBeforePr(command);

  if (!result.allowed) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    }));
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('enforce-plan-stored.ts') ||
  process.argv[1]?.endsWith('enforce-plan-stored.js')
) {
  main().catch(() => process.exit(0));
}
