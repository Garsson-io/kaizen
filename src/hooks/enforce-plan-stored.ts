/**
 * enforce-plan-stored.ts — PreToolUse gate: blocks code edits and PR creation
 * without a stored plan on the linked issue.
 *
 * @enforces I3  — Stored test plan.
 * @enforces I8  — Plan before implementation.
 *
 * Uses the Case FE (case-system.ts) as the single gateway — never calls
 * the GitHub BE (structured-data / section-editor) directly.
 *
 * Two trigger points:
 *   1. Edit/Write of source files in worktrees — blocks FIRST code edit
 *   2. Bash `gh pr create` — backstop with substance checks
 *
 * Part of kaizen #1055.
 */

import { execSync } from 'node:child_process';
import { readHookInput, traceNullInput } from './hook-io.js';
import { isGhPrCommand, stripHeredocBody, extractRepoFlag } from './parse-command.js';
import { CaseSystem, type PlanGateResult } from '../case-system.js';

// ── Types ───────────────────────────────────────────────────────────

export interface PlanCheckResult {
  allowed: boolean;
  reason?: string;
  missing?: string[];
}

export interface PlanCheckDeps {
  caseSystem: CaseSystem;
  getChangedFiles: () => string[];
  getCurrentBranch: () => string;
  detectRepo: () => string;
  isInWorktree: () => boolean;
  /** Absolute path of the current worktree root (or empty if not in one). */
  getWorktreeRoot: () => string;
  /** Absolute path of the main checkout. */
  getMainCheckout: () => string;
}

// ── Defaults ────────────────────────────────────────────────────────

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

const DEFAULT_DEPS: PlanCheckDeps = {
  caseSystem: new CaseSystem(),
  getChangedFiles: () => {
    const r = exec('git diff --name-only main...HEAD 2>/dev/null');
    return r ? r.split('\n').filter(Boolean) : [];
  },
  getCurrentBranch: () => exec('git rev-parse --abbrev-ref HEAD 2>/dev/null'),
  detectRepo: () => exec('git remote get-url origin 2>/dev/null').replace(/.*github\.com[:/]/, '').replace(/\.git$/, ''),
  isInWorktree: () => {
    const gitDir = exec('git rev-parse --git-dir 2>/dev/null');
    const gitCommon = exec('git rev-parse --git-common-dir 2>/dev/null');
    return !!gitDir && !!gitCommon && gitDir !== gitCommon;
  },
  getWorktreeRoot: () => exec('git rev-parse --show-toplevel 2>/dev/null'),
  getMainCheckout: () => {
    const gitCommon = exec('git rev-parse --git-common-dir 2>/dev/null');
    if (!gitCommon) return '';
    // git-common-dir is typically <main>/.git, so parent is main checkout
    return gitCommon.replace(/\/\.git$/, '').replace(/\/\.git\/.*$/, '');
  },
};

// ── Issue extraction ────────────────────────────────────────────────

export function extractIssueNumber(fullCommand: string): string | null {
  const match = fullCommand.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? match[1] : null;
}

export function extractIssueFromBranch(branch: string): string | null {
  // Try patterns in priority order:
  // 1. kNNN (k-prefix: k40-add, worktree-feat+k1055-desc)
  // 2. issue-NNN
  // 3. /NNN- (feat/NNN-desc)
  // 4. #NNN (explicit issue ref)
  // 5. -NNN$ (trailing number, common in worktree branch names)
  const patterns = [
    /(?:^|[^a-z\d])k(\d+)/i,
    /issue-(\d+)/i,
    /(?:^|\/)(\d+)-/,
    /#(\d+)/,
    /-(\d+)$/,
  ];
  for (const re of patterns) {
    const match = branch.match(re);
    if (match) return match[1];
  }
  return null;
}

// ── Source file detection ───────────────────────────────────────────

const SOURCE_EXTENSIONS = /\.(ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|rb|sh)$/;

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.test(filePath);
}

export function isDocsOnly(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(f => !isSourceFile(f));
}

// ── Substance checks (PR backstop only) ─────────────────────────────

