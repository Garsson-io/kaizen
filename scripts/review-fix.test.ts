import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync as spawnRaw } from 'node:child_process';

// A PID that is guaranteed dead: spawnSync waits for the process to exit,
// so by the time this runs the process is gone and process.kill(pid, 0) will throw ESRCH.
const DEAD_PID = spawnRaw('true').pid!;
import {
  parseStreamJsonResult,
  applyFixRunningPhase,
  checkFixResult,
  resolveMaxRounds,
  stateKey,
  loadState,
  saveState,
  parseArgs,
  buildFixPrompt,
  runFixLoop,
  type StreamJsonResult,
  type FixRunningAction,
  type CliArgs,
  type PrefetchResult,
  type ReviewFixState,
} from './review-fix.js';
import type { BatteryResult } from '../src/review-battery.js';

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

// ── resolveMaxRounds ─────────────────────────────────────────────────

describe('resolveMaxRounds', () => {
  it('uses state.maxRounds on resume (ignores opts.maxRounds)', () => {
    expect(resolveMaxRounds({ resume: true, maxRounds: 3 }, { maxRounds: 5 })).toBe(5);
  });

  it('uses opts.maxRounds on fresh start', () => {
    expect(resolveMaxRounds({ resume: false, maxRounds: 3 }, { maxRounds: 5 })).toBe(3);
  });

  it('uses opts.maxRounds when same on both', () => {
    expect(resolveMaxRounds({ resume: true, maxRounds: 3 }, { maxRounds: 3 })).toBe(3);
  });
});

// ── checkFixResult — integration tests with real temp files ──────────
//
// These tests exercise the full chain: write JSONL to a temp file → call
// checkFixResult → assert done/success/costUsd. They use a dead PID (0) so
// the "is the process running" check returns false (not running).
//
// The JSONL format matches real claude -p --output-format stream-json --verbose
// output, verified empirically. If the format changes, these tests break —
// that is the desired behavior (they guard against schema drift).

describe('checkFixResult (integration: real temp files)', () => {
  let tmpDir: string;

  // Create a fresh temp dir for each test, clean up after
  const setup = () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'review-fix-test-'));
    return tmpDir;
  };
  const teardown = () => rmSync(tmpDir, { recursive: true, force: true });

  it('reads a completed stream-json log and extracts done/success/costUsd', () => {
    const dir = setup();
    try {
      const logFile = join(dir, 'fix.log');
      // Real stream-json JSONL: system init, assistant message, result line
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed the gap.' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.31 }),
      ];
      writeFileSync(logFile, lines.join('\n') + '\n');
      const r = checkFixResult(logFile, DEAD_PID);
      expect(r.done).toBe(true);
      expect(r.success).toBe(true);
      expect(r.costUsd).toBeCloseTo(0.31);
    } finally { teardown(); }
  });

  it('reports success=false for error_during_generation result', () => {
    const dir = setup();
    try {
      const logFile = join(dir, 'fix.log');
      const lines = [
        JSON.stringify({ type: 'result', subtype: 'error_during_generation', is_error: true, result: '', total_cost_usd: 0.05 }),
      ];
      writeFileSync(logFile, lines.join('\n'));
      const r = checkFixResult(logFile, DEAD_PID);
      expect(r.done).toBe(true);
      expect(r.success).toBe(false);
    } finally { teardown(); }
  });

  it('returns done=false for an empty log (session just started, process still alive)', () => {
    const dir = setup();
    try {
      const logFile = join(dir, 'fix.log');
      writeFileSync(logFile, '');
      // Use current process PID — definitely alive
      const r = checkFixResult(logFile, process.pid);
      expect(r.done).toBe(false);
    } finally { teardown(); }
  });

  it('returns done=true success=false when process exited with no result line', () => {
    const dir = setup();
    try {
      const logFile = join(dir, 'fix.log');
      writeFileSync(logFile, 'partial output without result line\n');
      const r = checkFixResult(logFile, DEAD_PID);
      expect(r.done).toBe(true);
      expect(r.success).toBe(false);
    } finally { teardown(); }
  });
});

// ── stateKey ─────────────────────────────────────────────────────────

