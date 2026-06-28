import { describe, expect, it, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeHookOutput, getCurrentBranch, readHookInput, traceHookEvent, traceNullInput } from './hook-io.js';
import type { GitExec } from './lib/git-state.js';

const HOOK_IO_SOURCE = readFileSync(new URL('./hook-io.ts', import.meta.url), 'utf-8');

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
      // Set the trace file path only — isTraceEnabled() checks KAIZEN_HOOK_TRACE !== '0',
      // so any non-'0' value (including the path) enables tracing.
      process.env.KAIZEN_HOOK_TRACE = traceFile;

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
        expect(parseFailEntry.raw_preview).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        if (origTrace !== undefined) process.env.KAIZEN_HOOK_TRACE = origTrace;
        else delete process.env.KAIZEN_HOOK_TRACE;
        rmSync(traceFile, { force: true });
        rmSync(join(traceFile, '..'), { recursive: true, force: true });
      }
    });

    it('INVARIANT: KAIZEN_HOOK_TRACE=0 disables trace (no file written on parse failure)', async () => {
      // isTraceEnabled() returns false when KAIZEN_HOOK_TRACE === '0'
      // Redirect to a temp path so we can assert the file was NOT created.
      const traceDir = mkdtempSync(join(tmpdir(), 'hook-io-suppress-'));
      const traceFile = join(traceDir, 'trace.jsonl');
      const origTrace = process.env.KAIZEN_HOOK_TRACE;
      process.env.KAIZEN_HOOK_TRACE = '0';

      const originalStdin = process.stdin;
      const readable = Readable.from([Buffer.from('invalid json{{{')]);
      Object.defineProperty(process, 'stdin', { value: readable, configurable: true });

      try {
        const result = await readHookInput();
        expect(result).toBeNull();
        // MUST NOT have written any trace file
        expect(existsSync(traceFile)).toBe(false);
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        if (origTrace !== undefined) process.env.KAIZEN_HOOK_TRACE = origTrace;
        else delete process.env.KAIZEN_HOOK_TRACE;
        rmSync(traceDir, { recursive: true, force: true });
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
    const okBranch = (name: string): GitExec => () => ({ stdout: name + '\n', stderr: '', exitCode: 0 });

    it('returns trimmed branch name on success', () => {
      expect(getCurrentBranch('', { exec: okBranch('feat-branch'), cwd: '/repo' })).toBe('feat-branch');
    });

    it('returns empty string on git failure (nonzero exit)', () => {
      const fail: GitExec = () => ({ stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 });
      expect(getCurrentBranch('', { exec: fail, cwd: '/repo' })).toBe('');
    });

    it('returns empty string when the runner throws', () => {
      const thrower: GitExec = () => { throw new Error('boom'); };
      expect(getCurrentBranch('', { exec: thrower, cwd: '/repo' })).toBe('');
    });

    // #1073/#240 REGRESSION: read the branch from the gated command's target
    // worktree (`cd <wt> && ...`), not the agent's inherited process.cwd().
    it('anchors rev-parse to the cd-target worktree, not cwd', () => {
      const calls: string[][] = [];
      const exec: GitExec = (args) => {
        calls.push([...args]);
        return { stdout: 'wt-branch\n', stderr: '', exitCode: 0 };
      };
      const branch = getCurrentBranch('cd /work/wt && git status', { exec, cwd: '/main/checkout' });
      expect(branch).toBe('wt-branch');
      expect(calls[0].slice(0, 2)).toEqual(['-C', '/work/wt']);
      expect(calls[0]).not.toContain('/main/checkout');
    });

    it('falls back to the cwd anchor when the command names no target', () => {
      const calls: string[][] = [];
      const exec: GitExec = (args) => {
        calls.push([...args]);
        return { stdout: 'main\n', stderr: '', exitCode: 0 };
      };
      getCurrentBranch('', { exec, cwd: '/repo' });
      expect(calls[0].slice(0, 2)).toEqual(['-C', '/repo']);
    });
  });

  describe('traceNullInput', () => {
    it('INVARIANT: writes null_input trace entry with hook name', () => {
      // INVARIANT: when a hook receives null input (empty stdin), it calls
      // traceNullInput() which MUST write a trace entry so null-input events
      // are visible in observability tooling.
      const traceDir = mkdtempSync(join(tmpdir(), 'hook-io-nulltrace-'));
      const traceFile = join(traceDir, 'trace.jsonl');
      const origTrace = process.env.KAIZEN_HOOK_TRACE;
      process.env.KAIZEN_HOOK_TRACE = traceFile;

      try {
        traceNullInput('test-hook');
        expect(existsSync(traceFile)).toBe(true);
        const entries = readFileSync(traceFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(entries.length).toBe(1);
        expect(entries[0].hook).toBe('test-hook');
        expect(entries[0].action).toBe('ignore');
        expect(entries[0].reason).toBe('null_input');
        expect(entries[0].ts).toBeDefined();
      } finally {
        if (origTrace !== undefined) process.env.KAIZEN_HOOK_TRACE = origTrace;
        else delete process.env.KAIZEN_HOOK_TRACE;
        rmSync(traceDir, { recursive: true, force: true });
      }
    });

    it('INVARIANT: KAIZEN_HOOK_TRACE=0 suppresses null_input trace (no file written)', () => {
      // Redirect to a temp path so we can assert no write occurred.
      const traceDir = mkdtempSync(join(tmpdir(), 'hook-io-nullsuppress-'));
      const traceFile = join(traceDir, 'trace.jsonl');
      const origTrace = process.env.KAIZEN_HOOK_TRACE;
      process.env.KAIZEN_HOOK_TRACE = '0';
      try {
        traceNullInput('any-hook');
        // MUST NOT have written any trace file
        expect(existsSync(traceFile)).toBe(false);
      } finally {
        if (origTrace !== undefined) process.env.KAIZEN_HOOK_TRACE = origTrace;
        else delete process.env.KAIZEN_HOOK_TRACE;
        rmSync(traceDir, { recursive: true, force: true });
      }
    });
  });

  describe('traceHookEvent source invariant', () => {
    it('INVARIANT: exposes shared trace writer with explicit trace-file override support', () => {
      expect(HOOK_IO_SOURCE).toContain('traceHookEvent');
      expect(HOOK_IO_SOURCE).toContain('traceFile?: string');
      expect(HOOK_IO_SOURCE).toContain('options.traceFile');
    });

    it('INVARIANT: routes hook trace JSONL appends through appendJsonLine', () => {
      expect(HOOK_IO_SOURCE).toContain('appendJsonLine');
      expect(HOOK_IO_SOURCE).toContain("from '../lib/json-lines.js'");
      expect(HOOK_IO_SOURCE).not.toContain('appendFileSync');
      expect(HOOK_IO_SOURCE).not.toContain("JSON.stringify({ ts: new Date().toISOString(), hook, ...fields }) + '\\n'");
    });

    it('INVARIANT: writes to explicit trace file override', () => {
      const traceDir = mkdtempSync(join(tmpdir(), 'hook-io-override-'));
      const traceFile = join(traceDir, 'trace.jsonl');
      const origTrace = process.env.KAIZEN_HOOK_TRACE;
      delete process.env.KAIZEN_HOOK_TRACE;

      try {
        traceHookEvent('test-hook', { action: 'observe', reason: 'override_path' }, { traceFile });
        expect(existsSync(traceFile)).toBe(true);
        const entry = JSON.parse(readFileSync(traceFile, 'utf8').trim());
        expect(entry.hook).toBe('test-hook');
        expect(entry.action).toBe('observe');
        expect(entry.reason).toBe('override_path');
        expect(entry.ts).toBeDefined();
      } finally {
        if (origTrace !== undefined) process.env.KAIZEN_HOOK_TRACE = origTrace;
        else delete process.env.KAIZEN_HOOK_TRACE;
        rmSync(traceDir, { recursive: true, force: true });
      }
    });

    it('INVARIANT: trace write errors remain best-effort', () => {
      expect(() => {
        traceHookEvent('test-hook', { action: 'observe' }, { traceFile: '/dev/null/impossible/trace.jsonl' });
      }).not.toThrow();
    });
  });
});
