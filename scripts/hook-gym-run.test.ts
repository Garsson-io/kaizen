import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Scenario } from './hook-gym-schema.js';
import { runScenario, runAll } from './hook-gym-harness.js';

// Minimal scenario for tests — tiny timeout, haiku, 1 expectation.
const TEST_SCENARIO: Scenario = {
  name: 'test-scenario',
  description: 'Synthetic scenario for unit tests',
  prompt: 'echo hello {{timestamp}}',
  model: 'haiku',
  maxBudget: 0.01,
  timeoutSeconds: 10,
  expectedHooks: [
    {
      hookPattern: 'SessionStart',
      eventType: 'SessionStart',
      expectedDecision: 'fire',
      severity: 1,
      description: 'SessionStart hooks should fire',
    },
  ],
  expectedGates: [],
};

// Stream lines that simulate a Claude CLI --include-hook-events session
const HOOK_STARTED_LINE = JSON.stringify({
  type: 'system',
  subtype: 'hook_started',
  hook_id: 'h1',
  hook_name: 'SessionStart:startup',
  hook_event: 'SessionStart',
  uuid: 'u1',
  session_id: 's1',
});

const HOOK_RESPONSE_LINE = JSON.stringify({
  type: 'system',
  subtype: 'hook_response',
  hook_id: 'h1',
  hook_name: 'SessionStart:startup',
  hook_event: 'SessionStart',
  output: '',
  stdout: '',
  stderr: '',
  exit_code: 0,
  outcome: 'success',
  uuid: 'u1',
  session_id: 's1',
});

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Hello' }] },
});

function makeMockSpawn(
  lines: string[],
  exitCode: number = 0,
  delay: number = 0,
): any {
  return (_cmd: string, _args: string[], _opts: any) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    (child as any).stdout = stdout;
    (child as any).stderr = stderr;
    (child as any).killed = false;
    child.kill = () => {
      (child as any).killed = true;
      setTimeout(() => child.emit('close', 137), 10);
      return true;
    };

    setTimeout(() => {
      for (const line of lines) {
        stdout.push(line + '\n');
      }
      stdout.push(null);
      if (delay > 0) {
        setTimeout(() => child.emit('close', exitCode), delay);
      } else {
        child.emit('close', exitCode);
      }
    }, 10);

    return child;
  };
}

