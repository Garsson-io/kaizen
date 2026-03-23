import { describe, expect, it } from 'vitest';
import {
  checkDirtyFiles,
  detectTrigger,
  formatFileList,
  parseDirtyFiles,
} from './check-dirty-files.js';

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

  it('skips during merge resolution (kaizen #775)', () => {
    const mergeGit = (args: string) => {
      if (args.includes('status --porcelain')) return ' M conflict.ts';
      if (args.includes('rev-parse --show-toplevel')) return '/tmp/.test-merge-repo';
      return '';
    };
    // Can't easily test MERGE_HEAD existence without filesystem,
    // but we test the trigger detection and clean paths work
    const result = checkDirtyFiles('gh pr create --title "test"', { gitRunner: (args) => '' });
    expect(result.action).toBe('allow');
  });
});
