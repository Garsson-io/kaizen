import { describe, expect, it } from 'vitest';

import {
  buildKaizenCycleSteps,
  hasContextDelegationProgressEvidence,
} from './auto-dent-progress.js';

describe('auto-dent progress context delegation evidence (#1509)', () => {
  it('places delegated context work before implementation in the work-cycle view', () => {
    const phases = buildKaizenCycleSteps({
      prs: [],
      cases: [],
      stopRequested: false,
      progressSteps: [
        {
          phase: 'DELEGATE',
          state: 'done',
          detail: 'delegated broad issue search to explorer subagent',
        },
      ],
    }).map((step) => step.phase);

    expect(phases.indexOf('DELEGATE')).toBeGreaterThan(phases.indexOf('EVALUATE'));
    expect(phases.indexOf('DELEGATE')).toBeLessThan(phases.indexOf('CASE'));
  });

  it('recognizes explicit and textual context-delegation progress evidence', () => {
    expect(hasContextDelegationProgressEvidence([
      { phase: 'CONTEXT-DELEGATION', state: 'done', detail: 'not applicable: narrow single-file task' },
    ])).toBe(true);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'DELEGATE', state: 'done', detail: 'delegated transcript mining to subagent' },
    ])).toBe(true);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'DELEGATE', state: 'fail', detail: 'did not delegate to a subagent' },
    ])).toBe(false);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'DELEGATE', state: 'done', detail: '' },
    ])).toBe(false);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'RESEARCH', state: 'done', detail: 'delegated transcript mining to subagent' },
    ])).toBe(false);
  });
});
