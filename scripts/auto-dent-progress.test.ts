import { describe, expect, it } from 'vitest';

import {
  PROGRESS_PHASE_ORDER,
  buildKaizenCycleSteps,
  formatProgressStepsMarkdown,
  hasContextDelegationProgressEvidence,
  orderedProgressSteps,
  upsertContextDelegationProgressStep,
  upsertProgressStep,
  type AutoDentProgressResult,
  type RunProgressStep,
} from './auto-dent-progress.js';

function stepByPhase(steps: RunProgressStep[], phase: string): RunProgressStep {
  const step = steps.find((s) => s.phase === phase);
  expect(step).toBeDefined();
  return step!;
}

describe('auto-dent progress rendering core (#1311)', () => {
  it('upserts progress steps by phase with insert, merge, and replace semantics', () => {
    const result: AutoDentProgressResult = {
      prs: [],
      cases: [],
      stopRequested: false,
    };

    upsertProgressStep(result, {
      phase: 'TEST',
      state: 'started',
      detail: 'focused vitest',
      url: 'https://github.com/Garsson-io/kaizen/actions/runs/1',
    });
    upsertProgressStep(result, { phase: 'PR', state: 'created', detail: '#1645' });

    expect(result.progressSteps).toHaveLength(2);
    expect(stepByPhase(result.progressSteps!, 'TEST')).toMatchObject({
      state: 'started',
      detail: 'focused vitest',
      url: 'https://github.com/Garsson-io/kaizen/actions/runs/1',
    });

    upsertProgressStep(result, {
      phase: 'TEST',
      state: '',
      detail: 'focused vitest passed',
    });

    expect(stepByPhase(result.progressSteps!, 'TEST')).toMatchObject({
      state: 'started',
      detail: 'focused vitest passed',
      url: 'https://github.com/Garsson-io/kaizen/actions/runs/1',
    });

    upsertProgressStep(result, {
      phase: 'TEST',
      state: 'passed',
      detail: 'full suite passed',
    }, 'replace');

    expect(stepByPhase(result.progressSteps!, 'TEST')).toEqual({
      phase: 'TEST',
      state: 'passed',
      detail: 'full suite passed',
      url: undefined,
    });
  });

  it('builds a synthetic kaizen cycle without letting skipped phases override not-applicable defaults', () => {
    const steps = buildKaizenCycleSteps({
      prs: ['https://github.com/Garsson-io/kaizen/pull/1645'],
      cases: ['case/synthetic'],
      pickedIssue: 'not applicable',
      pickedIssueTitle: 'synthetic dashboard probe',
      progressSteps: [
        { phase: 'PLAN', state: 'done', detail: 'should not replace synthetic skip' },
        { phase: 'DELEGATE', state: 'done', detail: 'delegated dashboard inspection' },
        { phase: 'CASE', state: 'created', detail: 'should not replace synthetic skip' },
        { phase: 'FIX', state: 'done', detail: 'should not replace synthetic skip' },
      ],
      stopRequested: true,
      stopReason: 'synthetic complete',
    }, 'Garsson-io/kaizen');

    expect(steps.map((step) => step.phase)).toEqual(PROGRESS_PHASE_ORDER);
    expect(stepByPhase(steps, 'PLAN')).toMatchObject({
      state: 'not applicable',
      detail: 'synthetic test task',
    });
    expect(stepByPhase(steps, 'CASE')).toMatchObject({
      state: 'not applicable',
      detail: 'synthetic test task',
    });
    expect(stepByPhase(steps, 'FIX')).toMatchObject({
      state: 'not applicable',
      detail: 'synthetic test task',
    });
    expect(stepByPhase(steps, 'DELEGATE')).toMatchObject({
      state: 'done',
      detail: 'delegated dashboard inspection',
    });
    expect(stepByPhase(steps, 'STOP')).toMatchObject({
      state: 'requested',
      detail: 'synthetic complete',
    });
  });

  it('orders known phases without dropping unknown progress phases', () => {
    const original: RunProgressStep[] = [
      { phase: 'FUTURE-B', state: 'done', detail: 'late unknown' },
      { phase: 'STOP', state: 'requested', detail: 'stop' },
      { phase: 'PICK', state: 'selected', detail: '#1311' },
      { phase: 'FUTURE-A', state: 'started', detail: 'early unknown' },
    ];

    const ordered = orderedProgressSteps(original);

    expect(ordered.map((step) => step.phase)).toEqual(['PICK', 'STOP', 'FUTURE-B', 'FUTURE-A']);
    expect(ordered).toHaveLength(original.length);
    expect(original.map((step) => step.phase)).toEqual(['FUTURE-B', 'STOP', 'PICK', 'FUTURE-A']);
  });

  it('formats a representative progress result as the dashboard markdown table', () => {
    const markdown = formatProgressStepsMarkdown({
      prs: ['https://github.com/Garsson-io/kaizen/pull/1645'],
      cases: ['case/260629-k1311-auto-dent-progress-coverage'],
      pickedIssue: '#1311',
      pickedIssueTitle: 'Progress rendering coverage',
      progressSteps: [
        { phase: 'TEST', state: 'passed', detail: 'focused vitest' },
        {
          phase: 'MERGE',
          state: 'merged',
          detail: 'PR #1645',
          url: 'https://github.com/Garsson-io/kaizen/pull/1645',
        },
      ],
      reviewVerdict: 'pass',
      reviewUrls: ['https://github.com/Garsson-io/kaizen/pull/1645#issuecomment-1'],
      stopRequested: true,
      stopReason: 'merged and cleaned up',
    }, 'Garsson-io/kaizen');

    expect(markdown).toContain('#### Kaizen Work Cycle');
    expect(markdown).toContain('| Step | State | Detail | Link |');
    expect(markdown).toMatch(
      /\| PICK \| selected \| https:\/\/github\.com\/Garsson-io\/kaizen\/issues\/1311 . Progress rendering coverage \| https:\/\/github\.com\/Garsson-io\/kaizen\/issues\/1311 \|/,
    );
    expect(markdown).toContain('| TEST | passed | focused vitest | - |');
    expect(markdown).toContain(
      '| REVIEW | pass | pass (https://github.com/Garsson-io/kaizen/pull/1645#issuecomment-1) | https://github.com/Garsson-io/kaizen/pull/1645#issuecomment-1 |',
    );
    expect(markdown).toContain('| MERGE | merged | PR #1645 | https://github.com/Garsson-io/kaizen/pull/1645 |');
    expect(markdown).toContain('| STOP | requested | merged and cleaned up | - |');
    expect(markdown).not.toContain('[object Object]');
  });
});

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
      { phase: 'DELEGATE', state: 'not applicable', detail: 'narrow single-file task' },
    ])).toBe(true);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'DELEGATE', state: 'not applicable', detail: 'narrow single-file task' },
    ], { allowNotApplicable: false })).toBe(false);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'DELEGATE', state: 'done', detail: 'delegated transcript mining to subagent' },
    ], { allowNotApplicable: false })).toBe(true);
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

  it('requires delegation progress before implementation starts', () => {
    expect(hasContextDelegationProgressEvidence([
      { phase: 'DELEGATE', state: 'done', detail: 'delegated transcript mining to subagent' },
      { phase: 'IMPLEMENT', state: 'started', detail: 'case:case-1' },
    ])).toBe(true);
    expect(hasContextDelegationProgressEvidence([
      { phase: 'IMPLEMENT', state: 'started', detail: 'case:case-1' },
      { phase: 'DELEGATE', state: 'done', detail: 'delegated transcript mining to subagent' },
    ])).toBe(false);
  });

  it('preserves repeated delegation markers as history instead of overwriting order', () => {
    const result: AutoDentProgressResult = {
      prs: [],
      cases: [],
      stopRequested: false,
    };

    upsertProgressStep(result, { phase: 'DELEGATE', state: 'fail', detail: 'not delegated yet' });
    upsertProgressStep(result, { phase: 'IMPLEMENT', state: 'started', detail: 'case:case-1' });
    upsertProgressStep(result, { phase: 'DELEGATE', state: 'done', detail: 'late delegated search' });

    expect(result.progressSteps?.filter((step) => step.phase === 'DELEGATE')).toHaveLength(2);
    expect(hasContextDelegationProgressEvidence(result.progressSteps)).toBe(false);
  });

  it('inserts automatic delegation evidence before implementation progress', () => {
    const result: AutoDentProgressResult = {
      prs: [],
      cases: [],
      stopRequested: false,
      progressSteps: [
        { phase: 'IMPLEMENT', state: 'started', detail: 'case:case-1' },
        { phase: 'TEST', state: 'pass', detail: '12 tests' },
      ],
    };

    upsertContextDelegationProgressStep(result, {
      phase: 'DELEGATE',
      state: 'done',
      detail: 'delegated broad search to explorer subagent',
    });

    expect(result.progressSteps?.map((step) => step.phase)).toEqual([
      'DELEGATE',
      'IMPLEMENT',
      'TEST',
    ]);
    expect(hasContextDelegationProgressEvidence(result.progressSteps)).toBe(true);
  });
});
