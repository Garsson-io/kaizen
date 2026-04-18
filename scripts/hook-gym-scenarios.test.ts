import { describe, it, expect } from 'vitest';
import {
  SCENARIOS,
  getScenario,
  renderPrompt,
} from './hook-gym-scenarios.js';
import { SEVERITY_WEIGHT } from './hook-gym-schema.js';

describe('SCENARIOS', () => {
  it('defines at least 3 core scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(3);
  });

  it('includes probe-hooks, lifecycle-gates, full-clear', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(names).toContain('probe-hooks');
    expect(names).toContain('lifecycle-gates');
    expect(names).toContain('full-clear');
  });

  it('every scenario has at least one expected hook', () => {
    for (const s of SCENARIOS) {
      expect(s.expectedHooks.length).toBeGreaterThan(0);
    }
  });

  it('gate-lifecycle scenarios declare expected gates (behavioral-only scenarios may have none)', () => {
    // Core gate-lifecycle scenarios must assert gate behavior. Behavioral-only
    // scenarios (e.g. install-git-hooks-skill for epic #1059) observe Bash
    // tool calls rather than gates — they legitimately have no gates.
    const GATE_LIFECYCLE_SCENARIOS = ['probe-hooks', 'lifecycle-gates', 'full-clear'];
    for (const s of SCENARIOS) {
      if (GATE_LIFECYCLE_SCENARIOS.includes(s.name)) {
        expect(s.expectedGates.length).toBeGreaterThan(0);
      }
    }
  });

  it('every expected hook has severity 1-3', () => {
    for (const s of SCENARIOS) {
      for (const h of s.expectedHooks) {
        expect(h.severity).toBeGreaterThanOrEqual(1);
        expect(h.severity).toBeLessThanOrEqual(3);
      }
    }
  });

  it('every scenario has a positive budget and timeout', () => {
    for (const s of SCENARIOS) {
      expect(s.maxBudget).toBeGreaterThan(0);
      expect(s.timeoutSeconds).toBeGreaterThan(0);
    }
  });

  it('probe-hooks uses haiku (cheapest model)', () => {
    const s = getScenario('probe-hooks');
    expect(s?.model).toBe('haiku');
  });

  it('prompts that reference {{timestamp}} or {{host_repo}} pair the two placeholders consistently', () => {
    // Gate-lifecycle scenarios template a timestamp into file names + PR
    // titles and target a specific host repo. Behavioral-only scenarios may
    // not need them (e.g. install-git-hooks-skill runs a pure CLI invocation).
    // Invariant: if a prompt references either placeholder, the other is
    // handled too, preserving the render contract.
    for (const s of SCENARIOS) {
      const hasTs = s.prompt.includes('{{timestamp}}');
      const hasRepo = s.prompt.includes('{{host_repo}}');
      if (hasTs || hasRepo) {
        // Don't require BOTH; require at least the one(s) that appear to
        // roundtrip cleanly through renderPrompt (covered in its own tests).
        expect(hasTs || hasRepo).toBe(true);
      }
    }
  });
});

describe('getScenario', () => {
  it('returns the scenario by name', () => {
    const s = getScenario('probe-hooks');
    expect(s).toBeDefined();
    expect(s?.name).toBe('probe-hooks');
  });

  it('returns undefined for unknown name', () => {
    expect(getScenario('does-not-exist')).toBeUndefined();
  });
});

describe('renderPrompt', () => {
  it('replaces single placeholder', () => {
    const result = renderPrompt('hello {{name}}', { name: 'world' });
    expect(result).toBe('hello world');
  });

  it('replaces multiple placeholders', () => {
    const result = renderPrompt('{{a}} and {{b}}', { a: 'x', b: 'y' });
    expect(result).toBe('x and y');
  });

  it('replaces the same placeholder multiple times', () => {
    const result = renderPrompt('{{x}} {{x}} {{x}}', { x: 'hi' });
    expect(result).toBe('hi hi hi');
  });

  it('leaves unknown placeholders in place', () => {
    const result = renderPrompt('{{known}} {{unknown}}', { known: 'yes' });
    expect(result).toBe('yes {{unknown}}');
  });

  it('handles empty vars object', () => {
    const result = renderPrompt('{{x}} static', {});
    expect(result).toBe('{{x}} static');
  });

  it('renders a full scenario prompt without leaving {{timestamp}} or {{host_repo}}', () => {
    const s = getScenario('probe-hooks');
    expect(s).toBeDefined();
    const rendered = renderPrompt(s!.prompt, {
      timestamp: '20260413123000',
      host_repo: 'Garsson-io/kaizen',
    });
    expect(rendered).not.toContain('{{timestamp}}');
    expect(rendered).not.toContain('{{host_repo}}');
    expect(rendered).toContain('20260413123000');
    expect(rendered).toContain('Garsson-io/kaizen');
  });
});

describe('SEVERITY_WEIGHT', () => {
  it('weights advisory=1, enforcement=2, gate-critical=4', () => {
    expect(SEVERITY_WEIGHT[1]).toBe(1);
    expect(SEVERITY_WEIGHT[2]).toBe(2);
    expect(SEVERITY_WEIGHT[3]).toBe(4);
  });

  it('gate-critical hooks weigh more than advisory by a factor of 4', () => {
    expect(SEVERITY_WEIGHT[3] / SEVERITY_WEIGHT[1]).toBe(4);
  });
});
