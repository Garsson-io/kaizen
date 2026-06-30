import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

import { parseWorktreePorcelain, type WorktreeEntry } from '../src/hooks/worktree-integrity.js';
import { bindIssue, makeGitRun, readBoundIssue } from '../src/issue-binding.js';

export interface ProviderWorkspaceInput {
  repoRoot: string;
  invocationRoot: string;
  assignedIssue?: unknown;
  knownCases?: string[];
  runTag?: string;
}

export type ProviderWorkspaceResolution =
  | {
      ok: true;
      providerRoot: string;
      issue: number | null;
      source: 'unassigned' | 'invocation-root' | 'known-case' | 'worktree-list' | 'created-worktree';
      caseId?: string;
      branch?: string;
      created?: boolean;
    }
  | {
      ok: false;
      reason: 'binding-mismatch' | 'missing-binding' | 'missing-worktree' | 'create-failed';
      issue: number;
      providerRoot?: string;
      actualIssue?: number | null;
      detail: string;
    };

export interface ProviderWorkspaceDeps {
  listWorktrees?: (repoRoot: string) => WorktreeEntry[];
  readBoundIssue?: (root: string) => number | null;
  runGit?: (repoRoot: string, args: string[]) => { code: number; stdout: string; stderr: string };
  bindIssue?: (root: string, issue: number) => void;
  now?: () => Date;
  randomSuffix?: () => string;
  setupArtifacts?: (repoRoot: string, providerRoot: string) => void;
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

function defaultRunGit(repoRoot: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function defaultBindIssue(root: string, issue: number): void {
  bindIssue(issue, makeGitRun(root));
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

function timestampForCaseId(now: Date): string {
  const yy = String(now.getFullYear()).slice(-2);
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${yy}${mo}${dd}${hh}${mi}`;
}

function randomHexSuffix(): string {
  return Math.random().toString(16).slice(2, 6).padEnd(4, '0').slice(0, 4);
}

function setupProviderWorkspaceArtifacts(repoRoot: string, providerRoot: string): void {
  for (const artifact of ['node_modules', 'dist']) {
    const source = join(repoRoot, artifact);
    const target = join(providerRoot, artifact);
    if (existsSync(target) || !existsSync(source)) continue;
    try {
      symlinkSync(source, target, 'dir');
    } catch {
      // Advisory parity with kaizen-worktree-setup.sh: missing links should not
      // hide the real provider failure if the workspace can otherwise run.
    }
  }
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

export function ensureProviderWorkspaceRoot(
  input: ProviderWorkspaceInput,
  deps: ProviderWorkspaceDeps = {},
): ProviderWorkspaceResolution {
  const initial = resolveProviderWorkspaceRoot(input, deps);
  if (initial.ok || initial.reason !== 'missing-worktree') return initial;

  const issue = initial.issue;
  const repoRoot = resolve(input.repoRoot);
  const worktreesDir = join(repoRoot, '.claude', 'worktrees');
  const runGit = deps.runGit ?? defaultRunGit;
  const bind = deps.bindIssue ?? defaultBindIssue;
  const now = deps.now ?? (() => new Date());
  const suffix = deps.randomSuffix ?? randomHexSuffix;
  const setupArtifacts = deps.setupArtifacts ?? setupProviderWorkspaceArtifacts;
  mkdirSync(worktreesDir, { recursive: true });

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const extra = attempt === 0 ? '' : `-${suffix()}`;
    const caseId = `${timestampForCaseId(now())}-k${issue}-auto-dent${extra}`;
    const branch = `case/${caseId}`;
    const providerRoot = join(worktreesDir, caseId);
    if (existsSync(providerRoot)) continue;

    for (const base of ['origin/main', 'HEAD']) {
      const added = runGit(repoRoot, ['worktree', 'add', '-q', '-b', branch, providerRoot, base]);
      if (added.code !== 0) {
        lastError = (added.stderr || added.stdout || `git worktree add exited ${added.code}`).trim();
        continue;
      }

      try {
        bind(providerRoot, issue);
        if (input.runTag) {
          runGit(providerRoot, ['config', 'extensions.worktreeConfig', 'true']);
          runGit(providerRoot, ['config', '--worktree', 'kaizen.runtag', input.runTag]);
        }
        setupArtifacts(repoRoot, providerRoot);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          reason: 'create-failed',
          issue,
          providerRoot,
          detail: `created provider workspace ${providerRoot} for #${issue}, but failed to bind it: ${lastError}`,
        };
      }

      return {
        ok: true,
        providerRoot,
        issue,
        source: 'created-worktree',
        caseId,
        branch,
        created: true,
      };
    }
  }

  return {
    ok: false,
    reason: 'create-failed',
    issue,
    detail: `failed to create non-main case worktree for assigned issue #${issue}${lastError ? `: ${lastError}` : ''}`,
  };
}

export function formatProviderWorkspaceResolution(resolution: ProviderWorkspaceResolution): string {
  if (resolution.ok) {
    return [
      `provider_workspace=${resolution.providerRoot}`,
      `issue=${resolution.issue ?? 'unassigned'}`,
      `source=${resolution.source}`,
      resolution.caseId ? `case=${resolution.caseId}` : '',
      resolution.branch ? `branch=${resolution.branch}` : '',
    ].filter(Boolean).join(' ');
  }
  return [
    `provider_workspace_error=${resolution.reason}`,
    `issue=#${resolution.issue}`,
    resolution.providerRoot ? `provider_workspace=${resolution.providerRoot}` : '',
    resolution.actualIssue != null ? `actual_issue=#${resolution.actualIssue}` : '',
    resolution.detail,
  ].filter(Boolean).join(' ');
}
