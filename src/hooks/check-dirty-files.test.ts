import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDirtyFiles,
  detectTrigger,
  formatFileList,
  hasCommitBeforePush,
  parseDirtyFiles,
} from './check-dirty-files.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

describe('detectTrigger', () => {
  it('detects gh pr create', () => {
    expect(detectTrigger('gh pr create --title "test"')).toBe('pr_create');
  });

  it('detects git push', () => {
    expect(detectTrigger('git push origin feature')).toBe('git_push');
  });

  it('detects gh pr merge', () => {
    expect(detectTrigger('gh pr merge 42')).toBe('pr_merge');
  });

  it('returns none for other commands', () => {
    expect(detectTrigger('npm test')).toBe('none');
    expect(detectTrigger('git diff')).toBe('none');
  });

  it('returns none when git commit precedes git push in compound command (kaizen #721)', () => {
    expect(detectTrigger('git add -A && git commit -m "fix" && git push')).toBe('none');
    expect(detectTrigger('git commit -m "msg" && git push origin main')).toBe('none');
  });

  it('still detects standalone git push', () => {
    expect(detectTrigger('git push origin feature')).toBe('git_push');
    expect(detectTrigger('git push')).toBe('git_push');
  });

  it('still detects git push after non-commit commands', () => {
    expect(detectTrigger('npm test && git push')).toBe('git_push');
    expect(detectTrigger('echo done && git push origin main')).toBe('git_push');
  });
});

describe('hasCommitBeforePush', () => {
  it('detects commit before push in compound command', () => {
    expect(hasCommitBeforePush('git commit -m "fix" && git push')).toBe(true);
    expect(hasCommitBeforePush('git add -A && git commit -m "msg" && git push origin main')).toBe(true);
  });

  it('returns false for push without preceding commit', () => {
    expect(hasCommitBeforePush('git push origin main')).toBe(false);
    expect(hasCommitBeforePush('npm test && git push')).toBe(false);
  });

  it('returns false when push comes before commit', () => {
    expect(hasCommitBeforePush('git push && git commit -m "fix"')).toBe(false);
  });

  it('handles git -C path variants', () => {
    expect(hasCommitBeforePush('git -C /foo commit -m "x" && git -C /foo push')).toBe(true);
  });
});

describe('parseDirtyFiles', () => {
  it('parses porcelain output', () => {
    const output = ' M src/hooks/test.ts\n?? temp.log\nM  staged.ts';
    const report = parseDirtyFiles(output);
    expect(report.modified).toHaveLength(1);
    expect(report.untracked).toHaveLength(1);
    expect(report.staged).toHaveLength(1);
    expect(report.total).toBe(3);
  });

  it('handles empty output', () => {
    const report = parseDirtyFiles('');
    expect(report.total).toBe(0);
  });

  it('classifies MM (staged+modified) as staged (kaizen #871)', () => {
    const output = 'MM .claude-plugin/plugin.json';
    const report = parseDirtyFiles(output);
    expect(report.staged).toHaveLength(1);
    expect(report.modified).toHaveLength(0);
    expect(report.total).toBe(1);
  });

  it('classifies AM (added+modified) as staged', () => {
    const output = 'AM new-file.ts';
    const report = parseDirtyFiles(output);
    expect(report.staged).toHaveLength(1);
    expect(report.modified).toHaveLength(0);
  });
});

describe('formatFileList', () => {
  it('formats categorized file list', () => {
    const report = {
      staged: ['M  staged.ts'],
      modified: [' M modified.ts'],
      untracked: ['?? temp.log'],
      total: 3,
    };
    const formatted = formatFileList(report);
    expect(formatted).toContain('Staged but not committed');
    expect(formatted).toContain('Modified (unstaged)');
    expect(formatted).toContain('Untracked');
  });
});

