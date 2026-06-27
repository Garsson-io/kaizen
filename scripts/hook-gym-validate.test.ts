import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  validateAgainstScenario,
  loadFixture,
  validateFixtureFile,
  formatValidationReport,
} from './hook-gym-validate.js';
import { parseLogFile } from './hook-gym-stream.js';
import { getScenario } from './hook-gym-scenarios.js';
import type { Scenario, HookTimeline } from './hook-gym-schema.js';

const LIVE_PROBE_FIXTURE = resolve(__dirname, '../fixtures/live/probe-hooks.jsonl');

// ── Small helpers to build synthetic timelines ─────────────────────

function emptyTimeline(): HookTimeline {
  return { events: [], gatesActivated: {}, gatesCleared: {} };
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'test-scenario',
    description: 'test',
    prompt: 'p',
    model: 'haiku',
    maxBudget: 0.1,
    timeoutSeconds: 60,
    expectedHooks: [],
    expectedGates: [],
    ...overrides,
  };
}

function streamJsonLine(obj: Record<string, any>): string {
  return JSON.stringify(obj);
}

// ── validateAgainstScenario ────────────────────────────────────────

describe('validateAgainstScenario — empty scenario passes empty timeline', () => {
  it('reports pass with 0/0 hooks and 0/0 gates', () => {
    const r = validateAgainstScenario(emptyTimeline(), scenario());
    expect(r.passed).toBe(true);
    expect(r.hooksMatched).toBe(0);
    expect(r.hooksTotal).toBe(0);
    expect(r.gatesMatched).toBe(0);
    expect(r.gatesTotal).toBe(0);
    expect(r.totalLoss).toBe(0);
  });
});

