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
