/**
 * git-state.test.ts — unit tests for the hook state-reading primitive.
 *
 * Closes #1073 (plugin.json false positive) by establishing a categorical
 * fix for the family of false-positives produced by reading git state from
 * process.cwd() and by trusting stat-based porcelain output. See
 * docs/hooks-design.md § "State-reading discipline".
 *
 * Related closed regressions this module guards against:
 *   #232 — cwd drift cross-worktree
 *   #721 — compound commit+push timing
 *   #871 — MM status on content-identical file ("update-index --refresh"
 *          workaround; demonstrably insufficient — #1073 regressed)
 */

import { describe, expect, it } from 'vitest';
import {
  formatDiagnostic,
  isBypassRequested,
  readDirtyFiles,
  resolveTargetWorktree,
} from './git-state.js';

describe('resolveTargetWorktree', () => {
  const CWD = '/agent/cwd';

  it('returns fallbackCwd when command has neither -C nor cd', () => {
    const r = resolveTargetWorktree('gh pr create --title t', CWD);
    expect(r).toEqual({ dir: CWD, source: 'cwd' });
  });

  it('extracts git -C <path>', () => {
    const r = resolveTargetWorktree('git -C /work/repo push', CWD);
    expect(r).toEqual({ dir: '/work/repo', source: 'git-C' });
  });

  it('extracts cd X && <cmd>', () => {
    const r = resolveTargetWorktree('cd /wt && gh pr create', CWD);
    expect(r).toEqual({ dir: '/wt', source: 'cd' });
  });

  it('extracts cd X ; <cmd>', () => {
    const r = resolveTargetWorktree('cd /a ; gh pr create', CWD);
    expect(r).toEqual({ dir: '/a', source: 'cd' });
  });

  it('extracts (cd X && <cmd>) subshell form', () => {
    const r = resolveTargetWorktree('(cd /b && gh pr create)', CWD);
    expect(r).toEqual({ dir: '/b', source: 'cd' });
  });

  it('extracts cd "quoted path"', () => {
    const r = resolveTargetWorktree('cd "/q path" && gh pr create', CWD);
    expect(r).toEqual({ dir: '/q path', source: 'cd' });
  });

  it("extracts cd 'quoted path'", () => {
    const r = resolveTargetWorktree("cd '/sq' && gh pr create", CWD);
    expect(r).toEqual({ dir: '/sq', source: 'cd' });
  });

  it('prefers explicit git -C over preceding cd', () => {
    const r = resolveTargetWorktree('cd /a && git -C /b push', CWD);
    expect(r).toEqual({ dir: '/b', source: 'git-C' });
  });

  it('does not match cdlock or other prefixes (word boundary)', () => {
    const r = resolveTargetWorktree('cdlock /x && gh pr create', CWD);
    expect(r.source).toBe('cwd');
    expect(r.dir).toBe(CWD);
  });

  it('does not treat bare `cd -` as a target', () => {
    const r = resolveTargetWorktree('cd - && gh pr create', CWD);
    expect(r.source).toBe('cwd');
  });

  it('handles cd with no argument (bare cd = HOME) by falling back to cwd', () => {
    const r = resolveTargetWorktree('cd && gh pr create', CWD);
    expect(r.source).toBe('cwd');
  });
});

describe('readDirtyFiles — porcelain whitespace invariant (live-fixture regression)', () => {
  // Porcelain v1 distinguishes ` M file` (unstaged-modified) from `M  file`
  // (staged-modified) by the leading space. Dropping that whitespace caused
  // the hook to misbucket unstaged files as staged and to corrupt the file
  // path via slice(3). Regression guard for the first iteration of #1073.
  it('preserves leading whitespace when classifying unstaged-modified entries', () => {
    const runner = (args: string) => {
      if (args.includes('rev-parse --absolute-git-dir')) return { stdout: '/r/.git', exitCode: 0 };
      if (args.includes('status --porcelain')) {
        return { stdout: ' M .claude-plugin/plugin.json\n', exitCode: 0 };
      }
      if (args.includes('diff --quiet HEAD -- ')) return { stdout: '', exitCode: 1 };
      return { stdout: '', exitCode: 0 };
    };
    const r = readDirtyFiles('/r', { runner });
    expect(r.verified.modified).toHaveLength(1);
    expect(r.verified.staged).toHaveLength(0);
    expect(r.perFileDiff[0]?.file).toBe('.claude-plugin/plugin.json');
  });
});

