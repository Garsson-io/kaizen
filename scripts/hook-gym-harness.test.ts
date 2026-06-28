import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HookTimeline } from './hook-gym-schema.js';
import type { ValidationReport } from './hook-gym-validate.js';
import { RunResult } from './hook-gym-harness.js';
import { evt } from './hook-gym-test-utils.js';

function makeResult(overrides: {
  events?: ParsedHookEvent[];
  gatesActivated?: Record<string, number>;
  gatesCleared?: Record<string, number>;
  streamLines?: string[];
  validationPassed?: boolean;
  selfCheckPassed?: boolean;
  timedOut?: boolean;
} = {}): RunResult {
  const timeline: HookTimeline = {
    events: overrides.events ?? [],
    gatesActivated: overrides.gatesActivated ?? {},
    gatesCleared: overrides.gatesCleared ?? {},
  };
  const validation: ValidationReport = {
    scenario: 'test', passed: overrides.validationPassed ?? true,
    hookResults: [], gateResults: [],
    hooksMatched: 0, hooksTotal: 0, gatesMatched: 0, gatesTotal: 0,
    criticalMisses: 0, totalLoss: 0, confusionPairs: [],
  };
  return new RunResult({
    scenario: 'test', timeline, validation,
    selfCheckPassed: overrides.selfCheckPassed ?? true,
    timedOut: overrides.timedOut ?? false,
    durationMs: 1000, outDir: '/tmp/test', streamLines: overrides.streamLines ?? [],
  });
}

describe('RunResult.passed', () => {
  it('true when validation passes', () => {
    expect(makeResult({ validationPassed: true }).passed).toBe(true);
  });

  it('false when validation fails', () => {
    expect(makeResult({ validationPassed: false }).passed).toBe(false);
  });
});

describe('RunResult.hooks', () => {
  it('filters by event type', () => {
    const result = makeResult({
      events: [
        evt({ eventType: 'SessionStart' }),
        evt({ eventType: 'PreToolUse' }),
        evt({ eventType: 'PreToolUse' }),
        evt({ eventType: 'PostToolUse' }),
      ],
    });
    expect(result.hooks.byType('PreToolUse')).toHaveLength(2);
    expect(result.hooks.byType('SessionStart')).toHaveLength(1);
    expect(result.hooks.byType('Stop')).toHaveLength(0);
  });

  it('returns denials', () => {
    const result = makeResult({
      events: [
        evt({ decision: 'deny', reason: 'blocked' }),
        evt({ decision: 'none' }),
        evt({ decision: 'deny', reason: 'dirty files' }),
      ],
    });
    expect(result.hooks.denials()).toHaveLength(2);
  });

  it('returns gate-set events', () => {
    const result = makeResult({
      events: [
        evt({ decision: 'set-gate', reason: 'needs_review' }),
        evt({ decision: 'none' }),
        evt({ decision: 'set-gate', reason: 'needs_pr_kaizen' }),
      ],
    });
    expect(result.hooks.gatesSets()).toHaveLength(2);
  });

  it('matches by hook name pattern', () => {
    const result = makeResult({
      events: [
        evt({ hookName: 'PreToolUse:Bash' }),
        evt({ hookName: 'PreToolUse:Write' }),
        evt({ hookName: 'PostToolUse:Bash' }),
      ],
    });
    expect(result.hooks.matching('Bash')).toHaveLength(2);
    expect(result.hooks.matching('Write')).toHaveLength(1);
  });
});

describe('RunResult.gates', () => {
  it('reports activated gates', () => {
    const result = makeResult({ gatesActivated: { needs_review: 100, needs_pr_kaizen: 200 } });
    expect(result.gates.activated()).toEqual(['needs_review', 'needs_pr_kaizen']);
    expect(result.gates.wasActivated('needs_review')).toBe(true);
    expect(result.gates.wasActivated('needs_post_merge')).toBe(false);
  });

  it('reports cleared gates', () => {
    const result = makeResult({
      gatesActivated: { needs_review: 100 },
      gatesCleared: { needs_review: 500 },
    });
    expect(result.gates.wasCleared('needs_review')).toBe(true);
    expect(result.gates.isActive('needs_review')).toBe(false);
  });

  it('reports active gates (activated but not cleared)', () => {
    const result = makeResult({
      gatesActivated: { needs_review: 100, needs_pr_kaizen: 200 },
      gatesCleared: { needs_review: 500 },
    });
    expect(result.gates.isActive('needs_review')).toBe(false);
    expect(result.gates.isActive('needs_pr_kaizen')).toBe(true);
  });
});