describe('validateAgainstScenario — hook expectations', () => {
  it('"fire" is satisfied by any firing event', () => {
    const tl: HookTimeline = {
      events: [
        {
          timestamp: 10,
          eventType: 'SessionStart',
          hookId: 'h1',
          hookName: 'SessionStart:startup',
          durationMs: 1,
          exitCode: 0,
          outcome: 'success',
          decision: 'none',
          reason: null,
          rawOutput: '',
          stderr: null,
        },
      ],
      gatesActivated: {},
      gatesCleared: {},
    };
    const r = validateAgainstScenario(
      tl,
      scenario({
        expectedHooks: [
          {
            hookPattern: 'SessionStart',
            eventType: 'SessionStart',
            expectedDecision: 'fire',
            severity: 1,
            description: '',
          },
        ],
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.hooksMatched).toBe(1);
  });

  it('"deny" is satisfied when candidate has decision=deny', () => {
    const tl: HookTimeline = {
      events: [
        {
          timestamp: 20,
          eventType: 'PreToolUse',
          hookId: 'h1',
          hookName: 'PreToolUse:Bash',
          durationMs: 5,
          exitCode: 0,
          outcome: 'success',
          decision: 'deny',
          reason: 'no case found',
          rawOutput: '',
          stderr: null,
        },
      ],
      gatesActivated: {},
      gatesCleared: {},
    };
    const r = validateAgainstScenario(
      tl,
      scenario({
        expectedHooks: [
          {
            hookPattern: 'PreToolUse',
            eventType: 'PreToolUse',
            expectedDecision: 'deny',
            severity: 2,
            description: '',
          },
        ],
      }),
    );
    expect(r.passed).toBe(true);
  });

  it('"deny" is NOT satisfied when candidate allowed', () => {
    const tl: HookTimeline = {
      events: [
        {
          timestamp: 20,
          eventType: 'PreToolUse',
          hookId: 'h1',
          hookName: 'PreToolUse:Bash',
          durationMs: 5,
          exitCode: 0,
          outcome: 'success',
          decision: 'allow',
          reason: null,
          rawOutput: '',
          stderr: null,
        },
      ],
      gatesActivated: {},
      gatesCleared: {},
    };
    const r = validateAgainstScenario(
      tl,
      scenario({
        expectedHooks: [
          {
            hookPattern: 'PreToolUse',
            eventType: 'PreToolUse',
            expectedDecision: 'deny',
            severity: 3,
            description: '',
          },
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.criticalMisses).toBe(1);
    expect(r.totalLoss).toBe(4); // severity 3 = weight 4
    expect(r.confusionPairs).toHaveLength(1);
    expect(r.confusionPairs[0].expected).toBe('deny');
    expect(r.confusionPairs[0].actual).toBe('allow');
  });

  it('"skip" is satisfied when NO matching event exists', () => {
    const r = validateAgainstScenario(
      emptyTimeline(),
      scenario({
        expectedHooks: [
          {
            hookPattern: 'PreToolUse',
            eventType: 'PreToolUse',
            expectedDecision: 'skip',
            severity: 1,
            description: '',
          },
        ],
      }),
    );
    expect(r.passed).toBe(true);
  });

  it('"skip" FAILS when matching event exists', () => {
    const tl: HookTimeline = {
      events: [
        {
          timestamp: 20,
          eventType: 'PreToolUse',
          hookId: 'h1',
          hookName: 'PreToolUse:Bash',
          durationMs: 5,
          exitCode: 0,
          outcome: 'success',
          decision: 'deny',
          reason: 'x',
          rawOutput: '',
          stderr: null,
        },
      ],
      gatesActivated: {},
      gatesCleared: {},
    };
    const r = validateAgainstScenario(
      tl,
      scenario({
        expectedHooks: [
          {
            hookPattern: 'PreToolUse',
            eventType: 'PreToolUse',
            expectedDecision: 'skip',
            severity: 2,
            description: '',
          },
        ],
      }),
    );
    expect(r.passed).toBe(false);
  });

  it('reports "not-fired" when no candidate exists for a non-skip expectation', () => {
    const r = validateAgainstScenario(
      emptyTimeline(),
      scenario({
        expectedHooks: [
          {
            hookPattern: 'Stop',
            eventType: 'Stop',
            expectedDecision: 'block',
            severity: 3,
            description: '',
          },
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.hookResults[0].actualDecision).toBe('not-fired');
    expect(r.criticalMisses).toBe(1);
  });
});

describe('validateAgainstScenario — gate expectations', () => {
  it('gate activation + clearing match', () => {
    const tl: HookTimeline = {
      events: [],
      gatesActivated: { needs_review: 100 },
      gatesCleared: { needs_review: 200 },
    };
    const r = validateAgainstScenario(
      tl,
      scenario({
        expectedGates: [
          { gate: 'needs_review', shouldActivate: true, shouldClear: true },
        ],
      }),
    );
    expect(r.passed).toBe(true);
    expect(r.gatesMatched).toBe(1);
  });

  it('gate not activated when expected FAILS', () => {
    const r = validateAgainstScenario(
      emptyTimeline(),
      scenario({
        expectedGates: [
          { gate: 'needs_review', shouldActivate: true, shouldClear: false },
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.criticalMisses).toBe(1);
    expect(r.totalLoss).toBe(4);
  });

  it('gate cleared when expected to stay FAILS', () => {
    const tl: HookTimeline = {
      events: [],
      gatesActivated: { needs_review: 100 },
      gatesCleared: { needs_review: 200 },
    };
    const r = validateAgainstScenario(
      tl,
      scenario({
        expectedGates: [
          { gate: 'needs_review', shouldActivate: true, shouldClear: false },
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.gateResults[0].reason).toContain('clear');
  });
});

describe('loadFixture', () => {
  it('loads a stream-json (newline-delimited) fixture', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hg-fix-'));
    const fixturePath = join(tmp, 'fixture.jsonl');
    const lines = [
      streamJsonLine({
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'h1',
        hook_name: 'SessionStart:startup',
        hook_event: 'SessionStart',
        uuid: 'u',
        session_id: 's',
      }),
      streamJsonLine({
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
        uuid: 'u2',
        session_id: 's',
      }),
    ];
    writeFileSync(fixturePath, lines.join('\n'));
    const timeline = loadFixture(fixturePath);
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0].eventType).toBe('SessionStart');
  });

  it('loads a JSON-array fixture', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hg-fix-'));
    const fixturePath = join(tmp, 'fixture.json');
    writeFileSync(
      fixturePath,
      JSON.stringify([
        {
          type: 'system',
          subtype: 'hook_started',
          hook_id: 'h1',
          hook_name: 'PreToolUse:Bash',
          hook_event: 'PreToolUse',
          uuid: 'u',
          session_id: 's',
        },
        {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'h1',
          hook_name: 'PreToolUse:Bash',
          hook_event: 'PreToolUse',
          output: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'nope',
            },
          }),
          stdout: '',
          stderr: '',
          exit_code: 0,
          outcome: 'success',
          uuid: 'u2',
          session_id: 's',
        },
      ]),
    );
    const timeline = loadFixture(fixturePath);
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0].decision).toBe('deny');
  });
});

describe('validateFixtureFile — invariant I1 (PR has Closes #N)', () => {
  it('fixture showing hook DENY on missing closing keyword validates as PASS against a "I1 enforced" scenario', () => {
    // Ground truth: when agent attempts gh pr create with no Closes keyword,
    // the kaizen-enforce-pr-preconditions hook should DENY the PreToolUse.
    const invariantScenario: Scenario = scenario({
      name: 'invariant-I1',
      expectedHooks: [
        {
          hookPattern: 'PreToolUse',
          eventType: 'PreToolUse',
          expectedDecision: 'deny',
          severity: 3,
          description: 'PR create with no Closes keyword must be denied',
        },
      ],
    });

    const tmp = mkdtempSync(join(tmpdir(), 'hg-fix-'));
    const fixturePath = join(tmp, 'i1-violation.json');
    // Fixture representing: a violating `gh pr create` call → hook denies
    writeFileSync(
      fixturePath,
      JSON.stringify([
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
          output: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'BLOCKED: PR body missing Closes #<N> keyword (kaizen invariant I1)',
            },
          }),
          stdout: '',
          stderr: '',
          exit_code: 0,
          outcome: 'success',
          uuid: 'u2',
          session_id: 's',
        },
      ]),
    );

    const report = validateFixtureFile(fixturePath, invariantScenario);
    expect(report.passed).toBe(true);
  });

  it('fixture showing the hook ALLOW a violating call FAILS (invariant not enforced)', () => {
    const invariantScenario: Scenario = scenario({
      name: 'invariant-I1',
      expectedHooks: [
        {
          hookPattern: 'PreToolUse',
          eventType: 'PreToolUse',
          expectedDecision: 'deny',
          severity: 3,
          description: 'PR create with no Closes keyword must be denied',
        },
      ],
    });

    const tmp = mkdtempSync(join(tmpdir(), 'hg-fix-'));
    const fixturePath = join(tmp, 'i1-missed.json');
    // Fixture representing: hook fired but did NOT deny
    writeFileSync(
      fixturePath,
      JSON.stringify([
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
          output: '',
          stdout: '',
          stderr: '',
          exit_code: 0,
          outcome: 'success',
          uuid: 'u2',
          session_id: 's',
        },
      ]),
    );

    const report = validateFixtureFile(fixturePath, invariantScenario);
    expect(report.passed).toBe(false);
    expect(report.criticalMisses).toBe(1);
    expect(report.confusionPairs[0].expected).toBe('deny');
  });
});

