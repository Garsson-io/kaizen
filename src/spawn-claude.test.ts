import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { buildSpawnClaudeArgs, spawnClaude } from './spawn-claude.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function streamJsonPayload(text: string, costUsd: number): string {
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const result = JSON.stringify({ type: 'result', total_cost_usd: costUsd });
  return `${assistant}\n${result}\n`;
}

function mockClaude(stdout: string, stderr = '', exitCode = 0): void {
  vi.mocked(spawn).mockImplementation(() => {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', exitCode);
    });
    return proc;
  });
}

describe('buildSpawnClaudeArgs', () => {
  it('adds bounded live skill-test options without changing the stream-json contract', () => {
    expect(buildSpawnClaudeArgs({
      model: 'haiku',
      maxTurns: 8,
      maxBudgetUsd: 0.75,
      pluginDir: '/repo/kaizen',
    })).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', 'haiku',
      '--max-turns', '8',
      '--max-budget-usd', '0.75',
      '--plugin-dir', '/repo/kaizen',
    ]);
  });

  it('omits --plugin-dir only when callers explicitly request installed-plugin behavior', () => {
    expect(buildSpawnClaudeArgs({ model: 'haiku', pluginDir: null })).not.toContain('--plugin-dir');
  });

  it('supports JSON-mode prompt argv for live skill-chain tests', () => {
    expect(buildSpawnClaudeArgs({
      outputFormat: 'json',
      verbose: false,
      model: 'haiku',
      maxTurns: 3,
      maxBudgetUsd: 0.1,
      pluginDir: '/repo/kaizen',
      promptArg: 'Run /kaizen-zen',
    })).toEqual([
      '-p',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', 'haiku',
      '--max-turns', '3',
      '--max-budget-usd', '0.1',
      '--plugin-dir', '/repo/kaizen',
      'Run /kaizen-zen',
    ]);
  });
});

describe('spawnClaude live-skill metadata', () => {
  afterEach(() => {
    vi.mocked(spawn).mockRestore();
  });

  it('returns raw output and constructed args for checkpointing', async () => {
    const raw = streamJsonPayload('The Zen of Kaizen', 0.03);
    mockClaude(raw, 'diagnostic stderr');

    const result = await spawnClaude('Run /kaizen-zen', {
      cwd: '/repo/kaizen',
      model: 'haiku',
      pluginDir: '/repo/kaizen',
      maxTurns: 2,
      maxBudgetUsd: 0.05,
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });

    expect(result.text).toBe('The Zen of Kaizen');
    expect(result.costUsd).toBe(0.03);
    expect(result.rawStdout).toBe(raw);
    expect(result.rawStderr).toBe('diagnostic stderr');
    expect(result.args).toContain('--plugin-dir');
    expect(result.args).toContain('/repo/kaizen');
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'claude',
      result.args,
      expect.objectContaining({
        cwd: '/repo/kaizen',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ CLAUDE_CODE_ENTRYPOINT: 'cli' }),
      }),
    );
  });
});