describe('runHookGymScenario stream parsing', () => {
  it('delegates live JSON object parsing to the shared helper', () => {
    const source = readFileSync(fileURLToPath(new URL('./hook-gym-harness.ts', import.meta.url)), 'utf8');
    const liveSection = source.slice(
      source.indexOf("child.stdout?.on('data'"),
      source.indexOf("if (debug) child.stderr"),
    );

    expect(liveSection).toContain('parseJsonObject');
    expect(liveSection).not.toContain('JSON.parse(line)');
  });
});

describe('RunResult.agent', () => {
  it('delegates stream JSON parsing to the shared helper', () => {
    const source = readFileSync(fileURLToPath(new URL('./hook-gym-harness.ts', import.meta.url)), 'utf8');
    const agentSection = source.slice(
      source.indexOf('get agent()'),
      source.indexOf('/** Diagnose hook behavior'),
    );

    expect(agentSection).toContain('parsedStreamMessages');
    expect(agentSection).not.toContain('JSON.parse(line)');
  });

  const toolUseMsg = (name: string, input: Record<string, unknown>) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });

  const toolResultMsg = (content: string) => JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content }] },
  });

  it('detects tool usage', () => {
    const result = makeResult({
      streamLines: [
        toolUseMsg('Bash', { command: 'git status' }),
        toolUseMsg('Write', { file_path: '/tmp/test.md', content: 'hi' }),
      ],
    });
    expect(result.agent.usedTool('Bash')).toBe(true);
    expect(result.agent.usedTool('Write')).toBe(true);
    expect(result.agent.usedTool('Read')).toBe(false);
  });

  it('skips malformed stream lines while querying agent actions', () => {
    const result = makeResult({
      streamLines: [
        'not json',
        toolUseMsg('Bash', { command: 'git status' }),
        '{broken',
      ],
    });

    expect(result.agent.toolUses()).toEqual([
      { tool: 'Bash', input: { command: 'git status' } },
    ]);
    expect(result.agent.usedTool('Bash')).toBe(true);
  });

  it('detects skill usage', () => {
    const result = makeResult({
      streamLines: [
        toolUseMsg('Skill', { skill: 'kaizen-review-pr', args: '42' }),
      ],
    });
    expect(result.agent.usedSkill()).toBe(true);
    expect(result.agent.usedSkill('kaizen-review-pr')).toBe(true);
    expect(result.agent.usedSkill('kaizen-reflect')).toBe(false);
  });

  it('extracts PR URL from tool results', () => {
    const result = makeResult({
      streamLines: [
        toolResultMsg('https://github.com/Garsson-io/kaizen-test-fixture/pull/42'),
      ],
    });
    expect(result.agent.createdPR()).toBe('https://github.com/Garsson-io/kaizen-test-fixture/pull/42');
  });

  it('returns null when no PR created', () => {
    const result = makeResult({ streamLines: [toolUseMsg('Bash', { command: 'echo hi' })] });
    expect(result.agent.createdPR()).toBeNull();
  });

  it('detects worktree entry', () => {
    const result = makeResult({
      streamLines: [toolUseMsg('EnterWorktree', { name: 'test' })],
    });
    expect(result.agent.enteredWorktree()).toBe(true);
  });
});

describe('RunResult.summary', () => {
  it('produces a multi-line string with key metrics', () => {
    const result = makeResult({
      events: [evt({ decision: 'deny' }), evt({ decision: 'set-gate', reason: 'needs_review' })],
      gatesActivated: { needs_review: 100 },
    });
    const s = result.summary();
    expect(s).toContain('Scenario: test');
    expect(s).toContain('Hook events: 2');
    expect(s).toContain('Gates activated: needs_review');
    expect(s).toContain('Denials: 1');
  });
});

describe('RunResult.diagnose', () => {
  it('reports per-event-type stats', () => {
    const result = makeResult({
      events: [
        evt({ eventType: 'SessionStart' }),
        evt({ eventType: 'PreToolUse', rawOutput: 'some output' }),
        evt({ eventType: 'PreToolUse' }),
      ],
    });
    const d = result.diagnose();
    expect(d).toContain('SessionStart: 1 events');
    expect(d).toContain('PreToolUse: 2 events, 1 with output');
  });
});
