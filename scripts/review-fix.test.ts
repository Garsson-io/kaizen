import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseStreamJsonResult,
  applyFixRunningPhase,
  type StreamJsonResult,
  type FixRunningAction,
} from './review-fix.js';

// ── parseStreamJsonResult ────────────────────────────────────────────

describe('parseStreamJsonResult', () => {
  it('returns found=false for empty stdout', () => {
    expect(parseStreamJsonResult('')).toMatchObject({ found: false });
    expect(parseStreamJsonResult('   \n  ')).toMatchObject({ found: false });
  });

  it('finds result line in a multi-line stream-json log', () => {
    // Real stream-json format: result="" (empty), cost at top-level total_cost_usd
    const log = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixing...' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.14 }),
    ].join('\n');

    const r = parseStreamJsonResult(log);
    expect(r.found).toBe(true);
    expect(r.success).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.14);
  });

  it('extracts cost from top-level total_cost_usd field (real stream-json format)', () => {
    // Verified against real claude -p --output-format stream-json --verbose output:
    // total_cost_usd is a top-level field on the result message, NOT nested in usage
    const log = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      total_cost_usd: 0.22,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const r = parseStreamJsonResult(log);
    expect(r.costUsd).toBeCloseTo(0.22);
  });

  it('marks success=false for error_during_generation subtype', () => {
    const log = JSON.stringify({
      type: 'result',
      subtype: 'error_during_generation',
      is_error: true,
      result: '',
      total_cost_usd: 0,
    });
    const r = parseStreamJsonResult(log);
    expect(r.found).toBe(true);
    expect(r.success).toBe(false);
  });

  it('returns found=false when log has no result line (session still running)', () => {
    const log = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the diff...' }] } }),
      JSON.stringify({ type: 'tool_use', id: 'abc', name: 'Read', input: { file_path: '/foo' } }),
    ].join('\n');
    expect(parseStreamJsonResult(log)).toMatchObject({ found: false });
  });

  it('ignores non-result message types', () => {
    const log = [
      JSON.stringify({ type: 'system', content: 'init' }),
      JSON.stringify({ type: 'user', content: [] }),
    ].join('\n');
    expect(parseStreamJsonResult(log)).toMatchObject({ found: false });
  });

  it('handles malformed lines gracefully — skips them, finds result', () => {
    const log = [
      'not json at all',
      '{broken json',
      JSON.stringify({ type: 'result', subtype: 'success', result: '', total_cost_usd: 0.05 }),
    ].join('\n');
    const r = parseStreamJsonResult(log);
    expect(r.found).toBe(true);
    expect(r.success).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.05);
  });

  it('uses the LAST result line when multiple result lines exist', () => {
    const log = [
      JSON.stringify({ type: 'result', subtype: 'success', result: '', total_cost_usd: 0.01 }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '', total_cost_usd: 0.09 }),
    ].join('\n');
    const r = parseStreamJsonResult(log);
    expect(r.found).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.09);
  });
});

// ── applyFixRunningPhase ─────────────────────────────────────────────

function makeState(overrides: Partial<Parameters<typeof applyFixRunningPhase>[0]> = {}) {
  return {
    prUrl: 'https://github.com/test/test/pull/1',
    issueNum: '1',
    repo: 'test/test',
    maxRounds: 3,
    budgetCap: 2.0,
    currentRound: 1,
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    phase: 'fix_running' as const,
    rounds: [],
    activeFix: { pid: 99999, logFile: '/tmp/fix.log', promptFile: '/tmp/fix.prompt.txt' },
    ...overrides,
  };
}

const neverCalled = () => { throw new Error('checkFn should not be called'); };

describe('applyFixRunningPhase', () => {
  it('returns reset when activeFix is missing', () => {
    const state = makeState({ activeFix: undefined });
    const { action, state: next } = applyFixRunningPhase(state, neverCalled);
    expect(action).toBe('reset');
    expect(next.phase).toBe('needs_review');
  });

  it('returns wait when fix session is still running', () => {
    const state = makeState();
    const checkFn = () => ({ done: false, success: false, costUsd: 0, output: '' });
    const { action, state: next } = applyFixRunningPhase(state, checkFn);
    expect(action).toBe('wait');
    expect(next.phase).toBe('fix_running');
    expect(next.currentRound).toBe(1);
  });

  it('returns continue and advances round when fix succeeds', () => {
    const state = makeState();
    const checkFn = () => ({ done: true, success: true, costUsd: 0.18, output: 'done' });
    const { action, state: next } = applyFixRunningPhase(state, checkFn);
    expect(action).toBe('continue');
    expect(next.phase).toBe('needs_review');
    expect(next.currentRound).toBe(2);
    expect(next.activeFix).toBeUndefined();
    expect(next.totalCostUsd).toBeCloseTo(0.18);
    expect(next.rounds).toHaveLength(1);
    expect(next.rounds[0].verdict).toBe('fixed');
    expect(next.rounds[0].fixCost).toBeCloseTo(0.18);
  });

  it('returns continue and advances round when fix fails (retry review)', () => {
    const state = makeState();
    const checkFn = () => ({ done: true, success: false, costUsd: 0.05, output: '' });
    const { action, state: next } = applyFixRunningPhase(state, checkFn);
    expect(action).toBe('continue');
    expect(next.phase).toBe('needs_review');
    expect(next.currentRound).toBe(2);
    expect(next.rounds[0].verdict).toBe('fix_failed');
  });

  it('accumulates cost on top of existing totalCostUsd', () => {
    const state = makeState({ totalCostUsd: 0.50 });
    const checkFn = () => ({ done: true, success: true, costUsd: 0.10, output: '' });
    const { state: next } = applyFixRunningPhase(state, checkFn);
    expect(next.totalCostUsd).toBeCloseTo(0.60);
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    const frozen = Object.freeze(state);
    // Should not throw (returns new state object)
    const checkFn = () => ({ done: true, success: true, costUsd: 0, output: '' });
    expect(() => applyFixRunningPhase(frozen, checkFn)).not.toThrow();
  });
});
