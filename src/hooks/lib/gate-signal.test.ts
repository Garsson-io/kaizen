import { describe, it, expect } from 'vitest';
import { formatHookOutput, parseHookOutput, formatGateSignal, parseGateSignal, type HookOutput } from './gate-signal.js';

describe('formatHookOutput', () => {
  it('produces a YAML block delimited by ---', () => {
    const output: HookOutput = { hook: 'pr-review-loop', type: 'gate-set', gate: 'needs_review', reason: 'PR created' };
    const out = formatHookOutput(output);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('hook: pr-review-loop');
    expect(out).toContain('type: gate-set');
    expect(out).toContain('gate: needs_review');
    expect(out).toContain('reason: PR created');
    expect(out.endsWith('---\n')).toBe(true);
  });

  it('includes optional fields when present', () => {
    const output: HookOutput = {
      hook: 'pr-review-loop',
      type: 'gate-set',
      gate: 'needs_review',
      pr: 'https://github.com/org/repo/pull/42',
      round: 3,
      reason: 'Push detected',
    };
    const out = formatHookOutput(output);
    expect(out).toContain('pr: https://github.com/org/repo/pull/42');
    expect(out).toContain('round: 3');
  });

  it('omits optional fields when absent', () => {
    const out = formatHookOutput({ hook: 'pr-kaizen-clear', type: 'gate-clear', reason: 'cleared' });
    expect(out).not.toContain('gate:');
    expect(out).not.toContain('pr:');
    expect(out).not.toContain('round:');
  });

  it('round-trips through parseHookOutput', () => {
    const output: HookOutput = {
      hook: 'pr-review-loop',
      type: 'gate-set',
      gate: 'needs_review',
      pr: 'https://github.com/org/repo/pull/99',
      round: 2,
      reason: 'PR created',
    };
    const formatted = formatHookOutput(output);
    const parsed = parseHookOutput(formatted);
    expect(parsed).toEqual(output);
  });

  it('works for all hook output types', () => {
    for (const type of ['gate-set', 'gate-clear', 'deny', 'warn', 'block', 'info'] as const) {
      const out = formatHookOutput({ hook: 'test-hook', type, reason: `test ${type}` });
      expect(out).toContain(`type: ${type}`);
      const parsed = parseHookOutput(out);
      expect(parsed?.type).toBe(type);
    }
  });
});

describe('parseHookOutput', () => {
  it('extracts from a YAML block at the start of text', () => {
    const text = `---\nhook: pr-review-loop\ntype: gate-set\ngate: needs_review\nreason: PR created\n---\n`;
    const parsed = parseHookOutput(text);
    expect(parsed).toEqual({ hook: 'pr-review-loop', type: 'gate-set', gate: 'needs_review', reason: 'PR created' });
  });

  it('extracts from the middle of text (trailing content after ---)', () => {
    const text = `Some preamble\n---\nhook: pr-kaizen-clear\ntype: gate-clear\nreason: impediments filed\n---\nDone.\n`;
    const parsed = parseHookOutput(text);
    expect(parsed?.type).toBe('gate-clear');
    expect(parsed?.reason).toBe('impediments filed');
  });

  it('returns null for text without a YAML block', () => {
    expect(parseHookOutput('plain text output')).toBeNull();
    expect(parseHookOutput('MANDATORY SELF-REVIEW LOOP')).toBeNull();
  });

  it('returns null for a YAML block missing required fields', () => {
    expect(parseHookOutput('---\nhook: test\n---\n')).toBeNull(); // missing type + reason
    expect(parseHookOutput('---\ntype: info\nreason: hi\n---\n')).toBeNull(); // missing hook
  });

  it('returns null for unknown type', () => {
    expect(parseHookOutput('---\nhook: x\ntype: explode\nreason: boom\n---\n')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    expect(parseHookOutput('---\n: broken: yaml:\n---\n')).toBeNull();
  });

  it('parses all three gate names', () => {
    for (const gate of ['needs_review', 'needs_pr_kaizen', 'needs_post_merge'] as const) {
      for (const type of ['gate-set', 'gate-clear'] as const) {
        const text = `---\nhook: test\ntype: ${type}\ngate: ${gate}\nreason: test\n---\n`;
        const parsed = parseHookOutput(text);
        expect(parsed?.gate).toBe(gate);
        expect(parsed?.type).toBe(type);
      }
    }
  });

  it('rejects unknown gate names', () => {
    expect(parseHookOutput('---\nhook: x\ntype: gate-set\ngate: unknown_gate\nreason: test\n---\n')).toBeNull();
  });
});

// Verify aliases work
describe('backward-compat aliases', () => {
  it('formatGateSignal is formatHookOutput', () => {
    expect(formatGateSignal).toBe(formatHookOutput);
  });

  it('parseGateSignal is parseHookOutput', () => {
    expect(parseGateSignal).toBe(parseHookOutput);
  });
});
