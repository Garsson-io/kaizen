import { describe, expect, it, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { writeHookOutput, getCurrentBranch, readHookInput } from './hook-io.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Access the mocked execSync
import { execSync } from 'node:child_process';
const mockedExecSync = vi.mocked(execSync);

describe('hook-io', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readHookInput', () => {
    it('parses valid JSON from stdin', async () => {
      const input = JSON.stringify({
        session_id: 'test-123',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      });

      const originalStdin = process.stdin;
      const readable = Readable.from([Buffer.from(input)]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result).toEqual({
          session_id: 'test-123',
          tool_name: 'Bash',
          tool_input: { command: 'echo hello' },
        });
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });

    it('returns null on empty stdin', async () => {
      const originalStdin = process.stdin;
      const readable = Readable.from([Buffer.from('')]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result).toBeNull();
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });

    it('returns null on invalid JSON', async () => {
      const originalStdin = process.stdin;
      const readable = Readable.from([Buffer.from('not-json{{{')]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result).toBeNull();
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });

    it('handles multi-chunk stdin', async () => {
      const originalStdin = process.stdin;
      const chunk1 = Buffer.from('{"session_id":');
      const chunk2 = Buffer.from('"abc"}');
      const readable = Readable.from([chunk1, chunk2]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result).toEqual({ session_id: 'abc' });
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });

    it('parses tool_response with exit_code', async () => {
      const originalStdin = process.stdin;
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_response: { stdout: 'ok', stderr: '', exit_code: 0 },
      });
      const readable = Readable.from([Buffer.from(input)]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result?.tool_response?.exit_code).toBe(0);
        expect(result?.tool_response?.stdout).toBe('ok');
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }
    });
  });

  describe('writeHookOutput', () => {
    it('writes text to stdout', () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      writeHookOutput('advisory text');
      expect(writeSpy).toHaveBeenCalledWith('advisory text');
    });
  });

  describe('getCurrentBranch', () => {
    it('returns trimmed branch name on success', () => {
      mockedExecSync.mockReturnValue('feat-branch\n');
      expect(getCurrentBranch()).toBe('feat-branch');
    });

    it('returns empty string on git failure', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not a git repo');
      });
      expect(getCurrentBranch()).toBe('');
    });
  });
});
