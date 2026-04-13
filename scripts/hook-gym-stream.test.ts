import { describe, it, expect } from 'vitest';
import {
  parseHookDecision,
  createHookStreamProcessor,
  parseLogFile,
} from './hook-gym-stream.js';

// ── parseHookDecision ──────────────────────────────────────────────

describe('parseHookDecision', () => {
  it('returns none for empty output with exit 0', () => {
    const { decision, reason } = parseHookDecision('', '', 0);
    expect(decision).toBe('none');
    expect(reason).toBe(null);
  });

  it('detects PreToolUse deny', () => {
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no case found',
      },
    });
    const { decision, reason } = parseHookDecision(output, '', 0);
    expect(decision).toBe('deny');
    expect(reason).toBe('no case found');
  });

  it('detects PreToolUse allow', () => {
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    const { decision } = parseHookDecision(output, '', 0);
    expect(decision).toBe('allow');
  });

  it('detects Stop block', () => {
    const output = JSON.stringify({
      decision: 'block',
      reason: '2 gates pending',
    });
    const { decision, reason } = parseHookDecision(output, '', 0);
    expect(decision).toBe('block');
    expect(reason).toBe('2 gates pending');
  });

  it('detects set-gate from raw stderr pattern', () => {
    const { decision, reason } = parseHookDecision(
      '',
      'STATUS=needs_review written',
      0,
    );
    expect(decision).toBe('set-gate');
    expect(reason).toBe('needs_review');
  });

  it('detects clear-gate from raw pattern', () => {
    const { decision, reason } = parseHookDecision(
      '',
      'review_passed: clearing state',
      0,
    );
    expect(decision).toBe('clear-gate');
    expect(reason).toBe('needs_review');
  });

  it('classifies "clearing needs_review" text as clear-gate, not set-gate', () => {
    // Regression: SET patterns were checked before CLEAR, so the substring
    // "needs_review" in "clearing needs_review" matched SET first.
    const { decision, reason } = parseHookDecision(
      '',
      'clearing needs_review gate',
      0,
    );
    expect(decision).toBe('clear-gate');
    expect(reason).toBe('needs_review');
  });

  it('classifies STATUS=passed as clear-gate even when text mentions needs_review', () => {
    const { decision, reason } = parseHookDecision(
      '',
      'needs_review: STATUS=passed',
      0,
    );
    expect(decision).toBe('clear-gate');
    expect(reason).toBe('needs_review');
  });

  it('falls through to none for unrecognized JSON', () => {
    const output = JSON.stringify({ foo: 'bar' });
    const { decision } = parseHookDecision(output, '', 0);
    expect(decision).toBe('none');
  });

  it('handles non-JSON output gracefully', () => {
    const { decision } = parseHookDecision('plain text output', '', 0);
    expect(decision).toBe('none');
  });
});

// ── createHookStreamProcessor ──────────────────────────────────────

