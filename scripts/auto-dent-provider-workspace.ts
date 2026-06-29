import { execFileSync } from 'child_process';
import { isAbsolute, join, relative, resolve } from 'path';

import { parseWorktreePorcelain, type WorktreeEntry } from '../src/hooks/worktree-integrity.js';
import { makeGitRun, readBoundIssue } from '../src/issue-binding.js';

export interface ProviderWorkspaceInput {
  repoRoot: string;
  invocationRoot: string;
  assignedIssue?: unknown;
  knownCases?: string[];
}

export type ProviderWorkspaceResolution =
  | {
      ok: true;
      providerRoot: string;
      issue: number | null;
      source: 'unassigned' | 'invocation-root' | 'known-case' | 'worktree-list';
    }
  | {
      ok: false;
      reason: 'binding-mismatch' | 'missing-binding' | 'missing-worktree';
      issue: number;
      providerRoot?: string;
      actualIssue?: number | null;
      detail: string;
    };

export interface ProviderWorkspaceDeps {
  listWorktrees?: (repoRoot: string) => WorktreeEntry[];
  readBoundIssue?: (root: string) => number | null;
}

export function issueNumberFromRef(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:issues\/|#)?(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function sameRoot(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function defaultListWorktrees(repoRoot: string): WorktreeEntry[] {
  const output = execFileSync(
    'git',
    ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8' },
  );
  return parseWorktreePorcelain(output);
}

function defaultReadBoundIssue(root: string): number | null {
  return readBoundIssue(makeGitRun(root));
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

function caseRoot(repoRoot: string, nameOrPath: string): string | null {
  const worktreesDir = join(repoRoot, '.claude', 'worktrees');
  const root = nameOrPath.startsWith('/')
    ? nameOrPath
    : nameOrPath.startsWith('.claude/worktrees/')
      ? join(repoRoot, nameOrPath)
      : join(worktreesDir, nameOrPath);
  return isWithin(worktreesDir, root) ? root : null;
}

function worktreeLooksAssigned(entry: WorktreeEntry, issue: number): boolean {
  const issueToken = new RegExp(`(^|[-/])k${issue}($|[-/])`);
  return Boolean(issueToken.test(entry.branch ?? '') || issueToken.test(entry.path));
}

function validateAssignedRoot(
  root: string,
  issue: number,
  source: 'invocation-root' | 'known-case' | 'worktree-list',
  readIssue: (root: string) => number | null,
): ProviderWorkspaceResolution {
  const actualIssue = readIssue(root);
  if (actualIssue == null) {
    return {
      ok: false,
      reason: 'missing-binding',
      issue,
      providerRoot: root,
      actualIssue,
      detail: `provider workspace ${root} has no kaizen.issue binding for assigned issue #${issue}`,
    };
  }
  if (actualIssue !== issue) {
    return {
      ok: false,
      reason: 'binding-mismatch',
      issue,
      providerRoot: root,
      actualIssue,
      detail: `provider workspace ${root} is bound to #${actualIssue}, not assigned issue #${issue}`,
    };
  }
  return { ok: true, providerRoot: root, issue, source };
}

export function resolveProviderWorkspaceRoot(
  input: ProviderWorkspaceInput,
  deps: ProviderWorkspaceDeps = {},
): ProviderWorkspaceResolution {
  const issue = issueNumberFromRef(input.assignedIssue);
  const repoRoot = resolve(input.repoRoot);
  const invocationRoot = resolve(input.invocationRoot || input.repoRoot);
  const readIssue = deps.readBoundIssue ?? defaultReadBoundIssue;
  const listWorktrees = deps.listWorktrees ?? defaultListWorktrees;

  if (issue == null) {
    return {
      ok: true,
      providerRoot: repoRoot,
      issue: null,
      source: 'unassigned',
    };
  }

  if (!sameRoot(invocationRoot, repoRoot)) {
    return validateAssignedRoot(invocationRoot, issue, 'invocation-root', readIssue);
  }

  for (const knownCase of input.knownCases ?? []) {
    if (!knownCase) continue;
    const knownRoot = caseRoot(repoRoot, knownCase);
    if (!knownRoot) continue;
    const root = resolve(knownRoot);
    if (sameRoot(root, repoRoot)) continue;
    const resolved = validateAssignedRoot(root, issue, 'known-case', readIssue);
    if (resolved.ok || resolved.reason !== 'missing-binding') return resolved;
  }

  let sawAssignedWorktree = false;
  let firstAssignedFailure: ProviderWorkspaceResolution | undefined;
  for (const entry of listWorktrees(repoRoot)) {
    const root = resolve(entry.path);
    if (sameRoot(root, repoRoot)) continue;
    if (!worktreeLooksAssigned(entry, issue)) continue;

    sawAssignedWorktree = true;
    const resolved = validateAssignedRoot(root, issue, 'worktree-list', readIssue);
    if (resolved.ok) return resolved;
    firstAssignedFailure = firstAssignedFailure ?? resolved;
  }

  if (sawAssignedWorktree && firstAssignedFailure) return firstAssignedFailure;

  return {
    ok: false,
    reason: 'missing-worktree',
    issue,
    detail: `no non-main case worktree found for assigned issue #${issue}`,
  };
}

export function formatProviderWorkspaceResolution(resolution: ProviderWorkspaceResolution): string {
  if (resolution.ok) {
    return `provider_workspace=${resolution.providerRoot} issue=${resolution.issue ?? 'unassigned'} source=${resolution.source}`;
  }
  return [
    `provider_workspace_error=${resolution.reason}`,
    `issue=#${resolution.issue}`,
    resolution.providerRoot ? `provider_workspace=${resolution.providerRoot}` : '',
    resolution.actualIssue != null ? `actual_issue=#${resolution.actualIssue}` : '',
    resolution.detail,
  ].filter(Boolean).join(' ');
}