describe('readDirtyFiles', () => {
  type Runner = (args: string) => { stdout: string; exitCode: number };

  function makeRunner(handlers: Record<string, { stdout?: string; exitCode?: number }>): Runner {
    return (args: string) => {
      for (const [pattern, out] of Object.entries(handlers)) {
        if (args.includes(pattern)) {
          return { stdout: out.stdout ?? '', exitCode: out.exitCode ?? 0 };
        }
      }
      return { stdout: '', exitCode: 0 };
    };
  }

  it('returns empty report when porcelain is empty', () => {
    const runner = makeRunner({
      'rev-parse --absolute-git-dir': { stdout: '/fake/.git' },
      'status --porcelain': { stdout: '' },
    });
    const r = readDirtyFiles('/fake', { runner });
    expect(r.verified.total).toBe(0);
    expect(r.raw).toBe('');
  });

  it('filters out files where content matches HEAD (kaizen #871)', () => {
    // porcelain claims MM .claude-plugin/plugin.json, but git diff HEAD says clean
    const runner = makeRunner({
      'rev-parse --absolute-git-dir': { stdout: '/fake/.git' },
      'status --porcelain': { stdout: 'MM .claude-plugin/plugin.json\n' },
      // `git diff --quiet HEAD -- <file>` returns 0 when file matches HEAD
      'diff --quiet HEAD -- ': { exitCode: 0 },
    });
    const r = readDirtyFiles('/fake', { runner });
    expect(r.verified.total).toBe(0);
    expect(r.raw).toContain('.claude-plugin/plugin.json');
  });

  it('keeps files whose content differs from HEAD', () => {
    const runner = makeRunner({
      'rev-parse --absolute-git-dir': { stdout: '/fake/.git' },
      'status --porcelain': { stdout: ' M src/real.ts\n' },
      'diff --quiet HEAD -- ': { exitCode: 1 }, // real diff
    });
    const r = readDirtyFiles('/fake', { runner });
    expect(r.verified.total).toBe(1);
    expect(r.verified.modified).toHaveLength(1);
  });

  it('keeps untracked files (no HEAD to compare against)', () => {
    const runner = makeRunner({
      'rev-parse --absolute-git-dir': { stdout: '/fake/.git' },
      'status --porcelain': { stdout: '?? data/ipc/pending.json\n' },
    });
    const r = readDirtyFiles('/fake', { runner });
    expect(r.verified.total).toBe(1);
    expect(r.verified.untracked).toHaveLength(1);
  });

  it('returns gitDir for MERGE_HEAD skip decision', () => {
    const runner = makeRunner({
      'rev-parse --absolute-git-dir': { stdout: '/fake/.git/worktrees/wt' },
      'status --porcelain': { stdout: '' },
    });
    const r = readDirtyFiles('/fake', { runner });
    expect(r.gitDir).toBe('/fake/.git/worktrees/wt');
  });
});

describe('formatDiagnostic', () => {
  it('includes all required markers', () => {
    const out = formatDiagnostic({
      cwd: '/a',
      target: '/b',
      targetSource: 'cd',
      gitDir: '/b/.git',
      rawPorcelain: ' M foo\n',
      perFileDiff: [{ file: 'foo', diffIndexExitCode: 1, blobMatch: false }],
    });
    expect(out).toContain('[cwd]');
    expect(out).toContain('/a');
    expect(out).toContain('[target]');
    expect(out).toContain('/b');
    expect(out).toContain('[target-source]');
    expect(out).toContain('cd');
    expect(out).toContain('[git-dir]');
    expect(out).toContain('[porcelain]');
    expect(out).toContain('[diff-index]');
    expect(out).toContain('foo');
  });

  it('truncates long porcelain output to 20 lines', () => {
    const many = Array.from({ length: 50 }, (_, i) => ` M file${i}.ts`).join('\n');
    const out = formatDiagnostic({
      cwd: '/a',
      target: '/a',
      targetSource: 'cwd',
      gitDir: '/a/.git',
      rawPorcelain: many,
      perFileDiff: [],
    });
    expect(out).toContain('file0.ts');
    expect(out).toContain('truncated');
    expect(out).not.toContain('file49.ts');
  });
});

describe('isBypassRequested', () => {
  it('returns false when env var is unset', () => {
    expect(isBypassRequested({})).toBe(false);
  });

  it('returns true for "1"', () => {
    expect(isBypassRequested({ KAIZEN_ALLOW_DIRTY_FILES: '1' })).toBe(true);
  });

  it('returns true for "true"', () => {
    expect(isBypassRequested({ KAIZEN_ALLOW_DIRTY_FILES: 'true' })).toBe(true);
  });

  it('returns false for "0"', () => {
    expect(isBypassRequested({ KAIZEN_ALLOW_DIRTY_FILES: '0' })).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isBypassRequested({ KAIZEN_ALLOW_DIRTY_FILES: '' })).toBe(false);
  });
});