describe('validateFixtureFile — real captured fixtures', () => {
  it('scores the live probe-hooks fixture from observed hook verdicts', () => {
    const probeHooks = getScenario('probe-hooks');
    expect(probeHooks).toBeDefined();

    const report = validateFixtureFile(LIVE_PROBE_FIXTURE, probeHooks!);

    expect(report.passed).toBe(true);
    expect(report.criticalMisses).toBe(0);
    expect(report.hookResults.some(
      (result) =>
        result.expected.expectedDecision === 'set-gate' &&
        result.actualDecision === 'set-gate',
    )).toBe(true);
  });

  it('rejects a malformed copy of the live probe-hooks fixture before scoring', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hg-live-bad-'));
    const fixturePath = join(tmp, 'probe-hooks-bad.jsonl');
    const lines = readFileSync(LIVE_PROBE_FIXTURE, 'utf-8').trim().split('\n');
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const response = events.find(
      (event) => event.type === 'system' && event.subtype === 'hook_response',
    );
    expect(response).toBeDefined();
    response!.exit_code = '0';
    writeFileSync(fixturePath, events.map((event) => JSON.stringify(event)).join('\n'));

    const probeHooks = getScenario('probe-hooks');
    expect(probeHooks).toBeDefined();
    expect(() => validateFixtureFile(fixturePath, probeHooks!)).toThrow(/Invalid hook-gym fixture/);
  });
});

describe('formatValidationReport', () => {
  it('produces human-readable output with PASS marker', () => {
    const report = validateAgainstScenario(emptyTimeline(), scenario());
    const text = formatValidationReport(report);
    expect(text).toContain('✅ PASS');
    expect(text).toContain('test-scenario');
  });

  it('produces FAIL output with confusion pairs on mismatches', () => {
    const report = validateAgainstScenario(
      emptyTimeline(),
      scenario({
        expectedHooks: [
          {
            hookPattern: 'Stop',
            eventType: 'Stop',
            expectedDecision: 'block',
            severity: 3,
            description: '',
          },
        ],
      }),
    );
    const text = formatValidationReport(report);
    expect(text).toContain('❌ FAIL');
    expect(text).toContain('Confusion pairs');
    expect(text).toContain('not-fired');
  });
});