export function checkPlanSubstance(planText: string): string[] {
  const failures: string[] = [];
  if (planText.length < 200) failures.push(`Plan is too short (${planText.length} chars, need 200+)`);
  const headings = planText.match(/^#{1,4}\s+.+/gm) ?? [];
  if (headings.length < 2) failures.push(`Plan needs structured headings (${headings.length} found, need 2+)`);
  const listItems = planText.match(/^[\s]*[-*\d]+[.)]\s+.+/gm) ?? [];
  const headingItems = planText.match(/^#{3,4}\s+\S+/gm) ?? [];
  if (listItems.length + headingItems.length < 3) failures.push(`Plan has too few steps/items (${listItems.length + headingItems.length}, need 3+)`);
  return failures;
}

export function checkTestPlanSubstance(testPlanText: string): string[] {
  const failures: string[] = [];
  if (!/(?:## (?:Test Plan|Seam Map|Behaviors)|# Test Plan)/i.test(testPlanText)) failures.push('Missing test plan section header');
  const tableRows = testPlanText.match(/^\|.*\|.*\|/gm) ?? [];
  const behaviorHeadings = testPlanText.match(/^###\s+(?:L\d+|B\d+|\d+)\b/gm) ?? [];
  if (tableRows.length < 3 && behaviorHeadings.length < 2) failures.push('Test plan needs behaviors table or headings');
  if (!/\b(Unit|Integration|System|E2E|Agentic|Workflow)\b/i.test(testPlanText)) failures.push('Test plan must specify test levels');
  return failures;
}

// ── Gate 1: Edit/Write — block source edits without a plan ──────────

export function checkPlanBeforeEdit(
  filePath: string,
  deps: PlanCheckDeps = DEFAULT_DEPS,
): PlanCheckResult {
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') return { allowed: true };
  if (!deps.isInWorktree()) return { allowed: true };
  if (!isSourceFile(filePath)) return { allowed: true };

  const branch = deps.getCurrentBranch();
  const issueNum = extractIssueFromBranch(branch);
  if (!issueNum) {
    // Can't determine issue from branch — deny to close the loophole.
    // An agent in a worktree editing source MUST be working on an issue.
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: Cannot determine which issue you are working on (branch: ${branch || '?'}).

Your branch name must include the issue number. Accepted patterns:
  - k{N}-description        (e.g., k40-add-hello)
  - feat/{N}-description    (e.g., feat/40-add-hello)
  - issue-{N}               (e.g., fix/issue-40)

Rename the branch with:
  git branch -m k${'<N>'}-<description>

Or use /kaizen-implement which creates a correctly-named worktree.
This hook enforces I8: implementation must be tied to a planned issue.`,
    };
  }

  const repo = deps.detectRepo();
  if (!repo) return { allowed: true };

  const gate = deps.caseSystem.checkPlanGate(parseInt(issueNum, 10), repo);
  if (!gate.passed) {
    // Detect if the agent is writing to main checkout while in a worktree.
    // If so, include path correction — the agent has BOTH a plan problem AND a path problem.
    const worktreeRoot = deps.getWorktreeRoot();
    const mainCheckout = deps.getMainCheckout();
    const wrongPath = !!mainCheckout && !!worktreeRoot && worktreeRoot !== mainCheckout
      && filePath.startsWith(mainCheckout + '/') && !filePath.startsWith(worktreeRoot + '/');
    const suggestedPath = wrongPath && worktreeRoot
      ? filePath.replace(mainCheckout, worktreeRoot)
      : null;

    const pathHint = suggestedPath
      ? `\n\n⚠ Also: you wrote to the main checkout. Your worktree is ${worktreeRoot}.\nUse this path instead: ${suggestedPath}`
      : '';

    return {
      allowed: false,
      missing: [!gate.hasPlan ? 'plan' : 'testplan'],
      reason: `BLOCKED: No plan stored for issue #${issueNum}. You MUST run /kaizen-write-plan before writing any code.

DO THIS NOW:
  Skill({ skill: "kaizen-write-plan", args: "#${issueNum}" })

The skill knows how to create and store the plan correctly.
IMPORTANT: Wait for the skill to COMPLETE. Do not retry Write until the skill is done — intermediate retries will be denied again.${pathHint}`,
    };
  }

  return { allowed: true };
}

// ── Gate 2: gh pr create — full check with substance ────────────────

export function checkPlanBeforePr(
  fullCommand: string,
  deps: PlanCheckDeps = DEFAULT_DEPS,
): PlanCheckResult {
  const cmdLine = stripHeredocBody(fullCommand);
  if (!isGhPrCommand(cmdLine, 'create')) return { allowed: true };
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') return { allowed: true };

  const repo = extractRepoFlag(cmdLine) || deps.detectRepo();
  if (!repo) return { allowed: true };

  const changedFiles = deps.getChangedFiles();
  if (isDocsOnly(changedFiles)) return { allowed: true };

  const issueNum = extractIssueNumber(fullCommand) ?? extractIssueFromBranch(deps.getCurrentBranch());
  if (!issueNum) {
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: Cannot verify plan — no issue number found.

PR must link an issue with \`Closes #N\` in the body.
This hook enforces I3 (stored test plan) and I8 (plan before implementation).`,
    };
  }

  // Use Case FE for existence check
  const gate = deps.caseSystem.checkPlanGate(parseInt(issueNum, 10), repo);
  if (!gate.passed) {
    return {
      allowed: false,
      missing: [!gate.hasPlan ? 'plan' : 'testplan'],
      reason: `BLOCKED: PR requires a stored plan and test plan on issue #${issueNum} (I3, I8).

${gate.reason}

Run /kaizen-write-plan — the skill knows how to create and store the plan correctly.
  Skill({ skill: "kaizen-write-plan", args: "#${issueNum}" })`,
    };
  }

  return { allowed: true };
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput('enforce-plan-stored'); process.exit(0); }

  const toolName = input.tool_name ?? '';
  let result: PlanCheckResult;

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = (input.tool_input?.file_path as string) ?? '';
    result = checkPlanBeforeEdit(filePath);
  } else {
    const command = (input.tool_input?.command as string) ?? '';
    result = checkPlanBeforePr(command);
  }

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
