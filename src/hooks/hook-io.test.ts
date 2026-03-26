import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

    it('INVARIANT: writes json_parse_failed trace entry on invalid JSON', async () => {
      // When JSON.parse fails, readHookInput() MUST write a trace entry
      // so the failure is visible in the hook trace log. Silent swallow = invisible
      // failure (incident: PR #965 merged without review gate due to this gap).
      const traceFile = join(mkdtempSync(join(tmpdir(), 'hook-io-trace-')), 'trace.jsonl');
      const origTrace = process.env.KAIZEN_HOOK_TRACE;
      const origEnabled = process.env.KAIZEN_HOOK_TRACE_ENABLED;
      process.env.KAIZEN_HOOK_TRACE = traceFile;
      process.env.KAIZEN_HOOK_TRACE_ENABLED = '1';

      const originalStdin = process.stdin;
      const badJson = '{"tool_name":"Bash","body":"```code\nwith backticks and $vars\n```"}INVALID';
      const readable = Readable.from([Buffer.from(badJson)]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result).toBeNull();
        // MUST have written a trace entry
        expect(existsSync(traceFile)).toBe(true);
        const entries = readFileSync(traceFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const parseFailEntry = entries.find(e => e.error === 'json_parse_failed');
        expect(parseFailEntry).toBeDefined();
        expect(parseFailEntry.raw_length).toBeGreaterThan(0);
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        if (origTrace !== undefined) process.env.KAIZEN_HOOK_TRACE = origTrace;
        else delete process.env.KAIZEN_HOOK_TRACE;
        if (origEnabled !== undefined) process.env.KAIZEN_HOOK_TRACE_ENABLED = origEnabled;
        else delete process.env.KAIZEN_HOOK_TRACE_ENABLED;
        rmSync(traceFile, { force: true });
        rmSync(join(traceFile, '..'), { recursive: true, force: true });
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