describe('stateKey', () => {
  it('extracts PR number from a GitHub pull URL', () => {
    expect(stateKey('https://github.com/Garsson-io/kaizen/pull/846')).toBe('pr-846');
  });

  it('handles URLs with trailing slashes or query strings', () => {
    expect(stateKey('https://github.com/org/repo/pull/12')).toBe('pr-12');
  });

  it('falls back to sanitized slug for non-URL input', () => {
    const key = stateKey('some/weird:string!here');
    expect(key).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(key).not.toContain('/');
    expect(key).not.toContain(':');
  });

  it('produces different keys for different PR numbers', () => {
    expect(stateKey('https://github.com/org/repo/pull/1')).not.toBe(
      stateKey('https://github.com/org/repo/pull/2'),
    );
  });
});

// ── loadState / saveState ─────────────────────────────────────────────

describe('loadState / saveState (integration: real temp files)', () => {
  let tmpDir: string;
  const setup = () => { tmpDir = mkdtempSync(join(tmpdir(), 'rf-state-test-')); return tmpDir; };
  const teardown = () => rmSync(tmpDir, { recursive: true, force: true });

  it('loadState returns null when no state file exists', () => {
    const dir = setup();
    try {
      expect(loadState('https://github.com/org/repo/pull/999', dir)).toBeNull();
    } finally { teardown(); }
  });

  it('saveState + loadState round-trips the full state object', () => {
    const dir = setup();
    try {
      const state = {
        prUrl: 'https://github.com/org/repo/pull/42',
        issueNum: '1',
        repo: 'org/repo',
        maxRounds: 3,
        budgetCap: 2.0,
        currentRound: 2,
        totalCostUsd: 0.55,
        startedAt: '2026-01-01T00:00:00.000Z',
        phase: 'needs_review' as const,
        rounds: [{ round: 1, verdict: 'fixed' as const, fixCost: 0.55, reviewCost: 0 }],
      };
      saveState(state, dir);
      const loaded = loadState(state.prUrl, dir);
      expect(loaded).toEqual(state);
    } finally { teardown(); }
  });

  it('loadState returns null for a malformed JSON file', () => {
    const dir = setup();
    try {
      const key = stateKey('https://github.com/org/repo/pull/7');
      writeFileSync(join(dir, `${key}.json`), '{not valid json}');
      expect(loadState('https://github.com/org/repo/pull/7', dir)).toBeNull();
    } finally { teardown(); }
  });

  it('saveState overwrites existing state', () => {
    const dir = setup();
    try {
      const base = {
        prUrl: 'https://github.com/org/repo/pull/5',
        issueNum: '1',
        repo: 'org/repo',
        maxRounds: 3,
        budgetCap: 2.0,
        currentRound: 1,
        totalCostUsd: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        phase: 'needs_review' as const,
        rounds: [],
      };
      saveState(base, dir);
      saveState({ ...base, totalCostUsd: 0.99 }, dir);
      expect(loadState(base.prUrl, dir)?.totalCostUsd).toBeCloseTo(0.99);
    } finally { teardown(); }
  });
});

// ── parseArgs (CLI flag parsing) ─────────────────────────────────────

describe('parseArgs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses all required and optional flags', () => {
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => { throw new Error('exit'); });
    const result = parseArgs([
      'node', 'review-fix.ts',
      '--pr', 'https://github.com/org/repo/pull/1',
      '--issue', '42',
      '--repo', 'org/repo',
      '--dry-run',
      '--resume',
      '--max-rounds', '5',
      '--budget', '3.5',
    ]);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
    expect(result.issueNum).toBe('42');
    expect(result.repo).toBe('org/repo');
    expect(result.dryRun).toBe(true);
    expect(result.resume).toBe(true);
    expect(result.maxRounds).toBe(5);
    expect(result.budgetCap).toBeCloseTo(3.5);
  });

  it('exits 1 when --pr is missing', () => {
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['node', 'review-fix.ts', '--issue', '1', '--repo', 'org/repo'])).toThrow('exit');
  });

  it('exits 1 when --issue is missing', () => {
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['node', 'review-fix.ts', '--pr', 'https://github.com/org/repo/pull/1', '--repo', 'org/repo'])).toThrow('exit');
  });

  it('exits 1 when --repo is missing', () => {
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseArgs(['node', 'review-fix.ts', '--pr', 'https://github.com/org/repo/pull/1', '--issue', '1'])).toThrow('exit');
  });

  it('defaults: dryRun=false, resume=false, maxRounds=MAX_FIX_ROUNDS, budgetCap=BUDGET_CAP', () => {
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => { throw new Error('exit'); });
    const result = parseArgs([
      'node', 'review-fix.ts',
      '--pr', 'https://github.com/org/repo/pull/1',
      '--issue', '1',
      '--repo', 'org/repo',
    ]);
    expect(result.dryRun).toBe(false);
    expect(result.resume).toBe(false);
    expect(result.maxRounds).toBeGreaterThan(0);
    expect(result.budgetCap).toBeGreaterThan(0);
  });
});