describe('createHookStreamProcessor', () => {
  it('ignores non-system messages', () => {
    const p = createHookStreamProcessor();
    expect(
      p.process({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toBe(false);
    expect(p.getTimeline().events).toHaveLength(0);
  });

  it('ignores system messages that are not hook events', () => {
    const p = createHookStreamProcessor();
    expect(
      p.process({ type: 'system', subtype: 'init', session_id: 's1' }),
    ).toBe(false);
    expect(p.getTimeline().events).toHaveLength(0);
  });

  it('correlates hook_started and hook_response', () => {
    const p = createHookStreamProcessor();
    p.process({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      uuid: 'u1',
      session_id: 's1',
    });
    p.process({
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
      session_id: 's1',
    });

    const tl = p.getTimeline();
    expect(tl.events).toHaveLength(1);
    expect(tl.events[0].hookId).toBe('h1');
    expect(tl.events[0].eventType).toBe('PreToolUse');
    expect(tl.events[0].exitCode).toBe(0);
    expect(tl.events[0].outcome).toBe('success');
    expect(tl.events[0].decision).toBe('none');
  });

  it('tracks gate activation from set-gate decision', () => {
    const p = createHookStreamProcessor();
    p.process({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'PostToolUse:Bash',
      hook_event: 'PostToolUse',
      uuid: 'u1',
      session_id: 's1',
    });
    p.process({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'PostToolUse:Bash',
      hook_event: 'PostToolUse',
      output: '',
      stdout: 'STATUS=needs_review written',
      stderr: '',
      exit_code: 0,
      outcome: 'success',
      uuid: 'u2',
      session_id: 's1',
    });

    const tl = p.getTimeline();
    expect(tl.gatesActivated).toHaveProperty('needs_review');
    expect(tl.gatesActivated.needs_review).toBeGreaterThanOrEqual(0);
  });

  it('tracks gate activation from Stop block', () => {
    const p = createHookStreamProcessor();
    p.process({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'Stop:kaizen-stop-gate',
      hook_event: 'Stop',
      uuid: 'u1',
      session_id: 's1',
    });
    p.process({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'Stop:kaizen-stop-gate',
      hook_event: 'Stop',
      output: JSON.stringify({
        decision: 'block',
        reason: 'needs_review and needs_pr_kaizen pending',
      }),
      stdout: '',
      stderr: '',
      exit_code: 0,
      outcome: 'success',
      uuid: 'u2',
      session_id: 's1',
    });

    const tl = p.getTimeline();
    expect(tl.events[0].decision).toBe('block');
    expect(tl.gatesActivated).toHaveProperty('needs_review');
    expect(tl.gatesActivated).toHaveProperty('needs_pr_kaizen');
  });

  it('getDenials filters to deny decisions only', () => {
    const p = createHookStreamProcessor();
    // Deny event
    p.process({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'PreToolUse:Write',
      hook_event: 'PreToolUse',
      uuid: 'u1',
      session_id: 's1',
    });
    p.process({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'PreToolUse:Write',
      hook_event: 'PreToolUse',
      output: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no case',
        },
      }),
      stdout: '',
      stderr: '',
      exit_code: 0,
      outcome: 'success',
      uuid: 'u2',
      session_id: 's1',
    });
    // Non-deny event
    p.process({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h2',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      uuid: 'u3',
      session_id: 's1',
    });
    p.process({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h2',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      output: '',
      stdout: '',
      stderr: '',
      exit_code: 0,
      outcome: 'success',
      uuid: 'u4',
      session_id: 's1',
    });

    expect(p.getDenials()).toHaveLength(1);
    expect(p.getDenials()[0].hookId).toBe('h1');
    expect(p.getTimeline().events).toHaveLength(2);
  });

  it('getErrors filters to non-zero exit or error outcome', () => {
    const p = createHookStreamProcessor();
    p.process({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h1',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      uuid: 'u1',
      session_id: 's1',
    });
    p.process({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: '',
      stdout: '',
      stderr: 'boom',
      exit_code: 1,
      outcome: 'error',
      uuid: 'u2',
      session_id: 's1',
    });

    expect(p.getErrors()).toHaveLength(1);
    expect(p.getErrors()[0].exitCode).toBe(1);
    expect(p.getErrors()[0].stderr).toBe('boom');
  });

  it('getEventsByType filters by eventType', () => {
    const p = createHookStreamProcessor();
    for (const ev of ['PreToolUse', 'PostToolUse', 'PreToolUse']) {
      const id = Math.random().toString();
      p.process({
        type: 'system',
        subtype: 'hook_started',
        hook_id: id,
        hook_name: `${ev}:x`,
        hook_event: ev,
        uuid: 'u',
        session_id: 's',
      });
      p.process({
        type: 'system',
        subtype: 'hook_response',
        hook_id: id,
        hook_name: `${ev}:x`,
        hook_event: ev,
        output: '',
        stdout: '',
        stderr: '',
        exit_code: 0,
        outcome: 'success',
        uuid: 'u',
        session_id: 's',
      });
    }
    expect(p.getEventsByType('PreToolUse')).toHaveLength(2);
    expect(p.getEventsByType('PostToolUse')).toHaveLength(1);
    expect(p.getEventsByType('Stop')).toHaveLength(0);
  });
});

// ── parseLogFile ───────────────────────────────────────────────────

describe('parseLogFile', () => {
  it('returns empty timeline for empty input', () => {
    const tl = parseLogFile('');
    expect(tl.events).toHaveLength(0);
  });

  it('skips non-JSON lines', () => {
    const log = [
      'not json at all',
      JSON.stringify({
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'h1',
        hook_name: 'SessionStart:startup',
        hook_event: 'SessionStart',
        uuid: 'u1',
        session_id: 's1',
      }),
      'another non-json line',
      JSON.stringify({
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
        session_id: 's1',
      }),
    ].join('\n');

    const tl = parseLogFile(log);
    expect(tl.events).toHaveLength(1);
    expect(tl.events[0].eventType).toBe('SessionStart');
  });

  it('parses probed real-world format from --include-hook-events', () => {
    // Actual captured probe data (minus session-specific IDs)
    const log = [
      '{"type":"system","subtype":"hook_started","hook_id":"a","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"u1","session_id":"s1"}',
      '{"type":"system","subtype":"hook_response","hook_id":"a","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"u2","session_id":"s1"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.01}',
    ].join('\n');

    const tl = parseLogFile(log);
    expect(tl.events).toHaveLength(1);
    expect(tl.events[0].hookName).toBe('SessionStart:startup');
  });
});
