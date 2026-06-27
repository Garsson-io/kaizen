import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postInFlightUpdate,
  buildInFlightComment,
  relativizeWorktreePath,
  prettifyPath,
  stripCdPrefix,
  formatToolUse,
  type StreamContext,
} from './auto-dent-stream.js';
import * as github from './auto-dent-github.js';
import { makeRunResult } from './auto-dent-test-helpers.js';

describe('postInFlightUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when progressIssue is empty', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    expect(postInFlightUpdate('', 'owner/repo', 1, Date.now(), result, ctx)).toBe(false);
  });

  it('returns false when kaizenRepo is empty', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    expect(
      postInFlightUpdate('https://github.com/o/r/issues/42', '', 1, Date.now(), result, ctx),
    ).toBe(false);
  });

  it('returns false when progressIssue has no issue number', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    expect(postInFlightUpdate('not-a-url', 'owner/repo', 1, Date.now(), result, ctx)).toBe(false);
  });

  it('posts a comment and returns true on success', () => {
    const ghExecSpy = vi.spyOn(github, 'ghExec').mockReturnValue('ok');
    const result = makeRunResult({ toolCalls: 5, cost: 1.23 });
    const ctx: StreamContext = {};

    const posted = postInFlightUpdate(
      'https://github.com/o/r/issues/42',
      'owner/repo',
      3,
      Date.now() - 60_000,
      result,
      ctx,
    );

    expect(posted).toBe(true);
    expect(ghExecSpy).toHaveBeenCalledOnce();
    const cmd = ghExecSpy.mock.calls[0][0];
    expect(cmd).toContain('gh issue comment 42');
    expect(cmd).toContain('--repo owner/repo');
  });

  it('returns false when ghExec returns empty string', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue('');
    const result = makeRunResult();
    const ctx: StreamContext = {};

    const posted = postInFlightUpdate(
      'https://github.com/o/r/issues/42',
      'owner/repo',
      1,
      Date.now(),
      result,
      ctx,
    );

    expect(posted).toBe(false);
  });
});

describe('buildInFlightComment', () => {
  it('shows working status when no resultReceivedAt', () => {
    const result = makeRunResult({ toolCalls: 10, cost: 2.5 });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(2, Date.now() - 120_000, result, ctx);

    expect(comment).toContain('Run #2');
    expect(comment).toContain('working');
    expect(comment).toContain('10');
    expect(comment).toContain('$2.50');
  });

  it('shows waiting status when resultReceivedAt is set', () => {
    const result = makeRunResult({ toolCalls: 5, cost: 1.0 });
    const ctx: StreamContext = { resultReceivedAt: Date.now() - 5_000 };
    const comment = buildInFlightComment(1, Date.now() - 60_000, result, ctx);

    expect(comment).toContain('waiting for process exit');
  });

  it('includes last activity and phase when present', () => {
    const result = makeRunResult();
    const ctx: StreamContext = { lastActivity: 'Read foo.ts', lastPhase: 'IMPLEMENT' };
    const comment = buildInFlightComment(1, Date.now(), result, ctx);

    expect(comment).toContain('Read foo.ts');
    expect(comment).toContain('IMPLEMENT');
  });

  it('includes PRs when present', () => {
    const result = makeRunResult({ prs: ['https://github.com/o/r/pull/1'] });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(1, Date.now(), result, ctx);

    expect(comment).toContain('https://github.com/o/r/pull/1');
  });
});

// #1157 — semantic line budget for the live terminal stream.
const WT = '/home/aviad/projects/kaizen/.claude/worktrees/2606271151-c55d';

describe('relativizeWorktreePath', () => {
  it('collapses a worktree-absolute path to its repo-relative remainder', () => {
    expect(relativizeWorktreePath(`${WT}/scripts/foo.ts`)).toBe('scripts/foo.ts');
  });

  it('collapses a bare worktree root to "."', () => {
    expect(relativizeWorktreePath(WT)).toBe('.');
  });

  it('leaves non-worktree paths unchanged', () => {
    expect(relativizeWorktreePath('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(relativizeWorktreePath('src/cli.ts')).toBe('src/cli.ts');
  });

  it('relativizes a worktree path embedded inside a larger command string', () => {
    expect(relativizeWorktreePath(`sed -n 1,5p ${WT}/docs/x.md`)).toBe('sed -n 1,5p docs/x.md');
  });

  it('is a no-op on empty input', () => {
    expect(relativizeWorktreePath('')).toBe('');
  });
});

describe('prettifyPath', () => {
  it('collapses /home/<user>/ to ~/ for non-worktree absolute paths', () => {
    expect(prettifyPath('/home/aviad/projects/kaizen/src/cli.ts')).toBe(
      '~/projects/kaizen/src/cli.ts',
    );
  });

  it('prefers worktree-relative over home-collapse for worktree paths', () => {
    expect(prettifyPath(`${WT}/scripts/foo.ts`)).toBe('scripts/foo.ts');
  });
});

describe('stripCdPrefix', () => {
  it('removes a leading "cd <path>;" prefix', () => {
    expect(stripCdPrefix(`cd ${WT}; sed -n 1,5p file.ts`)).toBe('sed -n 1,5p file.ts');
  });

  it('removes a leading "cd <path> &&" prefix', () => {
    expect(stripCdPrefix(`cd ${WT} && npm test`)).toBe('npm test');
  });

  it('leaves commands without a cd prefix untouched', () => {
    expect(stripCdPrefix('npm run build')).toBe('npm run build');
    expect(stripCdPrefix('grep -n cd file.ts')).toBe('grep -n cd file.ts');
  });
});

describe('formatToolUse (#1157 semantic budget)', () => {
  it('Bash: renders the meaningful tail, not the worktree cd prefix', () => {
    const out = formatToolUse('Bash', {
      command: `cd ${WT}; sed -n 1,40p ${WT}/scripts/auto-dent-stream.ts`,
    });
    expect(out).toBe('$ sed -n 1,40p scripts/auto-dent-stream.ts');
    expect(out).not.toContain('worktrees');
    expect(out).not.toContain('cd ');
  });

  it('Read/Edit/Write: render worktree-absolute paths repo-relative', () => {
    expect(formatToolUse('Read', { file_path: `${WT}/scripts/foo.ts` })).toBe(
      'Read scripts/foo.ts',
    );
    expect(formatToolUse('Edit', { file_path: `${WT}/src/cli.ts` })).toBe('Edit src/cli.ts');
    expect(formatToolUse('Write', { file_path: `${WT}/docs/x.md` })).toBe('Write docs/x.md');
  });

  it('Grep: relativizes the search path', () => {
    expect(formatToolUse('Grep', { pattern: 'foo', path: `${WT}/scripts` })).toBe(
      'Grep "foo" scripts',
    );
  });

  it('preserves existing rendering for non-path tools', () => {
    expect(formatToolUse('Skill', { skill_name: 'kaizen-reflect' })).toBe('Skill /kaizen-reflect');
    expect(formatToolUse('Agent', { description: 'do a thing' })).toBe('Agent: do a thing');
    expect(formatToolUse('ExitWorktree', {})).toBe('ExitWorktree');
  });

  it('Bash falls back to description when no command, with prefix handling', () => {
    expect(formatToolUse('Bash', { description: 'run tests' })).toBe('$ run tests');
  });
});
