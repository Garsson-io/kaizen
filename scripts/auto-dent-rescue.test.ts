import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyRunExit,
  decideRescueAction,
  formatRescueReport,
  buildRescueTitle,
  rescueTarget,
  rescueRun,
  collectRunWorktrees,
  SKIPPED_GATES,
  type GitExec,
} from './auto-dent-rescue.js';
import type { GitExecResult } from '../src/hooks/lib/git-state.js';

describe('classifyRunExit', () => {
  it('treats wall-clock timeout as abnormal with a timeout reason', () => {
    const c = classifyRunExit({ exitCode: 143, timedOut: true, stopRequested: false });
    expect(c.abnormal).toBe(true);
    expect(c.reason).toMatch(/timeout/i);
  });

  it('treats a non-zero exit as abnormal', () => {
    const c = classifyRunExit({ exitCode: 1, timedOut: false, stopRequested: false });
    expect(c.abnormal).toBe(true);
    expect(c.reason).toMatch(/exit.*1/);
  });

  it('treats an intentional agent stop as not abnormal', () => {
    const c = classifyRunExit({ exitCode: 0, timedOut: false, stopRequested: true });
    expect(c.abnormal).toBe(false);
    expect(c.reason).toMatch(/stop/i);
  });

  it('treats a clean exit as not abnormal', () => {
    const c = classifyRunExit({ exitCode: 0, timedOut: false, stopRequested: false });
    expect(c.abnormal).toBe(false);
    expect(c.reason).toMatch(/clean/i);
  });
});

describe('decideRescueAction', () => {
  it('does nothing when there is no PR and no work', () => {
    const a = decideRescueAction({ commitsAheadBase: 0, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: null });
    expect(a.kind).toBe('none');
  });

  it('creates a draft PR when there is no PR but commits ahead', () => {
    const a = decideRescueAction({ commitsAheadBase: 3, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: null });
    expect(a.kind).toBe('create-draft');
    expect(a.commitDirty).toBe(false);
  });

  it('creates a draft PR and commits dirty when only dirty files exist', () => {
    const a = decideRescueAction({ commitsAheadBase: 0, unpushedCommits: 0, dirtyTotal: 2, existingOpenPr: null });
    expect(a.kind).toBe('create-draft');
    expect(a.commitDirty).toBe(true);
  });

  // Regression guard: a healthy open PR (commits ahead of main but already
  // pushed, nothing dirty) must NOT receive a spurious rescue comment.
  it('does nothing for a healthy open PR with no unpushed or dirty work', () => {
    const a = decideRescueAction({ commitsAheadBase: 5, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: 'https://x/pr/1' });
    expect(a.kind).toBe('none');
  });

  it('pushes to the existing PR when there are unpushed commits', () => {
    const a = decideRescueAction({ commitsAheadBase: 5, unpushedCommits: 2, dirtyTotal: 0, existingOpenPr: 'https://x/pr/1' });
    expect(a.kind).toBe('push-existing');
    expect(a.commitDirty).toBe(false);
  });

  it('pushes to the existing PR and commits dirty when files are dirty', () => {
    const a = decideRescueAction({ commitsAheadBase: 5, unpushedCommits: 0, dirtyTotal: 1, existingOpenPr: 'https://x/pr/1' });
    expect(a.kind).toBe('push-existing');
    expect(a.commitDirty).toBe(true);
  });
});

describe('formatRescueReport', () => {
  it('marks output as not-validated and lists context + skipped gates', () => {
    const body = formatRescueReport({
      runTag: 'handsome-lynx/run-1',
      runId: 'handsome-lynx-r1',
      worktree: '/wt/case-x',
      branch: 'case/x',
      failureReason: 'timeout (wall-clock watchdog SIGTERM)',
      commitsAhead: 2,
      dirtyTotal: 3,
      pickedIssue: '#1255',
    });
    expect(body).toMatch(/NOT VALIDATED/i);
    expect(body).toContain('handsome-lynx-r1');
    expect(body).toContain('/wt/case-x');
    expect(body).toContain('case/x');
    expect(body).toMatch(/timeout/);
    expect(body).toContain('#1255');
    for (const gate of SKIPPED_GATES) expect(body).toContain(gate);
  });
});

describe('buildRescueTitle', () => {
  it('includes the rescue marker and run tag', () => {
    const t = buildRescueTitle('handsome-lynx/run-1', '#1255');
    expect(t).toContain('[rescue]');
    expect(t).toContain('handsome-lynx/run-1');
    expect(t).toContain('#1255');
  });
});

// --- Orchestration with injected fakes ------------------------------------

interface FakeGitConfig {
  aheadBase?: number;
  unpushed?: number;
  pushExit?: number;
}

