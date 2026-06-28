import { describe, expect, it } from 'vitest';
import {
  mainCheckoutEditHint,
  matchingCaseWorktreeTargets,
  normalizeSanitizedCaseBranch,
  parseWorktreePorcelain,
  sessionSetupMessages,
} from './worktree-integrity.js';
import type { GitRun, GitResult } from '../issue-binding.js';

function fakeRun(responses: Record<string, GitResult>): GitRun {
  return (args: string[]) => responses[args.join('\0')] ?? { stdout: '', code: 1 };
}

describe('worktree integrity helper', () => {
  it('normalizes EnterWorktree-sanitized case branches', () => {
    const calls: string[][] = [];
    const run: GitRun = args => {
      calls.push(args);
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
        return { stdout: 'worktree-case+260626-k1506-demo', code: 0 };
      }
      if (args[0] === 'show-ref') return { stdout: '', code: 1 };
      if (args[0] === 'branch') return { stdout: '', code: 0 };
      return { stdout: '', code: 1 };
    };

    const result = normalizeSanitizedCaseBranch(run);

    expect(result.status).toBe('normalized');
    expect(result.branchAfter).toBe('case/260626-k1506-demo');
    expect(calls).toContainEqual(['branch', '-m', 'case/260626-k1506-demo']);
  });

  it('reports remediation when the canonical target branch already exists', () => {
    const run = fakeRun({
      ['rev-parse\0--abbrev-ref\0HEAD']: { stdout: 'worktree-case+260626-k1506-demo', code: 0 },
      ['show-ref\0--verify\0--quiet\0refs/heads/case/260626-k1506-demo']: { stdout: '', code: 0 },
    });

    const result = normalizeSanitizedCaseBranch(run);

    expect(result.status).toBe('target-exists');
    expect(result.message).toContain('Cannot normalize worktree-case+260626-k1506-demo -> case/260626-k1506-demo');
  });

  it('reports remediation when branch rename fails', () => {
    const run = fakeRun({
      ['rev-parse\0--abbrev-ref\0HEAD']: { stdout: 'worktree-case+260626-k1506-demo', code: 0 },
      ['show-ref\0--verify\0--quiet\0refs/heads/case/260626-k1506-demo']: { stdout: '', code: 1 },
      ['branch\0-m\0case/260626-k1506-demo']: { stdout: '', code: 1 },
    });

    const result = normalizeSanitizedCaseBranch(run);

    expect(result.status).toBe('rename-failed');
    expect(result.message).toContain('Failed to normalize worktree-case+260626-k1506-demo -> case/260626-k1506-demo');
  });

  it('session setup auto-binds after successful normalization', () => {
    let branch = 'worktree-case+260626-k1506-demo';
    const run: GitRun = args => {
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: branch, code: 0 };
      if (args[0] === 'show-ref') return { stdout: '', code: 1 };
      if (args[0] === 'branch') {
        branch = 'case/260626-k1506-demo';
        return { stdout: '', code: 0 };
      }
      if (args.join(' ') === 'config --worktree --get kaizen.issue') return { stdout: '', code: 1 };
      if (args.join(' ') === 'config --get extensions.worktreeConfig') return { stdout: '', code: 1 };
      if (args.join(' ') === 'config extensions.worktreeConfig true') return { stdout: '', code: 0 };
      if (args.join(' ') === 'config --worktree kaizen.issue 1506') return { stdout: '', code: 0 };
      return { stdout: '', code: 1 };
    };

    expect(sessionSetupMessages(run).join('\n')).toContain('Auto-bound this worktree to #1506');
  });

  it('parses worktree porcelain into entries', () => {
    expect(parseWorktreePorcelain(`worktree /repo\nbranch refs/heads/main\n\nworktree /repo/wt\nbranch refs/heads/case/260628-k1-demo\n`)).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/repo/wt', branch: 'case/260628-k1-demo' },
    ]);
  });

  it('finds matching case worktree targets only', () => {
    const output = `worktree /repo\nbranch refs/heads/main\n\nworktree /repo/wt1\nbranch refs/heads/case/260628-k1-demo\n\nworktree /repo/wt2\nbranch refs/heads/worktree-scratch\n`;
    const targets = matchingCaseWorktreeTargets('/repo', 'src/thing.ts', output, path => path === '/repo/wt1/src/thing.ts');
    expect(targets).toEqual(['/repo/wt1/src/thing.ts']);
  });

  it('reports a multiple-worktree hint without guessing', () => {
    const output = `worktree /repo\nbranch refs/heads/main\n\nworktree /repo/wt1\nbranch refs/heads/case/260628-k1-a\n\nworktree /repo/wt2\nbranch refs/heads/case/260628-k2-b\n`;
    const hint = mainCheckoutEditHint('/repo', 'src/thing.ts', {
      gitWorktreeList: () => output,
      pathExists: path => path.endsWith('/src/thing.ts'),
    });

    expect(hint).toContain('Multiple active case worktrees');
  });
});
