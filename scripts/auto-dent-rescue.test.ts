import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
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
    const a = decideRescueAction({ commitsAheadBase: 0, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: null, abnormal: true });
    expect(a.kind).toBe('none');
  });

  it('creates a draft PR when an abnormal exit stranded commits with no PR', () => {
    const a = decideRescueAction({ commitsAheadBase: 3, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: null, abnormal: true });
    expect(a.kind).toBe('create-draft');
    expect(a.commitDirty).toBe(false);
  });

  it('creates a draft PR and commits dirty when an abnormal exit left only dirty files', () => {
    const a = decideRescueAction({ commitsAheadBase: 0, unpushedCommits: 0, dirtyTotal: 2, existingOpenPr: null, abnormal: true });
    expect(a.kind).toBe('create-draft');
    expect(a.commitDirty).toBe(true);
  });

  // #1289 core: a CLEAN exit that ends with worktree commits and no PR is
  // intentional (discovery output / agent stopped on purpose) — never manufacture
  // a spurious "NOT VALIDATED" draft for it. This is the over-eager inverse gate
  // the exit classification was built to honor but was previously discarded.
  it('does nothing when a clean exit left commits ahead with no PR (#1289)', () => {
    const a = decideRescueAction({ commitsAheadBase: 3, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: null, abnormal: false });
    expect(a.kind).toBe('none');
    expect(a.commitDirty).toBe(false);
    expect(a.reason).toMatch(/clean exit|#1289/i);
  });

  it('does nothing when a clean exit left only dirty files with no PR (#1289)', () => {
    const a = decideRescueAction({ commitsAheadBase: 0, unpushedCommits: 0, dirtyTotal: 2, existingOpenPr: null, abnormal: false });
    expect(a.kind).toBe('none');
    expect(a.commitDirty).toBe(false);
  });

  // Regression guard: a healthy open PR (commits ahead of main but already
  // pushed, nothing dirty) must NOT receive a spurious rescue comment.
  it('does nothing for a healthy open PR with no unpushed or dirty work', () => {
    const a = decideRescueAction({ commitsAheadBase: 5, unpushedCommits: 0, dirtyTotal: 0, existingOpenPr: 'https://x/pr/1', abnormal: true });
    expect(a.kind).toBe('none');
  });

  // push-existing is exit-agnostic: extending an already-open PR with unpushed
  // work is correct whether the run crashed or stopped cleanly (#1289).
  it('pushes to the existing PR when there are unpushed commits (even on a clean exit)', () => {
    const a = decideRescueAction({ commitsAheadBase: 5, unpushedCommits: 2, dirtyTotal: 0, existingOpenPr: 'https://x/pr/1', abnormal: false });
    expect(a.kind).toBe('push-existing');
    expect(a.commitDirty).toBe(false);
  });

  it('pushes to the existing PR and commits dirty when files are dirty (even on a clean exit)', () => {
    const a = decideRescueAction({ commitsAheadBase: 5, unpushedCommits: 0, dirtyTotal: 1, existingOpenPr: 'https://x/pr/1', abnormal: false });
    expect(a.kind).toBe('push-existing');
    expect(a.commitDirty).toBe(true);
  });

  // #1284 supersede guard / #1282 regression: a branch whose most-recent PR
  // merged with no open PR must NOT get a fresh rescue PR even with work ahead
  // of base — pushing to a merged branch violates I7. The I7 guard takes
  // precedence over create-draft even when the exit was abnormal.
  it('does nothing when the most-recent PR merged with no open PR (I7 supersede)', () => {
    const a = decideRescueAction({
      commitsAheadBase: 3,
      unpushedCommits: 0,
      dirtyTotal: 2,
      existingOpenPr: null,
      mostRecentMerged: true,
      abnormal: true,
    });
    expect(a.kind).toBe('none');
    expect(a.commitDirty).toBe(false);
    expect(a.reason).toMatch(/merged|I7/i);
  });

  // The supersede guard must not fire when an open PR exists — that path keeps
  // precedence and still extends the open PR.
  it('still extends an open PR even if mostRecentMerged is mistakenly set', () => {
    const a = decideRescueAction({
      commitsAheadBase: 5,
      unpushedCommits: 2,
      dirtyTotal: 0,
      existingOpenPr: 'https://x/pr/1',
      mostRecentMerged: true,
      abnormal: false,
    });
    expect(a.kind).toBe('push-existing');
  });

  // A merged branch with NO work is also `none` — same outcome, distinct reason.
  it('does nothing for a merged branch with no work', () => {
    const a = decideRescueAction({
      commitsAheadBase: 0,
      unpushedCommits: 0,
      dirtyTotal: 0,
      existingOpenPr: null,
      mostRecentMerged: true,
      abnormal: true,
    });
    expect(a.kind).toBe('none');
  });

  // #1300 closed-issue guard: a picked issue that is already closed makes the
  // would-be draft moot — work resolved/superseded elsewhere. None, even with
  // work ahead of base AND an abnormal exit (the would-be create-draft case).
  it('does nothing when the picked issue is already closed (#1300)', () => {
    const a = decideRescueAction({
      commitsAheadBase: 3,
      unpushedCommits: 0,
      dirtyTotal: 2,
      existingOpenPr: null,
      pickedIssueClosed: true,
      abnormal: true,
    });
    expect(a.kind).toBe('none');
    expect(a.commitDirty).toBe(false);
    expect(a.reason).toMatch(/closed|#1300/i);
  });

  // The closed-issue guard must NOT touch the push-existing path: an open PR
  // keeps precedence and is extended even if the issue is marked closed.
  it('still extends an open PR even if pickedIssueClosed is set (#1300)', () => {
    const a = decideRescueAction({
      commitsAheadBase: 5,
      unpushedCommits: 2,
      dirtyTotal: 0,
      existingOpenPr: 'https://x/pr/1',
      pickedIssueClosed: true,
      abnormal: false,
    });
    expect(a.kind).toBe('push-existing');
  });

  // An OPEN (or unknown -> false) picked issue with stranded work + abnormal
  // exit still produces create-draft — the guard is closed-only, fail-open.
  it('still creates a draft when the picked issue is open/unknown (#1300)', () => {
    const a = decideRescueAction({
      commitsAheadBase: 3,
      unpushedCommits: 0,
      dirtyTotal: 0,
      existingOpenPr: null,
      pickedIssueClosed: false,
      abnormal: true,
    });
    expect(a.kind).toBe('create-draft');
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

/**
 * Fake `gh`. `pr` describes the most-recent PR on the branch as `queryBranchPrState`
 * sees it (`{ number, state, url }`):
 *   - a bare string  → an OPEN PR at that url (back-compat for existing callers)
 *   - an object      → an explicit state (e.g. MERGED) for supersede-guard tests
 *   - null           → no PR on the branch
 */
function makeFakeGh(
  pr: string | { number?: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string } | null,
  ghLog: string[][],
  // #1300: the state `gh issue view` reports for the picked issue. Defaults to
  // unknown ('{}' → null → fail-open), so existing tests that never set a picked
  // issue are unaffected.
  issueState?: 'OPEN' | 'CLOSED',
): (args: string[]) => string {
  const summary =
    pr == null
      ? null
      : typeof pr === 'string'
        ? { number: 1, state: 'OPEN' as const, url: pr }
        : { number: pr.number ?? 1, state: pr.state, url: pr.url };
  return (args) => {
    ghLog.push([...args]);
    if (args[0] === 'pr' && args[1] === 'list') {
      return summary ? JSON.stringify([summary]) : '[]';
    }
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/x/pull/999';
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    if (args[0] === 'issue' && args[1] === 'view') {
      return issueState ? JSON.stringify({ state: issueState }) : '{}';
    }
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
  const ctx = { repo: 'owner/repo', runTag: 'b/run-1', runId: 'b-r1', failureReason: 'timeout', abnormal: true };

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
    expect(ghLog.some((a) => a[0] === 'pr' && a[1] === 'list' && a.includes('--repo') && a.includes('owner/repo'))).toBe(true);
    expect(ghLog.some((a) => a[1] === 'create' && a.includes('--draft'))).toBe(true);
  });

  // #1289 end-to-end: a CLEAN-exit worktree (ctx.abnormal=false) with commits and
  // no PR must produce NO git push and NO gh pr create — the rescue declines to
  // manufacture a spurious "NOT VALIDATED" draft for work nobody abandoned.
  it('does nothing for a clean-exit worktree with commits and no PR (#1289)', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      { ...ctx, abnormal: false, failureReason: 'clean exit' },
      { git: makeFakeGit({ aheadBase: 2 }, gitLog), gh: makeFakeGh(null, ghLog), readDirty: makeReadDirty(1) },
    );
    expect(out.action).toBe('none');
    expect(out.pushed).toBe(false);
    expect(out.prUrl).toBeUndefined();
    expect(gitLog.some((a) => a.includes('push'))).toBe(false);
    expect(ghLog.some((a) => a[1] === 'create' || a[1] === 'comment')).toBe(false);
  });

  // Even on a clean exit, an already-open PR is extended (push-existing is
  // exit-agnostic): committed-but-unpushed work still belongs on the PR.
  it('extends an open PR with unpushed work even on a clean exit (#1289)', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      { ...ctx, abnormal: false, failureReason: 'clean exit' },
      { git: makeFakeGit({ aheadBase: 5, unpushed: 2 }, gitLog), gh: makeFakeGh('https://x/pr/1', ghLog), readDirty: makeReadDirty(0) },
    );
    expect(out.action).toBe('push-existing');
    expect(out.prUrl).toBe('https://x/pr/1');
    expect(ghLog.some((a) => a[1] === 'comment')).toBe(true);
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

  // #1282 end-to-end: a branch whose most-recent PR already MERGED (and no open
  // PR) must produce NO push and NO PR create — the rescue declines to add a
  // redundant draft on a merged branch.
  it('does nothing when the branch already has a merged PR (no open PR)', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      ctx,
      {
        git: makeFakeGit({ aheadBase: 3 }, gitLog),
        gh: makeFakeGh({ state: 'MERGED', url: 'https://x/pr/1280' }, ghLog),
        readDirty: makeReadDirty(2),
      },
    );
    expect(out.action).toBe('none');
    expect(out.pushed).toBe(false);
    expect(out.prUrl).toBeUndefined();
    expect(gitLog.some((a) => a.includes('push'))).toBe(false);
    expect(ghLog.some((a) => a[1] === 'create' || a[1] === 'comment')).toBe(false);
  });

  // #1300 end-to-end: stranded work, no PR, abnormal exit — but the picked issue
  // is already CLOSED (resolved by another path). The rescue must decline: NO
  // push, NO gh pr create. It still queried the issue state (issue view called).
  it('does nothing when the picked issue is already closed (#1300)', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      { ...ctx, pickedIssue: '#1225' },
      {
        git: makeFakeGit({ aheadBase: 3 }, gitLog),
        gh: makeFakeGh(null, ghLog, 'CLOSED'),
        readDirty: makeReadDirty(2),
      },
    );
    expect(out.action).toBe('none');
    expect(out.pushed).toBe(false);
    expect(out.prUrl).toBeUndefined();
    expect(gitLog.some((a) => a.includes('push'))).toBe(false);
    expect(ghLog.some((a) => a[1] === 'create' || a[1] === 'comment')).toBe(false);
    expect(ghLog.some((a) => a[0] === 'issue' && a[1] === 'view')).toBe(true);
  });

  // #1300 regression: an OPEN picked issue with stranded work still creates the
  // draft — the guard is closed-only and must never block a legitimate rescue.
  it('still creates a draft when the picked issue is open (#1300)', () => {
    const gitLog: string[][] = [];
    const ghLog: string[][] = [];
    const out = rescueTarget(
      { worktree, branch: 'case/x' },
      { ...ctx, pickedIssue: '#1300' },
      {
        git: makeFakeGit({ aheadBase: 2 }, gitLog),
        gh: makeFakeGh(null, ghLog, 'OPEN'),
        readDirty: makeReadDirty(1),
      },
    );
    expect(out.action).toBe('create-draft');
    expect(out.pushed).toBe(true);
    expect(ghLog.some((a) => a[1] === 'create' && a.includes('--draft'))).toBe(true);
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
      { repo: 'o/r', runTag: 'b/run-1', runId: 'b-r1', failureReason: 'timeout', abnormal: true },
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

// --- #1270: union marker cases with runtag-stamped on-disk worktrees ---------

/**
 * Build a repoRoot with on-disk case worktrees and a fake GitExec that answers
 * `worktree list`, per-worktree `kaizen.runtag`, and HEAD-branch queries.
 * `stamps[id]` = the runtag string the worktree carries, or undefined = unstamped.
 * `heads[id]` = the branch HEAD reports (defaults to `case/<id>-head`).
 */
function makeWorktreeRepo(
  ids: string[],
  stamps: Record<string, string | undefined>,
  heads: Record<string, string> = {},
) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rescue-union-'));
  const wtDir = join(repoRoot, '.claude', 'worktrees');
  const paths: Record<string, string> = {};
  for (const id of ids) {
    const p = join(wtDir, id);
    mkdirSync(p, { recursive: true });
    paths[id] = p;
  }
  const git: GitExec = (args) => {
    const a = [...args];
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    const fail = () => ({ stdout: '', stderr: '', exitCode: 1 });
    // git -C <repoRoot> worktree list --porcelain
    if (a.includes('worktree') && a.includes('list')) {
      const lines = [`worktree ${repoRoot}`, ...ids.map((id) => `worktree ${paths[id]}`)];
      return ok(lines.join('\n') + '\n');
    }
    // git -C <wt> config --worktree --get kaizen.runtag
    if (a.includes('config') && a.includes('kaizen.runtag')) {
      const wt = a[a.indexOf('-C') + 1];
      const id = ids.find((i) => paths[i] === wt);
      const tag = id ? stamps[id] : undefined;
      return tag ? ok(tag + '\n') : fail();
    }
    // git -C <wt> rev-parse --abbrev-ref HEAD
    if (a.includes('rev-parse') && a.includes('--abbrev-ref')) {
      const wt = a[a.indexOf('-C') + 1];
      const id = ids.find((i) => paths[i] === wt);
      return ok((id && (heads[id] ?? `case/${id}-head`)) || 'HEAD');
    }
    return ok();
  };
  return { repoRoot, paths, git };
}

describe('collectRunWorktrees — #1270 runtag union', () => {
  it('unions marker cases with on-disk worktrees stamped with this run tag', () => {
    // A = marker case (also stamped); B = runtag-only (no marker). Both included.
    const repo = makeWorktreeRepo(['A', 'B'], { A: 'run-X', B: 'run-X' });
    const targets = collectRunWorktrees(repo.repoRoot, ['A'], { runTag: 'run-X', git: repo.git });
    const byPath = Object.fromEntries(targets.map((t) => [t.worktree, t.branch]));
    expect(targets).toHaveLength(2);
    expect(byPath[repo.paths.A]).toBe('case/A'); // marker branch wins for A
    expect(byPath[repo.paths.B]).toBe('case/B-head'); // B recovered via runtag
  });

  it('excludes worktrees stamped with a DIFFERENT run tag (concurrency safety)', () => {
    const repo = makeWorktreeRepo(['C'], { C: 'other-run/run-2' });
    const targets = collectRunWorktrees(repo.repoRoot, [], { runTag: 'run-X', git: repo.git });
    expect(targets).toEqual([]);
  });

  it('excludes unstamped case worktrees', () => {
    const repo = makeWorktreeRepo(['D'], { D: undefined });
    const targets = collectRunWorktrees(repo.repoRoot, [], { runTag: 'run-X', git: repo.git });
    expect(targets).toEqual([]);
  });

  it('de-duplicates a case present both as a marker and a runtag match', () => {
    const repo = makeWorktreeRepo(['A'], { A: 'run-X' });
    const targets = collectRunWorktrees(repo.repoRoot, ['A'], { runTag: 'run-X', git: repo.git });
    expect(targets).toHaveLength(1);
    expect(targets[0].branch).toBe('case/A'); // marker precedence, not the HEAD guess
  });

  it('derives the branch from the worktree HEAD, not the directory name', () => {
    const repo = makeWorktreeRepo(['B'], { B: 'run-X' }, { B: 'case/260628-k1270-actual' });
    const targets = collectRunWorktrees(repo.repoRoot, [], { runTag: 'run-X', git: repo.git });
    expect(targets).toHaveLength(1);
    expect(targets[0].branch).toBe('case/260628-k1270-actual');
  });

  it('skips a runtag-matched worktree whose HEAD is detached', () => {
    const repo = makeWorktreeRepo(['E'], { E: 'run-X' }, { E: 'HEAD' });
    const targets = collectRunWorktrees(repo.repoRoot, [], { runTag: 'run-X', git: repo.git });
    expect(targets).toEqual([]);
  });

  it('does not scan when no runTag/git is supplied (marker-only back-compat)', () => {
    const repo = makeWorktreeRepo(['B'], { B: 'run-X' });
    const targets = collectRunWorktrees(repo.repoRoot, []);
    expect(targets).toEqual([]);
  });
});
