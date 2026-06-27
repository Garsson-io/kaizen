import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { gh, ghExec, ghResult, parseGhCommandArgs } from './gh-exec.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockSpawn = vi.mocked(spawnSync);

beforeEach(() => vi.clearAllMocks());

describe('ghResult — non-throwing shared GitHub CLI helper', () => {
  it('returns normalized status/stdout/stderr on success', () => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: '  hello world  \n',
      stderr: '  note  \n',
      signal: null,
      pid: 0,
      output: [],
    } as any);

    expect(ghResult(['issue', 'view', '1'])).toEqual({
      status: 0,
      stdout: 'hello world',
      stderr: 'note',
    });
  });

  it('preserves non-zero status without throwing', () => {
    mockSpawn.mockReturnValueOnce({
      status: 2,
      stdout: '  partial  \n',
      stderr: '  permission denied  \n',
      signal: null,
      pid: 0,
      output: [],
    } as any);

    expect(ghResult(['issue', 'view', '999'])).toEqual({
      status: 2,
      stdout: 'partial',
      stderr: 'permission denied',
    });
  });

  it('normalizes timeout/null status to status 1', () => {
    mockSpawn.mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      pid: 0,
      output: [],
    } as any);

    expect(ghResult(['issue', 'view', '1'])).toEqual({
      status: 1,
      stdout: '',
      stderr: '',
    });
  });

  it('passes custom timeout to spawnSync', () => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: 'ok',
      stderr: '',
      signal: null,
      pid: 0,
      output: [],
    } as any);

    ghResult(['issue', 'list'], 15_000);
    expect(mockSpawn).toHaveBeenCalledWith(
      'gh',
      ['issue', 'list'],
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('forwards stdin input to spawnSync alongside a positional timeout', () => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: '',
      stderr: '',
      signal: null,
      pid: 0,
      output: [],
    } as any);

    ghResult(['pr', 'comment', '7', '--body-file', '-'], 15_000, 'hello body');
    expect(mockSpawn).toHaveBeenCalledWith(
      'gh',
      ['pr', 'comment', '7', '--body-file', '-'],
      expect.objectContaining({ timeout: 15_000, input: 'hello body' }),
    );
  });

  it('omits the input key entirely when no stdin is provided', () => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: 'ok',
      stderr: '',
      signal: null,
      pid: 0,
      output: [],
    } as any);

    ghResult(['issue', 'list']);
    const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
    expect('input' in opts).toBe(false);
  });
});

describe('gh — shared GitHub CLI helper', () => {
  it('returns trimmed stdout on success', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '  hello world  \n', stderr: '', signal: null, pid: 0, output: [] } as any);
    expect(gh(['issue', 'view', '1'])).toBe('hello world');
  });

  it('passes args as array to spawnSync (no shell injection)', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any);
    gh(['api', '--method', 'PATCH', '/repos/org/repo/issues/comments/123']);
    expect(mockSpawn).toHaveBeenCalledWith('gh', ['api', '--method', 'PATCH', '/repos/org/repo/issues/comments/123'], expect.objectContaining({ timeout: 30_000 }));
  });

  it('throws with stderr on non-zero exit', () => {
    mockSpawn.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'permission denied', signal: null, pid: 0, output: [] } as any);
    expect(() => gh(['issue', 'view', '999'])).toThrow('permission denied');
  });

  it('throws on timeout (null status from killed process)', () => {
    mockSpawn.mockReturnValueOnce({ status: null, stdout: '', stderr: '', signal: 'SIGTERM', pid: 0, output: [] } as any);
    expect(() => gh(['issue', 'view', '1'])).toThrow('failed');
  });

  it('respects custom timeout', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: 'ok', stderr: '', signal: null, pid: 0, output: [] } as any);
    gh(['issue', 'list'], 60_000);
    expect(mockSpawn).toHaveBeenCalledWith('gh', ['issue', 'list'], expect.objectContaining({ timeout: 60_000 }));
  });

  it('returns empty string when stdout is null/undefined', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: null, stderr: '', signal: null, pid: 0, output: [] } as any);
    expect(gh(['issue', 'view', '1'])).toBe('');
  });

  it('forwards stdin input through to spawnSync', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any);
    gh(['pr', 'comment', '7', '--body-file', '-'], 15_000, 'reflection body');
    expect(mockSpawn).toHaveBeenCalledWith(
      'gh',
      ['pr', 'comment', '7', '--body-file', '-'],
      expect.objectContaining({ timeout: 15_000, input: 'reflection body' }),
    );
  });
});

describe('parseGhCommandArgs — shared gh command-string parser', () => {
  it('splits simple commands and quoted strings', () => {
    expect(parseGhCommandArgs('gh issue create --title "My Title"')).toEqual([
      'gh', 'issue', 'create', '--title', 'My Title',
    ]);
  });

  it('handles JSON-style escapes inside double-quoted strings', () => {
    expect(parseGhCommandArgs('gh issue create --body "line1\\nline2"')).toEqual([
      'gh', 'issue', 'create', '--body', 'line1\nline2',
    ]);
    expect(parseGhCommandArgs('gh issue create --body "say \\"hello\\""')).toEqual([
      'gh', 'issue', 'create', '--body', 'say "hello"',
    ]);
  });

  it('keeps backticks and command substitutions literal', () => {
    expect(parseGhCommandArgs('gh issue create --body "see `branch` and $(echo hack)"')).toEqual([
      'gh', 'issue', 'create', '--body', 'see `branch` and $(echo hack)',
    ]);
  });

  it('handles single-quoted strings and repeated spaces', () => {
    expect(parseGhCommandArgs("gh  issue  create --title 'My Title'")).toEqual([
      'gh', 'issue', 'create', '--title', 'My Title',
    ]);
  });
});

describe('ghExec — tolerant shared gh command-string adapter', () => {
  it('returns trimmed stdout on success', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '  ok  \n', stderr: '', signal: null, pid: 0, output: [] } as any);
    expect(ghExec('gh issue list')).toBe('ok');
  });

  it('returns empty string on failure instead of throwing', () => {
    mockSpawn.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'gh error', signal: null, pid: 0, output: [] } as any);
    expect(ghExec('gh issue list')).toBe('');
  });

  it('delegates via argv without shell interpretation', () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } as any);
    ghExec('gh issue create --body "has `backtick` and $(echo hack)"');
    expect(mockSpawn).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--body', 'has `backtick` and $(echo hack)'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
});