function makeFakeGit(cfg: FakeGitConfig, log: string[][]): GitExec {
  return (args) => {
    log.push([...args]);
    const joined = args.join(' ');
    const ok = (stdout = ''): GitExecResult => ({ stdout, stderr: '', exitCode: 0 });
    if (joined.includes('rev-list') && joined.includes('origin/main..HEAD')) return ok(String(cfg.aheadBase ?? 0));
    if (joined.includes('rev-list') && joined.includes('@{u}..HEAD')) return ok(String(cfg.unpushed ?? 0));
    if (joined.includes('status --porcelain')) return ok('');
    if (joined.includes('push')) {
      return cfg.pushExit && cfg.pushExit !== 0
        ? { stdout: '', stderr: 'remote rejected', exitCode: cfg.pushExit }
        : ok();
    }
    return ok();
  };
}

function makeFakeGh(prList: string | null, ghLog: string[][]): (args: string[]) => string {
  return (args) => {
    ghLog.push([...args]);
    if (args[0] === 'pr' && args[1] === 'list') {
      return prList ? JSON.stringify([{ url: prList }]) : '[]';
    }
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/x/pull/999';
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    return '';
  };
}

function makeReadDirty(total: number) {
  return () => ({
    verified: { staged: [], modified: [], untracked: [], total },
    raw: '',
    gitDir: '',
    perFileDiff: [],
  });
}

describe('rescueTarget orchestration', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'rescue-wt-'));
  const ctx = { repo: 'owner/repo', runTag: 'b/run-1', runId: 'b-r1', failureReason: 'timeout' };

  it('creates a draft PR when work is stranded with no PR', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      ctx,
      { git: makeFakeGit({ aheadBase: 2 }, gitLog), gh: makeFakeGh(null, ghLog), readDirty: makeReadDirty(1) },
    );
    expect(out.action).toBe('create-draft');
    expect(out.pushed).toBe(true);
    expect(out.prUrl).toBe('https://github.com/x/pull/999');
    // committed dirty (add + commit), pushed with --no-verify
    expect(gitLog.some((a) => a.includes('add'))).toBe(true);
    expect(gitLog.some((a) => a.includes('commit'))).toBe(true);
    expect(gitLog.some((a) => a.includes('push') && a.includes('--no-verify'))).toBe(true);
    expect(ghLog.some((a) => a[1] === 'create' && a.includes('--draft'))).toBe(true);
  });

  it('comments on the existing PR and pushes when extending it', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      ctx,
      { git: makeFakeGit({ aheadBase: 5, unpushed: 2 }, gitLog), gh: makeFakeGh('https://x/pr/1', ghLog), readDirty: makeReadDirty(0) },
    );
    expect(out.action).toBe('push-existing');
    expect(out.prUrl).toBe('https://x/pr/1');
    expect(ghLog.some((a) => a[1] === 'comment')).toBe(true);
    expect(ghLog.some((a) => a[1] === 'create')).toBe(false);
  });

  // Category prevention: a healthy run worktree with an open PR and no new work
  // produces NO git write and NO gh write — the system never manufactures noise.
  it('does nothing for a healthy open PR with no new work', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      ctx,
      { git: makeFakeGit({ aheadBase: 5, unpushed: 0 }, gitLog), gh: makeFakeGh('https://x/pr/1', ghLog), readDirty: makeReadDirty(0) },
    );
    expect(out.action).toBe('none');
    expect(out.pushed).toBe(false);
    expect(gitLog.some((a) => a.includes('push'))).toBe(false);
    expect(ghLog.some((a) => a[1] === 'create' || a[1] === 'comment')).toBe(false);
  });

  it('records a push failure without throwing (never hides the original failure)', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      ctx,
      { git: makeFakeGit({ aheadBase: 2, pushExit: 1 }, gitLog), gh: makeFakeGh(null, ghLog), readDirty: makeReadDirty(0) },
    );
    expect(out.action).toBe('create-draft');
    expect(out.pushed).toBe(false);
    expect(out.error).toMatch(/push failed/);
    expect(ghLog.some((a) => a[1] === 'create')).toBe(false);
  });

  it('returns none for a worktree that no longer exists', () => {
    const out = rescueTarget(
      { worktree: join(tmpdir(), 'does-not-exist-xyz'), branch: 'case/gone' },
      ctx,
      { git: makeFakeGit({}, []), gh: makeFakeGh(null, []), readDirty: makeReadDirty(0) },
    );
    expect(out.action).toBe('none');
    expect(out.pushed).toBe(false);
  });
});

describe('rescueRun + collectRunWorktrees', () => {
  it('rescues each provided target', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'rescue-multi-'));
    const outs = rescueRun(
      [{ worktree, branch: 'case/a' }],
      { repo: 'o/r', runTag: 'b/run-1', runId: 'b-r1', failureReason: 'timeout' },
      { git: makeFakeGit({ aheadBase: 1 }, []), gh: makeFakeGh(null, []), readDirty: makeReadDirty(0) },
    );
    expect(outs).toHaveLength(1);
    expect(outs[0].action).toBe('create-draft');
  });

  it('only collects worktrees that exist on disk', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'rescue-root-'));
    // No worktrees created under repoRoot/.claude/worktrees → nothing collected.
    const targets = collectRunWorktrees(repoRoot, ['260628-k1-foo', '', '260628-k2-bar']);
    expect(targets).toEqual([]);
  });
});
