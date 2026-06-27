/**
 * hook-gym-replay.test.ts — Tests for tool-action extraction and hook replay.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractToolActions,
  extractToolActionsFromFile,
  formatFixture,
  type ToolAction,
} from './hook-gym-replay.js';

const LIVE_PROBE_FIXTURE = resolve(__dirname, '../fixtures/live/probe-hooks.jsonl');

// ── extractToolActions ────────────────────────────────────────────

describe('extractToolActions', () => {
  it('extracts tool_use from assistant messages', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hello' } },
          ],
        },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe('Bash');
    expect(actions[0].input).toEqual({ command: 'echo hello' });
    expect(actions[0].index).toBe(0);
  });

  it('correlates tool_result with tool_use by ID', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hello' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'hello\n' },
          ],
        },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(1);
    expect(actions[0].result).toBeDefined();
    expect(actions[0].result!.stdout).toBe('hello\n');
  });

  it('handles multiple tool_use in one message', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'hi' } },
          ],
        },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(2);
    expect(actions[0].tool).toBe('Bash');
    expect(actions[1].tool).toBe('Write');
    expect(actions[0].index).toBe(0);
    expect(actions[1].index).toBe(1);
  });

  it('handles tool_result with array content', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat file' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [{ type: 'text', text: 'file content here' }],
            },
          ],
        },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions[0].result!.stdout).toBe('file content here');
  });

  it('skips non-JSON lines gracefully', () => {
    const lines = [
      'not json',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/x' } },
          ],
        },
      }),
      '  ',
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe('Read');
  });

  it('skips hook events (system type)', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h1' }),
      JSON.stringify({ type: 'system', subtype: 'hook_response', hook_id: 'h1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo ok' } },
          ],
        },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe('Bash');
  });

  it('returns empty array for hook-only fixture (no tool_use)', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h1' }),
      JSON.stringify({ type: 'system', subtype: 'hook_response', hook_id: 'h1', exit_code: 0 }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(0);
  });

  it('handles uncorrelated tool_result (orphan)', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'orphan', content: 'who am i' },
          ],
        },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(0);
  });

  it('preserves action ordering across multiple assistant messages', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'step1' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok1' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/a' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok2' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'step3' } }] },
      }),
    ];

    const actions = extractToolActions(lines);
    expect(actions).toHaveLength(3);
    expect(actions.map(a => a.index)).toEqual([0, 1, 2]);
    expect(actions.map(a => a.tool)).toEqual(['Bash', 'Write', 'Bash']);
    expect(actions[0].result).toBeDefined();
    expect(actions[1].result).toBeDefined();
    expect(actions[2].result).toBeUndefined(); // no result yet
  });
});

// ── extractToolActionsFromFile ────────────────────────────────────

describe('extractToolActionsFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts from stream-json file', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt' }] } }),
    ];
    const path = join(tmpDir, 'stream.jsonl');
    writeFileSync(path, lines.join('\n'));

    const actions = extractToolActionsFromFile(path);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe('Bash');
    expect(actions[0].result!.stdout).toBe('file.txt');
  });

  it('returns empty for JSON array (hook-event fixture)', () => {
    const hookEvents = [
      {
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'h1',
        hook_name: 'PreToolUse:Bash',
        hook_event: 'PreToolUse',
        uuid: 'u1',
        session_id: 's',
      },
      {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'h1',
        hook_name: 'PreToolUse:Bash',
        hook_event: 'PreToolUse',
        exit_code: 0,
        outcome: 'success',
        uuid: 'u2',
        session_id: 's',
      },
    ];
    const path = join(tmpDir, 'hooks.json');
    writeFileSync(path, JSON.stringify(hookEvents));

    const actions = extractToolActionsFromFile(path);
    expect(actions).toHaveLength(0);
  });

  it('extracts actions and tool results from the real captured probe-hooks fixture', () => {
    const actions = extractToolActionsFromFile(LIVE_PROBE_FIXTURE);

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some(
      (action) =>
        action.tool === 'Bash' &&
        String(action.input.command ?? '').includes('git checkout -b'),
    )).toBe(true);
    expect(actions.some(
      (action) =>
        action.tool === 'Write' &&
        String(action.input.file_path ?? '').endsWith('hook-gym-probe.md'),
    )).toBe(true);
    expect(actions.some(
      (action) => action.result?.stdout.includes('Switched to a new branch'),
    )).toBe(true);
  });
});

// ── formatFixture ─────────────────────────────────────────────────

describe('formatFixture', () => {
  it('produces valid JSON with compact format', () => {
    const actions: ToolAction[] = [
      { index: 0, tool: 'Bash', input: { command: 'echo hi' }, result: { stdout: 'hi', stderr: '', exitCode: '0' } },
      { index: 1, tool: 'Write', input: { file_path: '/tmp/a.txt', content: 'hello' } },
    ];

    const output = formatFixture(actions);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].tool).toBe('Bash');
    expect(parsed[0].result).toBeDefined();
    expect(parsed[1].tool).toBe('Write');
    expect(parsed[1].result).toBeUndefined();
  });

  it('truncates large input values', () => {
    const longContent = 'x'.repeat(1000);
    const actions: ToolAction[] = [
      { index: 0, tool: 'Write', input: { file_path: '/tmp/a.txt', content: longContent } },
    ];

    const output = formatFixture(actions);
    const parsed = JSON.parse(output);
    expect((parsed[0].input.content as string).length).toBeLessThan(600);
    expect((parsed[0].input.content as string)).toContain('...[truncated]');
  });
});