describe('checkDirtyFiles', () => {
  const mockGit = (porcelain: string) => (args: string) => {
    if (args.includes('status --porcelain')) return porcelain;
    if (args.includes('rev-parse --show-toplevel')) return '/tmp/fake-repo';
    return '';
  };

  it('allows non-trigger commands', () => {
    const result = checkDirtyFiles('npm test', { gitRunner: mockGit(' M dirty.ts') });
    expect(result.action).toBe('allow');
  });

  it('allows pr create when worktree is clean', () => {
    const result = checkDirtyFiles('gh pr create --title "test"', { gitRunner: mockGit('') });
    expect(result.action).toBe('allow');
  });

  it('blocks pr create when worktree is dirty', () => {
    const result = checkDirtyFiles('gh pr create --title "test"', {
      gitRunner: mockGit(' M src/hooks/test.ts'),
    });
    expect(result.action).toBe('deny');
    expect(result.message).toContain('DIRTY FILES');
    expect(result.message).toContain('creating a PR');
  });

  it('warns (not blocks) on git push when dirty (kaizen #775)', () => {
    const result = checkDirtyFiles('git push origin feature', {
      gitRunner: mockGit(' M src/hooks/test.ts'),
    });
    expect(result.action).toBe('warn');
    expect(result.message).toContain('pushing code');
    expect(result.message).toContain('advisory only');
  });

  it('warns on gh pr merge when dirty', () => {
    const result = checkDirtyFiles('gh pr merge 42', {
      gitRunner: mockGit(' M src/hooks/test.ts'),
    });
    expect(result.action).toBe('warn');
    expect(result.message).toContain('merging a PR');
  });

  it('calls update-index --refresh before status --porcelain (kaizen #871)', () => {
    const calls: string[] = [];
    const trackingGit = (args: string) => {
      calls.push(args);
      if (args.includes('rev-parse --git-dir')) return '/fake/.git';
      if (args.includes('status --porcelain')) return ' M dirty.ts';
      return '';
    };
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockImplementation(() => false);

    checkDirtyFiles('gh pr create --title "test"', { gitRunner: trackingGit });

    const refreshIdx = calls.findIndex(c => c.includes('update-index'));
    const statusIdx = calls.findIndex(c => c.includes('status --porcelain'));
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(refreshIdx);

    mockedExistsSync.mockRestore();
  });

  it('allows compound commit+push even when dirty (kaizen #721)', () => {
    const result = checkDirtyFiles('git add -A && git commit -m "fix" && git push', {
      gitRunner: mockGit(' M src/hooks/test.ts'),
    });
    expect(result.action).toBe('allow');
  });

  it('skips during merge resolution when MERGE_HEAD exists (kaizen #773)', () => {
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockImplementation((p) => {
      if (String(p) === join('/fake/.git/worktrees/my-wt', 'MERGE_HEAD')) return true;
      return false;
    });

    const mergeGit = (args: string) => {
      if (args.includes('rev-parse --git-dir')) return '/fake/.git/worktrees/my-wt';
      if (args.includes('status --porcelain')) return ' M conflict.ts';
      return '';
    };

    const result = checkDirtyFiles('gh pr create --title "test"', { gitRunner: mergeGit });
    expect(result.action).toBe('allow');

    mockedExistsSync.mockRestore();
  });

  it('blocks pr create when not in merge resolution (kaizen #773)', () => {
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockImplementation(() => false);

    const noMergeGit = (args: string) => {
      if (args.includes('rev-parse --git-dir')) return '/fake/.git';
      if (args.includes('status --porcelain')) return ' M conflict.ts';
      return '';
    };

    const result = checkDirtyFiles('gh pr create --title "test"', { gitRunner: noMergeGit });
    expect(result.action).toBe('deny');

    mockedExistsSync.mockRestore();
  });
});

/**
 * Categorical fix — #1073 and the cwd/stat-drift family.
 *
 * Closes #1073 (plugin.json phantom staged). Regression-guards #871 (MM
 * false-positive), #232 (cross-worktree cwd drift). Uses the gitExec
 * option (new-style runner with exit codes) to exercise the code path
 * that verifies porcelain claims with `git diff --quiet HEAD -- <file>`.
 */