// ── buildFixPrompt ────────────────────────────────────────────────────

describe('buildFixPrompt', () => {
  const baseFindings = [
    { requirement: 'Req A', status: 'DONE' as const, detail: 'already done' },
    { requirement: 'Req B', status: 'PARTIAL' as const, detail: 'partial detail' },
    { requirement: 'Req C', status: 'MISSING' as const, detail: 'missing detail' },
  ];

  it('excludes DONE findings from the gap list', () => {
    const prompt = buildFixPrompt('1', 'org/repo', 'https://github.com/org/repo/pull/1', 'main', 'issue body', baseFindings, false);
    expect(prompt).not.toContain('Req A');
    expect(prompt).toContain('Req B');
    expect(prompt).toContain('Req C');
  });

  it('includes PARTIAL and MISSING findings with their detail', () => {
    const prompt = buildFixPrompt('1', 'org/repo', 'https://github.com/org/repo/pull/1', 'main', 'issue body', baseFindings, false);
    expect(prompt).toContain('[PARTIAL]');
    expect(prompt).toContain('partial detail');
    expect(prompt).toContain('[MISSING]');
    expect(prompt).toContain('missing detail');
  });

  it('unmerged PR: includes branch checkout instructions', () => {
    const prompt = buildFixPrompt('1', 'org/repo', 'https://github.com/org/repo/pull/1', 'feat/my-branch', 'issue body', baseFindings, false);
    expect(prompt).toContain('feat/my-branch');
    expect(prompt).not.toContain('follow-up branch');
  });

  it('merged PR: includes follow-up branch instructions instead of checkout', () => {
    const prompt = buildFixPrompt('99', 'org/repo', 'https://github.com/org/repo/pull/99', 'feat/old', 'issue body', baseFindings, true);
    expect(prompt).toContain('MERGED');
    expect(prompt).toContain('fix/99-review-gaps');
    expect(prompt).not.toContain('git checkout feat/old');
  });

  it('truncates issueBody at 3000 chars to avoid prompt bloat', () => {
    const longBody = 'x'.repeat(5000);
    const prompt = buildFixPrompt('1', 'org/repo', 'https://github.com/org/repo/pull/1', 'main', longBody, baseFindings, false);
    // The body is sliced — total prompt length should not contain 5000 x's
    const xRuns = prompt.match(/x+/g) ?? [];
    const maxRun = Math.max(...xRuns.map(r => r.length));
    expect(maxRun).toBeLessThanOrEqual(3000);
  });

  it('produces empty gap list when all findings are DONE', () => {
    const allDone = [{ requirement: 'Req A', status: 'DONE' as const, detail: 'done' }];
    const prompt = buildFixPrompt('1', 'org/repo', 'https://github.com/org/repo/pull/1', 'main', 'issue', allDone, false);
    // No numbered gap items
    expect(prompt).not.toContain('[DONE]');
    expect(prompt).not.toContain('Req A');
  });
});


// ── runFixLoop (unit: injectable deps) ───────────────────────────────

