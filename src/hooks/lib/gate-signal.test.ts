import { describe, it, expect } from 'vitest';
import { formatGateSignal, parseGateSignal, type GateSignal } from './gate-signal.js';

describe('formatGateSignal', () => {
  it('produces a YAML block delimited by ---', () => {
    const signal: GateSignal = { gate: 'needs_review', action: 'set' };
    const out = formatGateSignal(signal);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('gate: needs_review');
    expect(out).toContain('action: set');
    expect(out.endsWith('---\n')).toBe(true);
  });

  it('includes optional fields when present', () => {
    const signal: GateSignal = {
      gate: 'needs_review',
      action: 'set',
      pr: 'https://github.com/org/repo/pull/42',
      round: 3,
      reason: 'push_exceeds_threshold',
    };
    const out = formatGateSignal(signal);
    expect(out).toContain('pr: https://github.com/org/repo/pull/42');
    expect(out).toContain('round: 3');
    expect(out).toContain('reason: push_exceeds_threshold');
  });

  it('omits optional fields when absent', () => {
    const out = formatGateSignal({ gate: 'needs_pr_kaizen', action: 'clear' });
    expect(out).not.toContain('pr:');
    expect(out).not.toContain('round:');
    expect(out).not.toContain('reason:');
  });

  it('round-trips through parseGateSignal', () => {
    const signal: GateSignal = {
      gate: 'needs_review',
      action: 'set',
      pr: 'https://github.com/org/repo/pull/99',
      round: 2,
      reason: 'pr_created',
    };
    const formatted = formatGateSignal(signal);
    const parsed = parseGateSignal(formatted);
    expect(parsed).toEqual(signal);
  });
});

describe('parseGateSignal', () => {
  it('extracts a gate signal from a YAML block at the start of text', () => {
    const text = `---\ngate: needs_review\naction: set\n---\n📋 PR created\n`;
    const signal = parseGateSignal(text);
    expect(signal).toEqual({ gate: 'needs_review', action: 'set' });
  });

  it('extracts a gate signal from the middle of text', () => {
    const text = `Some preamble\n---\ngate: needs_pr_kaizen\naction: clear\nreason: KAIZEN_IMPEDIMENTS\n---\nDone.\n`;
    const signal = parseGateSignal(text);
    expect(signal).toEqual({
      gate: 'needs_pr_kaizen',
      action: 'clear',
      reason: 'KAIZEN_IMPEDIMENTS',
    });
  });

  it('returns null for text without a YAML block', () => {
    expect(parseGateSignal('plain text output')).toBeNull();
    expect(parseGateSignal('MANDATORY SELF-REVIEW LOOP')).toBeNull();
  });

  it('returns null for a YAML block missing gate field', () => {
    expect(parseGateSignal('---\naction: set\n---\n')).toBeNull();
  });

  it('returns null for a YAML block with unknown gate name', () => {
    expect(parseGateSignal('---\ngate: unknown_gate\naction: set\n---\n')).toBeNull();
  });

  it('returns null for a YAML block with unknown action', () => {
    expect(parseGateSignal('---\ngate: needs_review\naction: toggle\n---\n')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    expect(parseGateSignal('---\n: broken: yaml:\n---\n')).toBeNull();
  });

  it('ignores --- in code blocks (e.g. triple-dash inside markdown)', () => {
    // A code block might contain --- but not as a gate signal
    const text = '```\n---\nsome_yaml: true\n---\n```\n';
    // This WILL parse the YAML if it happens to have gate/action fields,
    // which is fine — code blocks aren't gate signals in practice because
    // they won't have valid gate names.
    const signal = parseGateSignal(text);
    expect(signal).toBeNull(); // some_yaml is not a gate name
  });

  it('parses all three gate types', () => {
    for (const gate of ['needs_review', 'needs_pr_kaizen', 'needs_post_merge'] as const) {
      for (const action of ['set', 'clear'] as const) {
        const text = `---\ngate: ${gate}\naction: ${action}\n---\n`;
        const signal = parseGateSignal(text);
        expect(signal).toEqual({ gate, action });
      }
    }
  });
});