describe('checkDirtyFiles — categorical (#1073)', () => {
  type ExecResult = { stdout: string; exitCode: number };
  type ExecRunner = (args: string) => ExecResult;

  function makeExec(handlers: Array<[string, ExecResult]>): ExecRunner {
    return (args: string) => {
      for (const [pattern, out] of handlers) {
        if (args.includes(pattern)) return out;
      }
      return { stdout: '', exitCode: 0 };
    };
  }

  afterEach(() => {
    vi.mocked(existsSync).mockRestore();
  });

  describe('cwd-drift: cd X && gh pr create (#1073, #232)', () => {
    it('resolves to cd target and anchors every git call via -C <target>', () => {
      vi.mocked(existsSync).mockImplementation(() => false);

      const calls: string[] = [];
      const exec: ExecRunner = (args) => {
        calls.push(args);
        if (args.includes('rev-parse --absolute-git-dir')) {
          return { stdout: '/clean-wt/.git', exitCode: 0 };
        }
        if (args.includes('status --porcelain')) {
          return { stdout: '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      };

      const result = checkDirtyFiles('cd /clean-wt && gh pr create --title t', {
        gitExec: exec,
      });

      expect(result.action).toBe('allow');
      const anchored = calls.filter((c) => c.includes('status --porcelain'));
      expect(anchored.length).toBeGreaterThan(0);
      for (const c of anchored) {
        expect(c).toContain('-C /clean-wt');
      }
    });
  });

  describe('stat-vs-content: content-clean files are filtered (#871)', () => {
    it('allows pr create when porcelain reports MM but diff HEAD says clean', () => {
      vi.mocked(existsSync).mockImplementation(() => false);

      const exec = makeExec([
        ['rev-parse --absolute-git-dir', { stdout: '/r/.git', exitCode: 0 }],
        ['status --porcelain', { stdout: 'MM .claude-plugin/plugin.json\n', exitCode: 0 }],
        ['diff --quiet HEAD --', { stdout: '', exitCode: 0 }],
      ]);

      const result = checkDirtyFiles('gh pr create --title t', { gitExec: exec });
      expect(result.action).toBe('allow');
    });

    it('still denies when a tracked file actually differs from HEAD', () => {
      vi.mocked(existsSync).mockImplementation(() => false);

      const exec = makeExec([
        ['rev-parse --absolute-git-dir', { stdout: '/r/.git', exitCode: 0 }],
        ['status --porcelain', { stdout: ' M src/real.ts\n', exitCode: 0 }],
        ['diff --quiet HEAD --', { stdout: '', exitCode: 1 }],
      ]);

      const result = checkDirtyFiles('gh pr create --title t', { gitExec: exec });
      expect(result.action).toBe('deny');
    });
  });

  describe('observability: deny message diagnostic block (#1073 comment:2)', () => {
    it('includes [cwd], [target], [target-source], [git-dir], [porcelain] markers', () => {
      vi.mocked(existsSync).mockImplementation(() => false);

      const exec = makeExec([
        ['rev-parse --absolute-git-dir', { stdout: '/r/.git', exitCode: 0 }],
        ['status --porcelain', { stdout: ' M real.ts\n', exitCode: 0 }],
        ['diff --quiet HEAD --', { stdout: '', exitCode: 1 }],
      ]);

      const result = checkDirtyFiles('gh pr create --title t', { gitExec: exec });
      expect(result.action).toBe('deny');
      expect(result.message).toContain('[cwd]');
      expect(result.message).toContain('[target]');
      expect(result.message).toContain('[target-source]');
      expect(result.message).toContain('[git-dir]');
      expect(result.message).toContain('[porcelain]');
    });
  });

  describe('escape hatch: KAIZEN_ALLOW_DIRTY_FILES', () => {
    it('bypasses hook when env var is "1"', () => {
      vi.mocked(existsSync).mockImplementation(() => false);

      const exec = makeExec([
        ['rev-parse --absolute-git-dir', { stdout: '/r/.git', exitCode: 0 }],
        ['status --porcelain', { stdout: ' M real.ts\n', exitCode: 0 }],
        ['diff --quiet HEAD --', { stdout: '', exitCode: 1 }],
      ]);

      const result = checkDirtyFiles('gh pr create --title t', {
        gitExec: exec,
        env: { KAIZEN_ALLOW_DIRTY_FILES: '1' },
      });
      expect(result.action).toBe('allow');
      expect(result.bypassed).toBe(true);
    });

    it('does not bypass when env var is "0"', () => {
      vi.mocked(existsSync).mockImplementation(() => false);

      const exec = makeExec([
        ['rev-parse --absolute-git-dir', { stdout: '/r/.git', exitCode: 0 }],
        ['status --porcelain', { stdout: ' M real.ts\n', exitCode: 0 }],
        ['diff --quiet HEAD --', { stdout: '', exitCode: 1 }],
      ]);

      const result = checkDirtyFiles('gh pr create --title t', {
        gitExec: exec,
        env: { KAIZEN_ALLOW_DIRTY_FILES: '0' },
      });
      expect(result.action).toBe('deny');
    });
  });

  describe('regression guards (labeled param rows)', () => {
    it('#721: compound commit+push stays allowed even when dirty', () => {
      vi.mocked(existsSync).mockImplementation(() => false);
      const exec = makeExec([
        ['status --porcelain', { stdout: ' M anything.ts\n', exitCode: 0 }],
      ]);
      const result = checkDirtyFiles('git add -A && git commit -m fix && git push', {
        gitExec: exec,
      });
      expect(result.action).toBe('allow');
    });

    it('#232: git -C <other-wt> push anchors every git call to that worktree', () => {
      vi.mocked(existsSync).mockImplementation(() => false);
      const calls: string[] = [];
      const exec: ExecRunner = (args) => {
        calls.push(args);
        if (args.includes('rev-parse --absolute-git-dir')) {
          return { stdout: '/other-wt/.git', exitCode: 0 };
        }
        if (args.includes('status --porcelain')) return { stdout: '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      };
      checkDirtyFiles('git -C /other-wt push origin feat', { gitExec: exec });
      const anchored = calls.filter((c) => c.includes('status --porcelain'));
      expect(anchored.length).toBeGreaterThan(0);
      for (const c of anchored) expect(c).toContain('-C /other-wt');
    });
  });
});
