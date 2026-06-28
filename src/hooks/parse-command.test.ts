import { describe, expect, it } from 'vitest';
import {
  detectGhRepo,
  extractCdTarget,
  extractGitCPath,
  extractPrNumber,
  extractPrUrl,
  extractRepoFlag,
  getPrChangedFiles,
  isGhPrCommand,
  isGitCommand,
  reconstructPrUrl,
  splitCommandSegments,
  stripHeredocBody,
} from './parse-command.js';

describe('stripHeredocBody', () => {
  it('returns command unchanged when no heredoc', () => {
    expect(stripHeredocBody('gh pr create --title "test"')).toBe(
      'gh pr create --title "test"',
    );
  });

  it('strips heredoc body with single-quoted delimiter', () => {
    const cmd = `gh pr create --body "$(cat <<'EOF'\nsome body\nEOF\n)"`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('gh pr create');
    expect(result).toContain("<<'EOF'");
    expect(result).not.toContain('some body');
  });

  it('strips heredoc body with unquoted delimiter', () => {
    const cmd = `echo test\ncat <<HEREDOC\nline1\nline2\nHEREDOC`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('<<HEREDOC');
  });

  it('strips heredoc body with dash operator', () => {
    const cmd = `cat <<-EOF\n\tindented\nEOF`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('<<-EOF');
  });

  it('preserves commands after heredoc closing delimiter (kaizen #909)', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfix: something\n\nCo-Authored-By: Claude\nEOF\n)" && git push`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('git commit');
    expect(result).toContain('git push');
    expect(result).not.toContain('Co-Authored-By');
  });

  it('preserves chained commands after heredoc in gh pr create', () => {
    const cmd = `gh pr create --title "fix" --body "$(cat <<'EOF'\n## Summary\nFixed bug.\nEOF\n)" && git push -u origin branch`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('gh pr create');
    expect(result).toContain('git push');
    expect(result).not.toContain('Fixed bug');
  });
});