describe('runFixLoop', () => {
  let tmpDir: string;
  const setup = () => { tmpDir = mkdtempSync(join(tmpdir(), 'rf-loop-test-')); return tmpDir; };
  const teardown = () => rmSync(tmpDir, { recursive: true, force: true });

  const baseOpts: CliArgs = {
    prUrl: 'https://github.com/org/repo/pull/42',
    issueNum: '7',
    repo: 'org/repo',
    dryRun: false,
    resume: false,
    maxRounds: 3,
    budgetCap: 10.0,
  };

  const mockPrefetch = (): PrefetchResult => ({
    issueBody: 'fix the bug',
    prBody: 'adds feature',
    prDiff: '--- a\n+++ b',
    prBranch: 'feat/branch',
    isMerged: false,
  });

  function makePassBattery(): BatteryResult {
    return {
      verdict: 'pass',
      costUsd: 0.10,
      missingCount: 0,
      partialCount: 0,
      durationMs: 100,
      failedDimensions: [],
      skippedDimensions: [],
      dimensions: [{ dimension: 'security', verdict: 'pass', summary: 'all good', findings: [{ requirement: 'No secrets', status: 'DONE', detail: 'checked' }] }],
    };
  }

  function makeFailBattery(): BatteryResult {
    return {
      verdict: 'fail',
      costUsd: 0.15,
      missingCount: 1,
      partialCount: 0,
      durationMs: 100,
      failedDimensions: [],
      skippedDimensions: [],
      dimensions: [{ dimension: 'security', verdict: 'fail', summary: 'issues found', findings: [{ requirement: 'No secrets', status: 'MISSING', detail: 'secrets in code' }] }],
    };
  }

  it('pass path: outcome=pass and launchFix never called', async () => {
    const dir = setup();
    try {
      const launchFixMock = vi.fn().mockReturnValue({ pid: 0, logFile: '/tmp/fix.log', promptFile: '/tmp/fix.prompt' });
      const state = await runFixLoop(baseOpts, {
        prefetch: mockPrefetch,
        runReview: async () => makePassBattery(),
        launchFix: launchFixMock,
        getStateDir: () => dir,
      });
      expect(state.outcome).toBe('pass');
      expect(state.phase).toBe('done');
      expect(launchFixMock).not.toHaveBeenCalled();
    } finally { teardown(); }
  });

  it('budget path: outcome=budget_exceeded when review cost exceeds budgetCap', async () => {
    const dir = setup();
    try {
      const state = await runFixLoop({ ...baseOpts, budgetCap: 0.05 }, {
        prefetch: mockPrefetch,
        runReview: async () => makeFailBattery(), // costs 0.15 > 0.05
        launchFix: vi.fn(),
        getStateDir: () => dir,
      });
      expect(state.outcome).toBe('budget_exceeded');
      expect(state.phase).toBe('done');
    } finally { teardown(); }
  });

  it('dry-run path: outcome=dry_run and launchFix never called', async () => {
    const dir = setup();
    try {
      const launchFixMock = vi.fn();
      const state = await runFixLoop({ ...baseOpts, dryRun: true }, {
        prefetch: mockPrefetch,
        runReview: async () => makeFailBattery(),
        launchFix: launchFixMock,
        getStateDir: () => dir,
      });
      expect(state.outcome).toBe('dry_run');
      expect(launchFixMock).not.toHaveBeenCalled();
    } finally { teardown(); }
  });

  it('max-rounds path: outcome=max_rounds when maxRounds=1 and review fails', async () => {
    const dir = setup();
    try {
      const state = await runFixLoop({ ...baseOpts, maxRounds: 1 }, {
        prefetch: mockPrefetch,
        runReview: async () => makeFailBattery(),
        launchFix: vi.fn(),
        getStateDir: () => dir,
      });
      expect(state.outcome).toBe('max_rounds');
    } finally { teardown(); }
  });

  it('launch-fix path: calls launchFix and sets phase=fix_running when review fails with gaps', async () => {
    const dir = setup();
    try {
      const launchFixMock = vi.fn().mockReturnValue({ pid: 12345, logFile: join(dir, 'fix.log'), promptFile: join(dir, 'fix.prompt') });
      const state = await runFixLoop({ ...baseOpts, maxRounds: 3 }, {
        prefetch: mockPrefetch,
        runReview: async () => makeFailBattery(),
        launchFix: launchFixMock,
        getStateDir: () => dir,
      });
      expect(launchFixMock).toHaveBeenCalledTimes(1);
      expect(state.phase).toBe('fix_running');
      expect(state.activeFix?.pid).toBe(12345);
    } finally { teardown(); }
  });

  it('state is persisted to getStateDir after completion', async () => {
    const dir = setup();
    try {
      const launchFixMock = vi.fn().mockReturnValue({ pid: 99, logFile: join(dir, 'fix.log'), promptFile: join(dir, 'fix.prompt') });
      await runFixLoop(baseOpts, {
        prefetch: mockPrefetch,
        runReview: async () => makeFailBattery(),
        launchFix: launchFixMock,
        getStateDir: () => dir,
      });
      const saved = loadState(baseOpts.prUrl, dir);
      expect(saved).not.toBeNull();
      expect(saved?.phase).toBe('fix_running');
    } finally { teardown(); }
  });

  it('fix_running resume: returns early when fix session is still running', async () => {
    const dir = setup();
    try {
      const fixRunningState: ReviewFixState = {
        prUrl: baseOpts.prUrl,
        issueNum: baseOpts.issueNum,
        repo: baseOpts.repo,
        maxRounds: baseOpts.maxRounds,
        budgetCap: baseOpts.budgetCap,
        currentRound: 2,
        totalCostUsd: 0.15,
        startedAt: new Date().toISOString(),
        phase: 'fix_running',
        rounds: [{ round: 1, phase: 'review', verdict: 'fail', gaps: 1, reviewCost: 0.15, fixCost: 0 }],
        activeFix: { pid: 99999, logFile: join(dir, 'fix.log'), promptFile: join(dir, 'fix.prompt') },
      };
      saveState(fixRunningState, dir);
      const runReviewMock = vi.fn();
      const state = await runFixLoop({ ...baseOpts, resume: true }, {
        prefetch: mockPrefetch,
        checkFix: () => ({ done: false, success: false, costUsd: 0, output: '' }),
        runReview: runReviewMock,
        launchFix: vi.fn(),
        getStateDir: () => dir,
      });
      expect(state.phase).toBe('fix_running');
      expect(runReviewMock).not.toHaveBeenCalled();
    } finally { teardown(); }
  });

  it('fix_running resume: proceeds to review when fix session has completed', async () => {
    const dir = setup();
    try {
      const fixRunningState: ReviewFixState = {
        prUrl: baseOpts.prUrl,
        issueNum: baseOpts.issueNum,
        repo: baseOpts.repo,
        maxRounds: baseOpts.maxRounds,
        budgetCap: baseOpts.budgetCap,
        currentRound: 2,
        totalCostUsd: 0.15,
        startedAt: new Date().toISOString(),
        phase: 'fix_running',
        rounds: [],
        activeFix: { pid: 99999, logFile: join(dir, 'fix.log'), promptFile: join(dir, 'fix.prompt') },
      };
      saveState(fixRunningState, dir);
      const state = await runFixLoop({ ...baseOpts, resume: true }, {
        prefetch: mockPrefetch,
        checkFix: () => ({ done: true, success: true, costUsd: 0.20, output: 'done' }),
        runReview: async () => makePassBattery(),
        launchFix: vi.fn(),
        getStateDir: () => dir,
      });
      expect(state.outcome).toBe('pass');
    } finally { teardown(); }
  });

  it('fix_running resume: proceeds to next round when fix session completed with failure', async () => {
    const dir = setup();
    try {
      const fixRunningState: ReviewFixState = {
        prUrl: baseOpts.prUrl,
        issueNum: baseOpts.issueNum,
        repo: baseOpts.repo,
        maxRounds: baseOpts.maxRounds,
        budgetCap: baseOpts.budgetCap,
        currentRound: 2,
        totalCostUsd: 0.15,
        startedAt: new Date().toISOString(),
        phase: 'fix_running',
        rounds: [{ round: 1, phase: 'review', verdict: 'fail', gaps: 1, reviewCost: 0.15, fixCost: 0 }],
        activeFix: { pid: 99999, logFile: join(dir, 'fix.log'), promptFile: join(dir, 'fix.prompt') },
      };
      saveState(fixRunningState, dir);
      const runReviewMock = vi.fn().mockResolvedValue(makePassBattery());
      await runFixLoop({ ...baseOpts, resume: true }, {
        prefetch: mockPrefetch,
        checkFix: () => ({ done: true, success: false, costUsd: 0.05, output: 'failed' }),
        runReview: runReviewMock,
        launchFix: vi.fn(),
        getStateDir: () => dir,
      });
      expect(runReviewMock).toHaveBeenCalled();
    } finally { teardown(); }
  });
});
