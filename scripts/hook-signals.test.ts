import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { detectHookSignals, hasHookRejection, firstHookReason } from './hook-signals.js';
import { formatHookOutput } from '../src/hooks/lib/gate-signal.js';

/**
 * These tests pin the harness↔hook boundary contract: anything a kaizen hook
 * emits as a structured deny/block must be detectable by the harness, without
 * relying on English prose. See issue #1102.
 */
describe('detectHookSignals', () => {
  it('detects a PreToolUse permissionDecision:"deny" envelope', () => {
    // Exact shape emitted by enforce-plan-stored.ts (stdout JSON).
    const log = [
      'some prior tool output',
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'BLOCKED: No plan stored for issue #5.',
        },
      }),
      'trailing output',
    ].join('\n');

    const signals = detectHookSignals(log);
    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe('deny');
    expect(signals[0].source).toBe('permission-decision');
    expect(signals[0].reason).toContain('No plan stored');
  });

  it('detects a stop-gate decision:"block" envelope', () => {
    // Exact shape emitted by stop-gate.ts.
    const log = JSON.stringify({
      decision: 'block',
      reason: 'PR REVIEW required — run /kaizen-review-pr',
    });

    const signals = detectHookSignals(log);
    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe('block');
    expect(signals[0].source).toBe('stop-decision');
    expect(signals[0].reason).toContain('PR REVIEW');
  });

  it('BOUNDARY CONTRACT: output of formatHookOutput({type:"deny"}) is detected', () => {
    // This is the compound-interest test: any hook that emits via the canonical
    // gate-signal schema is automatically observable to the harness. If the
    // schema drifts from what the harness parses, this fails.
    const yaml = formatHookOutput({
      hook: 'check-dirty-files',
      type: 'deny',
      reason: 'Dirty files present at gh pr create.',
    });
    const log = `==> hook output\n${yaml}\n==> next`;

    const signals = detectHookSignals(log);
    expect(signals.some((s) => s.kind === 'deny')).toBe(true);
    const sig = signals.find((s) => s.kind === 'deny')!;
    expect(sig.source).toBe('canonical-yaml');
    expect(sig.hook).toBe('check-dirty-files');
    expect(sig.reason).toContain('Dirty files');
  });

  it('BOUNDARY CONTRACT: canonical block signal is detected', () => {
    const yaml = formatHookOutput({
      hook: 'stop-gate',
      type: 'block',
      reason: 'Pending review gate.',
    });
    const signals = detectHookSignals(`prefix\n${yaml}`);
    expect(signals.some((s) => s.kind === 'block' && s.source === 'canonical-yaml')).toBe(true);
  });

  it('does not flag a clean log (no false positives)', () => {
    const log = [
      'AUTO_DENT_PHASE: PICK | issue=#5',
      'Running tests... 12 passed',
      'gate-set needs_review (this is fine, not a deny/block)',
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }),
    ].join('\n');
    expect(detectHookSignals(log)).toEqual([]);
    expect(hasHookRejection(log)).toBe(false);
  });

  it('hasHookRejection is true when any deny/block is present', () => {
    const log = JSON.stringify({ decision: 'block', reason: 'gate' });
    expect(hasHookRejection(log)).toBe(true);
  });

  it('firstHookReason surfaces the first rejection reason for observability', () => {
    const log = [
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'first reason',
        },
      }),
      JSON.stringify({ decision: 'block', reason: 'second reason' }),
    ].join('\n');
    expect(firstHookReason(log)).toContain('first reason');
  });

  it('ignores malformed JSON lines without throwing', () => {
    const log = '{not valid json\n{"decision":"block","reason":"ok"}\nhalf {';
    const signals = detectHookSignals(log);
    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe('block');
  });
});

/**
 * REAL HARNESS SHAPE — the harness captures `claude --output-format stream-json`,
 * where the hook payload is nested as an escaped JSON string inside a
 * `hook_response` envelope's `output`/`stdout`, NOT as a bare top-level line.
 * These tests pin detection against that actual shape so the detector can never
 * again parse a format the harness doesn't produce (the #1102 fix's own bug).
 */
describe('detectHookSignals — real stream-json envelope nesting', () => {
  it('detects a deny nested-and-escaped inside a hook_response envelope', () => {
    const innerPayload = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'BLOCKED: Bash is not allowed during PR review.',
      },
    });
    // The harness writes one stream-json envelope per line; the payload appears
    // in BOTH output and stdout — detection must de-dupe to a single signal.
    const envelope = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_event: 'PreToolUse',
      output: innerPayload,
      stdout: innerPayload,
      exit_code: 2,
    });
    const log = `{"type":"system","subtype":"init"}\n${envelope}\n{"type":"result"}`;

    const signals = detectHookSignals(log);
    expect(signals.length).toBe(1);
    expect(signals[0].kind).toBe('deny');
    expect(signals[0].source).toBe('permission-decision');
    expect(signals[0].reason).toContain('not allowed during PR review');
    expect(hasHookRejection(log)).toBe(true);
  });

  it('detects a stop-gate block nested inside a stream-json envelope', () => {
    const inner = JSON.stringify({ decision: 'block', reason: 'PR REVIEW required' });
    const envelope = JSON.stringify({ type: 'system', subtype: 'hook_response', stdout: inner });
    const signals = detectHookSignals(envelope);
    expect(signals.some((s) => s.kind === 'block' && s.reason?.includes('PR REVIEW'))).toBe(true);
  });

  it('REGRESSION (#1102): real captured probe-hooks.jsonl yields ≥1 hook rejection', () => {
    // This fixture is a genuine `--output-format stream-json` capture committed
    // in #1049. The original #1102 fix returned ZERO signals against it because
    // it assumed bare top-level payloads. This test is the one that catches it.
    const fixture = fileURLToPath(new URL('../fixtures/live/probe-hooks.jsonl', import.meta.url));
    const log = readFileSync(fixture, 'utf8');
    const signals = detectHookSignals(log);
    expect(signals.length).toBeGreaterThan(0);
    expect(hasHookRejection(log)).toBe(true);
    expect(firstHookReason(log)).toBeTruthy();
    // Every detected signal must be a genuine rejection, never an allow.
    expect(signals.every((s) => s.kind === 'deny' || s.kind === 'block')).toBe(true);
  });
});