describe('splitCommandSegments', () => {
  it('splits on bare newlines (#1013)', () => {
    expect(splitCommandSegments('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('still collapses operator chains', () => {
    expect(splitCommandSegments('npm run build && gh pr create')).toEqual([
      'npm run build',
      'gh pr create',
    ]);
    expect(splitCommandSegments('a || b ; c | d')).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('collapses an operator+newline run into a single delimiter', () => {
    expect(splitCommandSegments('a &&\ngh pr create')).toEqual([
      'a',
      'gh pr create',
    ]);
  });
});

describe('isGhPrCommand', () => {
  it('detects gh pr create', () => {
    expect(isGhPrCommand('gh pr create --title "test"', 'create')).toBe(true);
  });

  it('detects gh pr merge', () => {
    expect(isGhPrCommand('gh pr merge 42 --squash', 'merge')).toBe(true);
  });

  it('detects either create or merge with alternation', () => {
    expect(isGhPrCommand('gh pr create --title "x"', 'create|merge')).toBe(
      true,
    );
    expect(isGhPrCommand('gh pr merge 42', 'create|merge')).toBe(true);
  });

  it('rejects non-PR commands', () => {
    expect(isGhPrCommand('npm run build', 'create')).toBe(false);
    expect(isGhPrCommand('echo "gh pr create"', 'create')).toBe(false);
  });

  it('handles piped commands', () => {
    expect(isGhPrCommand('echo test | gh pr create --title x', 'create')).toBe(
      true,
    );
  });

  it('handles chained commands', () => {
    expect(
      isGhPrCommand('npm run build && gh pr create --title x', 'create'),
    ).toBe(true);
  });

  it('detects gh pr create after newline-separated assignments (#1013)', () => {
    const cmd = `KAIZEN_REPO=$(jq -r '.kaizen.repo' kaizen.config.json)\nHOST_REPO=$(jq -r '.host.repo' kaizen.config.json)\ngh pr create --repo "$HOST_REPO" --title x`;
    expect(isGhPrCommand(cmd, 'create')).toBe(true);
  });

  it('word-bounds the subcommand so a longer one is not a prefix match (#1350)', () => {
    // `gh pr difftool` must not match the `diff` subcommand.
    expect(isGhPrCommand('gh pr difftool 42', 'diff')).toBe(false);
    expect(isGhPrCommand('gh pr diff 42', 'diff')).toBe(true);
    expect(isGhPrCommand('gh pr view 42', 'diff|view|comment|edit')).toBe(true);
  });

  it('detects gh pr create when backslash-continued across lines (#1013)', () => {
    const cmd = `export PATH="/x"\ngh pr create \\\n  --repo R \\\n  --title x`;
    expect(isGhPrCommand(cmd, 'create')).toBe(true);
  });

  it('does not resurrect heredoc false-positive after stripHeredocBody (#1013)', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\ngh pr create --title sneaky\nEOF\n)"`;
    expect(isGhPrCommand(stripHeredocBody(cmd), 'create')).toBe(false);
  });
});

describe('isGitCommand', () => {
  it('detects git push', () => {
    expect(isGitCommand('git push -u origin main', 'push')).toBe(true);
  });

  it('detects git -C <path> push', () => {
    expect(isGitCommand('git -C /some/path push origin main', 'push')).toBe(
      true,
    );
  });

  it('rejects non-git commands', () => {
    expect(isGitCommand('npm run build', 'push')).toBe(false);
  });

  it('detects git push after newline-separated assignments (#1013)', () => {
    expect(
      isGitCommand('export PATH=/x\ngit push -u origin main', 'push'),
    ).toBe(true);
  });

  // #1350: the alternation was unanchored, so every alternative after the first
  // matched as a bare substring anywhere in the segment. Any command merely
  // CONTAINING `log`/`show`/`status`/`branch`/`fetch` was treated as a readonly
  // git command — a gate bypass.
  describe('grouped + word-bounded alternation (#1350)', () => {
    const READONLY = 'diff|log|show|status|branch|fetch';

    it('does not match a non-git command that contains a subcommand substring', () => {
      expect(isGitCommand('rm -rf branch-backups', READONLY)).toBe(false);
      expect(isGitCommand('git push origin show', READONLY)).toBe(false);
      expect(isGitCommand('docker rm show', READONLY)).toBe(false);
      expect(isGitCommand('make deploy-log', READONLY)).toBe(false);
      // contains the literal substring "status" — flips OLD true -> NEW false
      expect(isGitCommand('echo status', READONLY)).toBe(false);
    });

    it('still matches every real git read-only subcommand', () => {
      expect(isGitCommand('git diff', READONLY)).toBe(true);
      expect(isGitCommand('git log --oneline', READONLY)).toBe(true);
      expect(isGitCommand('git show HEAD', READONLY)).toBe(true);
      expect(isGitCommand('git status', READONLY)).toBe(true);
      expect(isGitCommand('git branch -a', READONLY)).toBe(true);
      expect(isGitCommand('git fetch origin', READONLY)).toBe(true);
      expect(isGitCommand('git -C /some/path show HEAD', READONLY)).toBe(true);
    });

    it('word-bounds so a longer subcommand is not matched as a prefix', () => {
      // `git difftool` is interactive, not the readonly `diff`.
      expect(isGitCommand('git difftool', 'diff')).toBe(false);
      expect(isGitCommand('git diff', 'diff')).toBe(true);
    });
  });
});

describe('extractPrNumber', () => {
  it('extracts PR number from merge command', () => {
    expect(extractPrNumber('gh pr merge 42 --squash', 'merge')).toBe('42');
  });

  it('extracts PR number from merge with URL', () => {
    expect(
      extractPrNumber('gh pr merge 123 --repo Garsson-io/kaizen', 'merge'),
    ).toBe('123');
  });

  it('returns undefined when no PR number', () => {
    expect(extractPrNumber('gh pr merge --squash', 'merge')).toBeUndefined();
  });
});

describe('extractRepoFlag', () => {
  it('extracts --repo flag', () => {
    expect(
      extractRepoFlag('gh pr create --repo Garsson-io/kaizen --title test'),
    ).toBe('Garsson-io/kaizen');
  });

  it('returns undefined when no --repo flag', () => {
    expect(extractRepoFlag('gh pr create --title test')).toBeUndefined();
  });
});

describe('extractPrUrl', () => {
  it('extracts GitHub PR URL from text', () => {
    expect(
      extractPrUrl(
        'Created PR: https://github.com/Garsson-io/kaizen/pull/42',
      ),
    ).toBe('https://github.com/Garsson-io/kaizen/pull/42');
  });

  it('returns undefined for text without PR URL', () => {
    expect(extractPrUrl('No URL here')).toBeUndefined();
  });
});

describe('extractGitCPath', () => {
  it('extracts -C path from git command', () => {
    expect(extractGitCPath('git -C /some/path push origin main')).toBe(
      '/some/path',
    );
  });

  it('returns undefined when no -C flag', () => {
    expect(extractGitCPath('git push origin main')).toBeUndefined();
  });

  it('handles piped commands', () => {
    expect(extractGitCPath('echo test | git -C /foo status')).toBe('/foo');
  });
});

describe('extractCdTarget', () => {
  it('extracts target from cd X && <cmd>', () => {
    expect(extractCdTarget('cd /wt && gh pr create')).toBe('/wt');
  });

  it('extracts target from cd X ; <cmd>', () => {
    expect(extractCdTarget('cd /a ; gh pr create')).toBe('/a');
  });

  it('extracts target from (cd X && <cmd>) subshell', () => {
    expect(extractCdTarget('(cd /b && gh pr create)')).toBe('/b');
  });

  it('extracts target from double-quoted path', () => {
    expect(extractCdTarget('cd "/q path" && gh pr create')).toBe('/q path');
  });

  it('extracts target from single-quoted path', () => {
    expect(extractCdTarget("cd '/sq path' && gh pr create")).toBe('/sq path');
  });

  it('returns undefined for commands with no cd prefix', () => {
    expect(extractCdTarget('gh pr create')).toBeUndefined();
  });

  it('does not match cdlock or other word prefixes', () => {
    expect(extractCdTarget('cdlock /x && gh pr create')).toBeUndefined();
  });

  it('ignores cd - (previous dir, not a path target)', () => {
    expect(extractCdTarget('cd - && gh pr create')).toBeUndefined();
  });

  it('ignores bare cd (HOME, not explicit)', () => {
    expect(extractCdTarget('cd && gh pr create')).toBeUndefined();
  });

  it('returns first cd target when multiple present', () => {
    expect(extractCdTarget('cd /a && cd /b && gh pr create')).toBe('/a');
  });
});

describe('detectGhRepo', () => {
  it('detects repo from HTTPS URL', () => {
    expect(detectGhRepo('https://github.com/Garsson-io/kaizen.git')).toBe(
      'Garsson-io/kaizen',
    );
  });

  it('detects repo from SSH URL', () => {
    expect(detectGhRepo('git@github.com:Garsson-io/kaizen.git')).toBe(
      'Garsson-io/kaizen',
    );
  });

  it('returns undefined for non-GitHub URL', () => {
    expect(detectGhRepo('https://gitlab.com/foo/bar.git')).toBeUndefined();
  });
});

describe('getPrChangedFiles', () => {
  it('uses gh pr diff for merge commands', () => {
    const executor = (cmd: string) => {
      if (cmd.includes('gh pr diff')) return 'file1.ts\nfile2.ts\n';
      return '';
    };
    const files = getPrChangedFiles(
      'gh pr merge 42 --repo Garsson-io/kaizen',
      true,
      executor,
    );
    expect(files).toEqual(['file1.ts', 'file2.ts']);
  });

  it('falls back to git diff when gh pr diff returns empty', () => {
    const executor = (cmd: string) => {
      if (cmd.includes('gh pr diff')) return '';
      if (cmd.includes('git diff')) return 'fallback.ts\n';
      return '';
    };
    const files = getPrChangedFiles('gh pr merge 42', true, executor);
    expect(files).toEqual(['fallback.ts']);
  });

  it('uses git diff for create commands', () => {
    const executor = (cmd: string) => {
      if (cmd.includes('git diff')) return 'new-file.ts\n';
      return '';
    };
    const files = getPrChangedFiles(
      'gh pr create --title test',
      false,
      executor,
    );
    expect(files).toEqual(['new-file.ts']);
  });
});

describe('reconstructPrUrl', () => {
  it('extracts from stdout first', () => {
    expect(
      reconstructPrUrl(
        'gh pr create',
        'https://github.com/Garsson-io/kaizen/pull/42',
        '',
        'create',
      ),
    ).toBe('https://github.com/Garsson-io/kaizen/pull/42');
  });

  it('falls back to stderr', () => {
    expect(
      reconstructPrUrl(
        'gh pr create',
        '',
        'https://github.com/Garsson-io/kaizen/pull/42',
        'create',
      ),
    ).toBe('https://github.com/Garsson-io/kaizen/pull/42');
  });

  it('falls back to command args', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge https://github.com/Garsson-io/kaizen/pull/42 --squash',
        '✓ Merged',
        '',
        'merge',
      ),
    ).toBe('https://github.com/Garsson-io/kaizen/pull/42');
  });

  it('reconstructs from --repo + PR number', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge 42 --repo Garsson-io/kaizen --squash',
        '✓ Merged',
        '',
        'merge',
      ),
    ).toBe('https://github.com/Garsson-io/kaizen/pull/42');
  });

  it('reconstructs from PR number + git remote', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge 42 --squash',
        '✓ Merged',
        '',
        'merge',
        'Garsson-io/kaizen',
      ),
    ).toBe('https://github.com/Garsson-io/kaizen/pull/42');
  });

  it('returns undefined when no URL can be reconstructed', () => {
    expect(
      reconstructPrUrl('gh pr merge --squash', '✓ Merged', '', 'merge'),
    ).toBeUndefined();
  });
});
