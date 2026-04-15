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
import { appendFileSync } from 'node:fs';
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
  /** Explicitly-declared issue for this worktree via `git config kaizen.issue`. */
  getDeclaredIssue: () => string | null;
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
  getDeclaredIssue: () => {
    const v = exec('git config --get kaizen.issue 2>/dev/null');
    return v && /^\d+$/.test(v) ? v : null;
  },
};

// ── Issue extraction ────────────────────────────────────────────────

export function extractIssueNumber(fullCommand: string): string | null {
  const match = fullCommand.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? match[1] : null;
}

// NOTE: Branch-name parsing was intentionally removed.
// The issue binding is EXPLICIT via `git config kaizen.issue <N>` (set by the
// /kaizen-implement skill or the user). For PR creation, the canonical
// `Closes #N` syntax in the PR body is the fallback. Parsing branch names
// was fragile — every naming convention we didn't anticipate was a bypass.

// ── Source file detection ───────────────────────────────────────────
//
// Design: allowlist known NON-source (docs, config, assets). Everything
// else is treated as source. New languages then require no update — the
// default is "this is code" unless proven otherwise.

const NON_SOURCE_EXTENSIONS = new RegExp(
  '\\.(md|mdx|rst|txt|json|yml|yaml|toml|xml|html|htm|css|scss|sass|less|' +
  'svg|png|jpg|jpeg|gif|webp|ico|pdf|lock|lockb|sum|mod|csv|tsv)$',
  'i',
);

// Filenames (not extensions) that are considered docs/config, not source.
const NON_SOURCE_FILENAMES = new Set([
  'LICENSE', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS', 'CHANGELOG', 'VERSION',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore',
  '.env.example', '.nvmrc', '.node-version',
]);

/** True if the file is source code (default: yes, unless it's known docs/config). */
export function isSourceFile(filePath: string): boolean {
  const basename = filePath.replace(/^.*\//, '');
  if (NON_SOURCE_FILENAMES.has(basename)) return false;
  if (NON_SOURCE_EXTENSIONS.test(filePath)) return false;
  // Everything else: treat as source. Covers .ts, .py, .go, .rs, Makefile,
  // Dockerfile, .sh, unknown extensions, and anything future.
  return true;
}

export function isDocsOnly(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(f => !isSourceFile(f));
}

// NOTE: Bash-command inspection to detect source writes (`cat > file.ts`, `sed -i`,
// `tee`, etc.) was intentionally removed. Regex-based command parsing is fragile:
// agents can bypass by using any shell variant we didn't anticipate. The
// Edit/Write + NotebookEdit gate covers the natural path. A motivated bypass via
// raw shell is out of scope for this L2 hook — tracked as a follow-up if needed.

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

  // Issue must be EXPLICITLY declared via `git config kaizen.issue <N>`.
  // This is the agent's binding contract: "I am working on #N".
  // No branch-name parsing, no guessing.
  const issueNum = deps.getDeclaredIssue();
  if (!issueNum) {
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: You have not declared which issue you are working on.

Every source-code edit must be tied to an issue. Declare it explicitly:

  git config kaizen.issue <N>

(where <N> is the issue number, e.g. 1055)

Or use /kaizen-implement, which sets this for you.
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

  // Priority: declared issue > PR body "Closes #N" (canonical GitHub syntax).
  // No branch-name parsing — too fragile.
  const issueNum = deps.getDeclaredIssue() ?? extractIssueNumber(fullCommand);
  if (!issueNum) {
    return {
      allowed: false,
      missing: ['issue-link'],
      reason: `BLOCKED: Cannot verify plan — no issue declared.

Declare the issue explicitly:
  git config kaizen.issue <N>

Or include \`Closes #N\` in the PR body.
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

  // Substance check: plan must be substantive (not a rubber stamp).
  // This catches agents that store a trivial plan to satisfy the existence gate.
  const plan = deps.caseSystem.retrievePlan(parseInt(issueNum, 10), repo);
  const testPlan = deps.caseSystem.retrieveTestPlan(parseInt(issueNum, 10), repo);

  const planIssues = plan ? checkPlanSubstance(plan) : [];
  const testPlanIssues = testPlan ? checkTestPlanSubstance(testPlan) : [];

  if (planIssues.length > 0 || testPlanIssues.length > 0) {
    const parts: string[] = [];
    if (planIssues.length > 0) {
      parts.push(`Plan substance failures:\n${planIssues.map(i => `  - ${i}`).join('\n')}`);
    }
    if (testPlanIssues.length > 0) {
      parts.push(`Test plan substance failures:\n${testPlanIssues.map(i => `  - ${i}`).join('\n')}`);
    }
    return {
      allowed: false,
      missing: ['substance'],
      reason: `BLOCKED: Plan exists but is not substantive (rubber-stamp check).

${parts.join('\n\n')}

Run /kaizen-write-plan to produce a proper plan with Success Criteria,
Design Alternatives, and a Seam Map & Test Plan with test levels.
  Skill({ skill: "kaizen-write-plan", args: "#${issueNum}" })`,
    };
  }

  return { allowed: true };
}

// ── Accountability: log escape-hatch use ────────────────────────────

function logEscapeHatchUse(context: string): void {
  if (process.env.KAIZEN_SKIP_PLAN_CHECK !== '1') return;
  try {
    const logPath = process.env.KAIZEN_ESCAPE_LOG ?? '/tmp/.kaizen-escape-hatch.jsonl';
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      hook: 'enforce-plan-stored',
      context,
      branch: (() => { try { return exec('git rev-parse --abbrev-ref HEAD 2>/dev/null'); } catch { return ''; } })(),
      cwd: process.cwd(),
    }) + '\n';
    // Append-only; never throw
    appendFileSync(logPath, entry);
  } catch { /* never fail on log */ }
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput('enforce-plan-stored'); process.exit(0); }

  const toolName = input.tool_name ?? '';
  let result: PlanCheckResult;

  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const filePath = (input.tool_input?.file_path as string)
      ?? (input.tool_input?.notebook_path as string)
      ?? '';
    result = checkPlanBeforeEdit(filePath);
  } else if (toolName === 'Bash') {
    const command = (input.tool_input?.command as string) ?? '';
    result = checkPlanBeforePr(command);
  } else {
    result = { allowed: true };
  }

  // Accountability: log when escape hatch is set (regardless of outcome)
  if (process.env.KAIZEN_SKIP_PLAN_CHECK === '1') {
    logEscapeHatchUse(`tool=${toolName}`);
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
