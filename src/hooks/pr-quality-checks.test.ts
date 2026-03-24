import { describe, expect, it } from 'vitest';
import {
  checkCodeQuality,
  checkPractices,
  checkTestCoverage,
  checkVerification,
  detectCommandType,
  formatCodeQualityWarning,
  formatTestCoverageWarning,
  getChangedFiles,
  runQualityChecks,
} from './pr-quality-checks.js';

describe('detectCommandType', () => {
  it('detects gh pr create', () => {
    expect(detectCommandType('gh pr create --title "test"')).toBe('pr_create');
  });

  it('detects gh pr merge', () => {
    expect(detectCommandType('gh pr merge 42 --squash')).toBe('pr_merge');
  });

  it('detects git commit', () => {
    expect(detectCommandType('git commit -m "fix"')).toBe('git_commit');
  });

  it('returns none for other commands', () => {
    expect(detectCommandType('npm test')).toBe('none');
    expect(detectCommandType('git push')).toBe('none');
    expect(detectCommandType('echo "gh pr create"')).toBe('none');
  });

  it('handles heredoc bodies', () => {
    expect(detectCommandType('gh pr create --body "$(cat <<\'EOF\'\nsome body\nEOF\n)"')).toBe('pr_create');
  });
});

describe('getChangedFiles', () => {
  it('uses git diff for create', () => {
    const exec = (cmd: string) => {
      if (cmd.includes('git diff')) return 'src/a.ts\nsrc/b.ts';
      return '';
    };
    expect(getChangedFiles('gh pr create', false, exec)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('uses gh pr diff for merge', () => {
    const exec = (cmd: string) => {
      if (cmd.includes('gh pr diff')) return 'src/c.ts\nsrc/d.ts';
      return '';
    };
    expect(getChangedFiles('gh pr merge 42', true, exec)).toEqual(['src/c.ts', 'src/d.ts']);
  });

  it('falls back to git diff on merge if gh pr diff fails', () => {
    const exec = (cmd: string) => {
      if (cmd.includes('gh pr diff')) return '';
      if (cmd.includes('git diff')) return 'src/e.ts';
      return '';
    };
    expect(getChangedFiles('gh pr merge 42', true, exec)).toEqual(['src/e.ts']);
  });
});

describe('checkTestCoverage', () => {
  it('returns empty uncovered when all source files have tests', () => {
    const files = ['src/hooks/foo.ts', 'src/hooks/foo.test.ts'];
    const result = checkTestCoverage(files);
    expect(result.uncoveredFiles).toEqual([]);
    expect(result.srcCount).toBe(1);
    expect(result.testCount).toBe(1);
  });

  it('detects uncovered source files', () => {
    const files = ['src/hooks/foo.ts', 'src/hooks/bar.ts', 'src/hooks/foo.test.ts'];
    const result = checkTestCoverage(files);
    expect(result.uncoveredFiles).toEqual(['src/hooks/bar.ts']);
  });

  it('ignores non-TS/JS files', () => {
    const files = ['docs/README.md', 'package.json'];
    const result = checkTestCoverage(files);
    expect(result.srcCount).toBe(0);
    expect(result.uncoveredFiles).toEqual([]);
  });

  it('ignores test-util files as sources', () => {
    const files = ['src/test-util.ts'];
    const result = checkTestCoverage(files, { fileExists: () => false, readFile: () => '' });
    expect(result.srcCount).toBe(0);
  });

  it('ignores config files as sources', () => {
    const files = ['vitest.config.ts', 'jest.config.js'];
    const result = checkTestCoverage(files);
    expect(result.srcCount).toBe(0);
  });

  it('matches prefixed test names', () => {
    const files = ['src/ipc.ts', 'src/ipc-github-issues.test.ts'];
    const result = checkTestCoverage(files);
    expect(result.uncoveredFiles).toEqual([]);
  });

  it('detects coverage via import analysis', () => {
    const files = ['src/cases.ts', 'src/other.test.ts'];
    const result = checkTestCoverage(files, {
      fileExists: () => true,
      readFile: () => "import { something } from '../cases.js';",
    });
    expect(result.uncoveredFiles).toEqual([]);
  });

  it('excludes .claude/ and container/agent-runner/ files', () => {
    const files = ['.claude/hooks/foo.ts', 'container/agent-runner/src/bar.ts'];
    const result = checkTestCoverage(files);
    expect(result.srcCount).toBe(0);
  });
});

describe('formatTestCoverageWarning', () => {
  it('returns success message when all covered', () => {
    const msg = formatTestCoverageWarning({ srcCount: 2, testCount: 2, uncoveredFiles: [] }, false);
    expect(msg).toContain('Test coverage check');
    expect(msg).toContain('2 source file(s)');
  });

  it('returns empty for no source files', () => {
    const msg = formatTestCoverageWarning({ srcCount: 0, testCount: 0, uncoveredFiles: [] }, false);
    expect(msg).toBe('');
  });

  it('includes uncovered files in warning', () => {
    const msg = formatTestCoverageWarning(
      { srcCount: 2, testCount: 1, uncoveredFiles: ['src/foo.ts'] },
      false,
    );
    expect(msg).toContain('src/foo.ts');
    expect(msg).toContain('test-exceptions');
  });

  it('uses merge-specific language when merging', () => {
    const msg = formatTestCoverageWarning(
      { srcCount: 1, testCount: 0, uncoveredFiles: ['src/foo.ts'] },
      true,
    );
    expect(msg).toContain('CI pr-policy check will block merge');
  });
});

describe('checkVerification', () => {
  it('warns on missing verification in pr_create', () => {
    const msg = checkVerification('gh pr create --title "test" --body "just a summary"', 'pr_create', () => '');
    expect(msg).toContain('Missing Verification section');
  });

  it('passes when verification keyword present in command', () => {
    const msg = checkVerification('gh pr create --body "## Verification\n- check this"', 'pr_create', () => '');
    expect(msg).toBe('');
  });

  it('passes with Test plan header', () => {
    const msg = checkVerification('gh pr create --body "## Test plan\n- tests pass"', 'pr_create', () => '');
    expect(msg).toBe('');
  });

  it('shows post-merge verification on pr_merge', () => {
    const exec = (cmd: string) => {
      if (cmd.includes('gh pr view')) return '## Verification\n- Run npm test\n- Check output';
      return '';
    };
    const msg = checkVerification('gh pr merge 42', 'pr_merge', exec);
    expect(msg).toContain('POST-MERGE VERIFICATION REQUIRED');
  });

  it('warns when merge PR has no verification section', () => {
    const exec = (cmd: string) => {
      if (cmd.includes('gh pr view')) return '## Summary\nSome changes';
      return '';
    };
    const msg = checkVerification('gh pr merge 42', 'pr_merge', exec);
    expect(msg).toContain('no Verification section');
  });

  it('returns empty for git_commit', () => {
    expect(checkVerification('git commit -m "fix"', 'git_commit', () => '')).toBe('');
  });
});

describe('checkPractices', () => {
  it('returns empty for no files', () => {
    expect(checkPractices([])).toBe('');
  });

  it('includes always-relevant practices', () => {
    const msg = checkPractices(['src/foo.ts']);
    expect(msg).toContain('DRY');
    expect(msg).toContain('Display URLs');
    expect(msg).toContain('Evidence over summaries');
  });

  it('includes shell-specific practices for .sh files', () => {
    const msg = checkPractices(['scripts/build.sh']);
    expect(msg).toContain('Error paths');
  });

  it('includes TS-specific practices for .ts files', () => {
    const msg = checkPractices(['src/foo.ts']);
    expect(msg).toContain('Minimal surface');
    expect(msg).toContain('Dependencies declared');
  });

  it('includes hook-specific practices for hook files', () => {
    const msg = checkPractices(['.claude/hooks/my-hook.sh']);
    expect(msg).toContain('Worktree isolation');
    expect(msg).toContain('Error paths');
  });

  it('includes container-specific practices', () => {
    const msg = checkPractices(['container/agent-runner/Dockerfile']);
    expect(msg).toContain('Test deployed artifact');
    expect(msg).toContain('Test fresh state');
  });

  it('includes test interaction practice when tests changed', () => {
    const msg = checkPractices(['src/foo.test.ts']);
    expect(msg).toContain('Test the interaction');
  });
});

describe('checkCodeQuality', () => {
  it('checks mock count on git_commit', () => {
    const result = checkCodeQuality([], 'git_commit', {
      exec: () => 'src/foo.test.ts',
      fileExists: () => true,
      readFile: () => 'vi.mock("a");\nvi.mock("b");\nvi.mock("c");\nvi.mock("d");',
    });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('4 mocks');
  });

  it('checks file length on git_commit', () => {
    const longFile = Array(501).fill('const x = 1;').join('\n');
    const result = checkCodeQuality([], 'git_commit', {
      exec: () => 'src/big.ts',
      fileExists: () => true,
      readFile: () => longFile,
    });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('lines');
  });

  it('skips checks for non-commit commands', () => {
    const result = checkCodeQuality([], 'pr_create', {
      exec: () => '',
      fileExists: () => true,
      readFile: () => '',
    });
    expect(result.warnings).toEqual([]);
  });

  it('returns empty for none command type', () => {
    const result = checkCodeQuality([], 'none');
    expect(result.warnings).toEqual([]);
  });
});

describe('formatCodeQualityWarning', () => {
  it('returns empty for no warnings', () => {
    expect(formatCodeQualityWarning({ warnings: [] }, 'git_commit')).toBe('');
  });

  it('formats warnings with context', () => {
    const msg = formatCodeQualityWarning({ warnings: ['  test warning'] }, 'git_commit');
    expect(msg).toContain('staged files');
    expect(msg).toContain('test warning');
  });

  it('uses PR context for pr_create', () => {
    const msg = formatCodeQualityWarning({ warnings: ['  test'] }, 'pr_create');
    expect(msg).toContain('PR changed files');
  });
});

describe('runQualityChecks', () => {
  it('returns empty for unrecognized commands', () => {
    const result = runQualityChecks('npm test');
    expect(result.messages).toEqual([]);
  });

  it('runs all PR checks for gh pr create', () => {
    const result = runQualityChecks('gh pr create --title "test" --body "## Verification\n- ok"', {
      exec: () => 'src/a.ts\nsrc/a.test.ts',
    });
    // Should have test coverage success + practices checklist
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('runs test coverage and verification for gh pr merge', () => {
    const result = runQualityChecks('gh pr merge 42', {
      exec: (cmd) => {
        if (cmd.includes('gh pr diff')) return 'src/a.ts';
        if (cmd.includes('gh pr view')) return '## Verification\n- check';
        return '';
      },
    });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('runs code quality checks for git commit', () => {
    const result = runQualityChecks('git commit -m "fix"', {
      exec: () => '',
    });
    // No warnings if no files
    expect(result.messages).toEqual([]);
  });
});