describe('runScenario', () => {
  let outDir: string;
  const logs: string[] = [];
  const log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'hook-gym-run-'));
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('L4: writes stream.jsonl, timeline.md, result.json to output dir', async () => {
    const spawn = makeMockSpawn([HOOK_STARTED_LINE, HOOK_RESPONSE_LINE, ASSISTANT_LINE]);
    const result = await runScenario(TEST_SCENARIO, { spawn, outRoot: outDir, log });

    expect(existsSync(join(result.outDir, 'stream.jsonl'))).toBe(true);
    expect(existsSync(join(result.outDir, 'timeline.md'))).toBe(true);
    expect(existsSync(join(result.outDir, 'result.json'))).toBe(true);

    const streamContent = readFileSync(join(result.outDir, 'stream.jsonl'), 'utf8');
    expect(streamContent.trim().split('\n').length).toBeGreaterThanOrEqual(2);

    const timelineMd = readFileSync(join(result.outDir, 'timeline.md'), 'utf8');
    expect(timelineMd).toContain('# Hook Timeline');

    const resultJson = JSON.parse(readFileSync(join(result.outDir, 'result.json'), 'utf8'));
    expect(resultJson.scenario).toBe('test-scenario');
    expect(resultJson.hookEventCount).toBe(1);
  });

  it('captures hook events into the timeline', async () => {
    const spawn = makeMockSpawn([HOOK_STARTED_LINE, HOOK_RESPONSE_LINE]);
    const result = await runScenario(TEST_SCENARIO, { spawn, outRoot: outDir, log });

    expect(result.timeline.events).toHaveLength(1);
    expect(result.timeline.events[0].eventType).toBe('SessionStart');
    expect(result.timeline.events[0].hookName).toBe('SessionStart:startup');
  });

  it('L5: self-check replay matches the in-line verdict', async () => {
    const spawn = makeMockSpawn([HOOK_STARTED_LINE, HOOK_RESPONSE_LINE]);
    const result = await runScenario(TEST_SCENARIO, { spawn, outRoot: outDir, log });

    expect(result.selfCheckPassed).toBe(true);
    expect(logs.some(l => l.includes('Self-check: fixture replay matches live verdict'))).toBe(true);
  });

  it('L3: enforces timeout and kills subprocess', async () => {
    const shortTimeout: Scenario = { ...TEST_SCENARIO, timeoutSeconds: 1 };
    // Mock spawn that never closes naturally — relies on timeout
    const spawn = makeMockSpawn([HOOK_STARTED_LINE], 0, 60_000);
    const result = await runScenario(shortTimeout, { spawn, outRoot: outDir, log });

    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(logs.some(l => l.includes('Timeout'))).toBe(true);
  }, 15_000);

  it('handles spawn error gracefully', async () => {
    const spawn = (_cmd: string, _args: string[], _opts: any) => {
      const child = new EventEmitter() as ChildProcess;
      (child as any).stdout = new Readable({ read() {} });
      (child as any).stderr = new Readable({ read() {} });
      (child as any).killed = false;
      child.kill = () => { (child as any).killed = true; return true; };
      setTimeout(() => child.emit('error', new Error('ENOENT: claude not found')), 10);
      return child;
    };

    const result = await runScenario(TEST_SCENARIO, { spawn: spawn as any, outRoot: outDir, log });

    expect(result.passed).toBe(false);
    expect(logs.some(l => l.includes('Spawn error'))).toBe(true);
  });

  it('produces a non-empty timeline.md via formatTimeline', async () => {
    const spawn = makeMockSpawn([
      HOOK_STARTED_LINE,
      HOOK_RESPONSE_LINE,
      ASSISTANT_LINE,
    ]);
    const result = await runScenario(TEST_SCENARIO, { spawn, outRoot: outDir, log });

    const md = readFileSync(join(result.outDir, 'timeline.md'), 'utf8');
    expect(md).toContain('SessionStart');
    expect(md).toContain('## Gates');
  });
});

describe('runAll (L6)', () => {
  let outDir: string;
  const logs: string[] = [];
  const log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'hook-gym-runall-'));
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('runs all scenarios and returns aggregate pass/fail', async () => {
    const spawn = makeMockSpawn([HOOK_STARTED_LINE, HOOK_RESPONSE_LINE]);
    const scenarios = [TEST_SCENARIO, { ...TEST_SCENARIO, name: 'second-scenario' }];
    const { results, allPassed } = await runAll(scenarios, { spawn, outRoot: outDir, log });

    expect(results).toHaveLength(2);
    expect(results[0].scenario).toBe('test-scenario');
    expect(results[1].scenario).toBe('second-scenario');
    expect(allPassed).toBe(true);
    expect(logs.some(l => l.includes('2/2 passed'))).toBe(true);
    expect(logs.some(l => l.includes('2/2 passed'))).toBe(true);
  });

  it('exits with allPassed=false when any scenario fails', async () => {
    const passSpawn = makeMockSpawn([HOOK_STARTED_LINE, HOOK_RESPONSE_LINE]);
    // Scenario that will fail: expects a hook that never fires
    const failScenario: Scenario = {
      ...TEST_SCENARIO,
      name: 'fail-scenario',
      expectedHooks: [
        {
          hookPattern: 'NeverFires',
          eventType: 'Stop',
          expectedDecision: 'block',
          severity: 3,
          description: 'This hook never fires',
        },
      ],
    };

    const { results, allPassed } = await runAll(
      [TEST_SCENARIO, failScenario],
      { spawn: passSpawn, outRoot: outDir, log },
    );

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(allPassed).toBe(false);
    expect(logs.some(l => l.includes('1/2 passed'))).toBe(true);
  });

  it('prints a summary table', async () => {
    const spawn = makeMockSpawn([HOOK_STARTED_LINE, HOOK_RESPONSE_LINE]);
    await runAll([TEST_SCENARIO], { spawn, outRoot: outDir, log });

    expect(logs.some(l => l.includes('1/1 passed'))).toBe(true);
    expect(logs.some(l => l.includes('test-scenario'))).toBe(true);
  });
});
